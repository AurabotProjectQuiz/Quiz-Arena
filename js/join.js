import { supabase } from './supabaseClient.js';
import { generatePlayerId, EMOJI_CHOICES, escapeHtml, shuffle, $ } from './utils.js';

// ------------------------------------------------------------
// State
// ------------------------------------------------------------
const playerId = generatePlayerId();
let playerName = '';
let playerEmoji = null;
let code = null;
let channel = null;

let myQueue = [];            // this player's own shuffled question order (classic mode)
let myIndex = -1;
let currentQuestion = null;
let answered = false;
let questionStartClientTime = 0;
let myScore = 0;
let timerInterval = null;
let advanceTimeout = null;

// Eels & Escalators (board mode) state
let gameMode = 'classic';
let allQuestions = [];       // full pool for this player, board mode
let usedThisLap = new Set(); // question ids already used since the pool was last reshuffled
let roundQueue = [];         // current round's 6 questions
let roundIndex = -1;
let myPosition = 0;
let gameEnded = false;
let waitingForRoundResult = false;
let pendingRoundResult = null;
const QUESTIONS_PER_ROUND = 6;
const BOARD_SIZE = 100;

// Firewall Duel state
let currentDuelId = null;
let myFirewall = 100;

const OPTION_CLASSES = ['opt-a', 'opt-b', 'opt-c', 'opt-d'];
const CIRCUMFERENCE = 2 * Math.PI * 34;

const screens = ['join', 'waiting', 'question', 'reveal', 'round-result', 'duel-searching', 'done', 'final'];
function showScreen(name) {
  for (const s of screens) {
    $(`#screen-${s}`).hidden = s !== name;
  }
}

// ------------------------------------------------------------
// Emoji picker
// ------------------------------------------------------------
function renderEmojiGrid() {
  const grid = $('#emoji-grid');
  grid.innerHTML = EMOJI_CHOICES
    .map((e) => `<button type="button" class="emoji-choice" data-emoji="${e}">${e}</button>`)
    .join('');
  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('.emoji-choice');
    if (!btn) return;
    grid.querySelectorAll('.emoji-choice').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    playerEmoji = btn.dataset.emoji;
  });
}
renderEmojiGrid();

// ------------------------------------------------------------
// If this page was opened by scanning the host's QR code, the link
// includes ?code=XXXXX — pre-fill it so all that's left is picking a
// name and a character.
// ------------------------------------------------------------
(() => {
  const codeFromUrl = new URLSearchParams(window.location.search).get('code');
  if (codeFromUrl) {
    $('#input-code').value = codeFromUrl.toUpperCase();
    $('#input-name').focus();
  }
})();

// ------------------------------------------------------------
// Step 1: join form
// ------------------------------------------------------------
$('#btn-join').addEventListener('click', async () => {
  const codeInput = $('#input-code').value.trim().toUpperCase();
  const nameInput = $('#input-name').value.trim();
  const errorEl = $('#join-error');
  errorEl.textContent = '';

  if (codeInput.length < 4) {
    errorEl.textContent = 'Enter the game code from the host screen.';
    return;
  }
  if (!nameInput) {
    errorEl.textContent = 'Enter your name.';
    return;
  }
  if (!playerEmoji) {
    errorEl.textContent = 'Pick a character.';
    return;
  }

  code = codeInput;
  playerName = nameInput;
  $('#btn-join').disabled = true;
  $('#btn-join').textContent = 'Joining…';

  await joinGame();
});

async function joinGame() {
  channel = supabase.channel(`quiz-${code}`, {
    config: { presence: { key: playerId } },
  });

  channel.on('broadcast', { event: 'game_start' }, ({ payload }) => onGameStart(payload));
  channel.on('broadcast', { event: 'answer_result' }, ({ payload }) => onAnswerResult(payload));
  channel.on('broadcast', { event: 'round_result' }, ({ payload }) => onRoundResult(payload));
  channel.on('broadcast', { event: 'duel_start' }, ({ payload }) => onDuelStart(payload));
  channel.on('broadcast', { event: 'duel_result' }, ({ payload }) => onDuelResult(payload));
  channel.on('broadcast', { event: 'game_over' }, ({ payload }) => onGameOver(payload));

  channel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      await channel.track({ name: playerName, emoji: playerEmoji });
      $('#waiting-emoji').textContent = playerEmoji;
      $('#waiting-name').textContent = playerName;
      showScreen('waiting');
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      $('#join-error').textContent = "Couldn't connect. Check the code and try again.";
      $('#btn-join').disabled = false;
      $('#btn-join').textContent = 'Join game';
    }
  });
}

// ------------------------------------------------------------
// Step 3: each player gets the full question set once, then
// works through their own shuffled order at their own pace.
// ------------------------------------------------------------
function onGameStart(payload) {
  gameMode = payload.mode || 'classic';
  gameEnded = false;

  if (gameMode === 'board') {
    allQuestions = payload.questions.map((q) => ({ ...q, options: shuffle(q.options) }));
    usedThisLap = new Set();
    myPosition = 0;
    startNewRound();
    return;
  }

  if (gameMode === 'duel') {
    myFirewall = 100;
    enterDuelSearching();
    return;
  }

  // Shuffle the order questions appear in for this player, AND shuffle
  // each question's answer options independently — so the correct
  // answer isn't reliably in the same position (e.g. always "a")
  // regardless of how the quiz bank was authored or generated.
  const withShuffledOptions = payload.questions.map((q) => ({
    ...q,
    options: shuffle(q.options),
  }));
  myQueue = shuffle(withShuffledOptions);
  myIndex = -1;
  myScore = 0;
  showNextQuestion();
}

// ------------------------------------------------------------
// Eels & Escalators — draw 6 questions per round from the quiz's
// question bank, without repeats until the whole bank has been used,
// then reshuffle and go again (in a different order) for as long as
// the game continues.
// ------------------------------------------------------------
function drawRoundQuestions() {
  const pool = allQuestions;
  let picks = shuffle(pool.filter((q) => !usedThisLap.has(q.id))).slice(0, QUESTIONS_PER_ROUND);

  if (picks.length < QUESTIONS_PER_ROUND) {
    // Bank ran out mid-round (or has fewer than 6 questions total) —
    // start a fresh lap and top up the rest of this round from it.
    const pickedIds = new Set(picks.map((q) => q.id));
    usedThisLap = new Set(pickedIds);
    const freshPool = pool.filter((q) => !pickedIds.has(q.id));
    const topUp = shuffle(freshPool.length ? freshPool : pool).slice(0, QUESTIONS_PER_ROUND - picks.length);
    picks = picks.concat(topUp);
  }

  picks.forEach((q) => usedThisLap.add(q.id));
  if (usedThisLap.size >= pool.length) usedThisLap = new Set(); // lap complete — next draw reshuffles fresh

  return picks;
}

function startNewRound() {
  roundQueue = drawRoundQuestions();
  roundIndex = -1;
  showNextRoundQuestion();
}

function showNextRoundQuestion() {
  roundIndex++;
  currentQuestion = roundQueue[roundIndex];
  answered = false;
  questionStartClientTime = performance.now();

  $('#progress-label').textContent = `Question ${roundIndex + 1} of ${QUESTIONS_PER_ROUND} · Square ${myPosition}`;
  $('#player-question-text').textContent = currentQuestion.text;

  const grid = $('#player-options-grid');
  grid.innerHTML = currentQuestion.options
    .map((opt, i) => `
      <button type="button" class="option-btn ${OPTION_CLASSES[i]}" data-option-id="${opt.id}">
        <span class="shape"></span>${escapeHtml(opt.text)}
      </button>
    `)
    .join('');
  grid.querySelectorAll('.option-btn').forEach((btn) => {
    btn.addEventListener('click', () => submitAnswer(btn.dataset.optionId));
  });

  showScreen('question');
  startTimer(currentQuestion.timeLimitSeconds, () => {
    if (!answered) submitAnswer(null);
  });
}

function showNextQuestion() {
  myIndex++;
  if (myIndex >= myQueue.length) {
    $('#done-total-score').textContent = myScore;
    showScreen('done');
    return;
  }

  currentQuestion = myQueue[myIndex];
  answered = false;
  questionStartClientTime = performance.now();

  $('#progress-label').textContent = `Question ${myIndex + 1} of ${myQueue.length}`;
  $('#player-question-text').textContent = currentQuestion.text;

  const grid = $('#player-options-grid');
  grid.innerHTML = currentQuestion.options
    .map((opt, i) => `
      <button type="button" class="option-btn ${OPTION_CLASSES[i]}" data-option-id="${opt.id}">
        <span class="shape"></span>${escapeHtml(opt.text)}
      </button>
    `)
    .join('');
  grid.querySelectorAll('.option-btn').forEach((btn) => {
    btn.addEventListener('click', () => submitAnswer(btn.dataset.optionId));
  });

  showScreen('question');
  startTimer(currentQuestion.timeLimitSeconds, () => {
    if (!answered) submitAnswer(null); // ran out of time — counts as no answer
  });
}

function submitAnswer(optionId) {
  if (answered || !currentQuestion) return;
  answered = true;
  clearTimer();

  const timeTakenMs = performance.now() - questionStartClientTime;
  const payload = { playerId, questionId: currentQuestion.id, optionId, timeTakenMs };
  if (gameMode === 'duel') payload.duelId = currentDuelId;

  channel.send({ type: 'broadcast', event: 'answer', payload });

  // Fallback: if the host doesn't respond in time (e.g. connection hiccup),
  // move on anyway so a stuck message never strands the player. Duels wait
  // on an opponent too, so they get a longer grace period tied to the
  // question's own time limit rather than a flat 4s.
  if (gameMode === 'duel') {
    advanceTimeout = setTimeout(() => enterDuelSearching(), currentQuestion.timeLimitSeconds * 1000 + 6000);
  } else if (gameMode === 'board') {
    advanceTimeout = setTimeout(() => {
      if (roundIndex + 1 < roundQueue.length) {
        showNextRoundQuestion();
      } else {
        waitingForRoundResult = true;
        maybeShowRoundResult();
      }
    }, 4000);
  } else {
    advanceTimeout = setTimeout(() => showNextQuestion(), 4000);
  }
}

// ------------------------------------------------------------
// Step 4: instant per-question feedback from the host, then
// auto-advance to this player's next question.
// ------------------------------------------------------------
function onAnswerResult(payload) {
  if (payload.playerId !== playerId) return; // not this player's answer
  if (!currentQuestion || payload.questionId !== currentQuestion.id) return; // stale

  clearTimeout(advanceTimeout);

  if (gameMode === 'board') {
    const banner = $('#reveal-banner');
    if (payload.correct) {
      banner.textContent = 'Correct! ✅';
      banner.className = 'reveal-banner correct';
    } else {
      banner.textContent = 'Not quite ❌';
      banner.className = 'reveal-banner incorrect';
    }
    $('#points-earned').textContent = '';
    $('#my-total-score').textContent = '';
    showScreen('reveal');

    setTimeout(() => {
      if (gameEnded) return;
      if (roundIndex + 1 < roundQueue.length) {
        showNextRoundQuestion();
      } else {
        waitingForRoundResult = true;
        maybeShowRoundResult(); // in case the host's round_result already arrived
      }
    }, 1400);
    return;
  }

  myScore = payload.totalScore;

  const banner = $('#reveal-banner');
  if (payload.correct) {
    banner.textContent = 'Correct! ✅';
    banner.className = 'reveal-banner correct';
    $('#points-earned').textContent = `+${payload.points} points`;
  } else {
    banner.textContent = 'Not quite ❌';
    banner.className = 'reveal-banner incorrect';
    $('#points-earned').textContent = '+0 points';
  }
  $('#my-total-score').textContent = myScore;

  showScreen('reveal');
  setTimeout(() => showNextQuestion(), 1400);
}

// ------------------------------------------------------------
// Eels & Escalators — round result (movement + escalator/eel) arrives
// once the host has processed all 6 answers for this round. It can
// arrive before or after the reveal delay above finishes, so both
// paths funnel through maybeShowRoundResult().
// ------------------------------------------------------------
function onRoundResult(payload) {
  if (payload.playerId !== playerId) return;
  pendingRoundResult = payload;
  maybeShowRoundResult();
}

function maybeShowRoundResult() {
  if (!waitingForRoundResult || !pendingRoundResult || gameEnded) return;
  const result = pendingRoundResult;
  pendingRoundResult = null;
  waitingForRoundResult = false;
  myPosition = result.landedOn;

  $('#round-result-headline').textContent = `${result.correct}/${QUESTIONS_PER_ROUND} correct!`;

  let detail = `You moved from square ${result.from} to ${result.to}.`;
  if (result.snapType === 'escalator') {
    detail += ` 🛗 An escalator boosted you up to ${result.landedOn}!`;
  } else if (result.snapType === 'eel') {
    detail += ` 🐍 Oh no, an eel! You slid down to ${result.landedOn}.`;
  }
  $('#round-result-detail').textContent = detail;
  $('#round-result-square').textContent = result.landedOn;

  showScreen('round-result');

  setTimeout(() => {
    if (gameEnded) return;
    if (result.finished) {
      $('#done-headline').textContent = 'You reached square 100! 🏁';
      $('#done-total-score').textContent = `Finished #${result.finishOrder}`;
      showScreen('done');
    } else {
      startNewRound();
    }
  }, 2600);
}

// ------------------------------------------------------------
// Firewall Duel — the host pairs two waiting players and sends them
// the same question. Answer, see the result, then requeue for the
// next opponent — same instant-feedback rhythm as every other mode.
// ------------------------------------------------------------
function onDuelStart(payload) {
  if (!payload.players[playerId]) return; // this pairing isn't for me

  currentDuelId = payload.duelId;
  const opponentId = Object.keys(payload.players).find((id) => id !== playerId);
  const opponent = payload.players[opponentId];
  const me = payload.players[playerId];
  myFirewall = me.firewall;

  $('#duel-my-emoji').textContent = playerEmoji;
  $('#duel-opponent-emoji').textContent = opponent.emoji;
  $('#duel-opponent-name').textContent = opponent.name;
  $('#duel-my-firewall-fill').style.width = `${myFirewall}%`;
  $('#duel-opp-firewall-fill').style.width = `${opponent.firewall}%`;
  $('#duel-header').hidden = false;

  currentQuestion = { ...payload.question, options: shuffle(payload.question.options) };
  answered = false;
  questionStartClientTime = performance.now();

  $('#progress-label').textContent = `⚡ Duel vs ${opponent.name}`;
  $('#player-question-text').textContent = currentQuestion.text;

  const grid = $('#player-options-grid');
  grid.innerHTML = currentQuestion.options
    .map((opt, i) => `
      <button type="button" class="option-btn ${OPTION_CLASSES[i]}" data-option-id="${opt.id}">
        <span class="shape"></span>${escapeHtml(opt.text)}
      </button>
    `)
    .join('');
  grid.querySelectorAll('.option-btn').forEach((btn) => {
    btn.addEventListener('click', () => submitAnswer(btn.dataset.optionId));
  });

  showScreen('question');
  startTimer(currentQuestion.timeLimitSeconds, () => {
    if (!answered) submitAnswer(null);
  });
}

function onDuelResult(payload) {
  if (payload.duelId !== currentDuelId) return; // stale — already moved on
  const mine = payload.results[playerId];
  if (!mine) return;

  clearTimeout(advanceTimeout);
  myFirewall = mine.firewall;

  const banner = $('#reveal-banner');
  if (mine.opponentBroken) {
    banner.textContent = 'Firewall breached! You win this one 🏆';
    banner.className = 'reveal-banner correct';
  } else if (mine.broken) {
    banner.textContent = 'Your firewall was breached! 😵';
    banner.className = 'reveal-banner incorrect';
  } else if (mine.yourDamageDealt > 0) {
    banner.textContent = `Direct hit — ${mine.yourDamageDealt} damage! ⚡`;
    banner.className = 'reveal-banner correct';
  } else if (mine.damageTaken > 0) {
    banner.textContent = `Took ${mine.damageTaken} damage! 🛡️`;
    banner.className = 'reveal-banner incorrect';
  } else {
    banner.textContent = 'Both firewalls held ⚡';
    banner.className = 'reveal-banner';
  }
  $('#points-earned').textContent = mine.broken ? 'Firewall rebooted to 100%' : `Firewall: ${mine.firewall}%`;

  $('#score-label').textContent = 'Your firewall';
  $('#my-total-score').textContent = `${myFirewall}%`;

  showScreen('reveal');
  setTimeout(() => {
    if (gameEnded) return;
    enterDuelSearching();
  }, 1800);
}

function enterDuelSearching() {
  currentDuelId = null;
  $('#duel-searching-firewall').textContent = `${myFirewall}%`;
  showScreen('duel-searching');
}

// ------------------------------------------------------------
// Step 6: final results (host ended the game)
// ------------------------------------------------------------
function onGameOver(payload) {
  gameEnded = true;
  waitingForRoundResult = false;
  pendingRoundResult = null;

  const myEntry = payload.leaderboard.find((p) => p.id === playerId);
  $('#final-headline').textContent = myEntry
    ? `You finished #${myEntry.place} 🎉`
    : 'Game over!';

  const el = $('#podium');
  const top3 = payload.leaderboard.slice(0, 3);
  const classes = ['first', 'second', 'third'];
  el.innerHTML = top3
    .map((p, i) => `
      <div class="podium-place ${classes[i]}">
        <span class="podium-emoji">${p.emoji}</span>
        <span class="podium-name">${escapeHtml(p.name)}</span>
        <span class="podium-score">${p.score}</span>
        <div class="podium-block">${i + 1}</div>
      </div>
    `)
    .join('');

  clearTimer();
  clearTimeout(advanceTimeout);
  showScreen('final');
}

// ------------------------------------------------------------
// Countdown timer
// ------------------------------------------------------------
function startTimer(totalSeconds, onComplete) {
  clearTimer();
  const progress = $('#timer-progress');
  const countEl = $('#timer-count');
  progress.style.strokeDasharray = `${CIRCUMFERENCE}`;
  const startedAt = performance.now();

  timerInterval = setInterval(() => {
    const elapsed = (performance.now() - startedAt) / 1000;
    const remaining = Math.max(0, totalSeconds - elapsed);
    const fraction = remaining / totalSeconds;
    progress.style.strokeDashoffset = `${CIRCUMFERENCE * (1 - fraction)}`;
    progress.style.stroke = fraction < 0.25 ? 'var(--danger)' : 'var(--lime)';
    countEl.textContent = Math.ceil(remaining);

    if (remaining <= 0) {
      clearTimer();
      onComplete();
    }
  }, 100);
}

function clearTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}
