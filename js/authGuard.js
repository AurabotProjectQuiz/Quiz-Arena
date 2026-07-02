import { supabase } from './supabaseClient.js';

/**
 * Redirects to /login.html unless the current user is logged in AND has
 * one of the allowed roles. Returns { session, role } on success, or
 * null (having already redirected) on failure.
 *
 * This is a page-experience guard, not the only line of defense — the
 * actual quiz writes are enforced at the database level via Row Level
 * Security policies (see sql/auth_and_roles.sql), so this just keeps
 * logged-out visitors from seeing pages meant for teachers/admins.
 */
export async function requireRole(allowedRoles) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = '/login.html';
    return null;
  }

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', session.user.id)
    .single();

  if (error || !profile || !allowedRoles.includes(profile.role)) {
    window.location.href = '/login.html';
    return null;
  }

  return { session, role: profile.role };
}
