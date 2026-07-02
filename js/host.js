import { supabase } from './supabaseClient.js';
import { calculateScore, rankPlayers } from './scoring.js';
import { generateJoinCode, escapeHtml, shuffle, $ } from './utils.js';

// ------------------------------------------------------------
// State
// ------------------------------------------------------------
let quiz = null;
let questions = [];         // full question objects, WITH correct_option_id — never broadcast this array as-is
let questionsById = {};     // id -> question, for validating answers as they come in
let code = null;
let channel = null;

let players = {};           // playerId -> { id, name, emoji, score, answered }

const screens = ['pick', 'lobby', 'live', 'final'];
function showScreen(name) {
  for (const s of screens) {
    $(`#screen-${s}`).hidden = s !== name;
  }
}

// ------------------------------------------------------------
// Step 1: pick a quiz
// ------------------------------------------------------------
async function loadQuizzes() {
  const listEl = $('#quiz-list');
  const { data, error } = await supabase
    .from('quizzes')
    .select('id, title, topic')
    .order('created_at', { ascending: false });

  if (error) {
    listEl.innerHTML = `<p class="error-text">Couldn't load quizzes: ${escapeHtml(error.message)}</p>`;
    return;
  }
  if (!data || data.length === 0) {
    listEl.innerHTML = `<p class="error-text">No quizzes saved yet. Add one in Supabase first.</p>`;
    return;
  }

  listEl.innerHTML = '';
  for (const q of data) {
    const btn = document.createElement('button');
    btn.className = 'quiz-pick';
    btn.innerHTML = `<span class="title">${escapeHtml(q.title)}</span><span class="topic">${escapeHtml(q.topic)}</span>`;
    btn.addEventListener('click', () => selectQuiz(q));
    listEl.appendChild(btn);
  }
}

async function selectQuiz(selected) {
  const listEl = $('#quiz-list');
  listEl.innerHTML = '<p class="center-text">Loading questions…</p>';

  const { data, error } = await supabase
    .from('questions')
    .select('id, question_text, options, correct_option_id, time_limit_seconds, order_index')
    .eq('quiz_id', selected.id)
    .order('order_index', { ascending: true });

  if (error) {
    console.error('Failed to load questions:', error);
    listEl.innerHTML = `<p class="error-text">Couldn't load questions: ${escapeHtml(error.message)}</p>`;
    return;
  }
  if (!data || data.length === 0) {
    listEl.innerHTML = `<p class="error-text">This quiz has no questions yet — add some in Supabase first.</p>`;
    return;
  }

  quiz = selected;
  questions = data;
  questionsById = Object.fromEntries(data.map((q) => [q.id, q]));

  listEl.innerHTML = '<p class="center-text">Connecting…</p>';
  await createGameSession();
}

// ------------------------------------------------------------
// Step 2: lobby — create a Realtime room, wait for players
// ------------------------------------------------------------
async function createGameSession() {
  code = generateJoinCode();
  players = {};

  channel = supabase.channel(`quiz-${code}`, {
    config: { presence: { key: 'host' } },
  });

  channel.on('presence', { event: 'sync' }, syncPlayersFromPresence);
  channel.on('broadcast', { event: 'answer' }, ({ payload }) => handleAnswer(payload));

  channel.subscribe(async (status, err) => {
    console.log('Realtime channel status:', status, err ?? '');
    if (status === 'SUBSCRIBED') {
      await channel.track({ role: 'host' });
      $('#join-code-display').textContent = code;
      $('#lobby-quiz-title').textContent = `${quiz.title} · ${quiz.topic}`;
      showScreen('lobby');
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      const listEl = $('#quiz-list');
      listEl.innerHTML = `<p class="error-text">Couldn't connect (${status}). Check the browser console for details — this usually means Realtime isn't reachable for your Supabase project yet.</p>`;
    }
  });
}

function syncPlayersFromPresence() {
  const state = channel.presenceState();
  for (const key in state) {
    if (key === 'host') continue;
    if (!players[key]) {
      const meta = state[key][0];
      players[key] = { id: key, name: meta.name, emoji: meta.emoji, score: 0, answered: 0 };
    }
  }
  renderRoster();
}

function renderRoster() {
  const roster = $('#player-roster');
  const list = Object.values(players);
  $('#player-count').textContent = list.length;
  roster.innerHTML = list
    .map((p) => `<div class="player-chip"><span class="emoji">${p.emoji}</span>${escapeHtml(p.name)}</div>`)
    .join('');
  $('#btn-start-game').disabled = list.length === 0;
}

// ============================================================
// PRETEND HOST — DEMO MODE
// Lets you preview the full host experience (lobby → start → live
// scoring → end game) without needing real devices. Adds fake players
// to the lobby, then auto-simulates their answers once the game starts.
// To remove this feature later: delete this whole block, delete the two
// one-line hook calls marked "demo hook" inside startGame() and
// endGame() below, and delete the "PRETEND HOST DEMO" button in
// host.html.
// ============================================================
const DEMO_BOT_NAMES = ['Nova 🤖', 'Blaze 🤖', 'Pixel 🤖', 'Comet 🤖', 'Juno 🤖', 'Rex 🤖', 'Lumi 🤖', 'Zephyr 🤖'];
const DEMO_BOT_EMOJIS = ['🦊', '🐸', '🐼', '🦁', '🐯', '🐨', '🦄', '🐢'];
let demoAnswerInterval = null;

function addDemoPlayers(count = 6) {
  const names = shuffle(DEMO_BOT_NAMES).slice(0, count);
  names.forEach((name, i) => {
    const id = `demo-${Date.now()}-${i}`;
    players[id] = { id, name, emoji: DEMO_BOT_EMOJIS[i % DEMO_BOT_EMOJIS.length], score: 0, answered: 0, isDemo: true };
  });
  renderRoster();
}

$('#btn-pretend-host')?.addEventListener('click', () => addDemoPlayers());

function startDemoAnswering() {
  const hasDemoPlayers = Object.values(players).some((p) => p.isDemo);
  if (!hasDemoPlayers) return;

  clearInterval(demoAnswerInterval);
  demoAnswerInterval = setInterval(() => {
    const stillGoing = Object.values(players).filter((p) => p.isDemo && p.answered < questions.length);
    if (stillGoing.length === 0) {
      clearInterval(demoAnswerInterval);
      return;
    }
    const bot = stillGoing[Math.floor(Math.random() * stillGoing.length)];
    const q = questions[bot.answered]; // bots just answer in original quiz order
    const willBeCorrect = Math.random() < 0.7; // 70% correct, to look realistic
    const wrongOption = q.options.find((o) => o.id !== q.correct_option_id);
    const optionId = willBeCorrect ? q.correct_option_id : (wrongOption ? wrongOption.id : null);
    const timeTakenMs = Math.random() * q.time_limit_seconds * 1000;
    handleAnswer({ playerId: bot.id, questionId: q.id, optionId, timeTakenMs });
  }, 900 + Math.random() * 1200);
}

function stopDemoAnswering() {
  clearInterval(demoAnswerInterval);
  demoAnswerInterval = null;
}
// ============================================================
// END PRETEND HOST DEMO MODE
// ============================================================

$('#btn-start-game').addEventListener('click', startGame);

function startGame() {
  const sanitized = questions.map((q) => ({
    id: q.id,
    text: q.question_text,
    options: q.options,
    timeLimitSeconds: q.time_limit_seconds,
  }));

  channel.send({ type: 'broadcast', event: 'game_start', payload: { questions: sanitized } });

  $('#total-count').textContent = Object.keys(players).length;
  $('#finished-count').textContent = '0';
  renderLeaderboard(rankPlayers(Object.values(players)), '#leaderboard');
  showScreen('live');

  startDemoAnswering(); // demo hook — delete this line to remove pretend-host mode
}

// ------------------------------------------------------------
// Step 3: live scoring
// ------------------------------------------------------------
function handleAnswer(payload) {
  const { playerId, questionId, optionId, timeTakenMs } = payload;
  const player = players[playerId];
  const question = questionsById[questionId];
  if (!player || !question) return;

  const isCorrect = optionId != null && optionId === question.correct_option_id;
  const points = calculateScore(isCorrect, timeTakenMs, question.time_limit_seconds);

  player.score += points;
  player.answered += 1;

  const leaderboard = rankPlayers(Object.values(players));

  channel.send({
    type: 'broadcast',
    event: 'answer_result',
    payload: {
      playerId,
      questionId,
      correct: isCorrect,
      points,
      totalScore: player.score,
      leaderboard,
    },
  });

  renderLeaderboard(leaderboard, '#leaderboard');
  updateFinishedCount();
}

function updateFinishedCount() {
  const total = questions.length;
  const finished = Object.values(players).filter((p) => p.answered >= total).length;
  $('#finished-count').textContent = finished;
  $('#total-count').textContent = Object.keys(players).length;
}

$('#btn-end-game').addEventListener('click', endGame);

// ------------------------------------------------------------
// Step 4: final results
// ------------------------------------------------------------
function endGame() {
  stopDemoAnswering(); // demo hook — delete this line to remove pretend-host mode
  const leaderboard = rankPlayers(Object.values(players));
  channel.send({ type: 'broadcast', event: 'game_over', payload: { leaderboard } });
  renderPodium(leaderboard, '#podium');
  renderLeaderboard(leaderboard, '#final-leaderboard');
  showScreen('final');
}

// ------------------------------------------------------------
// Shared render helpers
// ------------------------------------------------------------
function renderLeaderboard(leaderboard, targetSelector) {
  const el = $(targetSelector);
  const maxScore = Math.max(1, ...leaderboard.map((p) => p.score));
  const total = questions.length || 1;
  el.innerHTML = leaderboard
    .map((p) => {
      const answered = players[p.id]?.answered ?? 0;
      return `
      <div class="leaderboard-row rank-${p.place}">
        <span class="place">${p.place}</span>
        <span class="emoji">${p.emoji}</span>
        <span class="name">${escapeHtml(p.name)} <span style="color:var(--text-faint);font-size:12px;">${answered}/${total}</span></span>
        <span class="score">${p.score}</span>
        <div class="bar"><div class="bar-fill" style="width:${(p.score / maxScore) * 100}%"></div></div>
      </div>
    `;
    })
    .join('');
}

function renderPodium(leaderboard, targetSelector) {
  const el = $(targetSelector);
  const top3 = leaderboard.slice(0, 3);
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
}

// ------------------------------------------------------------
// Init
// ------------------------------------------------------------
loadQuizzes();
