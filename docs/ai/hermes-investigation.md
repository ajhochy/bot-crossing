# Hermes compatibility and Claude identity investigation

Date: 2026-09-18. Scope: read-only inspection of adapter source, synthetic test stores, and
aggregate schema/lifecycle metadata from installed harness stores. No prompt or transcript content
was recorded, and no harness-owned file was changed.

## Hermes findings

- Hermes upgrades profiles independently. The installed sample has 17 readable stores. Nine older
  named profiles lack `sessions.hidden`; newer stores have it. Every sampled store retains the
  other fields currently used by the adapter, and every sampled `messages` table has `active`.
- The former fixed query required `s.hidden`, so the first old profile raised during `prepare()`.
  That exception escaped the profile loop and the harness-level scanner correctly isolated the
  entire Hermes adapter, which unfortunately meant zero Hermes threads instead of partial results.
- `ended_at IS NULL` is not running evidence. The live aggregate contains 1,455 open-ended rows,
  including 667 old ACP rows with no messages. Hermes's own durable `session_turn_leases` table is
  held around load -> run -> flush, refreshed during long turns, expires after owner failure, and
  is released in the turn finalizer. It is positive activity evidence. Absence of a live lease on
  an open-ended row is unknown, while non-null `ended_at` is quiet/completed evidence.
- Hermes's separate `runtime/active_sessions.json` registry is unsuitable for the running flag: its
  source explicitly says it tracks open chat surfaces, including idle CLI/TUI sessions.
- Cron rows are scheduled executions rather than talkable threads. Five existed in the sampled
  default store. The compatibility scan returned 2,077 non-cron threads across all 17 profiles and
  returned no diagnostic. Excluding those five rows did not hide any profile that also had a
  conversational row.
- `main` is Bot Crossing's existing pilot key and participates in thread ids and saved state. Hermes
  calls that profile `default`. The adapter therefore preserves `pilot: "main"` and ids such as
  `hermes:main:<session>`, while exposing `profile: "default"`. Named profile ids are unchanged in
  both fields.

## Implemented adapter behavior

- Build the SELECT, hidden predicate, message preview predicate, cron predicate, and turn-lease
  expression from each database's `sqlite_master` and `PRAGMA table_info` capabilities.
- Treat `sessions.id` as the one required column; optional missing fields receive neutral aliases.
- Catch open/query failures per profile, continue scanning later profiles, warn with the pilot id,
  and expose the same sanitized failures from `diagnostic()` for `/api/harnesses`.
- Emit `running: true` / `activity: "active"` only for an unexpired matching durable turn lease;
  emit `false` / `quiet` for an ended row; emit `null` / `unknown` for open rows without proof.
  `activityEvidence` records `turn-lease`, `ended`, or `unavailable`.

## Regression fixtures

`test/hermes-compat.test.mjs` uses temporary SQLite stores only:

1. Current main schema plus an older profile without `hidden`; both visible rows survive and a
   current-schema hidden row stays excluded.
2. A malformed profile between valid stores; later stores still scan, and both warning and harness
   diagnostic name the failed pilot.
3. Unexpired lease, expired lease, open-ended/no-lease, and ended rows; only the live lease is
   active, open-ended uncertainty stays explicit, and ended is quiet.
4. Cron plus conversational rows and named profile rows; cron is excluded, `main` ids remain stable,
   and canonical Hermes profile identity is present.

The pre-implementation run failed 4/4 as expected (`s.hidden`, missing `messages`, absent activity
evidence/profile identity). The post-implementation run passed 4/4.

## Claude identity gotchas for the project resolver work

- The adapter must keep `cwd` as the exact folder the session actually ran in because terminal
  resume uses it. `projectPath` and `worktree` are grouping labels and must not overwrite `cwd`.
- In 789 installed desktop records inspected structurally, every record had `cwd` and `originCwd`.
  There were 599 plain records where the paths matched and 190 standard
  `.claude/worktrees/<name>` records where `originCwd` matched the repository root. This supports
  the current split: worktree `cwd`, root `projectPath`, parsed worktree name.
- Only 73 records had explicit `worktreePath` and `worktreeName`, so those fields are useful
  confirmation when present but cannot replace the path fallback. CLI transcripts do not carry
  either field; their observed metadata carries absolute `cwd`.
- A plain arbitrary working directory is legitimate. Keep `projectPath = cwd` and `worktree = ''`
  at the adapter seam; the shared Git resolver can later discover a containing repository or keep
  it explicit as non-Git. Guessing a repository in the Claude adapter would duplicate that logic.
- The encoded CLI project-directory fallback is lossy because `-` represents path separators;
  prefer transcript `cwd` whenever present, as the adapter already does.
- Duplicate desktop records are merged by CLI session id. `mergeThread()` explicitly preserves one
  `cwd` but allows spread order to choose `projectPath`; if duplicates can disagree, those fields
  can become internally inconsistent. A future Claude identity patch should merge the identity
  tuple atomically and cover the case with a fixture.
- Suggested Claude fixtures: plain arbitrary absolute cwd; standard worktree with origin root;
  explicit `worktreePath`/`worktreeName`; CLI-only worktree; missing transcript cwd fallback; and
  duplicate desktop records with conflicting identity fields.
