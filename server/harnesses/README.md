# Harness adapters

A **harness** is whatever runs the agent threads you want to see as bots — Claude Code,
Codex CLI, OpenCode, and so on. Bot Crossing does not care which one you use: it asks every
harness present on the machine for its threads and draws whatever comes back.

Adding one is meant to be **one new file in this directory**, plus one line in `index.mjs`.
Nothing in `server/scan.mjs`, `server/api.mjs`, or anywhere under `src/` should need to change.
If you find yourself editing those to land a harness, that is a bug in this seam — please say so
in the PR, because the next person will hit it too.

The current registry supports Claude Code, Codex, Cursor, Antigravity, Hermes, Kilo Code,
Rhythm and OpenCode. Support means their local session evidence can be drawn; reopening is a
separate capability. In particular, Codex desktop UUID targeting and Rhythm external session
navigation are unavailable. Codex can provide exact CLI resume syntax when its CLI exists, but
terminal launch has not been verified end to end.

## Project and session model

Adapters report the exact session `cwd` and their best project label. The resolver then uses
canonical Git common-directory evidence for the stable project ID and canonical worktree roots
for checkout IDs. Linked worktrees share a project, independent clones stay separate, and an
unknown or missing path remains explicit. Bot Crossing's grouping overrides and identity cache
live only in its own `data/` directory.

Return durable workers as ordinary threads with `parentId`. This makes one flat graph that can
represent nested, orphaned and archived-parent cases without duplicating a child. `running` and
`unread` are nullable: lack of evidence is `null`, accompanied by `activity: 'unknown'` and a
short `activityEvidence`, rather than a guess.

## The shape of it

```js
// server/harnesses/my-harness.mjs
export default {
  id: 'my-harness',              // stable, kebab-case, used as a key — never change it later
  name: 'My Harness',            // what a human sees in the UI
  detect,                        // () => Promise<boolean>
  scanThreads,                   // () => Promise<Thread[]>
  openThread,                    // (ref) => { ok, url, command? } | { ok: false, error }
  newSession,                    // (dir) => { ok, url, command? } | { ok: false, error }
}
```

Then, in `index.mjs`:

```js
import myHarness from './my-harness.mjs'
export const HARNESSES = [claudeCode, myHarness]
```

### `detect()`

Is this harness on this machine at all? Usually just "does its data directory exist". Cheap —
it runs on every scan, so that installing a harness while the colony is open is noticed on the
next poll. Returning `false` means the harness is skipped entirely, and no bot for it
ever appears.

### `scanThreads()`

The real work: return one `Thread` per session the harness knows about.

Throwing is survivable — the scanner logs it and carries on with the other harnesses, so one
broken adapter costs you its own threads and nothing else. Prefer that over returning junk.

### `openThread(ref)` / `newSession(dir)`

Return `{ ok: true, url }`, `{ ok: true, command }`, both, or `{ ok: false, error }`.
`openThread` gets the `ref` from the thread it belongs to; `newSession` gets an absolute
directory that the server has already checked still exists. An app URL should only be exposed
as an available capability when it targets the intended thread reliably.

Add `command: { argv, cwd }` — the harness's own CLI resuming the same thread, with an absolute `argv[0]` —
when the CLI is installed, and the server runs it in a terminal for a machine with no desktop app or a person who asked for one.
Never spawn it yourself.

If your harness has no verified opener, return `{ ok: false, error: '…' }` and say why — the UI
shows the reason rather than pretending the click worked. Codex currently offers its documented
`codex resume <id>` CLI shape when the executable is installed, while exact desktop UUID
targeting remains unavailable; the terminal launch path has not been verified end to end.
Rhythm has no verified external per-session opener.

### There is no `setArchived`, and that is deliberate

Bot Crossing does not write to a harness. Not the transcripts, not the session records, not one
flag. Archiving is recorded in `data/colony.json` and nowhere else: the thread leaves the map and
the bot walks back to the ship.

It used to write one flag — `isArchived` on Claude Code's own session record — and that write
genuinely landed on disk. It just did not *mean* anything: the desktop app serves from the copy it
loaded at launch, so the thread stayed in its list until the app restarted, and the app rewrote the
record from memory the next time it touched the thread. Holding that together took a re-assert on
every scan, a `ps` sweep to guess whether the app had re-read the file, and a *pending* state for
the gap between them. All of that is gone. Harness scans do not start harness executables;
project resolution may run bounded, read-only `git worktree list` and `git status` subprocesses
with optional locks disabled.

Archiving in the harness's own UI still works and is still the right way to do it — your adapter
reports it through the `archived` field and the bot goes home on the next poll.

## The `Thread` your adapter returns

Only `id` is truly required, but the colony gets duller the more you leave out. An adapter's
`project` is its best human label before project resolution. After `/api/threads` resolves Git
evidence, `project` and `projectId` are the stable opaque project identity, while `projectName`
is the label shown to people and `legacyProject` retains the adapter value.

| Field | Type | What it means |
| --- | --- | --- |
| `id` | string | **Unique across every harness.** A UUID is fine; otherwise prefix it, e.g. `my-harness:1234` |
| `title` | string | Thread title. `'Untitled thread'` if the harness has none |
| `preview` | string | First prompt, trimmed — shown on the thread card |
| `project` | string | Adapter-provided repo/folder label. The resolver replaces it with stable identity in the API response |
| `projectPath` | string | Absolute path to the repo root |
| `worktree` | string | Worktree name, or `''` |
| `cwd` | string | Exact directory where the thread is actually working; keep it even when nested in a checkout |
| `gitBranch` | string | Branch name, or `''` |
| `model` / `effort` | string | Shown on the thread card |
| `createdAt` | number | Epoch ms |
| `lastActivityAt` | number | Epoch ms. Sorts the colony and drives the "asleep for 3 days" behaviour |
| `lastFocusedAt` | number | Epoch ms, `0` if unknowable |
| `activity` | `'active' \| 'quiet' \| 'unknown'` | Normalized activity conclusion |
| `activityEvidence` | string | Concise source for that conclusion |
| `running` | boolean \| null | `true` only with current positive evidence; `null` when activity is unknowable |
| `unread` | boolean \| null | Moved on since last focus, or `null` when the harness has no focus/read evidence |
| `hasError` | boolean | Errored — the bot slumps, red eyes |
| `starred` / `routine` / `prState` | | Optional extras; `prState: 'merged'` triggers the confetti |
| `archived` | boolean | Archived in the harness's own records. Read-only — reporting it is all an adapter does |
| `sizeBytes` | number | Transcript size. **This is how finished a building looks**, on a log scale |
| `source` | string | Free-form, for your own bookkeeping (the Claude adapter uses `desktop` / `cli`) |
| `canOpen` | boolean | Whether this thread can be opened. The UI greys the button out |
| `openCapabilities` | object | Optional app/terminal availability, verification and unavailable reasons |
| `parentId` | string \| null | Prefixed thread ID of the parent task. Every worker is a normal thread in one flat graph |
| `orphaned` | boolean | Parent evidence exists but that parent is not present in this scan |
| `subagents` | array | Legacy compatibility for transient errands. New durable worker integrations should return each child once as a thread with `parentId` |
| `ref` | object | **Opaque.** Whatever *you* need to find this thread again |

### About `ref`

`ref` is the whole reason the browser does not know what a session id looks like. Your adapter
puts whatever it needs in there, the page hands it straight back on open, and
nothing between the two ever inspects it.

Keep it small and keep it serialisable — it makes a round trip through JSON on every action.
Do not put a file handle, a class instance, or a secret in it.

## Ground rules

- **Read-only. No exceptions.** Bot Crossing writes only its own `data/colony.json` preferences
  and `data/identities.json` identity cache. A harness's transcripts and records are somebody's
  actual work; the colony is a viewer, not an editor. If an adapter seems to need a write, it
  does not — say so in an issue.
- **Never run anything out of another application's bundle.** Not to read from it, not to
  execute it. Only files under the user's own home directory. Opening a thread goes through a
  URL the OS resolves, or a command the user already has on `PATH`.
- **Never block the scan.** It runs on a poll. Cache anything expensive against file mtime —
  see `transcriptMeta` in `claude-code.mjs`, which is what keeps a 12MB transcript from being
  reparsed every few seconds.
- **Read heads, not whole files.** `readHead` in `../lib/fsutil.mjs` pulls the first chunk and
  drops a trailing partial line, so `JSON.parse` never sees half a record.
- **Expect malformed data.** A session being written *right now* is a normal thing to trip
  over. Skip that record and move on; do not throw the pass away.
- **Never widen `id` collisions.** The colony keys its archive list and saved layout on `id`.
  Two harnesses handing back the same id would merge two unrelated threads into one bot.

## Starting points

Verified on a real machine:

- **Claude Code** — desktop records in
  `~/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/local_*.json`
  (`%APPDATA%\Claude\claude-code-sessions\…` on Windows), and in the same folder a
  `deleted_<cliSessionId>` marker for every thread deleted in the app, holding the deletion time
  in epoch ms — the record goes, the CLI transcript stays, and the marker is all that tells a
  deleted thread from one started in a terminal, so the adapter reports it as `archived`; CLI
  transcripts in `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`; live processes in
  `~/.claude/sessions/*.json`. `CLAUDE_CONFIG_DIR` (the CLI's own override for `~/.claude`) and
  `BOT_CROSSING_CLAUDE_DESKTOP` (the session store) point both roots elsewhere, which is how
  `test/harness.test.mjs` fakes an install. Implemented in `claude-code.mjs`.
- **Codex** — read-only thread metadata from the newest compatible `~/.codex/state_<n>.sqlite`
  plus rollouts in `~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl`. The adapter joins
  them by session UUID, retains CLI-only rollouts, builds a flat parent graph and uses bounded
  lifecycle evidence. Implemented in `codex.mjs`.
- **Hermes** — one SQLite store per pilot profile. The adapter probes schema capabilities per
  profile, isolates profile failures, excludes cron rows and treats only an unexpired turn lease
  as positive running evidence. Implemented in `hermes.mjs`.
- **Rhythm** — read-only persisted session/profile rows with parent-worker relationships and
  bounded status evidence. It deliberately reports external per-session navigation unavailable.
  Implemented in `rhythm.mjs`.

For anything else, the fastest way in is usually to start a throwaway session in that harness
and watch which files change:

```bash
find ~ -maxdepth 4 -newermt '-2 minutes' -type f 2>/dev/null | grep -iv Library/Caches
```

## Checking your work

Run the existing suite first:

```bash
npm test
```

Adapter fixtures use temporary synthetic stores and must never point at or modify a real harness
database. A new adapter should also clear these focused checks:

1. `node --check server/harnesses/my-harness.mjs`
2. With the app running, `GET /api/harnesses` lists every registered harness and whether
   `detect()` found it. If yours is missing or `detected: false`, stop here — nothing else
   will work until it shows up:

   ```bash
   curl -s localhost:5274/api/harnesses
   ```
3. Scan straight from node and look at the result — the number should match what the harness
   itself reports, and no field should be `undefined`:

   ```bash
   node -e 'import("./server/scan.mjs").then(async m => {
     const t = (await m.scanThreads()).filter(x => x.harness === "my-harness")
     console.log(t.length, "threads"); console.dir(t[0], { depth: 4 })
   })'
   ```
4. `npm run dev`, then confirm the bots appear on the right plots, the thread card fills in,
   unknown activity stays labeled unknown, and available/unavailable Open behavior matches the
   adapter's declared capability.
5. Archive one thread and confirm only Bot Crossing's `data/colony.json` changes. Harness files
   must remain unchanged.
