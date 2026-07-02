import { supabase } from './supabaseClient.js';
import { $ } from './utils.js';

// If already logged in, skip straight to the right page.
(async () => {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) await redirectByRole(session.user.id);
})();

$('#btn-login').addEventListener('click', login);
$('#input-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') login();
});

async function login() {
  const email = $('#input-email').value.trim();
  const password = $('#input-password').value;
  const errorEl = $('#login-error');
  errorEl.textContent = '';

  if (!email || !password) {
    errorEl.textContent = 'Enter both your email and password.';
    return;
  }

  const btn = $('#btn-login');
  btn.disabled = true;
  btn.textContent = 'Logging in…';

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    errorEl.textContent = error.message;
    btn.disabled = false;
    btn.textContent = 'Log in';
    return;
  }

  await redirectByRole(data.user.id);
  btn.disabled = false;
  btn.textContent = 'Log in';
}

async function redirectByRole(userId) {
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .single();

  if (error || !profile) {
    $('#login-error').textContent = "This account isn't set up with a role yet — contact your admin.";
    await supabase.auth.signOut();
    return;
  }

  if (profile.role === 'admin') {
    window.location.href = '/admin.html';
  } else if (profile.role === 'teacher') {
    window.location.href = '/dashboard.html';
  } else {
    $('#login-error').textContent = 'Unrecognized account role — contact your admin.';
    await supabase.auth.signOut();
  }
}
