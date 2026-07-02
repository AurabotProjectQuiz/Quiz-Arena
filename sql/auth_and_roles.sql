-- ============================================================
-- Adds real login accounts with two roles: admin and teacher.
-- Only teachers/admins can create/edit/delete quizzes. Only admins
-- can create teacher accounts (via the create-teacher Edge Function —
-- see supabase-functions/create-teacher.ts).
--
-- Run this once in the Supabase SQL Editor. If you previously ran
-- sql/enable_editing.sql (open-to-everyone write access), this
-- replaces those policies with proper role checks.
-- ============================================================

-- ------------------------------------------------------------
-- profiles: one row per logged-in user, marking their role.
-- id matches the corresponding row in Supabase's built-in auth.users.
-- ------------------------------------------------------------
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin', 'teacher')),
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

-- ------------------------------------------------------------
-- current_user_role(): looks up the calling user's role.
-- SECURITY DEFINER means this runs with elevated privileges internally,
-- which avoids Postgres's "infinite recursion" error that happens if a
-- policy on `profiles` tries to query `profiles` directly. This is the
-- standard Supabase pattern for role checks.
-- ------------------------------------------------------------
create or replace function public.current_user_role()
returns text
language sql
security definer
set search_path = public
stable
as $$
  select role from profiles where id = auth.uid();
$$;

-- ------------------------------------------------------------
-- profiles policies
-- ------------------------------------------------------------
drop policy if exists "Users can read own profile" on profiles;
create policy "Users can read own profile"
  on profiles for select
  using (auth.uid() = id);

drop policy if exists "Admins can read all profiles" on profiles;
create policy "Admins can read all profiles"
  on profiles for select
  using (public.current_user_role() = 'admin');

-- Note: there's no insert/update/delete policy for profiles here on
-- purpose — accounts are only ever created via the create-teacher Edge
-- Function, which uses the service role key and bypasses RLS entirely.

-- ------------------------------------------------------------
-- Replace the old "anyone can write" policies (from enable_editing.sql)
-- with proper role checks. Safe to run even if those never existed.
-- ------------------------------------------------------------
drop policy if exists "Public write access to quizzes" on quizzes;
drop policy if exists "Public update access to quizzes" on quizzes;
drop policy if exists "Public delete access to quizzes" on quizzes;
drop policy if exists "Public write access to questions" on questions;
drop policy if exists "Public update access to questions" on questions;
drop policy if exists "Public delete access to questions" on questions;

create policy "Teachers and admins can insert quizzes"
  on quizzes for insert
  with check (public.current_user_role() in ('teacher', 'admin'));

create policy "Teachers and admins can update quizzes"
  on quizzes for update
  using (public.current_user_role() in ('teacher', 'admin'));

create policy "Teachers and admins can delete quizzes"
  on quizzes for delete
  using (public.current_user_role() in ('teacher', 'admin'));

create policy "Teachers and admins can insert questions"
  on questions for insert
  with check (public.current_user_role() in ('teacher', 'admin'));

create policy "Teachers and admins can update questions"
  on questions for update
  using (public.current_user_role() in ('teacher', 'admin'));

create policy "Teachers and admins can delete questions"
  on questions for delete
  using (public.current_user_role() in ('teacher', 'admin'));

-- Read access to quizzes/questions stays public — host.html and
-- join.html need to read quizzes without anyone logging in.

-- ============================================================
-- ONE-TIME MANUAL STEP: create your first admin account.
-- (Nothing can automate this — there's no admin yet to create one!)
--
-- 1. Supabase Dashboard > Authentication > Users > Add user.
--    Enter your email + a password, and check "Auto Confirm User".
-- 2. Copy that new user's UUID (shown in the users list).
-- 3. Run this, with your real email + the UUID you just copied:
--
--    insert into profiles (id, email, role)
--    values ('PASTE-THE-UUID-HERE', 'your@email.com', 'admin');
--
-- After that, log in at /login.html with that email + password —
-- you'll land on the admin page, where you can create teacher
-- accounts for anyone else who needs to build quizzes.
-- ============================================================
