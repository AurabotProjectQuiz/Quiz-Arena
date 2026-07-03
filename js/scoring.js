// ============================================================
// Scoring: speed-based bonus, like Kahoot.
// A correct answer scores between MIN_POINTS and MAX_POINTS,
// decaying linearly with how long the player took to answer.
// A wrong (or missing) answer always scores 0.
// ============================================================

export const MAX_POINTS = 1000;
export const MIN_POINTS = 500;

/**
 * @param {boolean} isCorrect - whether the chosen option was correct
 * @param {number} timeTakenMs - time from question shown to answer submitted
 * @param {number} timeLimitSeconds - the question's time limit
 * @returns {number} points earned (integer)
 */
export function calculateScore(isCorrect, timeTakenMs, timeLimitSeconds) {
  if (!isCorrect) return 0;

  const timeLimitMs = timeLimitSeconds * 1000;
  const clampedMs = Math.min(Math.max(timeTakenMs, 0), timeLimitMs);
  const speedFraction = 1 - clampedMs / timeLimitMs; // 1 = instant, 0 = right at the buzzer

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
  const timeLimitMs = timeLimitSeconds * 1000;
  const clampedMs = Math.min(Math.max(timeTakenMs, 0), timeLimitMs);
  const speedFraction = 1 - clampedMs / timeLimitMs;
  return Math.round(MIN_DUEL_DAMAGE + (MAX_DUEL_DAMAGE - MIN_DUEL_DAMAGE) * speedFraction);
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
