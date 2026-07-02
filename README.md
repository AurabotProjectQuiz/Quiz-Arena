# Quiz Arena

A live, buzzer-style quiz game (Blooket/Kahoot-style). No student accounts —
players join with a name + emoji and a game code. Built as a plain static
site (no build step) so it deploys straight to Netlify from GitHub.

- **Quizzes & questions** are stored in Supabase Postgres.
- **The live game itself** (who's joined, current question, scores) runs
  entirely over Supabase Realtime (Presence + Broadcast) — nothing about
  a game or a player is written to the database, which is what keeps this
  essentially free to run. See "Why this stays cheap" below.

## 1. Create your Supabase project

1. Go to [supabase.com](https://supabase.com) and create a new project (free tier is fine).
2. In the Supabase dashboard, open **SQL Editor > New query**, paste in the
   contents of [`sql/schema.sql`](sql/schema.sql), and run it. This creates
   `quizzes` and `questions` tables, sets up read-only public access, and
   inserts one sample quiz ("World Capitals") so you can test immediately.
3. Go to **Project Settings > API** and copy your **Project URL** and
   **anon public key**.
4. Open `js/supabaseClient.js` and paste them in:

   ```js
   const SUPABASE_URL = 'https://xxxxx.supabase.co';
   const SUPABASE_ANON_KEY = 'eyJ...';
   ```

   This key is safe to expose in client-side code — it can only do what
   your Row Level Security policies allow (public read-only, in this case).
5. In Supabase, turn on Realtime for broadcasting: it's on by default for
   new projects, but if you ever see connection errors, check
   **Project Settings > Realtime** is enabled.

## 2. Run it locally

This is a static site with ES modules, so it needs to be served over HTTP
(not opened as a `file://` URL). Any static server works, e.g.:

```bash
npx serve .
# or
python3 -m http.server 8080
```

Then open `/index.html`, click **Host a game** in one tab and **Join a
game** in another (or on your phone) to test the full flow.

## 3. Add your own quizzes

For now, add quizzes and questions directly in the Supabase **Table
Editor** (no admin UI yet — see "What's next" below):

- **quizzes**: `title`, `topic`
- **questions**: `quiz_id` (pick the quiz), `order_index` (0, 1, 2…),
  `question_text`, `time_limit_seconds`, `correct_option_id` (must match
  one of the `id`s in `options`), and `options` as JSON, e.g.:

  ```json
  [
    {"id": "a", "text": "Paris"},
    {"id": "b", "text": "Rome"},
    {"id": "c", "text": "Berlin"},
    {"id": "d", "text": "Madrid"}
  ]
  ```

## 4. Deploy

1. Push this folder to a GitHub repo.
2. In [Netlify](https://app.netlify.com), **Add new site > Import an
   existing project**, connect the repo. Build command: leave blank.
   Publish directory: `.` (already set in `netlify.toml`).
3. Deploy. Share the `/host.html` link with yourself and `/join.html`
   with students.

## How the live game works

This is **self-paced, like Blooket** — not lockstep like Kahoot. Every
player moves through the quiz on their own, in their own random order, at
their own speed, and the host screen is just a live-updating leaderboard.

- The host generates a 5-character join code and opens a Supabase Realtime
  channel named `quiz-<CODE>`.
- Players "join" by connecting to that same channel and calling
  `track()` with their name + emoji (Presence) — this is how the host
  sees the live roster in the lobby, with zero database writes.
- When the host clicks **Start**, it sends **one** broadcast containing the
  *entire* question set (text + options, but not the correct answers) to
  every player at once. Each player's browser shuffles that list into its
  own random order (`shuffle()` in `js/utils.js`) — that's the whole
  "randomized per student" behavior, no extra messages needed.
- From there, each player runs their own local loop: show question → start
  timer → on answer (or timeout), broadcast `{ playerId, questionId,
  optionId, timeTakenMs }` → wait for the host's result → show
  correct/incorrect + points → auto-advance to their next question. Nobody
  waits on anybody else.
- The host is the single source of truth for scoring: it keeps the correct
  answers privately, validates each incoming answer, computes points, and
  broadcasts an `answer_result` back that carries both that player's
  feedback *and* the refreshed leaderboard. Every client receives every
  message, but only the matching player's screen reacts to a given
  `answer_result` — everyone else just uses it to update the live
  leaderboard. There's no peer-to-peer connection; the host channel is the
  relay point for everything.
- A player who finishes all their questions sees a "you're done, waiting
  on the others" screen. The host can end the game whenever it wants
  (doesn't have to wait for stragglers) — that broadcasts final results
  to everyone.

This host-as-relay design is deliberate groundwork for the sabotage/power-up
mechanics you mentioned wanting later: since every player's answer already
passes through the host, a future "steal points" or "freeze a rival" effect
is just another broadcast event addressed to a specific `playerId`, handled
the same way `answer_result` already is.

### Scoring (v1)

Speed bonus, defined in `js/scoring.js`:
- Correct answers score between **500** (answered right at the time
  limit) and **1000** (answered instantly), decaying linearly.
- Wrong, timed-out, or missing answers score **0**.
- Easy to change: edit `MIN_POINTS`/`MAX_POINTS`/the decay curve in one
  place. This is also where you'll plug in different scoring rules per
  game mode once those exist.

## Why this stays cheap

Supabase's free tier includes 5 GB of egress and 2 million Realtime
messages/month. Because nothing about an in-progress game (players,
answers, scores) is written to or read from the database — it's all
ephemeral Broadcast/Presence messages of a few hundred bytes — a full
class game (30 players × 20 questions) uses on the order of a few MB.
You'd need hundreds of games in a month before this gets anywhere near
the free tier limits. The only database reads are the one-time "load
quiz list" and "load questions for the chosen quiz" at the very start.

**Known v1 limitations:**
- If a player refreshes or loses connection mid-game, they rejoin as a
  "new" player with score reset to 0 (nothing is persisted per-player).
  Fine for a live classroom setting; worth fixing later if you want
  reconnect support.
- Scoring trusts the client's reported `timeTakenMs` and answer choice.
  Since the correct answers themselves are never sent to the browser
  (only the host's private copy knows them), a player can't just read the
  answer out of devtools — but a determined student could still fake their
  timing to always claim max speed points. Fine for casual classroom use;
  if that ever matters, the host can independently timestamp when it
  *receives* each answer as a sanity check.

## What's next (per your roadmap)

- **Game modes with sabotage/power-ups.** The architecture already routes
  every player action through the host, so a mode is: (1) extra broadcast
  event types like `sabotage` targeted at a specific `playerId`, handled
  in `join.js` the same way `answer_result` is (check "is this for me"),
  and (2) alternate scoring/rules dropped into `scoring.js`. The host would
  pick a mode alongside the quiz topic on the lobby screen.
- A **quiz editor UI** in the host app, instead of using the Supabase
  Table Editor directly.
- **Persisting final results** to a `game_results` table (optional, only
  written once at game end — still cheap) so you can review past games.
- **Reconnect support**: persist `{code, playerId, name, emoji, score}` to
  `sessionStorage` so a refreshed tab can rejoin its game in progress.
