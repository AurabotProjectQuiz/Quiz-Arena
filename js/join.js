import { supabase } from './supabaseClient.js';
import { generatePlayerId, EMOJI_CHOICES, escapeHtml, shuffle, launchConfetti, enableConsistentEmoji, renderForcefieldAvatar, $ } from './utils.js';
import { createAsteroidsGame, WEAPON_TYPES } from './asteroidsGame.js';

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
let currentDuelOpponentEmoji = '🤖';
let currentDuelOpponentName = 'Opponent';
let duelQuestionIndex = -1;
let duelTotalQuestions = 3;
const DUEL_QUESTIONS_PER_BATCH = 3;

// Asteroid Defense state — the actual mini-game lives in
// js/asteroidsGame.js; this is just the shop/wave pacing around it.
let asteroidsMoney = 0;
let asteroidsWave = 1;
let asteroidsQuestionsAnsweredInBatch = 0;
let asteroidsGameInstance = null;
let shopCountdownInterval = null;
let defenseCountdownInterval = null;
const ASTEROIDS_QUESTIONS_PER_WAVE = 5;
const ASTEROIDS_SHOP_SECONDS = 5;
const ASTEROIDS_DEFENSE_SECONDS = 10;

const OPTION_CLASSES = ['opt-a', 'opt-b', 'opt-c', 'opt-d'];
const CIRCUMFERENCE = 2 * Math.PI * 34;

const screens = ['join', 'waiting', 'rules', 'question', 'reveal', 'round-result', 'duel-battle', 'duel-searching', 'duel-waiting', 'board-update', 'asteroids-shop', 'asteroids-defense', 'done', 'final'];
function showScreen(name) {
  for (const s of screens) {
    $(`#screen-${s}`).hidden = s !== name;
  }
}

// Full-screen color wash + resets the points-earned color to match,
// so a correct/wrong answer registers instantly, before you've even
// read the banner text. Called right before showScreen('reveal').
function flashRevealScreen(isCorrect) {
  const el = $('#screen-reveal');
  el.classList.remove('flash-correct', 'flash-incorrect');
  void el.offsetWidth; // force reflow so the animation restarts every time
  el.classList.add(isCorrect ? 'flash-correct' : 'flash-incorrect');
  $('#points-earned').classList.toggle('correct', isCorrect);
  $('#points-earned').classList.toggle('incorrect', !isCorrect);
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
enableConsistentEmoji();
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
  channel.on('broadcast', { event: 'duel_question' }, ({ payload }) => onDuelQuestion(payload));
  channel.on('broadcast', { event: 'duel_question_result' }, ({ payload }) => onDuelQuestionResult(payload));
  channel.on('broadcast', { event: 'duel_result' }, ({ payload }) => onDuelResult(payload));
  channel.on('broadcast', { event: 'game_over' }, ({ payload }) => onGameOver(payload));
  channel.on('broadcast', { event: 'time_update' }, ({ payload }) => onTimeUpdate(payload));

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
// ------------------------------------------------------------
// Quick "how to play" rules screen shown right when a game starts,
// before the first question — so players actually know what's going on
// instead of figuring out the mechanics mid-game. Auto-continues after
// a few seconds so it never strands anyone who doesn't tap anything.
// ------------------------------------------------------------
const MODE_RULES = {
  classic: {
    title: '🧠 Classic Quiz',
    body: ['Answer each question at your own pace.', 'Faster correct answers earn more points!'],
  },
  board: {
    title: '🐍🛗 Eels & Escalators',
    body: [
      'Every 6 questions is a round — how many you get right is how far you move on the shared board.',
      'Land on an escalator to zoom up, or an eel to slide back down.',
      'First to square 100 wins!',
    ],
  },
  duel: {
    title: '🔥 Firewall Duel',
    body: [
      "You'll be matched against another player for a 3-question battle.",
      'Answer correctly and fast to earn money — and if you answer faster than your opponent, you chip 20% off their shield!',
      'Fully deplete their shield and you steal 15% of their money — their shield instantly refreshes and the battle continues.',
      "See the full battle play out on a big screen once you've both finished your 3, then you'll get a new opponent.",
    ],
  },
  outbreak: {
    title: '🦠 Outbreak: Antivirus Grid',
    body: [
      'Correct answers claim a node on the shared grid, shown on the main screen.',
      'Claim nodes next to your own territory for bonus chain points!',
      'Once the grid fills up, fast correct answers can flip a rival node.',
      "You'll get a peek at the board on your own screen every 5 questions.",
    ],
  },
  asteroids: {
    title: '☄️ Asteroid Defense',
    body: [
      "Answer 5 questions to earn money — faster correct answers earn more!",
      "Then you'll get 5 seconds in the shop to buy or upgrade weapons.",
      'Hold the left side of your world to rotate left, the right side to rotate right — weapons rotate with it, so line them up straight with incoming asteroids!',
      'The Rocket Launcher auto-tracks targets, no aiming needed.',
      "If an asteroid hits your world, you can't score again until the wave ends.",
      'Asteroids get tougher and faster with every wave!',
    ],
  },
};

let pendingGameStartPayload = null;
let rulesAutoTimeout = null;

function onGameStart(payload) {
  gameMode = payload.mode || 'classic';
  gameEnded = false;
  pendingGameStartPayload = payload;
  showModeRules();
}

function showModeRules() {
  const rules = MODE_RULES[gameMode] || MODE_RULES.classic;
  $('#rules-title').textContent = rules.title;
  $('#rules-body').innerHTML = rules.body.map((line) => `<li>${escapeHtml(line)}</li>`).join('');
  showScreen('rules');

  clearTimeout(rulesAutoTimeout);
  rulesAutoTimeout = setTimeout(proceedPastRules, 8000);
}

function proceedPastRules() {
  clearTimeout(rulesAutoTimeout);
  beginGameForMode(pendingGameStartPayload);
}

$('#btn-rules-continue').addEventListener('click', proceedPastRules);

function beginGameForMode(payload) {
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

  if (gameMode === 'asteroids') {
    const withShuffledOptions = payload.questions.map((q) => ({ ...q, options: shuffle(q.options) }));
    myQueue = shuffle(withShuffledOptions);
    myIndex = -1;
    myScore = 0;
    asteroidsMoney = 0;
    asteroidsWave = 1;
    asteroidsQuestionsAnsweredInBatch = 0;
    initAsteroidsGameInstance();
    showNextAsteroidsQuestion();
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
    btn.addEventListener('click', () => { btn.classList.add('tapped'); submitAnswer(btn.dataset.optionId); });
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
    btn.addEventListener('click', () => { btn.classList.add('tapped'); submitAnswer(btn.dataset.optionId); });
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
  if (gameMode === 'duel') {
    payload.duelId = currentDuelId;
    payload.questionIndex = duelQuestionIndex;
  }

  channel.send({ type: 'broadcast', event: 'answer', payload });

  // Fallback: if the host doesn't respond in time (e.g. connection hiccup),
  // move on anyway so a stuck message never strands the player. Duels wait
  // on an opponent too, so they get a longer grace period tied to the
  // question's own time limit rather than a flat 4s.
  if (gameMode === 'duel') {
    // Fallback in case our own duel_question_result broadcast gets lost:
    // move to the "waiting for opponent" screen anyway after a beat (the
    // real event, once it arrives, clears this and shows the proper
    // reveal first). If nothing at all arrives for a long while, bail
    // out to searching rather than stranding the player forever.
    advanceTimeout = setTimeout(() => {
      enterDuelWaitingForOpponent();
      advanceTimeout = setTimeout(() => enterDuelSearching(), (currentQuestion.timeLimitSeconds + 25) * 1000);
    }, 1500);
  } else if (gameMode === 'board') {
    advanceTimeout = setTimeout(() => {
      if (roundIndex + 1 < roundQueue.length) {
        showNextRoundQuestion();
      } else {
        waitingForRoundResult = true;
        maybeShowRoundResult();
      }
    }, 4000);
  } else if (gameMode === 'asteroids') {
    advanceTimeout = setTimeout(() => showNextAsteroidsQuestion(), 4000);
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
    flashRevealScreen(payload.correct);
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

  if (gameMode === 'outbreak') {
    myScore = payload.totalScore;
    const banner = $('#reveal-banner');
    const cr = payload.claimResult;
    let positiveFlash = payload.correct;

    if (!payload.correct) {
      banner.textContent = 'Not quite ❌';
      banner.className = 'reveal-banner incorrect';
      $('#points-earned').textContent = '+0 points';
    } else if (cr?.type === 'claimed') {
      banner.textContent = cr.chainCount > 0 ? `Node claimed! Chain x${cr.chainCount} 🔗` : 'Node claimed! 🦠';
      banner.className = 'reveal-banner correct';
      $('#points-earned').textContent = `+${payload.points} points`;
    } else if (cr?.type === 'flipped') {
      banner.textContent = 'Rival node flipped! 💥';
      banner.className = 'reveal-banner correct';
      $('#points-earned').textContent = `+${payload.points} points`;
    } else if (cr?.type === 'steal_failed') {
      banner.textContent = 'Correct — but the hack was repelled 🛡️';
      banner.className = 'reveal-banner correct';
      $('#points-earned').textContent = `+${payload.points} points`;
    } else {
      banner.textContent = 'Correct! ✅';
      banner.className = 'reveal-banner correct';
      $('#points-earned').textContent = `+${payload.points} points`;
    }
    $('#my-total-score').textContent = myScore;

    flashRevealScreen(positiveFlash);
    showScreen('reveal');
    setTimeout(() => {
      if (payload.gridSnapshot) {
        renderBoardSnapshot(payload.gridSnapshot);
        showScreen('board-update');
        setTimeout(() => showNextQuestion(), 5000);
      } else {
        showNextQuestion();
      }
    }, 1400);
    return;
  }

  if (gameMode === 'asteroids') {
    asteroidsMoney = payload.totalScore;
    myScore = payload.totalScore;

    const banner = $('#reveal-banner');
    if (payload.correct) {
      banner.textContent = `+$${payload.points}! 💰`;
      banner.className = 'reveal-banner correct';
    } else {
      banner.textContent = 'Not quite ❌';
      banner.className = 'reveal-banner incorrect';
    }
    $('#points-earned').textContent = '';
    $('#score-label').textContent = 'Your money';
    $('#my-total-score').textContent = `$${asteroidsMoney}`;

    flashRevealScreen(payload.correct);
    showScreen('reveal');

    asteroidsQuestionsAnsweredInBatch += 1;
    setTimeout(() => {
      if (asteroidsQuestionsAnsweredInBatch >= ASTEROIDS_QUESTIONS_PER_WAVE) {
        asteroidsQuestionsAnsweredInBatch = 0;
        enterAsteroidsShopPhase();
      } else {
        showNextAsteroidsQuestion();
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

  flashRevealScreen(payload.correct);
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

  // duel_start bypasses the normal "dismiss rules screen" flow
  // (proceedPastRules) entirely, so make sure that screen's auto-dismiss
  // timer can never fire later and clobber an in-progress battle.
  clearTimeout(rulesAutoTimeout);

  currentDuelId = payload.duelId;
  const opponentId = Object.keys(payload.players).find((id) => id !== playerId);
  const opponent = payload.players[opponentId];
  const me = payload.players[playerId];
  myFirewall = me.firewall;
  currentDuelOpponentEmoji = opponent.emoji;
  currentDuelOpponentName = opponent.name;
  duelTotalQuestions = payload.totalQuestions;

  // Deliberately not shown here — players answer blind, without seeing
  // either shield. Both avatars only appear together on the big battle
  // cinematic after all 3 questions are done.

  renderDuelQuestion(payload.questionIndex, payload.question);
}

// Sent by the host once both players have answered the previous
// question (index 1 or 2 — index 0 arrives as part of duel_start above).
function onDuelQuestion(payload) {
  if (payload.duelId !== currentDuelId) return; // not my current duel
  renderDuelQuestion(payload.questionIndex, payload.question);
}

function renderDuelQuestion(questionIndex, question) {
  clearTimeout(advanceTimeout);
  duelQuestionIndex = questionIndex;
  currentQuestion = { ...question, options: shuffle(question.options) };
  answered = false;
  questionStartClientTime = performance.now();

  $('#progress-label').textContent = `⚡ Duel Q${duelQuestionIndex + 1}/${duelTotalQuestions} vs ${currentDuelOpponentName}`;
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
    btn.addEventListener('click', () => { btn.classList.add('tapped'); submitAnswer(btn.dataset.optionId); });
  });

  showScreen('question');
  startTimer(currentQuestion.timeLimitSeconds, () => {
    if (!answered) submitAnswer(null);
  });
}

// Per-question feedback — quick and light, like classic mode. The big
// force-field battle cinematic only shows once, after question 3
// resolves for both players.
function onDuelQuestionResult(payload) {
  if (payload.playerId !== playerId) return; // this is the opponent's own per-question result, not mine
  if (payload.duelId !== currentDuelId || payload.questionIndex !== duelQuestionIndex) return; // stale
  clearTimeout(advanceTimeout);

  // Money and shield outcomes depend on your opponent's answer to this
  // same question too, so they're not known yet — that all gets settled
  // (and shown) in the big battle screen once you've both finished.
  const banner = $('#reveal-banner');
  if (payload.correct) {
    banner.textContent = 'Correct! ✅';
    banner.className = 'reveal-banner correct';
    $('#points-earned').textContent = '';
  } else {
    banner.textContent = 'Not quite ❌';
    banner.className = 'reveal-banner incorrect';
    $('#points-earned').textContent = '';
  }
  $('#score-label').textContent = `Question ${duelQuestionIndex + 1} of ${duelTotalQuestions}`;
  $('#my-total-score').textContent = payload.correct ? '✅' : '❌';

  flashRevealScreen(payload.correct);
  showScreen('reveal');

  // Neither the next question nor the battle cinematic can arrive until
  // your OPPONENT has also answered this question — so after your own
  // quick reveal, sit on a "waiting for opponent" screen. Whichever
  // real event (onDuelQuestion or onDuelResult) arrives next will
  // override this screen automatically, AND clears this timer via the
  // shared advanceTimeout variable — important, because if the
  // opponent had already answered, the next question can legitimately
  // arrive before this 1.3s reveal finishes, and this must not be
  // allowed to fire late and yank the player off a question they're
  // already mid-way through answering.
  advanceTimeout = setTimeout(() => {
    enterDuelWaitingForOpponent();
    advanceTimeout = setTimeout(() => enterDuelSearching(), (currentQuestion.timeLimitSeconds + 25) * 1000);
  }, 1300);
}

function onDuelResult(payload) {
  if (payload.duelId !== currentDuelId) return; // stale — already moved on
  const mine = payload.results[playerId];
  if (!mine) return;
  const opponentId = Object.keys(payload.results).find((id) => id !== playerId);
  const theirs = opponentId ? payload.results[opponentId] : null;

  clearTimeout(advanceTimeout);
  myFirewall = mine.firewall;
  showDuelBattleCinematic(mine, theirs);
}

// The big, dramatic full-screen result — shown once per 3-question
// battle, after both duelists have finished their whole batch.
function showDuelBattleCinematic(mine, theirs) {
  const oppFirewall = theirs ? theirs.firewall : 100;
  $('#duel-battle-my-avatar').innerHTML = renderForcefieldAvatar(playerEmoji, mine.firewall, 120);
  $('#duel-battle-opp-avatar').innerHTML = renderForcefieldAvatar(currentDuelOpponentEmoji, oppFirewall, 120);
  $('#duel-battle-opp-name').textContent = currentDuelOpponentName;

  const myAvatarEl = $('#duel-battle-my-avatar').querySelector('.forcefield-avatar');
  const oppAvatarEl = $('#duel-battle-opp-avatar').querySelector('.forcefield-avatar');
  const banner = $('#duel-battle-banner');
  const zapBolt = $('#duel-battle-zap');

  clearFloatingDamage(myAvatarEl);
  clearFloatingDamage(oppAvatarEl);
  myAvatarEl?.classList.remove('hit-shake');
  oppAvatarEl?.classList.remove('hit-shake');
  banner.className = 'duel-battle-banner';
  banner.textContent = '';
  $('#duel-battle-scores').textContent = '';

  showScreen('duel-battle');

  const STRIKE_GAP_MS = 450;
  const AFTER_STRIKES_PAUSE_MS = 500;
  const MONEY_POPUP_DELAY_MS = 500;
  const ACT_GAP_MS = 900;

  function fireZap(direction, targetAvatarEl) {
    zapBolt.classList.remove('zap-fire-right', 'zap-fire-left');
    void zapBolt.offsetWidth; // force reflow so the animation replays every time
    zapBolt.classList.add(direction);
    targetAvatarEl?.classList.remove('hit-shake');
    void targetAvatarEl?.offsetWidth;
    targetAvatarEl?.classList.add('hit-shake');
  }

  // Plays out one side's attacks: a banner naming the winner, one strike
  // animation per attack won, the cumulative shield damage floating up,
  // the money they earned this battle floating up, and — if a shield
  // actually broke this act — the stolen-money flourish.
  let t = 300; // small intro pause before anything happens
  function scheduleAct(attackerName, isMe, attacksWon, damageDealt, moneyEarned, stolenAmount) {
    const targetAvatarEl = isMe ? oppAvatarEl : myAvatarEl;
    const attackerAvatarEl = isMe ? myAvatarEl : oppAvatarEl;
    const direction = isMe ? 'zap-fire-right' : 'zap-fire-left';
    const toneClass = attacksWon > 0 ? (isMe ? 'correct' : 'incorrect') : 'missed';

    setTimeout(() => {
      banner.textContent =
        attacksWon > 0
          ? `${attackerName} won ${attacksWon} attack${attacksWon > 1 ? 's' : ''}!`
          : `${attackerName} missed 💨`;
      banner.className = `duel-battle-banner ${toneClass}`;
    }, t);
    t += 400;

    for (let i = 0; i < attacksWon; i++) {
      setTimeout(() => fireZap(direction, targetAvatarEl), t + i * STRIKE_GAP_MS);
    }
    if (attacksWon > 0) t += attacksWon * STRIKE_GAP_MS;

    if (attacksWon > 0) {
      t += AFTER_STRIKES_PAUSE_MS;
      const damageTime = t;
      setTimeout(() => spawnFloatingDamage(targetAvatarEl, `-${damageDealt}%`, 'damage'), damageTime);
    }

    if (moneyEarned > 0) {
      t += MONEY_POPUP_DELAY_MS;
      const moneyTime = t;
      setTimeout(() => spawnFloatingMoneyGain(attackerAvatarEl, `+$${moneyEarned}`), moneyTime);
    }

    if (stolenAmount > 0) {
      t += MONEY_POPUP_DELAY_MS;
      const stealTime = t;
      setTimeout(() => {
        banner.textContent = `${attackerName} destroyed the shield — stole $${stolenAmount}! 💰`;
        banner.className = `duel-battle-banner ${toneClass}`;
        spawnFloatingMoneyLoss(targetAvatarEl, `-$${stolenAmount}`);
      }, stealTime);
      t += 700;
    }

    t += ACT_GAP_MS;
  }

  // Act 1: my attacks land on them. Act 2: their attacks land on me.
  scheduleAct('You', true, mine.yourAttacksWon, mine.yourDamageDealt, mine.yourMoneyEarned, mine.moneyStolen);
  scheduleAct(currentDuelOpponentName, false, mine.opponentAttacksWon, mine.damageTaken, mine.opponentMoneyEarned, mine.moneyLost);

  const finalScoreTime = t;
  setTimeout(() => {
    $('#duel-battle-scores').textContent = `Your money: $${mine.totalScore}`;
  }, finalScoreTime);

  setTimeout(() => {
    if (gameEnded) return;
    enterDuelSearching();
  }, finalScoreTime + 1800);
}

function spawnFloatingDamage(anchorEl, text, kind) {
  if (!anchorEl) return;
  const el = document.createElement('div');
  el.className = `floating-damage ${kind}`;
  el.textContent = text;
  anchorEl.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

function spawnFloatingMoneyLoss(anchorEl, text) {
  if (!anchorEl) return;
  const el = document.createElement('div');
  el.className = 'floating-money-loss';
  el.textContent = text;
  anchorEl.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

function spawnFloatingMoneyGain(anchorEl, text) {
  if (!anchorEl) return;
  const el = document.createElement('div');
  el.className = 'floating-money-gain';
  el.textContent = text;
  anchorEl.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

function clearFloatingDamage(anchorEl) {
  anchorEl?.querySelectorAll('.floating-damage').forEach((el) => el.remove());
}

function enterDuelSearching() {
  currentDuelId = null;
  $('#duel-searching-firewall').textContent = `${myFirewall}%`;
  showScreen('duel-searching');
}

// Shown after this player has answered a question but the opponent
// hasn't yet — neither the next question nor the battle cinematic can
// arrive until both have answered. onDuelQuestion or onDuelResult takes
// over from here the instant the opponent answers too.
function enterDuelWaitingForOpponent() {
  $('#duel-waiting-firewall').textContent = `${myFirewall}%`;
  showScreen('duel-waiting');
}

// Renders the same compact grid style the host screen uses, from the
// small snapshot the host sends every 5 questions in Outbreak mode.
function renderBoardSnapshot(snapshot) {
  const legendById = Object.fromEntries(snapshot.legend.map((p) => [p.id, p]));

  $('#snapshot-legend').innerHTML = snapshot.legend
    .map(
      (p) => `
        <div class="outbreak-legend-chip">
          <span class="outbreak-legend-swatch" style="background:${p.color}"></span>
          <span>${p.emoji} ${escapeHtml(p.name)}</span>
        </div>
      `
    )
    .join('');

  $('#snapshot-grid').innerHTML = snapshot.cells
    .map((ownerId) => {
      if (!ownerId || !legendById[ownerId]) return `<div class="outbreak-cell"></div>`;
      const owner = legendById[ownerId];
      return `<div class="outbreak-cell claimed" style="background:${owner.color}22;border-color:${owner.color};" title="${escapeHtml(owner.name)}">${owner.emoji}</div>`;
    })
    .join('');
}

// ------------------------------------------------------------
// Asteroid Defense — question batches of 5 feed money, then a 5-second
// shop, then a 10-second wave of the actual mini-game (js/asteroidsGame.js
// runs the physics; this just drives the pacing around it). Loops
// forever, escalating in difficulty, until the host ends the game.
// ------------------------------------------------------------
function initAsteroidsGameInstance() {
  const container = $('#asteroids-arena-container');
  asteroidsGameInstance = createAsteroidsGame(container, {
    onAsteroidDestroyed: (total) => {
      $('#defense-destroyed-count').textContent = total;
    },
    onEarthHit: () => {
      $('#defense-shields-banner').hidden = false;
    },
  });
}

function showNextAsteroidsQuestion() {
  myIndex++;
  if (myIndex >= myQueue.length) {
    // Asteroid waves keep escalating until the host ends the game, so
    // there's no natural "finished the quiz" point like other modes —
    // just reshuffle and keep going.
    myQueue = shuffle(myQueue.map((q) => ({ ...q, options: shuffle(q.options) })));
    myIndex = 0;
  }

  currentQuestion = myQueue[myIndex];
  answered = false;
  questionStartClientTime = performance.now();

  $('#progress-label').textContent = `☄️ Question ${asteroidsQuestionsAnsweredInBatch + 1} of ${ASTEROIDS_QUESTIONS_PER_WAVE}`;
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
    btn.addEventListener('click', () => { btn.classList.add('tapped'); submitAnswer(btn.dataset.optionId); });
  });

  showScreen('question');
  startTimer(currentQuestion.timeLimitSeconds, () => {
    if (!answered) submitAnswer(null);
  });
}

function enterAsteroidsShopPhase() {
  renderAsteroidsShop();
  showScreen('asteroids-shop');

  let remaining = ASTEROIDS_SHOP_SECONDS;
  $('#shop-timer').textContent = remaining;
  clearInterval(shopCountdownInterval);
  shopCountdownInterval = setInterval(() => {
    remaining -= 1;
    $('#shop-timer').textContent = Math.max(0, remaining);
    if (remaining <= 0) {
      clearInterval(shopCountdownInterval);
      enterAsteroidsDefensePhase();
    }
  }, 1000);
}

function weaponDescription(def) {
  if (def.homing) return 'Auto-tracks any asteroid in range — no aiming needed!';
  return `Fires ${(1000 / def.baseFireRateMs).toFixed(1)}/sec — rotate the world to aim`;
}

function renderAsteroidsShop() {
  $('#shop-money').textContent = `$${asteroidsMoney}`;
  $('#shop-wave-label').textContent = `Wave ${asteroidsWave} incoming…`;

  const atMaxWeapons = asteroidsGameInstance.getWeaponCount() >= asteroidsGameInstance.getMaxWeapons();
  const buyList = $('#shop-buy-list');
  buyList.innerHTML = Object.values(WEAPON_TYPES)
    .map(
      (def) => `
        <div class="shop-weapon-card">
          <span class="shop-emoji">${def.emoji}</span>
          <div class="shop-info">
            <span class="shop-name">${escapeHtml(def.name)}</span>
            <span class="shop-desc">${escapeHtml(weaponDescription(def))}</span>
          </div>
          <button type="button" class="shop-buy-btn" data-type="${def.key}" ${asteroidsMoney < def.cost || atMaxWeapons ? 'disabled' : ''}>
            $${def.cost}
          </button>
        </div>
      `
    )
    .join('');
  buyList.querySelectorAll('.shop-buy-btn').forEach((btn) => {
    btn.addEventListener('click', () => buyWeapon(btn.dataset.type));
  });

  const owned = asteroidsGameInstance.getWeapons();
  const ownedList = $('#shop-owned-list');
  ownedList.innerHTML =
    owned.length === 0
      ? '<p class="center-text" style="color:var(--text-faint);font-size:13px;">No weapons yet — buy one above!</p>'
      : owned
          .map(
            (w) => `
        <div class="shop-owned-card">
          <span>${w.emoji}</span>
          <span>${escapeHtml(w.name)} · Lv.${w.level}</span>
          <button type="button" class="shop-upgrade-btn" data-index="${w.index}" ${
              w.upgradeCost === null || asteroidsMoney < w.upgradeCost ? 'disabled' : ''
            }>
            ${w.upgradeCost === null ? 'MAX' : `Upgrade $${w.upgradeCost}`}
          </button>
        </div>
      `
          )
          .join('');
  ownedList.querySelectorAll('.shop-upgrade-btn').forEach((btn) => {
    btn.addEventListener('click', () => upgradeWeapon(parseInt(btn.dataset.index, 10)));
  });
}

function buyWeapon(typeKey) {
  const def = WEAPON_TYPES[typeKey];
  if (!def || asteroidsMoney < def.cost) return;
  if (!asteroidsGameInstance.addWeapon(typeKey)) return;
  asteroidsMoney -= def.cost;
  renderAsteroidsShop();
}

function upgradeWeapon(index) {
  const owned = asteroidsGameInstance.getWeapons();
  const w = owned[index];
  if (!w || w.upgradeCost === null || asteroidsMoney < w.upgradeCost) return;
  if (!asteroidsGameInstance.upgradeWeapon(index)) return;
  asteroidsMoney -= w.upgradeCost;
  renderAsteroidsShop();
}

function enterAsteroidsDefensePhase() {
  $('#defense-wave-label').textContent = `Wave ${asteroidsWave}`;
  $('#defense-destroyed-count').textContent = asteroidsGameInstance.getAsteroidsDestroyed();
  $('#defense-shields-banner').hidden = true;
  showScreen('asteroids-defense');

  asteroidsGameInstance.startWave(asteroidsWave);

  let remaining = ASTEROIDS_DEFENSE_SECONDS;
  $('#defense-timer').textContent = remaining;
  clearInterval(defenseCountdownInterval);
  defenseCountdownInterval = setInterval(() => {
    remaining -= 1;
    $('#defense-timer').textContent = Math.max(0, remaining);
    if (remaining <= 0) {
      clearInterval(defenseCountdownInterval);
      asteroidsGameInstance.stopWave();
      syncAsteroidsProgress();
      asteroidsWave += 1;
      showNextAsteroidsQuestion();
    }
  }, 1000);
}

function syncAsteroidsProgress() {
  channel.send({
    type: 'broadcast',
    event: 'asteroids_sync',
    payload: {
      playerId,
      asteroidsDestroyed: asteroidsGameInstance.getAsteroidsDestroyed(),
      wave: asteroidsGameInstance.getWave(),
    },
  });
}

// ------------------------------------------------------------
// Step 6: final results (host ended the game)
// ------------------------------------------------------------
// ------------------------------------------------------------
// Teacher-set overall game duration — a persistent countdown badge,
// visible across every gameplay screen, independent of game mode.
// ------------------------------------------------------------
function onTimeUpdate(payload) {
  if (gameEnded) return;
  const badge = $('#game-time-badge');
  const mm = String(Math.floor(payload.secondsRemaining / 60)).padStart(2, '0');
  const ss = String(payload.secondsRemaining % 60).padStart(2, '0');
  $('#game-time-remaining').textContent = `${mm}:${ss}`;
  badge.hidden = false;
  badge.classList.toggle('low-time', payload.secondsRemaining <= 30);
}

function onGameOver(payload) {
  gameEnded = true;
  waitingForRoundResult = false;
  pendingRoundResult = null;
  $('#game-time-badge').hidden = true;

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
  clearInterval(shopCountdownInterval);
  clearInterval(defenseCountdownInterval);
  if (asteroidsGameInstance) {
    asteroidsGameInstance.destroy();
    asteroidsGameInstance = null;
  }
  showScreen('final');
  launchConfetti();
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
