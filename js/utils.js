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
