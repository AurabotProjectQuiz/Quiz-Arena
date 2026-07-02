-- ============================================================
-- Run this ONCE in the Supabase SQL Editor if you already ran the
-- original schema.sql. It adds write permissions so the new "Manage
-- quizzes" editor in the app can create/edit/delete quizzes.
--
-- SECURITY NOTE: this makes quizzes/questions writable by anyone who
-- has your site's anon key (which is public, embedded in the site's
-- JS). That's fine for a personal/teacher tool where you're not
-- widely publicizing the manage page, but it means there's no login —
-- anyone with the link could edit or delete your quizzes. If that ever
-- matters, the fix later is adding Supabase Auth and scoping these
-- policies to `auth.uid() is not null` instead of `true`.
-- ============================================================

create policy "Public write access to quizzes"
  on quizzes for insert
  with check (true);

create policy "Public update access to quizzes"
  on quizzes for update
  using (true);

create policy "Public delete access to quizzes"
  on quizzes for delete
  using (true);

create policy "Public write access to questions"
  on questions for insert
  with check (true);

create policy "Public update access to questions"
  on questions for update
  using (true);

create policy "Public delete access to questions"
  on questions for delete
  using (true);
