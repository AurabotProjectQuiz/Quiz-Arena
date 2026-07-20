// ============================================================
// Scoring: speed-based bonus, like Kahoot.
// A correct answer scores between MIN_POINTS and MAX_POINTS,
// decaying linearly with how long the player took to answer.
// A wrong (or missing) answer always scores 0.
// ============================================================

export const MAX_POINTS = 1000;
export const MIN_POINTS = 500;

/**
 * Shared by every mode that needs "how fast was this answer" as a
 * 0–1 value: 1 = instant, 0 = right at the buzzer.
 * @param {number} timeTakenMs
 * @param {number} timeLimitSeconds
 */
export function calculateSpeedFraction(timeTakenMs, timeLimitSeconds) {
  const timeLimitMs = timeLimitSeconds * 1000;
  const clampedMs = Math.min(Math.max(timeTakenMs, 0), timeLimitMs);
  return 1 - clampedMs / timeLimitMs;
}

/**
 * @param {boolean} isCorrect - whether the chosen option was correct
 * @param {number} timeTakenMs - time from question shown to answer submitted
 * @param {number} timeLimitSeconds - the question's time limit
 * @returns {number} points earned (integer)
 */
export function calculateScore(isCorrect, timeTakenMs, timeLimitSeconds) {
  if (!isCorrect) return 0;
  const speedFraction = calculateSpeedFraction(timeTakenMs, timeLimitSeconds);
  return Math.round(MIN_POINTS + (MAX_POINTS - MIN_POINTS) * speedFraction);
}

// ============================================================
// Firewall Duel: damage dealt to an opponent's firewall for winning an
// exchange. Same speed-decay shape as calculateScore above, just
// rescaled so a 100% firewall typically takes 3–5 solid hits to break.
// ============================================================
export const MAX_DUEL_DAMAGE = 40;
export const MIN_DUEL_DAMAGE = 15;

/**
 * @param {number} timeTakenMs - the winning answer's response time
 * @param {number} timeLimitSeconds - the duel question's time limit
 * @returns {number} damage dealt (integer)
 */
export function calculateDuelDamage(timeTakenMs, timeLimitSeconds) {
  const speedFraction = calculateSpeedFraction(timeTakenMs, timeLimitSeconds);
  return Math.round(MIN_DUEL_DAMAGE + (MAX_DUEL_DAMAGE - MIN_DUEL_DAMAGE) * speedFraction);
}

// ============================================================
// Outbreak: Antivirus Grid — bonus points per same-owner neighbor when
// a claim "chains" onto your existing territory.
// ============================================================
export const OUTBREAK_CHAIN_BONUS = 60;

// ============================================================
// Asteroid Defense — money earned per correct answer, spent on weapons
// between waves. Same speed-decay shape as everywhere else.
// ============================================================
export const MAX_MONEY = 120;
export const MIN_MONEY = 40;

export function calculateMoney(isCorrect, timeTakenMs, timeLimitSeconds) {
  if (!isCorrect) return 0;
  const speedFraction = calculateSpeedFraction(timeTakenMs, timeLimitSeconds);
  return Math.round((MIN_MONEY + (MAX_MONEY - MIN_MONEY) * speedFraction) / 5) * 5; // round to nearest $5
}

// ============================================================
// Firewall Duel — money earned per correct answer within a battle,
// independent of who wins that question's attack. Capped at $100 max,
// per the game's spec.
// ============================================================
export const DUEL_MAX_MONEY = 100;
export const DUEL_MIN_MONEY = 30;

export function calculateDuelMoney(timeTakenMs, timeLimitSeconds) {
  const speedFraction = calculateSpeedFraction(timeTakenMs, timeLimitSeconds);
  return Math.round((DUEL_MIN_MONEY + (DUEL_MAX_MONEY - DUEL_MIN_MONEY) * speedFraction) / 5) * 5;
}

/**
 * Sorts players by score descending and attaches a `place` (1-indexed),
 * with ties sharing the same place.
 * @param {Array<{id:string,name:string,emoji:string,score:number}>} players
 */
export function rankPlayers(players) {
  const sorted = [...players].sort((a, b) => b.score - a.score);
  let place = 0;
  let lastScore = null;
  return sorted.map((player, i) => {
    if (player.score !== lastScore) {
      place = i + 1;
      lastScore = player.score;
    }
    return { ...player, place };
  });
}
