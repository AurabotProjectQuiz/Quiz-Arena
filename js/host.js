import { supabase } from './supabaseClient.js';
import { calculateScore, rankPlayers, calculateDuelDamage, calculateSpeedFraction, calculateMoney, OUTBREAK_CHAIN_BONUS } from './scoring.js';
import { generateJoinCode, escapeHtml, shuffle, launchConfetti, enableConsistentEmoji, $ } from './utils.js';
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
// Game mode — 'classic' (existing quiz), 'board' (Eels & Escalators),
// 'duel' (Firewall Duel), 'outbreak' (Antivirus Grid), or 'asteroids'
// (Asteroid Defense)
// ------------------------------------------------------------
let gameMode = 'classic';

$('#mode-classic').addEventListener('click', () => setGameMode('classic'));
$('#mode-board').addEventListener('click', () => setGameMode('board'));
$('#mode-duel').addEventListener('click', () => setGameMode('duel'));
$('#mode-outbreak').addEventListener('click', () => setGameMode('outbreak'));
$('#mode-asteroids').addEventListener('click', () => setGameMode('asteroids'));

function setGameMode(mode) {
  gameMode = mode;
  $('#mode-classic').classList.toggle('selected', mode === 'classic');
  $('#mode-board').classList.toggle('selected', mode === 'board');
  $('#mode-duel').classList.toggle('selected', mode === 'duel');
  $('#mode-outbreak').classList.toggle('selected', mode === 'outbreak');
  $('#mode-asteroids').classList.toggle('selected', mode === 'asteroids');
}

// Eels & Escalators — board-mode-only state
let finishedOrderCounter = 0;
let endgameTimerTimeout = null;
let endgameTimerInterval = null;
let endgameTimerStarted = false;

// Firewall Duel — duel-mode-only state
let duelQueue = [];      // playerIds waiting to be matched
let activeDuels = {};    // duelId -> { players: [idA, idB], question, answers: {}, resolved, timerHandle }
let duelCounter = 0;
// Duels are meant to feel like a fast reflex showdown, not a full-length
// quiz question — cap the timer regardless of what the quiz itself has
// each question set to, so matches resolve (and requeue) quickly.
const DUEL_TIME_LIMIT_SECONDS = 8;

// Outbreak: Antivirus Grid — outbreak-mode-only state
const OUTBREAK_GRID_SIZE = 8; // 8x8 = 64 nodes
let outbreakGrid = [];        // flat array of { ownerId: string|null, claimSpeedFraction: number }
const OUTBREAK_COLORS = ['#7c5cfc', '#c8ff4d', '#ff6f59', '#4dd8ff', '#ffd166', '#ff5c7a', '#38bdf8', '#f472b6'];

// Asteroid Defense — asteroids-mode-only state. The actual mini-game
// (rotating world, weapons, asteroid physics) runs entirely on each
// student's own device (js/asteroidsGame.js, driven by join.js) — the
// host only runs the normal quiz-answering pipeline (money instead of
// points) and receives small periodic sync messages so its leaderboard
// can show wave/asteroids-destroyed progress.


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
  channel.on('broadcast', { event: 'asteroids_sync' }, ({ payload }) => handleAsteroidsSync(payload));

  channel.subscribe(async (status, err) => {
    console.log('Realtime channel status:', status, err ?? '');
    if (status === 'SUBSCRIBED') {
      await channel.track({ role: 'host' });
      $('#join-code-display').textContent = code;
      $('#lobby-quiz-title').textContent = `${quiz.title} · ${quiz.topic}`;
      $('#lobby-mode-label').textContent =
        gameMode === 'board' ? '🐍🛗 Eels & Escalators'
        : gameMode === 'duel' ? '🔥 Firewall Duel'
        : gameMode === 'outbreak' ? '🦠 Outbreak: Antivirus Grid'
        : gameMode === 'asteroids' ? '☄️ Asteroid Defense'
        : '🧠 Classic Quiz';
      renderJoinQrCode(code);
      showScreen('lobby');
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      const listEl = $('#quiz-list');
      listEl.innerHTML = `<p class="error-text">Couldn't connect (${status}). Check the browser console for details — this usually means Realtime isn't reachable for your Supabase project yet.</p>`;
    }
  });
}

// Encodes a direct join link (not just the bare code) so scanning the QR
// skips straight to the name/emoji screen with the code pre-filled —
// see js/join.js reading ?code= on load. Uses a public QR-image service
// via a plain <img> tag rather than a client-side rendering library —
// simpler and more robust (nothing to silently fail to draw).
function renderJoinQrCode(joinCode) {
  const img = $('#join-qr-img');
  const joinUrl = `${window.location.origin}/join.html?code=${joinCode}`;
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(joinUrl)}`;

  img.onerror = () => {
    console.error('QR code image failed to load — falling back to code-only join.');
    $('#qr-card').hidden = true;
  };
  img.onload = () => {
    $('#qr-card').hidden = false;
  };
  img.src = qrImageUrl;
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
        // Eels & Escalators fields — unused in classic/duel modes
        position: 0,
        roundAnswered: 0,
        roundCorrect: 0,
        finished: false,
        finishOrder: null,
        // Firewall Duel fields — unused in classic/board modes
        firewall: 100,
        wins: 0,
        breachesDealt: 0,
        duelOpponentId: null,
        // Outbreak fields — unused in classic/board/duel modes
        nodesOwned: 0,
        outbreakColor: null,
        // Asteroid Defense fields — unused in every other mode
        asteroidsDestroyed: 0,
        wave: 1,
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
      firewall: 100,
      wins: 0,
      breachesDealt: 0,
      duelOpponentId: null,
      nodesOwned: 0,
      outbreakColor: null,
      asteroidsDestroyed: 0,
      wave: 1,
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
    if (gameMode === 'duel') {
      // Bots can only "answer" while they're actually paired in a live
      // duel and haven't submitted yet — matchmaking handles the rest.
      const waitingBots = Object.values(activeDuels)
        .filter((d) => !d.resolved)
        .flatMap((d) => d.players.map((pid) => ({ pid, duel: d })))
        .filter(({ pid, duel }) => players[pid]?.isDemo && !duel.answers[pid]);
      if (waitingBots.length === 0) return;
      const { pid, duel } = waitingBots[Math.floor(Math.random() * waitingBots.length)];
      const willBeCorrect = Math.random() < 0.7;
      const wrongOption = duel.question.options.find((o) => o.id !== duel.question.correct_option_id);
      const optionId = willBeCorrect ? duel.question.correct_option_id : (wrongOption ? wrongOption.id : null);
      const timeTakenMs = Math.random() * duel.timeLimitSeconds * 1000;
      handleAnswer({ playerId: pid, duelId: duel.id, questionId: duel.question.id, optionId, timeTakenMs });
      return;
    }

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
  if (gameMode === 'duel') return startDuelGame();
  if (gameMode === 'outbreak') return startOutbreakGame();
  if (gameMode === 'asteroids') return startAsteroidsGame();

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
  $('#duel-view').hidden = true;
  $('#outbreak-view').hidden = true;

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
  $('#duel-view').hidden = true;
  $('#outbreak-view').hidden = true;

  channel.send({ type: 'broadcast', event: 'game_start', payload: { mode: 'board', questions: sanitized } });

  updateBoardProgress();
  renderBoard();
  showScreen('live');

  startDemoAnswering(); // demo hook — delete this line to remove pretend-host mode
}

// ------------------------------------------------------------
// Firewall Duel — game start: reset every player's firewall/wins,
// queue everyone up, and let matchmaking pair the first duels.
// ------------------------------------------------------------
function startDuelGame() {
  duelQueue = [];
  activeDuels = {};
  duelCounter = 0;

  for (const p of Object.values(players)) {
    p.firewall = 100;
    p.wins = 0;
    p.breachesDealt = 0;
    p.duelOpponentId = null;
    duelQueue.push(p.id);
  }
  duelQueue = shuffle(duelQueue);

  $('#live-heading').textContent = '🔥 Firewall Duel';
  $('#leaderboard').hidden = false;
  $('#board-view').hidden = true;
  $('#duel-view').hidden = false;
  $('#outbreak-view').hidden = true;
  $('#total-count').textContent = Object.keys(players).length;
  $('#finished-count').textContent = '0';

  channel.send({ type: 'broadcast', event: 'game_start', payload: { mode: 'duel' } });

  renderLeaderboard(rankDuelPlayers(Object.values(players)), '#leaderboard');
  tryMatchmaking();
  showScreen('live');

  startDemoAnswering(); // demo hook — delete this line to remove pretend-host mode
}

// ------------------------------------------------------------
// Firewall Duel — matchmaking: pair up any two waiting players and
// send them the same random question. Runs again after every
// resolution, so players requeue into a fresh duel almost instantly.
// ------------------------------------------------------------
function tryMatchmaking() {
  while (duelQueue.length >= 2) {
    const aId = duelQueue.shift();
    const bId = duelQueue.shift();
    if (!players[aId] || !players[bId]) {
      // One side vanished (not currently possible — players are never
      // removed once they join — but keep the other one in the queue
      // rather than silently dropping them, in case that ever changes).
      if (players[aId]) duelQueue.unshift(aId);
      if (players[bId]) duelQueue.unshift(bId);
      continue;
    }

    const duelId = `duel-${++duelCounter}`;
    const question = questions[Math.floor(Math.random() * questions.length)];
    const duelTimeLimit = Math.min(question.time_limit_seconds, DUEL_TIME_LIMIT_SECONDS);

    players[aId].duelOpponentId = bId;
    players[bId].duelOpponentId = aId;

    activeDuels[duelId] = {
      id: duelId,
      players: [aId, bId],
      question,
      timeLimitSeconds: duelTimeLimit,
      answers: {},
      resolved: false,
      timerHandle: null,
    };

    const sanitizedQuestion = {
      id: question.id,
      text: question.question_text,
      options: question.options,
      timeLimitSeconds: duelTimeLimit,
    };

    channel.send({
      type: 'broadcast',
      event: 'duel_start',
      payload: {
        duelId,
        question: sanitizedQuestion,
        players: {
          [aId]: { name: players[aId].name, emoji: players[aId].emoji, firewall: players[aId].firewall },
          [bId]: { name: players[bId].name, emoji: players[bId].emoji, firewall: players[bId].firewall },
        },
      },
    });

    activeDuels[duelId].timerHandle = setTimeout(
      () => resolveDuel(duelId),
      duelTimeLimit * 1000 + 1000
    );
  }

  renderDuelView();
}

// ------------------------------------------------------------
// Step 3: live scoring — answers arrive asynchronously, any player,
// any question, any time. Host validates + scores + relays the result
// back (filtered client-side by playerId) plus the refreshed leaderboard.
// ------------------------------------------------------------
function handleAnswer(payload) {
  if (gameMode === 'board') return handleBoardAnswer(payload);
  if (gameMode === 'duel') return handleDuelAnswer(payload);
  if (gameMode === 'outbreak') return handleOutbreakAnswer(payload);
  if (gameMode === 'asteroids') return handleAsteroidsAnswer(payload);

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
// Firewall Duel — both duelists answer independently and asynchronously
// (same relay pattern as everywhere else); once both have answered, or
// the duel's own timer runs out, the round resolves immediately.
// ------------------------------------------------------------
function handleDuelAnswer(payload) {
  const { playerId, duelId, questionId, optionId, timeTakenMs } = payload;
  const duel = activeDuels[duelId];
  if (!duel || duel.resolved) return; // stale — this duel already resolved
  if (questionId !== duel.question.id) return;
  if (duel.answers[playerId]) return; // already answered this round
  if (!duel.players.includes(playerId)) return;

  duel.answers[playerId] = { optionId, timeTakenMs };

  const [aId, bId] = duel.players;
  if (duel.answers[aId] && duel.answers[bId]) {
    resolveDuel(duelId);
  }
}

function resolveDuel(duelId) {
  const duel = activeDuels[duelId];
  if (!duel || duel.resolved) return;
  duel.resolved = true;
  clearTimeout(duel.timerHandle);

  const [aId, bId] = duel.players;
  const a = players[aId];
  const b = players[bId];
  const q = duel.question;
  const duelTimeLimit = duel.timeLimitSeconds;
  const aAns = duel.answers[aId];
  const bAns = duel.answers[bId];
  const aCorrect = !!aAns && aAns.optionId === q.correct_option_id;
  const bCorrect = !!bAns && bAns.optionId === q.correct_option_id;

  let damageToA = 0;
  let damageToB = 0;
  if (aCorrect && bCorrect) {
    // Both right — whoever was faster lands the hit.
    if (aAns.timeTakenMs <= bAns.timeTakenMs) damageToB = calculateDuelDamage(aAns.timeTakenMs, duelTimeLimit);
    else damageToA = calculateDuelDamage(bAns.timeTakenMs, duelTimeLimit);
  } else if (aCorrect) {
    damageToB = calculateDuelDamage(aAns.timeTakenMs, duelTimeLimit);
  } else if (bCorrect) {
    damageToA = calculateDuelDamage(bAns.timeTakenMs, duelTimeLimit);
  } // else: both wrong (or timed out) — no damage either way

  if (damageToB > 0) a.breachesDealt += 1;
  if (damageToA > 0) b.breachesDealt += 1;

  a.firewall = Math.max(0, a.firewall - damageToA);
  b.firewall = Math.max(0, b.firewall - damageToB);

  const aBroken = a.firewall <= 0;
  const bBroken = b.firewall <= 0;
  if (aBroken) {
    b.wins += 1;
    a.firewall = 100; // reboot
  }
  if (bBroken) {
    a.wins += 1;
    b.firewall = 100;
  }

  channel.send({
    type: 'broadcast',
    event: 'duel_result',
    payload: {
      duelId,
      results: {
        [aId]: { yourDamageDealt: damageToB, damageTaken: damageToA, firewall: a.firewall, broken: aBroken, opponentBroken: bBroken },
        [bId]: { yourDamageDealt: damageToA, damageTaken: damageToB, firewall: b.firewall, broken: bBroken, opponentBroken: aBroken },
      },
    },
  });

  delete activeDuels[duelId];
  a.duelOpponentId = null;
  b.duelOpponentId = null;
  duelQueue.push(aId, bId);

  renderLeaderboard(rankDuelPlayers(Object.values(players)), '#leaderboard');
  tryMatchmaking(); // also re-renders the duel view
}

function renderDuelView() {
  const listEl = $('#duel-list');
  const statusEl = $('#duel-queue-status');
  statusEl.textContent = duelQueue.length > 0 ? `🔍 ${duelQueue.length} searching for an opponent…` : '';

  const duels = Object.values(activeDuels).filter((d) => !d.resolved);
  listEl.innerHTML = duels
    .map((d) => {
      const [aId, bId] = d.players;
      const a = players[aId];
      const b = players[bId];
      if (!a || !b) return '';
      return `
        <div class="duel-card">
          <div class="duel-vs-side">
            <span class="duel-vs-emoji">${a.emoji}</span>
            <span class="duel-vs-name">${escapeHtml(a.name)}</span>
            <div class="firewall-bar"><div class="firewall-fill" style="width:${a.firewall}%;background:${firewallColor(a.firewall)}"></div></div>
          </div>
          <span class="duel-vs-label">⚡</span>
          <div class="duel-vs-side">
            <span class="duel-vs-emoji">${b.emoji}</span>
            <span class="duel-vs-name">${escapeHtml(b.name)}</span>
            <div class="firewall-bar"><div class="firewall-fill" style="width:${b.firewall}%;background:${firewallColor(b.firewall)}"></div></div>
          </div>
        </div>
      `;
    })
    .join('');
}

function firewallColor(pct) {
  if (pct > 50) return 'var(--lime)';
  if (pct > 20) return 'var(--gold)';
  return 'var(--danger)';
}

// Firewall Duel ranking: most wins first, breaches dealt breaks ties.
// `score` is repurposed as "wins" so the existing leaderboard/podium
// renderers work unchanged.
function rankDuelPlayers(list) {
  const sorted = [...list].sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    return b.breachesDealt - a.breachesDealt;
  });
  let place = 0;
  let lastKey = null;
  return sorted.map((p, i) => {
    const key = `${p.wins}-${p.breachesDealt}`;
    if (key !== lastKey) {
      place = i + 1;
      lastKey = key;
    }
    return { id: p.id, name: p.name, emoji: p.emoji, score: p.wins, place };
  });
}

// ------------------------------------------------------------
// Outbreak: Antivirus Grid — game start. Every player answers their own
// shuffled question queue independently (same async pacing as classic
// mode — students don't need to see the grid at all, only the host
// screen does). A correct answer claims a node on the shared grid
// instead of just adding to an abstract score.
// ------------------------------------------------------------
function startOutbreakGame() {
  outbreakGrid = Array.from({ length: OUTBREAK_GRID_SIZE * OUTBREAK_GRID_SIZE }, () => ({
    ownerId: null,
    claimSpeedFraction: 0,
  }));

  const sanitized = questions.map((q) => ({
    id: q.id,
    text: q.question_text,
    options: q.options,
    timeLimitSeconds: q.time_limit_seconds,
  }));

  Object.values(players).forEach((p, i) => {
    p.score = 0;
    p.answered = 0;
    p.nodesOwned = 0;
    p.outbreakColor = OUTBREAK_COLORS[i % OUTBREAK_COLORS.length];
  });

  $('#live-heading').textContent = '🦠 Outbreak: Antivirus Grid';
  $('#leaderboard').hidden = false;
  $('#board-view').hidden = true;
  $('#duel-view').hidden = true;
  $('#outbreak-view').hidden = false;
  $('#total-count').textContent = Object.keys(players).length;
  $('#finished-count').textContent = '0';

  channel.send({ type: 'broadcast', event: 'game_start', payload: { mode: 'outbreak', questions: sanitized } });

  renderLeaderboard(rankPlayers(Object.values(players)), '#leaderboard');
  renderOutbreakLegend();
  renderOutbreakGrid();
  showScreen('live');

  startDemoAnswering(); // demo hook — delete this line to remove pretend-host mode
}

function outbreakNeighbors(index) {
  const row = Math.floor(index / OUTBREAK_GRID_SIZE);
  const col = index % OUTBREAK_GRID_SIZE;
  const neighbors = [];
  if (row > 0) neighbors.push(index - OUTBREAK_GRID_SIZE);
  if (row < OUTBREAK_GRID_SIZE - 1) neighbors.push(index + OUTBREAK_GRID_SIZE);
  if (col > 0) neighbors.push(index - 1);
  if (col < OUTBREAK_GRID_SIZE - 1) neighbors.push(index + 1);
  return neighbors;
}

// Picks which node a correct answer targets: prefer growing your own
// territory (unclaimed node next to one you own — sets up chain bonuses),
// then any unclaimed node, then an enemy node on your border (a steal
// attempt), then any enemy node at all. Returns null only once this
// player already owns literally every node.
function pickOutbreakTarget(playerId) {
  const owned = [];
  const unclaimedAny = [];
  const enemyAny = [];
  outbreakGrid.forEach((cell, i) => {
    if (cell.ownerId === playerId) owned.push(i);
    else if (cell.ownerId === null) unclaimedAny.push(i);
    else enemyAny.push(i);
  });

  const unclaimedAdjacent = new Set();
  const enemyAdjacent = new Set();
  for (const idx of owned) {
    for (const n of outbreakNeighbors(idx)) {
      if (outbreakGrid[n].ownerId === null) unclaimedAdjacent.add(n);
      else if (outbreakGrid[n].ownerId !== playerId) enemyAdjacent.add(n);
    }
  }

  if (unclaimedAdjacent.size > 0) return [...unclaimedAdjacent][Math.floor(Math.random() * unclaimedAdjacent.size)];
  if (unclaimedAny.length > 0) return unclaimedAny[Math.floor(Math.random() * unclaimedAny.length)];
  if (enemyAdjacent.size > 0) return [...enemyAdjacent][Math.floor(Math.random() * enemyAdjacent.size)];
  if (enemyAny.length > 0) return enemyAny[Math.floor(Math.random() * enemyAny.length)];
  return null;
}

function handleOutbreakAnswer(payload) {
  const { playerId, questionId, optionId, timeTakenMs } = payload;
  const player = players[playerId];
  const question = questionsById[questionId];
  if (!player || !question) return;

  const isCorrect = optionId != null && optionId === question.correct_option_id;
  const basePoints = calculateScore(isCorrect, timeTakenMs, question.time_limit_seconds);
  player.answered += 1;

  let claimResult = null;
  let totalPoints = 0;
  let changedIndex = null;

  if (!isCorrect) {
    claimResult = { type: 'wrong' };
  } else {
    const target = pickOutbreakTarget(playerId);
    if (target === null) {
      totalPoints = basePoints;
      claimResult = { type: 'board_full' };
    } else {
      const cell = outbreakGrid[target];
      const speedFraction = calculateSpeedFraction(timeTakenMs, question.time_limit_seconds);

      if (cell.ownerId === null) {
        cell.ownerId = playerId;
        cell.claimSpeedFraction = speedFraction;
        changedIndex = target;
        const chainCount = outbreakNeighbors(target).filter((n) => outbreakGrid[n].ownerId === playerId).length;
        totalPoints = basePoints + chainCount * OUTBREAK_CHAIN_BONUS;
        player.score += totalPoints;
        player.nodesOwned += 1;
        claimResult = { type: 'claimed', chainCount };
      } else if (speedFraction > cell.claimSpeedFraction) {
        // Steal succeeds — answered faster than whoever holds this node.
        const previousOwner = players[cell.ownerId];
        if (previousOwner) previousOwner.nodesOwned = Math.max(0, previousOwner.nodesOwned - 1);
        cell.ownerId = playerId;
        cell.claimSpeedFraction = speedFraction;
        changedIndex = target;
        const chainCount = outbreakNeighbors(target).filter((n) => outbreakGrid[n].ownerId === playerId).length;
        totalPoints = basePoints + chainCount * OUTBREAK_CHAIN_BONUS;
        player.score += totalPoints;
        player.nodesOwned += 1;
        claimResult = { type: 'flipped', chainCount };
      } else {
        // Steal fails — still correct, still scores the base points, but
        // the node holds.
        totalPoints = basePoints;
        player.score += totalPoints;
        claimResult = { type: 'steal_failed' };
      }
    }
  }

  const showBoardUpdate = player.answered > 0 && player.answered % 5 === 0;

  channel.send({
    type: 'broadcast',
    event: 'answer_result',
    payload: {
      playerId,
      questionId,
      correct: isCorrect,
      points: totalPoints,
      totalScore: player.score,
      claimResult,
      gridSnapshot: showBoardUpdate ? buildOutbreakGridSnapshot() : null,
    },
  });

  renderLeaderboard(rankPlayers(Object.values(players)), '#leaderboard');
  renderOutbreakGrid(changedIndex);
  updateFinishedCount();
}

// A compact snapshot of the grid + a small legend of who owns what color,
// sent to a student's own device every 5 questions so they get a peek at
// the shared board without needing to see it live the whole game.
function buildOutbreakGridSnapshot() {
  return {
    cells: outbreakGrid.map((cell) => cell.ownerId),
    legend: Object.values(players).map((p) => ({ id: p.id, name: p.name, emoji: p.emoji, color: p.outbreakColor })),
  };
}

function renderOutbreakLegend() {
  const el = $('#outbreak-legend');
  el.innerHTML = Object.values(players)
    .map(
      (p) => `
        <div class="outbreak-legend-chip">
          <span class="outbreak-legend-swatch" style="background:${p.outbreakColor}"></span>
          <span>${p.emoji} ${escapeHtml(p.name)}</span>
        </div>
      `
    )
    .join('');
}

function renderOutbreakGrid(justChangedIndex = null) {
  const el = $('#outbreak-grid');
  el.innerHTML = outbreakGrid
    .map((cell, i) => {
      if (cell.ownerId === null) return `<div class="outbreak-cell"></div>`;
      const owner = players[cell.ownerId];
      if (!owner) return `<div class="outbreak-cell"></div>`;
      const cls = i === justChangedIndex ? 'outbreak-cell claimed just-claimed' : 'outbreak-cell claimed';
      return `<div class="${cls}" style="background:${owner.outbreakColor}22;border-color:${owner.outbreakColor};" title="${escapeHtml(owner.name)}">${owner.emoji}</div>`;
    })
    .join('');
}

// ------------------------------------------------------------
// Asteroid Defense — game start. Same shape as classic mode (every
// player gets the full question bank and self-paces through it), just
// with money instead of points. The actual mini-game runs entirely on
// each student's own device.
// ------------------------------------------------------------
function startAsteroidsGame() {
  const sanitized = questions.map((q) => ({
    id: q.id,
    text: q.question_text,
    options: q.options,
    timeLimitSeconds: q.time_limit_seconds,
  }));

  Object.values(players).forEach((p) => {
    p.score = 0;
    p.answered = 0;
    p.asteroidsDestroyed = 0;
    p.wave = 1;
  });

  $('#live-heading').textContent = '☄️ Asteroid Defense';
  $('#leaderboard').hidden = false;
  $('#board-view').hidden = true;
  $('#duel-view').hidden = true;
  $('#outbreak-view').hidden = true;
  $('#total-count').textContent = Object.keys(players).length;
  $('#finished-count').textContent = '0';

  channel.send({ type: 'broadcast', event: 'game_start', payload: { mode: 'asteroids', questions: sanitized } });

  renderLeaderboard(rankPlayers(Object.values(players)), '#leaderboard');
  showScreen('live');

  startDemoAnswering(); // demo hook — delete this line to remove pretend-host mode
}

// Money is awarded exactly like classic scoring, just relabeled and
// rescaled — the actual asteroid combat that money buys happens
// entirely client-side, so this function is deliberately simple.
function handleAsteroidsAnswer(payload) {
  const { playerId, questionId, optionId, timeTakenMs } = payload;
  const player = players[playerId];
  const question = questionsById[questionId];
  if (!player || !question) return;

  const isCorrect = optionId != null && optionId === question.correct_option_id;
  const moneyEarned = calculateMoney(isCorrect, timeTakenMs, question.time_limit_seconds);
  player.score += moneyEarned;
  player.answered += 1;

  channel.send({
    type: 'broadcast',
    event: 'answer_result',
    payload: {
      playerId,
      questionId,
      correct: isCorrect,
      points: moneyEarned,
      totalScore: player.score,
    },
  });

  renderLeaderboard(rankPlayers(Object.values(players)), '#leaderboard');
  updateFinishedCount();
}

// Each student's device reports its own wave/asteroids-destroyed
// progress periodically (after every wave), since the host never
// simulates the actual combat — this is purely for the host's
// leaderboard display, not used for any scoring decision.
function handleAsteroidsSync(payload) {
  const player = players[payload.playerId];
  if (!player) return;
  player.asteroidsDestroyed = payload.asteroidsDestroyed;
  player.wave = payload.wave;
  renderLeaderboard(rankPlayers(Object.values(players)), '#leaderboard');
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

  // Any duels still in flight won't get to resolve — cancel their timers
  // so they don't fire after the game screen has already moved on.
  for (const duel of Object.values(activeDuels)) {
    clearTimeout(duel.timerHandle);
  }
  activeDuels = {};
  duelQueue = [];
  outbreakGrid = [];

  const leaderboard =
    gameMode === 'board' ? rankBoardPlayers(Object.values(players))
    : gameMode === 'duel' ? rankDuelPlayers(Object.values(players))
    : rankPlayers(Object.values(players));
  channel.send({ type: 'broadcast', event: 'game_over', payload: { leaderboard } });
  renderPodium(leaderboard, '#podium');
  renderLeaderboard(leaderboard, '#final-leaderboard');
  showScreen('final');
  launchConfetti();
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
      } else if (gameMode === 'duel') {
        const firewall = players[p.id]?.firewall ?? 100;
        const breaches = players[p.id]?.breachesDealt ?? 0;
        suffix = `🛡️ ${firewall}% · ${breaches} breaches`;
        barFraction = p.score / maxScore;
      } else if (gameMode === 'outbreak') {
        const nodes = players[p.id]?.nodesOwned ?? 0;
        const totalNodes = OUTBREAK_GRID_SIZE * OUTBREAK_GRID_SIZE;
        suffix = `🗺️ ${nodes}/${totalNodes} nodes`;
        barFraction = p.score / maxScore;
      } else if (gameMode === 'asteroids') {
        const wave = players[p.id]?.wave ?? 1;
        const destroyed = players[p.id]?.asteroidsDestroyed ?? 0;
        suffix = `🛰️ Wave ${wave} · 💥 ${destroyed}`;
        barFraction = p.score / maxScore;
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
enableConsistentEmoji();
(async () => {
  const auth = await requireRole(['teacher', 'admin']);
  if (!auth) return;
  loadQuizzes();
})();
