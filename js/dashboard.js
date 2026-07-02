import { supabase } from './supabaseClient.js';
import { $ } from './utils.js';
import { requireRole } from './authGuard.js';

$('#btn-sign-out').addEventListener('click', async () => {
  await supabase.auth.signOut();
  window.location.href = '/index.html';
});

(async () => {
  await requireRole(['teacher', 'admin']);
})();
