---
date: 2026-09-18
repo: bot-crossing
branch: codex/rhythm-session-graph
pr: draft stack
issues: []
status: validated-locally
tags: [run, bot-crossing]
index: "[[bot-crossing]]"
---

# Multi-harness implementation verification

## Files changed

Shared Git identity resolver and Bot Crossing state migration; project/checkout inspector and filters; Codex durable worker graph and lifecycle parser; Hermes capability-probed profile queries; dedicated Rhythm graph and OpenCode deduplication. The colony rendering, materials, and art remain intact.

## Checks run

- `npm test`: 172 tests passed across synthetic harness databases/rollouts, temporary Git repositories, real loopback state API, conflict merges, and corrupted-state preservation.
- `npm run build`: passed. Vite retains its existing large bundle advisory; no lint/typecheck configuration or GitHub Actions workflow exists.
- Changed modules: `node --check`; `git diff --check`.
- `BOT_CROSSING_LIVE_URL=http://127.0.0.1:5287 node tools/verify-live.mjs`: PASS against the production Node server and actual local stores. 15,475 unique sessions, 408 projects, 573 checkouts, zero harness warnings. Initial HTTP scan 13,710 ms; immediate warm scan 3,645 ms. Git phase 1,126 / 105 ms, 43 / 0 commands; cold status probes capped at 12 and concurrent Git at 4. Samples reflect one machine under load, not a latency guarantee.
- Live record counts: Claude 1,917; Codex 886 roots + 397 workers; Hermes 2,077; Rhythm 5,968 roots + 2,173 workers; standalone OpenCode 1,970 roots + 87 workers. Proven Rhythm engine aliases appeared once.
- Live browser: full-history search remains responsive; the current project shows one Codex parent and its three workers with no browser errors. Worker metadata enrichment found nicknames for all 397 Codex children and removed 97 otherwise untitled worker labels.
- Rendered synthetic browser: same-name clone separation; main and arbitrary worktree grouping; cross-harness shared checkout; dirty/clean/missing states; group/reset and reload persistence for both occupied and unused worktrees; exact selected cwd; nested worker and archived parent navigation; harness/status filters; disabled unsupported opening; mobile and desktop cards. Captures kept locally at `/tmp/bot-crossing-final-desktop.png` and `/tmp/bot-crossing-final-mobile.png`, not committed.
- Preview server interruption: scan warning appeared, formerly active agents became unknown, a failed grouping save did not persist, and recovery restored the original grouping/activity.

## Repairs found during verification

The baseline no-CLI tests accidentally discovered the installed Codex CLI; an explicit empty override makes fixtures hermetic. The first rendered pass revealed CSS overriding hidden buttons; the global hidden rule fixed it. The real combined endpoint exposed synchronous diagnostics being treated as promises; regression coverage now accepts both. Review caught unused-checkout selection, repeated alias migration after unarchive, quadratic legend counting, stale engine double counts, and corrupt identity-cache overwrite. Those were repaired and covered by regression tests or repeated rendered interaction. An API corruption test initially reached installed stores before rejecting the cache; it now supplies an empty temporary fixture, including in the foundation PR. No unresolved regression was filed as a follow-up issue.

## Evidence boundaries and limitations

Lifecycle completion/interruption/partial-write transitions were tested with synthetic records. Live discovery confirmed current Codex activity and hierarchy, but no additional production tasks were started to force every transition. The installed Codex CLI help verified exact resume syntax and cwd/UUID arguments; a terminal was not resumed end to end. The app's own navigation API selected a worker and restored its parent, but the OS deep link could not be verified, so Bot Crossing disables that desktop action. Rhythm has no verified external per-session opener, and its button explicitly says unavailable. Its offline evidence is persisted SQLite status, not a process heartbeat. The observed Rhythm services were a source runtime; installed packaged behavior was not qualified or restarted.

Git status is bounded and explicitly unknown until inspected for historical checkouts. Missing paths retain prior cached identity; moving an entire clone/common Git directory cannot be inferred safely and may require explicit grouping. Ambiguous legacy layout names are retained for review instead of guessed; old keys are never deleted. Historical OpenCode prompt previews and exact transcript byte totals beyond the newest 200 sessions are omitted from list scans. No cleanup recommendation or deletion workflow is introduced.
