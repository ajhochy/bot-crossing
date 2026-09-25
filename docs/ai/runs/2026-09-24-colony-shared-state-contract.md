# Colony shared state extraction: acceptance contract

Scope: issue #1527, supporting existing `issue-1527-service-c5`. Tests and proposal only; no product implementation, commits, scans, app launch, or real user state access.

## Observed RED

`node --test test/shared-state-parity.test.mjs`: **3 fail, 5 pass**. Assertions fail, not imports or setup.

- HTTP reading a valid version 3 file discards an unrecognized nested field.
- HTTP conflict/retry and embedded conflict/retry discard that same field. The embedded failure isolates the shared `mergeState` known-field projection: its initial read and ordinary save preserve unknown fields, but the merge does not.
- Both adapters preserve legacy UUID migration, archive removal plus concurrent addition, and reject the stale save without changing saved bytes.
- The actual standalone scene client refuses saves before a successful initial read, including after a failed read, without sending a write request.
- HTTP's existing no-base curl compatibility passes. Embedded still refuses missing bases and creates no saved file.

RED log: `/private/tmp/colony-shared-state-contract-red.log`.

Existing `node --test test/embedded-service.test.mjs`: **11/11 pass**, including parent disposal and frame-size repairs. Log: `/private/tmp/colony-shared-state-existing-service.log`.

## Proposed extraction boundary

1. Extract a shared state model module: default fields, legacy UUID migration, and known-field normalization. Retain unknown JSON fields as opaque data. Explicitly separate HTTP's historical coercion from embedded strict shape validation; never make embedded inherit the tolerant HTTP path. Transport-only `baseUpdatedAt` must not become persisted future state.
2. Extract an instance-created state store with an explicit absolute data directory and a shared per-file queue. Reuse the embedded bounded no-follow reads, saved-byte fingerprints, atomic temporary-file commit, and monotonic `updatedAt` stamp. Expose read and compare/write operations; parameterize the HTTP legacy missing/zero-base exception explicitly. Keep embedded `ensureActive` checkpoints at every awaited stage and directly before synchronous rename. A generic extraction must not erase the existing disposal guarantee.
3. HTTP retains its origin checks, routes, JSON response shapes and 409 response containing current state. Only replace its duplicated state read/write internals. Standalone thread opening and new-session routes remain untouched. Embedded retains method allowlisting, control/frame/aggregate limits, chunk staging, generation ownership and disposal. It does not import `api.mjs` or start HTTP.
4. Keep `mergeState` as the scene's shared conflict algorithm, correcting loss of opaque fields without inventing per-field merge semantics for unknown schemas. At minimum preserve unchanged opaque fields and remote-only fields through retries. The two known archive operations remain three-way merges, never a union.
5. Keep the initial-read gate at the scene client boundary. Requiring a service-side read would break deliberately supported standalone curl writes. The future embedded scene adapter must use the same per-client read/adopt/merge/save state machine. That adapter does not exist yet, so this contract does **not** claim its guard is tested.

Behavioral parity does not prove code is actually shared: parent review must confirm both adapters import the extracted implementation rather than independently passing duplicated logic.

## Fixture and contract limits

The HTTP adapter runs in a dedicated child with synthetic HOME and data directory. The test invokes only `/api/state`; no real harness scan is called. Parent environment is unchanged. The child creates a temporary loopback listener and is stopped and cleaned after each fixture; embedded tests invoke the real service directly with a scanner that fails if called. Existing service tests are untouched.

`docs/ai/contracts/issue-1527-shared-state.json` preserves all six original issue acceptance criteria verbatim and leaves them unverified in this bounded slice. Its supplemental evidence records these eight executable checks. It does not replace native pinned Electron, hostile-frame, private IPC or rendering acceptance, or the existing resolver/service contracts.

## Implementation and bounded verification

Implemented the proposed extraction in `server/state-model.mjs` and `server/state-store.mjs`. Both `server/api.mjs` and `server/embedded-service.mjs` import the same store. The state model shares defaults, migration and unknown-field preservation, with explicit strict versus HTTP compatibility modes. HTTP retains tolerant known-field conversion, legacy settings arrays and missing/zero-base writes; it now also receives bounded no-follow saved-file reads, atomic 0600 writes and monotonic timestamps. `baseUpdatedAt` remains transport metadata and is not persisted.

The store carries the existing embedded raw-byte checks and per-file queue. The queue is process-local, not a cross-process lock; the final fingerprint check and rename do not claim an OS-wide compare-and-swap transaction. Embedded liveness checks remain after awaited operations and immediately before synchronous rename. Paging, chunk limits and cancellation stay in the embedded transport service. Open/new-session/reveal HTTP route bodies and the embedded method allowlist were not edited.

`mergeState` preserves opaque state fields using a deterministic whole-value policy: keep the remote field when local matches its base; a locally changed or removed field wins whole. Unknown nested objects are never blended. Archive and known-map merge rules remain unchanged.

Additional tests cover remote-only fields, local-only changes, competing whole-value changes, transport metadata exclusion, symlink refusal with unchanged target bytes, oversized saved-file refusal, and the HTTP tolerant / embedded strict split.

Commands and evidence on branch `codex/colony-embedded-artifact`, base commit `0f3e79d05aaeecec0091aff83d8547c11de2063c`, with these uncommitted changes:

- First implementation action repeated original RED: 3 fail / 5 pass (`/private/tmp/colony-shared-state-implementation-red.log`). Extended opaque-field contract before product edits: 5 fail / 5 pass (`/private/tmp/colony-shared-state-extended-red.log`).
- `node --test test/shared-state-parity.test.mjs test/embedded-service.test.mjs test/state.test.mjs`: 42 pass / 0 fail (`/private/tmp/colony-shared-state-focused-final.log`). Includes 13 new parity checks and all 11 unchanged embedded service checks.
- `npm test`: 213 pass / 0 fail; includes the sealed artifact builder fixtures (`/private/tmp/colony-shared-state-full-test.log`).
- `npm run build`: exit 0, existing bundle-size warning (`/private/tmp/colony-shared-state-build.log`).
- `node --check` on state-model, state-store, api, embedded-service and merge-state: exit 0. `git diff --check`: exit 0.
- Repository-wide reference search found no stale references to removed private `STATE_VERSION`, `STATE_FILE`, `writeState`, `serialise`, or `migrateId` internals outside ignored generated output.

GitNexus impact was attempted before product edits for readState, writeState, apiMiddleware, createEmbeddedService and mergeState. It could not classify risk because Bot Crossing has no registered index. Direct reference inspection identifies the HTTP state routes and archive reconciliation, embedded state methods, `src/game/api.js` and `src/main.js` merge callers. This is a documented analysis-tool limitation, not a clean graph claim.

Verification-gate was entered. The bounded source/API test and build evidence above is green; **no issue-wide PASS is claimed**. Native pinned Electron private IPC, hostile-frame validation, the embedded renderer's initial-read/merge client, and rendered/native smoke remain parent receiver work. No real harness scans, app launches, production writes, commits or pushes were performed.
