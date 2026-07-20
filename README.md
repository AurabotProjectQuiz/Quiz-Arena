# Quiz Arena

A live, buzzer-style quiz game (Blooket/Kahoot-style). Only logged-in
teachers/admins can host games or manage quizzes — students never need
an account, they just join with a name + emoji and a game code. Built as
a plain static site (no build step) so it deploys straight to Netlify
from GitHub.

- **Quizzes & questions** are stored in Supabase Postgres.
- **Accounts & roles** (admin/teacher) run on Supabase Auth, with Row
  Level Security enforcing who can write quiz data at the database level.
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

## 3. Set up accounts (admin + teachers)

Only logged-in teachers/admins can create or edit quizzes now — this is
enforced by the database itself (Row Level Security), not just hidden in
the UI. Three steps to get this running:

### a) Run the roles migration

In Supabase SQL Editor, run [`sql/auth_and_roles.sql`](sql/auth_and_roles.sql).
This creates a `profiles` table (marks each account as `admin` or
`teacher`) and locks quiz writes down to those roles only. If you'd
previously run `sql/enable_editing.sql` (open-to-everyone writes), this
replaces those policies.

### b) Deploy the create-teacher function

Creating a login for someone requires Supabase's privileged service-role
key, which can never be exposed in browser code — so account creation has
to go through a small server-side function instead:

1. Supabase Dashboard > **Edge Functions** > **Deploy a new function** >
   **Via Editor**.
2. Name it exactly `create-teacher`.
3. Paste in the contents of
   [`supabase-functions/create-teacher.ts`](supabase-functions/create-teacher.ts).
4. Click **Deploy**. No extra configuration needed — the keys it needs
   are automatically available inside the function.

### c) Create your first admin account (one manual, one-time step)

Nothing can automate this part — there's no admin yet to create one:

1. Supabase Dashboard > **Authentication > Users > Add user**. Enter your
   email + a password, and check **Auto Confirm User**.
2. Copy that new user's UUID from the users list.
3. Back in SQL Editor, run (with your real email + the UUID you copied):
   ```sql
   insert into profiles (id, email, role)
   values ('PASTE-THE-UUID-HERE', 'your@email.com', 'admin');
   ```
4. Go to `/login.html` on your deployed site and log in — you'll land on
   the **admin page**, where you can create teacher accounts for anyone
   else who needs to build quizzes. Each teacher gets an email + a
   temporary password you set and share with them directly (there's no
   self-signup or "forgot password" flow yet — that'd be a good next
   addition if you need it).

## 4. Add your own quizzes

Log in at `/login.html` (as a teacher or admin) to reach the quiz editor.
Create a new quiz (title + topic), add questions with **2 to 4** answers
each (leave an answer blank to only offer fewer options), and pick the
correct one with the radio button next to it. Click **Add question** to
add more, **Save quiz** when you're done. Click any quiz in the list to
edit it — question edits fully replace the previous set for that quiz
(simplest way to support editing without complex merging), and there's a
**Delete this quiz** button in the editor too.

*(You can still add/edit rows directly in Supabase's Table Editor too if
you ever prefer that — same tables, same format — logged in there as
yourself rather than through the app.)*

## 5. Deploy

1. Push this folder to a GitHub repo.
2. In [Netlify](https://app.netlify.com), **Add new site > Import an
   existing project**, connect the repo. Build command: leave blank.
   Publish directory: `.` (already set in `netlify.toml`).
3. Deploy. Share `/join.html` with students (no login needed) and
   `/login.html` with teachers — logging in takes them to their
   dashboard, with **Host a game** and **Manage quizzes**.

## How the live game works

This is **self-paced, like Blooket** — not lockstep like Kahoot. Every
player moves through the quiz on their own, in their own random order, at
their own speed, and the host screen is just a live-updating leaderboard.

- The host generates a 5-character join code and opens a Supabase Realtime
  channel named `quiz-<CODE>`. The lobby also shows a QR code (generated
  entirely client-side via the `qrcode` library, loaded from a CDN — no
  server involved) encoding a direct link like `/join.html?code=ABCDE`.
  Scanning it pre-fills the code on the join form, so students just need
  to add a name and pick a character.
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

## Game modes

The host picks a mode on the "Pick a quiz" screen, before generating the
join code. All five modes share the same quiz bank and the same
host-as-relay architecture above — only the round logic differs.

Right when a game starts, every player sees a quick **"How to play"**
screen for their mode (`MODE_RULES` in `js/join.js`) before the first
question appears — a "Let's go!" button dismisses it early, or it
auto-continues after 8 seconds so nobody gets stuck waiting on it.

### Visual feel

The whole app leans into big, bouncy, arcade energy rather than a flat
quiz form: emoji characters idle-bounce everywhere (lobby, leaderboard,
podium, duels), correct/wrong answers punch in with a scale-pop, a color
flash across the screen, and (for wrong answers) a shake — and the final
podium fires off a confetti burst. None of this needs image assets or a
build step; it's all CSS keyframes plus a couple of small DOM hooks
(`launchConfetti()` in `js/utils.js`). If it still doesn't feel exciting
enough once real students are on it, the next lever up would be actual
illustrated character art (bigger investment — needs generated/commissioned
images, a place to host them, and swapping emoji for `<img>` sprites
throughout).

**🧠 Classic Quiz** — every player answers all the quiz's questions, once
each, in their own shuffled order, at their own pace. Score is the
Kahoot-style speed bonus described below.

**🐍🛗 Eels & Escalators** — a shared 100-square board (visible on the host
screen) that every player is racing across. Correct answers move you
forward; questions are drawn randomly from the quiz bank in batches of 6
(a "round"), and how many of those 6 you got right is how far you move.
Landing on an escalator square boosts you up the board; landing on an eel
sends you sliding back down. First to square 100 wins; once enough
players finish, a 60-second countdown starts so the rest of the class
still gets a defined end point rather than waiting on stragglers.

**🔥 Firewall Duel** — the host continuously pairs up waiting players into
1-on-1 duels. Each duel is a **3-question batch**: both players get the
*same* 3 random questions, and answer them independently at their own
pace, blind — **you don't see either shield while answering**, only a
quick correct/incorrect ping after each question, since the real outcome
depends on comparing both players' answers and isn't known until you've
both finished. A fixed **8-second** timer applies to each question
regardless of what the quiz's own questions are set to. A player who
finishes their 3 before their opponent sees a "waiting for your opponent
to finish" screen — the battle can't resolve until both have answered
all 3.

**Scoring is money, not points** (`p.score` is money here, same idea as
Asteroid Defense but capped lower — up to **$100 per correct answer**,
`calculateDuelMoney()` in `js/scoring.js` — the leaderboard shows it
directly). Once both duelists finish their batch, the host walks through
the 3 questions **in order** (`resolveDuelBattle()` in `js/host.js`):
- Anyone who answered a question correctly earns money for their own
  speed, independent of their opponent.
- Whoever answered correctly **and faster** on that question wins that
  question's "attack" and chips a flat **20%** off the opponent's
  shield — so winning all 3 takes 60% off, like a 3-hit combo. (If the
  faster answer was wrong, the other player wins the attack instead, as
  long as they were correct.)
- The instant a shield hits 0%, the breaker **steals 15% of the broken
  player's money — as it stood at that exact point in the sequence**,
  not their eventual end-of-battle total. The shield then **refreshes
  to 100% immediately and the same battle keeps going** on the
  remaining questions — it doesn't wait for a new matchup, and it can
  break more than once in a single battle if the remaining questions go
  badly enough. Outside of a break, shield level always **carries over**
  into a player's next matchup.

Both players requeue for a fresh opponent once the battle ends — nobody
sits out. `DUEL_QUESTIONS_PER_BATCH`, `DUEL_TIME_LIMIT_SECONDS`,
`DUEL_SHIELD_DAMAGE_PCT` (20), and `DUEL_STEAL_FRACTION` (0.15) are all
named constants near the top of the Firewall Duel section in
`js/host.js` if you want to retune any of them.

**Visuals:** each player's avatar shows inside a glowing circular
"force field" ring whose arc-length and glow strength represent their
current shield % — bright and full at 100%, thinner and dimmer as it
drains, pulsing red once it drops below 20%, with a rotating electric
crackle texture behind it for a more "fluro/energized" feel
(`renderForcefieldAvatar()` in `js/utils.js`, shared by both the host
and student screens so they match).

Once both duelists finish their 3 questions, a **separate full-screen
battle screen** plays as a two-act sequence
(`showDuelBattleCinematic()` in `js/join.js`) — no question UI, just
both avatars: first "You won N attacks!" with N strike (⚡) animations
firing in a row, a floating "-40%"-style shield number, and a floating
lime "+$X" for the money you earned; then the same beats play out for
the opponent's attacks. If a shield actually broke during either act, a
distinct gold **"-$X" stolen-money number floats up from whoever it was
taken from** over about a second, on top of the shield number. The
host's live scoreboard and pairing list use the same force-field
avatars too, so the whole screen matches.

**🦠 Outbreak: Antivirus Grid** — one shared 8×8 grid (64 nodes) lives on
the host screen only — students don't need to see it, they just answer
their own shuffled questions independently, exactly like Classic Quiz.
A correct answer claims a node: it prefers an unclaimed node **next to
territory you already own** (so you naturally grow connected blobs), and
only falls back to a random unclaimed node, then an enemy node, if
there's nothing left nearby. Claiming a node next to your own existing
nodes pays a **chain bonus** (`OUTBREAK_CHAIN_BONUS` in `js/scoring.js`,
per connected same-owner neighbor). Once the grid fills up, a correct
answer can **flip** an enemy node instead — but only if you answered
faster than whoever originally claimed it (a genuine speed comparison
stored per-node, not a coin flip). A failed steal attempt still scores
the normal base points for getting the question right; it just doesn't
take the node. The leaderboard ranks by total points, same as classic
scoring underneath — the grid is what makes the same scoring feel like
territory conquest instead of an abstract number going up. Since students
don't see the grid live, every 5th question they answer triggers a
5-second **board update** on their own screen — a snapshot of the current
grid, sent as part of that answer's own result message rather than a
separate broadcast (`gridSnapshot` in `handleOutbreakAnswer`, `js/host.js`).

**☄️ Asteroid Defense** — unlike every other mode, this one is entirely
**personal**: each student has their own private mini-game running on
their own device, and the host doesn't simulate any of it — it only runs
the normal quiz pipeline (money instead of points) and shows a
leaderboard of wave reached / asteroids destroyed, updated whenever a
student's device reports in. The loop: answer 5 questions (faster
correct answers earn more money) → a 5-second shop to buy or upgrade
weapons → a 10-second wave where asteroids approach a world in the
center and your weapons (fixed to the sphere's surface) auto-fire at
anything in range and in their arc as you **drag to rotate the world**
and bring them to bear. If an asteroid reaches the world, scoring is
suspended for the rest of that wave (per the original spec: "you can't
gain any more points"), though the game keeps running visually. Then
back to 5 more questions, forever escalating (faster spawns, faster
asteroids, more asteroid HP) until the host ends the game — there's no
natural "finish," matching the endless-wave-survival feel.

Weapons: **Blaster** ($50, 1 shot/sec), **Machine Gun** ($150, ~4
shots/sec), **Laser** ($250, 2 shots/sec, longer reach) all need to be
pointed **straight** at an incoming asteroid — their firing arc is
narrow on purpose (8–12°, `arcDegrees` per weapon in
`js/asteroidsGame.js`), no shooting on the diagonal; the **Rocket
Launcher** ($400, fires every 2s) is laser-*guided* — it auto-tracks any
asteroid in range regardless of aim, at the cost of a slow fire rate.
Each weapon upgrades up to level 3 (more damage, faster fire). All the
numbers (costs, fire rates, difficulty scaling per wave) live in
`js/asteroidsGame.js`, in one place, specifically so they're easy to
retune after playtesting.

Rotation control: hold down on the **left half** of the world to spin it
counterclockwise, the **right half** to spin it clockwise — continuous
for as long as it's held, at a fixed speed
(`ROTATION_SPEED_DEG_PER_SEC`, 150°/sec — a full 180° turn takes about
1.2 seconds).

The arena is genuinely **responsive** rather than a fixed pixel size:
the CSS sizes `.ast-arena` to `min(94vw, 480px)` (fills nearly the full
screen width on a phone, capped at 480px on anything wider), and
`createAsteroidsGame()` measures the actual rendered size at creation
time and computes every other measurement — world size, spawn ring,
weapon ring — as a fraction of that. So it fills whatever space it's
actually given on any device, instead of everyone getting the same
small fixed box regardless of screen size.

Asteroids also spawn much further out and travel much slower than
earlier versions — on a typical ~390px-wide phone that's roughly a
4.5–5 second approach at wave 1 (versus about 1.25 seconds in the very
first version), which should be enough time to notice an incoming
asteroid, decide which weapon should take it, and rotate to line it up.
The two things that matter most for this pacing, both in
`js/asteroidsGame.js`: the geometry fractions right after the size is
measured (`OUTER_RADIUS`/`INNER_RADIUS`, currently 0.48/0.09 of the
arena's width) control distance, and `asteroidSpeed` inside `startWave()`
(currently `26 + wave * 5`) controls speed — increase distance or
decrease speed for even more reaction time, or the reverse to make it
more frantic.

This one is a real physics-lite mini-game (rotation input, projectile
travel, collision, difficulty curves) built without being able to
visually test animation feel — **it will almost certainly need some
tuning once real students are playing it on real phones** (spawn
pacing, weapon arc width, weapon balance).
`ROTATION_SPEED_DEG_PER_SEC` and each weapon's `arcDegrees` near the top
of `js/asteroidsGame.js` are the first things to adjust if rotating feels
too slow/fast or aiming feels too strict/loose.

One limitation worth knowing: the 🎭 Pretend Host demo bots will still
correctly earn money by "answering" questions, since that part runs
through the normal host pipeline — but they can't play the actual
asteroid mini-game (there's no real browser tab for a bot), so their
wave/asteroids-destroyed stats on the host leaderboard will just stay at
0. To actually test the mini-game itself, play through `/join.html`
yourself in a real browser tab.

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

## Consistent emoji across every device

The same emoji character looks different on every OS, since there's no
actual image, just a Unicode character each device renders in its own
style. `host.html` and `join.html` both load a small CDN library that
scans the page and replaces emoji characters with actual images, so
everyone sees the same style regardless of device —
`enableConsistentEmoji()` in `js/utils.js`.

This originally used a Microsoft "Fluent Emoji" library (closer to
Windows 11's native look) hosted on a smaller, independent CDN — that
CDN started returning 403 (Forbidden) errors, so it's now **Twemoji**
instead, hosted on jsDelivr (a major, well-established CDN). The visual
style changed slightly (Twitter's flat cartoon look rather than
Microsoft's Fluent style), but it's far less likely to go down. If you
ever want to try a different provider again, it's a two-line change: the
`<script>` src in `host.html`/`join.html`, and the
`window.twemoji.parse(...)` call in `enableConsistentEmoji()`.

Since the leaderboard, roster, and podium all re-render constantly during
a game, a one-time pass on page load isn't enough — a `MutationObserver`
watches for any DOM change and re-scans automatically (debounced, so a
burst of updates only triggers one pass), rather than every render
function needing to remember to call this itself. If the CDN is ever
unreachable for any reason, this fails quietly and emoji just fall back
to each device's native rendering — nothing else in the app depends on
it working.

## Previewing it yourself (no second device needed)

On the lobby screen there's a **🎭 Pretend Host** button — click it to add
6 fake players with bot names/emojis. Click **Start game** as normal and
they'll answer questions automatically (roughly 70% correct, random
timing) every second or so, so you can watch the live leaderboard reorder,
finish the game, and see the podium — all from one browser tab. This
works for all three modes, including Firewall Duel (bots will queue up
and duel each other, and you if you're playing along from `/join.html`).

This is entirely self-contained and safe to delete once you're done
testing:
- Remove the block in `js/host.js` between the `PRETEND HOST — DEMO MODE`
  and `END PRETEND HOST DEMO MODE` comments.
- Remove the two one-line "demo hook" calls (`startDemoAnswering()` in
  `startGame()`, `stopDemoAnswering()` in `endGame()`) — they're commented
  so you can find them.
- Remove the button block in `host.html` between the
  `<!-- PRETEND HOST DEMO -->` and `<!-- END PRETEND HOST DEMO -->`
  comments.

Fake players never touch Supabase or the real join code — they're purely
local to your browser tab, so this costs nothing and real students
connecting to the same game code would just see them as regular players
in the lobby.

## What's next (per your roadmap)

- **More game modes.** Firewall Duel (🔥), Outbreak: Antivirus Grid (🦠),
  and Asteroid Defense (☄️) are built; two other concepts were pitched
  alongside them and are still on the table if you want more variety
  later: a fully cooperative class-vs-boss mode ("Meteor Storm") and
  team-based play with bankable gadgets ("Heist Crew"). Each new mode
  follows the same recipe: a `mode-<name>` tab, mode-only state alongside
  the existing `board`/`duel`/`outbreak` state blocks in `host.js`, a
  `start<Name>Game()` dispatched from `startGame()`, a
  `handle<Name>Answer()` dispatched from
  `handleAnswer()`, and matching screens/handlers in `join.js`.
- **Persisting final results** to a `game_results` table (optional, only
  written once at game end — still cheap) so you can review past games.
- **Reconnect support**: persist `{code, playerId, name, emoji, score}` to
  `sessionStorage` so a refreshed tab can rejoin its game in progress.
- **Password reset / self-service** for teacher accounts — right now an
  admin sets a temporary password directly; there's no "forgot password"
  email flow yet.
