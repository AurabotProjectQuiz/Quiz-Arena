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

let myQueue = [];            // this player's own shuffled question order
let myIndex = -1;
let currentQuestion = null;
let answered = false;
let questionStartClientTime = 0;
let myScore = 0;
let timerInterval = null;
let advanceTimeout = null;

const OPTION_CLASSES = ['opt-a', 'opt-b', 'opt-c', 'opt-d'];
const CIRCUMFERENCE = 2 * Math.PI * 34;

const screens = ['join', 'waiting', 'question', 'reveal', 'done', 'final'];
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
  myQueue = shuffle(payload.questions);
  myIndex = -1;
  myScore = 0;
  showNextQuestion();
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
  channel.send({
    type: 'broadcast',
    event: 'answer',
    payload: { playerId, questionId: currentQuestion.id, optionId, timeTakenMs },
  });

  // Fallback: if the host doesn't respond in time (e.g. connection hiccup),
  // move on anyway so a stuck message never strands the player.
  advanceTimeout = setTimeout(() => showNextQuestion(), 4000);
}

// ------------------------------------------------------------
// Step 4: instant per-question feedback from the host, then
// auto-advance to this player's next question.
// ------------------------------------------------------------
function onAnswerResult(payload) {
  if (payload.playerId !== playerId) return; // not this player's answer
  if (!currentQuestion || payload.questionId !== currentQuestion.id) return; // stale

  clearTimeout(advanceTimeout);
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
// Step 6: final results (host ended the game)
// ------------------------------------------------------------
function onGameOver(payload) {
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
