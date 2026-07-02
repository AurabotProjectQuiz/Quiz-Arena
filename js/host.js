import { supabase } from './supabaseClient.js';
import { calculateScore, rankPlayers } from './scoring.js';
import { generateJoinCode, escapeHtml, shuffle, $ } from './utils.js';
import { requireRole } from './authGuard.js';
import { BOARD_SIZE, ESCALATORS, EELS } from './boardConfig.js';

// ------------------------------------------------------------
// State
// ------------------------------------------------------------
let quiz = null;
let questions = [];         // full question objects, WITH correct_option_id — never broadcast this array as-is
let questionsById = {};     // id -> question, for validating answers as they come in
let code = null;
let channel = null;

let players = {};           // playerId -> { id, name, emoji, score, answered, ...board fields }

// ------------------------------------------------------------
// Game mode — 'classic' (existing quiz) or 'board' (Eels & Escalators)
// ------------------------------------------------------------
let gameMode = 'classic';

$('#mode-classic').addEventListener('click', () => setGameMode('classic'));
$('#mode-board').addEventListener('click', () => setGameMode('board'));

function setGameMode(mode) {
  gameMode = mode;
  $('#mode-classic').classList.toggle('selected', mode === 'classic');
  $('#mode-board').classList.toggle('selected', mode === 'board');
}

// Eels & Escalators — board-mode-only state
let finishedOrderCounter = 0;
let endgameTimerTimeout = null;
let endgameTimerInterval = null;
let endgameTimerStarted = false;

const screens = ['pick', 'lobby', 'live', 'final'];
function showScreen(name) {
  for (const s of screens) {
    $(`#screen-${s}`).hidden = s !== name;
  }
}

$('#btn-sign-out').addEventListener('click', async () => {
  await supabase.auth.signOut();
  window.location.href = '/index.html';
});

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
      $('#lobby-mode-label').textContent =
        gameMode === 'board' ? '🐍🛗 Eels & Escalators' : '🧠 Classic Quiz';
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
      players[key] = {
        id: key,
        name: meta.name,
        emoji: meta.emoji,
        score: 0,
        answered: 0,
        // Eels & Escalators fields — unused in classic mode
        position: 0,
        roundAnswered: 0,
        roundCorrect: 0,
        finished: false,
        finishOrder: null,
      };
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
    players[id] = {
      id,
      name,
      emoji: DEMO_BOT_EMOJIS[i % DEMO_BOT_EMOJIS.length],
      score: 0,
      answered: 0,
      isDemo: true,
      position: 0,
      roundAnswered: 0,
      roundCorrect: 0,
      finished: false,
      finishOrder: null,
    };
  });
  renderRoster();
}

$('#btn-pretend-host')?.addEventListener('click', () => addDemoPlayers());

function startDemoAnswering() {
  const hasDemoPlayers = Object.values(players).some((p) => p.isDemo);
  if (!hasDemoPlayers) return;

  clearInterval(demoAnswerInterval);
  demoAnswerInterval = setInterval(() => {
    const stillGoing =
      gameMode === 'board'
        ? Object.values(players).filter((p) => p.isDemo && !p.finished)
        : Object.values(players).filter((p) => p.isDemo && p.answered < questions.length);
    if (stillGoing.length === 0) {
      clearInterval(demoAnswerInterval);
      return;
    }
    const bot = stillGoing[Math.floor(Math.random() * stillGoing.length)];
    // Board mode draws a random question each turn (rounds repeat the bank);
    // classic mode still answers in original quiz order.
    const q = gameMode === 'board' ? questions[Math.floor(Math.random() * questions.length)] : questions[bot.answered];
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
  if (gameMode === 'board') return startBoardGame();

  // Send every player the full question set (no correct answers) in one
  // message. Each player shuffles it into their own order client-side and
  // works through it independently — this is the one broadcast that
  // replaces the old "one question at a time" loop.
  const sanitized = questions.map((q) => ({
    id: q.id,
    text: q.question_text,
    options: q.options,
    timeLimitSeconds: q.time_limit_seconds,
  }));

  $('#live-heading').textContent = 'Live standings';
  $('#leaderboard').hidden = false;
  $('#board-view').hidden = true;

  channel.send({ type: 'broadcast', event: 'game_start', payload: { mode: 'classic', questions: sanitized } });

  $('#total-count').textContent = Object.keys(players).length;
  $('#finished-count').textContent = '0';
  renderLeaderboard(rankPlayers(Object.values(players)), '#leaderboard');
  showScreen('live');

  startDemoAnswering(); // demo hook — delete this line to remove pretend-host mode
}

// ------------------------------------------------------------
// Eels & Escalators — game start
// ------------------------------------------------------------
function startBoardGame() {
  finishedOrderCounter = 0;
  endgameTimerStarted = false;
  clearTimeout(endgameTimerTimeout);
  clearInterval(endgameTimerInterval);
  $('#board-timer-banner').hidden = true;

  for (const p of Object.values(players)) {
    p.position = 0;
    p.roundAnswered = 0;
    p.roundCorrect = 0;
    p.finished = false;
    p.finishOrder = null;
  }

  const sanitized = questions.map((q) => ({
    id: q.id,
    text: q.question_text,
    options: q.options,
    timeLimitSeconds: q.time_limit_seconds,
  }));

  $('#live-heading').textContent = '🐍🛗 Eels & Escalators';
  $('#leaderboard').hidden = true;
  $('#board-view').hidden = false;

  channel.send({ type: 'broadcast', event: 'game_start', payload: { mode: 'board', questions: sanitized } });

  updateBoardProgress();
  renderBoard();
  showScreen('live');

  startDemoAnswering(); // demo hook — delete this line to remove pretend-host mode
}

// ------------------------------------------------------------
// Step 3: live scoring — answers arrive asynchronously, any player,
// any question, any time. Host validates + scores + relays the result
// back (filtered client-side by playerId) plus the refreshed leaderboard.
// ------------------------------------------------------------
function handleAnswer(payload) {
  if (gameMode === 'board') return handleBoardAnswer(payload);

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

// ------------------------------------------------------------
// Eels & Escalators — answers arrive the same way as classic mode,
// but 6 of them make up a "round": correct answers = squares moved,
// then any escalator/eel at the landing square is applied.
// ------------------------------------------------------------
const QUESTIONS_PER_ROUND = 6;

function handleBoardAnswer(payload) {
  const { playerId, questionId, optionId } = payload;
  const player = players[playerId];
  const question = questionsById[questionId];
  if (!player || !question || player.finished) return;

  const isCorrect = optionId != null && optionId === question.correct_option_id;
  player.roundAnswered += 1;
  if (isCorrect) player.roundCorrect += 1;

  channel.send({
    type: 'broadcast',
    event: 'answer_result',
    payload: { playerId, questionId, correct: isCorrect },
  });

  if (player.roundAnswered >= QUESTIONS_PER_ROUND) {
    resolveRoundForPlayer(player);
  }
}

function resolveRoundForPlayer(player) {
  const moved = player.roundCorrect;
  const from = player.position;
  const beforeSnap = Math.min(BOARD_SIZE, from + moved);

  let landedOn = beforeSnap;
  let snapType = null;
  if (beforeSnap < BOARD_SIZE) {
    if (ESCALATORS[beforeSnap] != null) {
      landedOn = ESCALATORS[beforeSnap];
      snapType = 'escalator';
    } else if (EELS[beforeSnap] != null) {
      landedOn = EELS[beforeSnap];
      snapType = 'eel';
    }
  }

  player.position = landedOn;
  player.roundAnswered = 0;
  player.roundCorrect = 0;

  const finishedNow = landedOn >= BOARD_SIZE && !player.finished;
  if (finishedNow) {
    player.finished = true;
    finishedOrderCounter += 1;
    player.finishOrder = finishedOrderCounter;
  }

  channel.send({
    type: 'broadcast',
    event: 'round_result',
    payload: {
      playerId: player.id,
      correct: moved,
      from,
      to: beforeSnap,
      landedOn,
      snapType,
      finished: player.finished,
      finishOrder: player.finishOrder,
    },
  });

  renderBoard();
  updateBoardProgress();

  const allPlayers = Object.values(players);
  if (allPlayers.length > 0 && allPlayers.every((p) => p.finished)) {
    endGame();
    return;
  }
  if (finishedNow) checkBoardEndgame();
}

// End-game timer rules:
// - >2 players: once the 3rd player finishes, start a 60s timer, then end.
// - exactly 2 players: once the 1st player finishes, start a 60s timer, then end.
// - 1 player: ends as soon as they finish.
function checkBoardEndgame() {
  const list = Object.values(players);
  const total = list.length;
  const finishedCount = list.filter((p) => p.finished).length;

  if (total <= 1) {
    if (finishedCount >= 1) endGame();
    return;
  }
  if (endgameTimerStarted) return;

  if (total === 2 && finishedCount >= 1) {
    startEndgameTimer();
  } else if (total > 2 && finishedCount >= 3) {
    startEndgameTimer();
  }
}

function startEndgameTimer() {
  endgameTimerStarted = true;
  const banner = $('#board-timer-banner');
  const countEl = $('#board-timer-count');
  banner.hidden = false;

  let remaining = 60;
  countEl.textContent = remaining;
  clearInterval(endgameTimerInterval);
  endgameTimerInterval = setInterval(() => {
    remaining -= 1;
    countEl.textContent = Math.max(0, remaining);
  }, 1000);

  clearTimeout(endgameTimerTimeout);
  endgameTimerTimeout = setTimeout(() => {
    clearInterval(endgameTimerInterval);
    endGame();
  }, 60000);
}

function updateBoardProgress() {
  const list = Object.values(players);
  $('#finished-count').textContent = list.filter((p) => p.finished).length;
  $('#total-count').textContent = list.length;
}

// ------------------------------------------------------------
// Eels & Escalators — board rendering
// ------------------------------------------------------------
function boardRowsTopToBottom() {
  // 10 rows of 10, serpentine numbering matching the board art:
  // bottom row is 1→10 (ascending), each row above alternates direction.
  const rows = [];
  for (let visualRow = 0; visualRow < 10; visualRow++) {
    const rowFromBottom = 9 - visualRow;
    const base = rowFromBottom * 10;
    const ascending = rowFromBottom % 2 === 0;
    const nums = Array.from({ length: 10 }, (_, i) => (ascending ? base + i + 1 : base + 10 - i));
    rows.push(nums);
  }
  return rows;
}

function renderBoard() {
  const grid = $('#board-grid');
  const list = Object.values(players);

  const tokensBySquare = {};
  for (const p of list) {
    if (p.position === 0) continue;
    (tokensBySquare[p.position] ||= []).push(p);
  }

  grid.innerHTML = boardRowsTopToBottom()
    .map((row) =>
      row
        .map((num) => {
          let cls = 'board-cell';
          let feature = '';
          if (ESCALATORS[num] != null) {
            cls += ' cell-escalator';
            feature = '⬆️';
          } else if (EELS[num] != null) {
            cls += ' cell-eel';
            feature = '🐍';
          }
          const tokens = (tokensBySquare[num] || [])
            .map((p) => `<span class="board-token" title="${escapeHtml(p.name)}">${p.emoji}</span>`)
            .join('');
          return `<div class="${cls}"><span class="cell-num">${num}</span><span class="cell-feature">${feature}</span><div class="cell-tokens">${tokens}</div></div>`;
        })
        .join('')
    )
    .join('');

  const startPlayers = list.filter((p) => p.position === 0);
  const startTokens = startPlayers
    .map((p) => `<span class="board-token" title="${escapeHtml(p.name)}">${p.emoji}</span>`)
    .join('');
  $('#board-start-row').innerHTML = `<span class="start-label">START ⭐</span>${startTokens}`;
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
  clearTimeout(endgameTimerTimeout);
  clearInterval(endgameTimerInterval);
  $('#board-timer-banner').hidden = true;

  const leaderboard = gameMode === 'board' ? rankBoardPlayers(Object.values(players)) : rankPlayers(Object.values(players));
  channel.send({ type: 'broadcast', event: 'game_over', payload: { leaderboard } });
  renderPodium(leaderboard, '#podium');
  renderLeaderboard(leaderboard, '#final-leaderboard');
  showScreen('final');
}

// Board-mode ranking: finished players first (earliest finisher wins),
// then unfinished players ordered by how far along the board they got.
// `score` here is repurposed as "square reached" so the existing
// leaderboard/podium renderers work unchanged.
function rankBoardPlayers(list) {
  const sorted = [...list].sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.finished && b.finished) return a.finishOrder - b.finishOrder;
    return b.position - a.position;
  });
  let place = 0;
  let lastKey = null;
  return sorted.map((p, i) => {
    const key = p.finished ? `f${p.finishOrder}` : `p${p.position}`;
    if (key !== lastKey) {
      place = i + 1;
      lastKey = key;
    }
    return { id: p.id, name: p.name, emoji: p.emoji, score: p.position, place };
  });
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
      let suffix;
      let barFraction;
      if (gameMode === 'board') {
        const finished = players[p.id]?.finished;
        suffix = finished ? `finished 🏁 #${players[p.id].finishOrder}` : `square ${p.score}/${BOARD_SIZE}`;
        barFraction = p.score / BOARD_SIZE;
      } else {
        const answered = players[p.id]?.answered ?? 0;
        suffix = `${answered}/${total}`;
        barFraction = p.score / maxScore;
      }
      return `
      <div class="leaderboard-row rank-${p.place}">
        <span class="place">${p.place}</span>
        <span class="emoji">${p.emoji}</span>
        <span class="name">${escapeHtml(p.name)} <span style="color:var(--text-faint);font-size:12px;">${suffix}</span></span>
        <span class="score">${p.score}</span>
        <div class="bar"><div class="bar-fill" style="width:${barFraction * 100}%"></div></div>
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
(async () => {
  const auth = await requireRole(['teacher', 'admin']);
  if (!auth) return;
  loadQuizzes();
})();
