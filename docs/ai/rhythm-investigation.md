# Rhythm adapter investigation

## Scope and runtime boundary

The investigation was read-only. It did not start, stop, or adopt either Rhythm service and did
not write the Rhythm or OpenCode databases. The observed listeners on ports 4001 and 4096 belonged
to a source checkout runtime: the API reported `commit: dev`, and the process paths resolved inside
the Rhythm repository. `/Applications/Rhythm.app` was present as version 0.18.64, but it was not
launched or treated as the owner of those processes. Installed-app behavior therefore remains a
separate qualification gate.

The adapter reads the persisted SQLite store directly so the colony still has data when the API or
engine is unavailable. The default macOS path is
`~/Library/Application Support/Rhythm/rhythm.db`; `RHYTHM_DB` is a whole-path fixture override.
Every SQLite open uses `{ readOnly: true }`. Schema discovery uses read-only `sqlite_master` and
`PRAGMA table_info(...)` queries only; there are no PRAGMA assignments, migrations, transactions,
or transcript writes.

## Durable identity and hierarchy

Rhythm has two session identities. `agent_sessions.id` is the local Rhythm id and
`agent_sessions.sdk_session_id` is the durable OpenCode engine id. The source model calls the
profile id and engine agent name distinct authoritative fields
(`apps/api_server/src/models/agent_session.ts:46-58`) and documents the SDK mapping
(`apps/api_server/src/models/agent_session.ts:75-86`). Creation records the in-memory mapping and
persists the same SDK id before returning the durable row
(`apps/api_server/src/controllers/agent_sessions_controller.ts:1057-1080`).

`parent_session_id` is a local Rhythm id, not an engine id
(`apps/api_server/src/models/agent_session.ts:109-115`). The repository recursively attaches every
descendant and links each child through that local id
(`apps/api_server/src/repositories/agent_sessions_repository.ts:327-363`). Child engine events are
upserted by SDK id and inherit project/worktree scope while retaining their specialist engine agent
identity (`apps/api_server/src/repositories/agent_sessions_repository.ts:419-516`). If the child
event arrives before its parent mapping, Rhythm queues and later drains a durable pending edge
(`apps/api_server/src/repositories/agent_sessions_repository.ts:1209-1284`).

The Bot Crossing representation is therefore one flat thread per `agent_sessions` row:

- `id`: `rhythm:<local id>`
- `parentId`: `rhythm:<local parent id>`
- `agentName` / `engineAgentId`: the row's engine agent name
- `profileId`: `agent_configs.id`; `profile`: joined human label with stable fallbacks
- `ref`: exact local id, mapped SDK id, and exact session cwd
- checkout: durable `cwd`, `worktree_name`, `worktree_path`, and `worktree_branch`

Malformed missing parents remain visible with `orphaned: true`. One deterministic edge is removed
from a corrupt cycle so recursive consumers terminate.

## Engine deduplication

The live aggregate contained 8,141 Rhythm rows: 5,968 local roots and 2,173 local children. Of
7,954 rows with an SDK mapping, 7,952 still existed in the OpenCode store and there were no
duplicate SDK mappings. At least 2,156 child edges matched the engine parent edge exactly; one
local child mapped to an engine root, one engine-side child parent was null, and 16 differed. The
OpenCode store also contained 1,970 unclaimed roots and 87 unclaimed children.

Those counts rule out filtering OpenCode by installation or by directory. Each emitted Rhythm row
instead carries `dedupeIds: ['opencode:<sdk id>']` only when its own durable mapping is present. The
scanner collects those claims from current or retained Rhythm rows and removes matching raw
OpenCode rows. The claim field stays on the response because preference migration needs the engine
alias. When a retained Rhythm observation is stale but its mapped OpenCode row is current, the
scanner keeps the stable Rhythm local id, profile, checkout, and parent graph while overlaying the
engine row's activity, error, and activity time with explicit stale-metadata evidence. This keeps
exactly one record during a Rhythm adapter failure. If Rhythm has never scanned successfully, it
has no retained claims and every standalone OpenCode row remains. Claims must be collected from
children as well as roots because one observed Rhythm child mapped to an engine root.

The generic OpenCode adapter now emits both roots and children with their engine `parent_id`. Its
cold scan uses one indexed latest-message pass, bounded indexed error batches, and exact byte totals
for only the 200 most recently updated sessions. Historical prompt previews and old transcript byte
totals are omitted from list scans instead of scanning the multi-gigabyte store during the colony
request. The engine session title remains the compact list label; no transcript detail endpoint is
introduced by this work.

## Activity and offline behavior

Rhythm persists `starting`, `working`, `idle`, `resumable`, `closed`, and `error` statuses
(`apps/api_server/src/models/agent_session.ts:22`). Live `busy` and `idle` engine events update that
row (`apps/api_server/src/services/opencode_stream_bridge.ts:1661-1713`), and final assistant output
updates `last_preview` plus `last_activity_at`
(`apps/api_server/src/repositories/agent_sessions_repository.ts:1012-1018`). Because the database can
outlive the process that wrote `working`, the adapter treats a recent `starting`/`working` row as
running for at most 30 minutes. An older active status becomes `activity: unknown` and
`running: null`; it never stays active forever. Persisted non-running statuses become quiet, and
`error` also sets `hasError`.

No API request is needed for this fallback. The evidence label explicitly says that activity came
from persisted Rhythm status. The adapter caches a successful scan against both the main database
and WAL size/mtime signature and returns a defensive copy on unchanged polls. Missing files,
unsupported SQLite, read-only open failure, and incompatible required columns degrade to an empty
Rhythm result with a harness diagnostic, leaving other harnesses available.

## Navigation

No verified external per-session navigation exists. Neither the checked-in macOS Info.plist nor
the installed app Info.plist defines `CFBundleURLTypes`, and `AppDelegate.swift` has no URL-open
handler. Rhythm does have an internal notification payload `agentSession:<local id>` that selects
the Agents screen and session inside the running Flutter process
(`apps/desktop_flutter/lib/app/core/layout/app_shell.dart:142-171`), but that string is not an OS URL
scheme.

The adapter consequently reports `canOpen: false`, marks app and terminal capabilities unavailable,
and returns a specific refusal from `openThread`. It also refuses `newSession`. A future verified
deep link can replace this without changing stored refs.

## Verification evidence

Synthetic fixtures cover a root, child, grandchild, orphan, profile/engine identity, exact
checkout, proven SDK claims, stale activity, errors, offline operation, read-only database bytes,
standalone OpenCode children, and unavailable navigation. On the observed stores after the bounded
query change:

- Rhythm: 8,141 rows, 276 ms cold and 5 ms warm.
- OpenCode: 10,009 rows, 520 ms cold and 6 ms warm.

These timings are single local samples, not release targets. They contain counts and elapsed times
only; no titles, prompts, transcript text, session ids, or private profile content were recorded.
