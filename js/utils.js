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
