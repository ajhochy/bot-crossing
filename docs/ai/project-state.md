# Project state

## Current focus
Overview counts, selected task-card cleanup and exact Codex/Rhythm Electron opening.

## Active branch / PR
`codex/overview-and-thread-opening`, based on `codex/rhythm-session-graph`; follow-up fork draft [#4](https://github.com/ajhochy/bot-crossing/pull/4). Prior fork draft stack remains [#1](https://github.com/ajhochy/bot-crossing/pull/1),
[#2](https://github.com/ajhochy/bot-crossing/pull/2), [#3](https://github.com/ajhochy/bot-crossing/pull/3).
The approved Rhythm receiver is [draft PR #1538](https://github.com/ajhochy/Rhythm/pull/1538) on its own `codex/electron-session-opening` branch.

## Completed locally
Code, rendered UI and native opening are verified. Draft #4 is published without merging;
the Dev Dashboard run was recorded at revision 4218. Bot Crossing is serving the current built
UI and native-opening server on its existing loopback port. The separate Rhythm receiver draft is
published. Its broad gate failed in three unchanged packages (API trigger parity, fork interrupted
output and mobile edited-title visibility); causes remain uninvestigated and recorded in that PR.

## Risks / known issues
Terminal resume remains unqualified end to end. The shipping Rhythm Flutter app has no external
session link; only an explicitly configured, running patched Electron profile enables opening.
No signed Electron package or release qualification is claimed. Persisted Rhythm activity is not a
live heartbeat. Existing build chunk-size warning remains.

## Test status
185/185 tests, production build, changed-module syntax and whitespace checks pass. Live API smoke
returned 15,493 unique sessions and no warnings. Rendered default/historical overview, details,
parent navigation and desktop/mobile action layouts pass. Installed Codex exact worker and parent
routes pass through the real Open path. Rhythm native sandbox cold/second-instance selection passed;
13 focused receiver contracts and native live exact-target switching now pass. Live main/API/engine
process IDs stayed unchanged. Updating an already running renderer required one Reload and normal
Google sign-in under existing host security policy.
The shared workflow wrapper fails on its assumed absent typecheck script; repo-native documented
checks were used directly. No GitHub Actions workflow exists.

## Review handoff
The stacked fork drafts are ready for review; no merge has been performed.
Detailed evidence: [run report](runs/2026-09-18-overview-opening.md).
The packaged Colony integration and native UI/menu plan is tracked separately in [Rhythm epic #1525](https://github.com/ajhochy/Rhythm/issues/1525), with four milestones and twelve implementation issues.

## Recent coding-agent runs

### 2026-09-24 — COL-01 embedded artifact builder
- Files modified: `package.json`, `.gitignore`, `tools/build-rhythm-embedded.mjs`, `server/embedded-host.mjs`, `server/embedded-preload.cjs`, `licenses/`, and `test/rhythm-embedded-build.test.mjs` add the sealed upstream artifact; `docs/ai/contracts/issue-1526.json` is the reviewed acceptance contract.
- Checks run: builder contract 4/4 pass; synthetic adapter/grouping suite 89/89 pass; production `npm run build` pass; local artifact 38 sealed files and 6,841,476 licensed asset bytes. Details: [run evidence](runs/2026-09-24-colony-embedded-artifact.md).
- Decisions made: preserve the existing scanner-backed `/api` implementation in an importable host entry, require a caller-owned absolute data directory, and allow a dirty artifact only when `dirty` and `sourceDirty` are both true.
- Deviations from spec: none for the bounded upstream builder; Rhythm pin and receiver remain the parent integration scope.
- Concerns: the local artifact is dirty because this worktree is uncommitted; clean pinned revision and native Electron behavior remain unverified.

### 2026-09-24 — COL-02 private embedded service
- Files modified: `server/embedded-service.mjs` adds an instance-owned inventory and state service; `server/embedded-host.mjs` delegates to it without HTTP or process-global paths; `server/embedded-preload.cjs` states the remaining receiver boundary; `test/embedded-service.test.mjs` covers bounded reads, writes and refusals; `docs/ai/contracts/issue-1527-service.json` records focused criteria.
- Checks run: RED contract 0/4 before implementation; focused service 8/8 pass; artifact builder and service 11/11 pass; full `npm test` 196/196 pass; `npm run build` pass; syntax checks pass.
- Decisions made: require an injected scanner so construction stays inert; keep each profile's generations and transfers instance-owned, while serializing writes by exact owned state path.
- Deviations from spec: none for the private service seam. Renderer data adapter, native channel, packaged worker and real Electron test are pending.
- Concerns: standalone HTTP behavior passed existing tests but has not been refactored to call this new service; native private IPC and large-state renderer adaptation remain unverified.

### 2026-09-24 — COL-02 disposal and frame limit review repair
- Files modified: `server/embedded-service.mjs` revokes in-flight scan/write work after disposal and uses the actual cursor in page sizing; `test/embedded-service.test.mjs` adds disposal and one MiB boundary regressions.
- Checks run: disposal RED 0/2 and cursor boundary RED 0/1 before repair; focused service 11/11 pass; service, builder, and standalone state 33/33 pass; `npm run build`, syntax, and diff whitespace checks pass. Evidence: `/private/tmp/rhythm-repair4/colony-service-disposal-repair-tests.log` and `colony-service-disposal-repair-build.log` in the same directory.
- Decisions made: check instance liveness after awaited work and commit state by synchronous atomic rename so disposal cannot interleave between the final check and commit.
- Deviations from spec: no private channel or native receiver added in this repair.
- Concerns: standalone HTTP still does not consume the shared service, and native IPC, profile ownership, and packaged behavior remain unverified.

### 2026-09-24 — COL-02 shared state extraction
- Files modified: shared state model/store consumed by HTTP and embedded adapters, opaque-field conflict merge, and parity tests. Details: [contract and verification](runs/2026-09-24-colony-shared-state-contract.md).
- Checks run: original RED 3 fail / 5 pass; focused 42/42; full npm test 213/213 including builder fixtures; production build and changed-source syntax checks pass.
- Decisions made: explicit HTTP compatibility mode; embedded strict validation and liveness retained; unknown fields use whole-value three-way conflict resolution with changed local value winning.
- Deviations from spec: no native receiver work in this bounded extraction. GitNexus impact unavailable because Bot Crossing is not indexed.
- Concerns: private child IPC and embedded scene adapter remain unverified; shared queue is process-local, not an OS-level cross-process CAS.
