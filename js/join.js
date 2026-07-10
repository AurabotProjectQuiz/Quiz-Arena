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
let duelResultCounter = 0; // every 3rd result gets the big full-screen cinematic
const DUEL_CINEMATIC_EVERY = 3;

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

const screens = ['join', 'waiting', 'rules', 'question', 'reveal', 'round-result', 'duel-battle', 'duel-searching', 'board-update', 'asteroids-shop', 'asteroids-defense', 'done', 'final'];
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
      "You'll be matched against another player for a quick 1-on-1.",
      'Answer correctly and fast to damage their firewall.',
      "Break their firewall to win the round — then you'll get a new opponent!",
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
    duelResultCounter = 0;
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

  currentDuelId = payload.duelId;
  const opponentId = Object.keys(payload.players).find((id) => id !== playerId);
  const opponent = payload.players[opponentId];
  const me = payload.players[playerId];
  myFirewall = me.firewall;
  currentDuelOpponentEmoji = opponent.emoji;
  currentDuelOpponentName = opponent.name;

  $('#duel-my-avatar').innerHTML = renderForcefieldAvatar(playerEmoji, myFirewall, 64);
  $('#duel-opponent-avatar').innerHTML = renderForcefieldAvatar(opponent.emoji, opponent.firewall, 64);
  $('#duel-opponent-name').textContent = opponent.name;
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
    btn.addEventListener('click', () => { btn.classList.add('tapped'); submitAnswer(btn.dataset.optionId); });
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
  const opponentId = Object.keys(payload.results).find((id) => id !== playerId);
  const theirs = opponentId ? payload.results[opponentId] : null;

  clearTimeout(advanceTimeout);
  myFirewall = mine.firewall;
  duelResultCounter += 1;

  if (duelResultCounter % DUEL_CINEMATIC_EVERY === 0) {
    showDuelBattleCinematic(mine, theirs);
    return;
  }

  const banner = $('#reveal-banner');
  let outcome = null; // true = positive flash, false = negative flash, null = no flash (a wash)
  if (mine.opponentBroken) {
    banner.textContent = 'Firewall breached! You win this one 🏆';
    banner.className = 'reveal-banner correct';
    outcome = true;
  } else if (mine.broken) {
    banner.textContent = 'Your firewall was breached! 😵';
    banner.className = 'reveal-banner incorrect';
    outcome = false;
  } else if (mine.yourDamageDealt > 0) {
    banner.textContent = `Direct hit — ${mine.yourDamageDealt} damage! ⚡`;
    banner.className = 'reveal-banner correct';
    outcome = true;
  } else if (mine.damageTaken > 0) {
    banner.textContent = `Took ${mine.damageTaken} damage! 🛡️`;
    banner.className = 'reveal-banner incorrect';
    outcome = false;
  } else {
    banner.textContent = 'Both firewalls held ⚡';
    banner.className = 'reveal-banner';
  }
  $('#points-earned').textContent = mine.broken ? 'Firewall rebooted to 100%' : `Firewall: ${mine.firewall}%`;

  $('#score-label').textContent = 'Your firewall';
  $('#my-total-score').textContent = `${myFirewall}%`;

  // Force-field avatars + a zap flash the instant the attack lands, so
  // the result reads as an actual hit rather than just changed numbers.
  $('#duel-reveal-avatars').hidden = false;
  $('#duel-reveal-my-avatar').innerHTML = renderForcefieldAvatar(playerEmoji, mine.firewall, 64);
  $('#duel-reveal-opp-avatar').innerHTML = renderForcefieldAvatar(currentDuelOpponentEmoji, theirs ? theirs.firewall : 100, 64);
  $('#duel-reveal-opp-name').textContent = currentDuelOpponentName;

  const zapBolt = $('#zap-bolt');
  zapBolt.classList.remove('zap-active');
  void zapBolt.offsetWidth; // force reflow so the animation replays every time
  const myAvatarEl = $('#duel-reveal-my-avatar').querySelector('.forcefield-avatar');
  const oppAvatarEl = $('#duel-reveal-opp-avatar').querySelector('.forcefield-avatar');
  myAvatarEl?.classList.remove('hit-shake');
  oppAvatarEl?.classList.remove('hit-shake');
  if (mine.damageTaken > 0 || mine.yourDamageDealt > 0) {
    zapBolt.classList.add('zap-active');
    void myAvatarEl?.offsetWidth;
    if (mine.damageTaken > 0) myAvatarEl?.classList.add('hit-shake');
    if (mine.yourDamageDealt > 0) oppAvatarEl?.classList.add('hit-shake');
  }

  if (outcome !== null) flashRevealScreen(outcome);
  showScreen('reveal');
  setTimeout(() => {
    if (gameEnded) return;
    enterDuelSearching();
  }, 1800);
}

// The big, dramatic version — shown every 3rd duel result instead of the
// quick inline reveal, so the full-screen spectacle doesn't get old from
// showing up after every single ~8-second exchange.
function showDuelBattleCinematic(mine, theirs) {
  const oppFirewall = theirs ? theirs.firewall : 100;
  $('#duel-battle-my-avatar').innerHTML = renderForcefieldAvatar(playerEmoji, mine.firewall, 120);
  $('#duel-battle-opp-avatar').innerHTML = renderForcefieldAvatar(currentDuelOpponentEmoji, oppFirewall, 120);
  $('#duel-battle-opp-name').textContent = currentDuelOpponentName;

  const banner = $('#duel-battle-banner');
  if (mine.opponentBroken) {
    banner.textContent = 'Firewall breached! You win this one 🏆';
    banner.className = 'duel-battle-banner correct';
  } else if (mine.broken) {
    banner.textContent = 'Your firewall was breached! 😵';
    banner.className = 'duel-battle-banner incorrect';
  } else if (mine.yourDamageDealt > 0) {
    banner.textContent = `Direct hit — ${mine.yourDamageDealt} damage!`;
    banner.className = 'duel-battle-banner correct';
  } else if (mine.damageTaken > 0) {
    banner.textContent = `Took ${mine.damageTaken} damage!`;
    banner.className = 'duel-battle-banner incorrect';
  } else {
    banner.textContent = 'Both firewalls held ⚡';
    banner.className = 'duel-battle-banner';
  }

  // Zap travels from whoever landed the hit toward whoever took it — "my"
  // avatar sits on the left of the stage, opponent on the right.
  const zapBolt = $('#duel-battle-zap');
  zapBolt.classList.remove('zap-fire-right', 'zap-fire-left');
  void zapBolt.offsetWidth; // force reflow so the animation replays every time

  const myAvatarEl = $('#duel-battle-my-avatar').querySelector('.forcefield-avatar');
  const oppAvatarEl = $('#duel-battle-opp-avatar').querySelector('.forcefield-avatar');
  myAvatarEl?.classList.remove('hit-shake');
  oppAvatarEl?.classList.remove('hit-shake');
  clearFloatingDamage(myAvatarEl);
  clearFloatingDamage(oppAvatarEl);

  if (mine.yourDamageDealt > 0) {
    zapBolt.classList.add('zap-fire-right');
    void oppAvatarEl?.offsetWidth;
    oppAvatarEl?.classList.add('hit-shake');
    spawnFloatingDamage(oppAvatarEl, `-${mine.yourDamageDealt}`, 'damage');
  } else if (mine.damageTaken > 0) {
    zapBolt.classList.add('zap-fire-left');
    void myAvatarEl?.offsetWidth;
    myAvatarEl?.classList.add('hit-shake');
    spawnFloatingDamage(myAvatarEl, `-${mine.damageTaken}`, 'damage');
  }

  showScreen('duel-battle');
  setTimeout(() => {
    if (gameEnded) return;
    enterDuelSearching();
  }, 2800);
}

function spawnFloatingDamage(anchorEl, text, kind) {
  if (!anchorEl) return;
  const el = document.createElement('div');
  el.className = `floating-damage ${kind}`;
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
