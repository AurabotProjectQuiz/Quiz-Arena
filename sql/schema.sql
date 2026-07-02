-- ============================================================
-- Live Quiz Game — Supabase schema
-- Run this in the Supabase SQL editor (Project > SQL Editor > New query)
-- ============================================================

-- Quizzes: a saved set of questions on a topic
create table if not exists quizzes (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  topic text not null,
  created_at timestamptz not null default now()
);

-- Questions belonging to a quiz.
-- options is a JSON array like: [{"id":"a","text":"Paris"},{"id":"b","text":"Rome"}]
create table if not exists questions (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references quizzes(id) on delete cascade,
  order_index int not null default 0,
  question_text text not null,
  options jsonb not null,
  correct_option_id text not null,
  time_limit_seconds int not null default 20,
  created_at timestamptz not null default now()
);

create index if not exists questions_quiz_id_idx on questions(quiz_id);

-- ============================================================
-- Row Level Security
-- Questions/quizzes are read-only to anonymous players and hosts.
-- Nothing about players/games is stored here at all — that stays
-- entirely in-memory / Realtime, which is what keeps this cheap.
-- ============================================================

alter table quizzes enable row level security;
alter table questions enable row level security;

create policy "Public read access to quizzes"
  on quizzes for select
  using (true);

create policy "Public read access to questions"
  on questions for select
  using (true);

-- NOTE: There are intentionally no insert/update/delete policies for the
-- anon role. Add quizzes/questions from the Supabase Table Editor, or
-- add an authenticated "admin" policy later once you build a quiz editor.

-- ============================================================
-- Sample data — delete or edit this once you're adding your own quizzes
-- ============================================================

with new_quiz as (
  insert into quizzes (title, topic) values ('World Capitals', 'Geography')
  returning id
)
insert into questions (quiz_id, order_index, question_text, options, correct_option_id, time_limit_seconds)
select id, 0, 'What is the capital of France?',
  '[{"id":"a","text":"Paris"},{"id":"b","text":"Rome"},{"id":"c","text":"Berlin"},{"id":"d","text":"Madrid"}]'::jsonb,
  'a', 20
from new_quiz
union all
select id, 1, 'What is the capital of Japan?',
  '[{"id":"a","text":"Seoul"},{"id":"b","text":"Beijing"},{"id":"c","text":"Tokyo"},{"id":"d","text":"Bangkok"}]'::jsonb,
  'c', 20
from new_quiz
union all
select id, 2, 'What is the capital of Australia?',
  '[{"id":"a","text":"Sydney"},{"id":"b","text":"Canberra"},{"id":"c","text":"Melbourne"},{"id":"d","text":"Perth"}]'::jsonb,
  'b', 20
from new_quiz;
