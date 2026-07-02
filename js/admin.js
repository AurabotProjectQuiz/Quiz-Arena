import { supabase } from './supabaseClient.js';
import { escapeHtml, $ } from './utils.js';
import { requireRole } from './authGuard.js';

$('#btn-sign-out').addEventListener('click', async () => {
  await supabase.auth.signOut();
  window.location.href = '/index.html';
});

// ------------------------------------------------------------
// Create a teacher account (via the create-teacher Edge Function —
// this can't be done directly from the browser, since it needs the
// privileged service role key which must stay server-side).
// ------------------------------------------------------------
$('#btn-create-teacher').addEventListener('click', async () => {
  const email = $('#input-teacher-email').value.trim();
  const password = $('#input-teacher-password').value;
  const errorEl = $('#create-error');
  const successEl = $('#create-success');
  errorEl.textContent = '';
  successEl.textContent = '';

  if (!email || !password) {
    errorEl.textContent = 'Enter both an email and a temporary password.';
    return;
  }

  const btn = $('#btn-create-teacher');
  btn.disabled = true;
  btn.textContent = 'Creating…';

  const { data, error } = await supabase.functions.invoke('create-teacher', {
    body: { email, password },
  });

  btn.disabled = false;
  btn.textContent = 'Create teacher account';

  if (error || data?.error) {
    errorEl.textContent = data?.error || error.message || 'Something went wrong.';
    return;
  }

  successEl.textContent = `Teacher account created for ${email}. Share the password with them directly — they can log in at /login.html.`;
  $('#input-teacher-email').value = '';
  $('#input-teacher-password').value = '';
  loadTeacherList();
});

// ------------------------------------------------------------
// List existing teacher accounts
// ------------------------------------------------------------
async function loadTeacherList() {
  const listEl = $('#teacher-list');
  const { data, error } = await supabase
    .from('profiles')
    .select('email, created_at')
    .eq('role', 'teacher')
    .order('created_at', { ascending: false });

  if (error) {
    listEl.innerHTML = `<p class="error-text">Couldn't load teacher list: ${escapeHtml(error.message)}</p>`;
    return;
  }
  if (!data || data.length === 0) {
    listEl.innerHTML = '<p class="center-text">No teacher accounts yet.</p>';
    return;
  }

  listEl.innerHTML = data
    .map((t) => `<div class="player-chip" style="margin-bottom:8px;">${escapeHtml(t.email)}</div>`)
    .join('');
}

// ------------------------------------------------------------
// Init
// ------------------------------------------------------------
(async () => {
  const auth = await requireRole(['admin']);
  if (!auth) return;
  loadTeacherList();
})();
