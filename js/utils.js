// ============================================================
// Shared utilities
// ============================================================

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion

export function generateJoinCode(length = 5) {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

export function generatePlayerId() {
  return (crypto.randomUUID?.() ?? `p-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

export const EMOJI_CHOICES = [
  '🦊', '🐸', '🐼', '🦁', '🐯', '🐨', '🐵', '🦄',
  '🐙', '🦉', '🐢', '🦖', '🐳', '🦋', '🐝', '🦩',
  '🐲', '🦔', '🐧', '🦈', '🐺', '🦑', '🐬', '🦜',
];

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $all(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

export function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ------------------------------------------------------------
// Confetti burst for the final results screen — pure CSS/DOM, no
// external library. Pieces remove themselves once their fall animation
// finishes.
// ------------------------------------------------------------
const CONFETTI_EMOJI = ['🎉', '✨', '🎊', '⭐', '💥'];

export function launchConfetti(count = 40) {
  for (let i = 0; i < count; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.textContent = CONFETTI_EMOJI[Math.floor(Math.random() * CONFETTI_EMOJI.length)];
    piece.style.left = `${Math.random() * 100}vw`;
    piece.style.fontSize = `${16 + Math.random() * 16}px`;
    piece.style.animationDuration = `${2 + Math.random() * 1.5}s`;
    piece.style.animationDelay = `${Math.random() * 0.6}s`;
    document.body.appendChild(piece);
    piece.addEventListener('animationend', () => piece.remove());
  }
}

// ------------------------------------------------------------
// Firewall Duel: a glowing circular "force field" ring around a
// player's emoji avatar, whose arc-length and glow strength represent
// their current firewall %. Shared between host.js (scoreboard, duel
// pairing cards) and join.js (the duel battle screen) so both look
// identical.
// ------------------------------------------------------------
export function forcefieldColor(pct) {
  if (pct > 50) return 'var(--lime)';
  if (pct > 20) return 'var(--gold)';
  return 'var(--danger)';
}

export function renderForcefieldAvatar(emoji, firewallPercent, sizePx = 64) {
  const pct = Math.max(0, Math.min(100, firewallPercent));
  const color = forcefieldColor(pct);
  const criticalClass = pct <= 20 ? ' critical' : '';
  const emojiSize = Math.round(sizePx * 0.55);
  return `
    <div class="forcefield-avatar${criticalClass}" style="width:${sizePx}px;height:${sizePx}px;">
      <div class="forcefield-ring" style="--pct:${pct};--ff-color:${color};"></div>
      <span class="forcefield-emoji" style="font-size:${emojiSize}px;">${emoji}</span>
    </div>
  `;
}

// ------------------------------------------------------------
// Consistent cross-platform emoji rendering.
//
// The SAME emoji character (e.g. 🦖) renders differently on every OS,
// because there's no image — each device's own emoji font decides how
// to draw it (Windows 11 uses Microsoft's "Fluent Emoji" set, which
// tends to look more polished/cute than macOS's or older Windows'
// built-in sets). To make it look the same — and use the nicer style —
// everywhere, this loads a small library (from a CDN, added as a
// <script> tag in each page's <head>) that scans the page and replaces
// Unicode emoji characters with actual Fluent Emoji images.
//
// Since this app re-renders things like the leaderboard or roster
// constantly, a one-time pass on page load isn't enough — a
// MutationObserver watches for any DOM change and re-scans (debounced,
// so a burst of updates only triggers one pass), so newly-added emoji
// anywhere in the app get converted automatically without every
// render function needing to remember to call this.
//
// If the CDN script fails to load (network hiccup, ad blocker, etc.),
// this fails quietly and emoji just fall back to each device's normal
// native rendering — nothing else in the app depends on this working.
// ------------------------------------------------------------
export function enableConsistentEmoji() {
  if (typeof window === 'undefined' || !window.fluentemoji) {
    console.warn('Fluent Emoji library not loaded — emoji will use each device\'s native style instead.');
    return;
  }

  const parseAll = () => window.fluentemoji.parse(document.body, { className: 'fluent-emoji-img' });
  parseAll();

  let debounceHandle = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounceHandle);
    debounceHandle = setTimeout(parseAll, 60);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}
