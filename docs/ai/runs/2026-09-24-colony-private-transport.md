# Colony private protocol and scene transport — source slice

Branch `codex/colony-embedded-artifact`, baseline `857c8b0c5ee11fa91ca14bab57eb9ba5f008d8af`; uncommitted changes above upstream draft PR #5. No worker, native receiver, preload or real harness/store scans were added in this slice.

## Changes

- `server/embedded-protocol.mjs`: versioned document session, exact method/envelope schemas, bounded JSON, complete request/response frame measurements, immutable input snapshots, duplicate outstanding ID refusal, 32-request admission limit, sanitized errors and prompt pending-call revocation. Native Electron frame identity must still be established by the future receiver before constructing this session.
- `server/embedded-service.mjs`: one frozen generation now contains threads, project inventory and warnings with a consistent scan timestamp. Every page is capped at 250 records, all collections together at 20,000 records and 32 MiB. Pending scans reserve generation capacity before source reads. Trusted response budgets include the protocol envelope; legacy flat-array fixture behavior retains its original boundary assertions. Snapshots use the same JSON omission of optional undefined fields as standalone HTTP.
- `src/game/embedded-api.js` and `src/game/api.js`: the actual scene exports select the pinned private bridge when present, fail closed for incompatible bridges, download/upload large state with ordered bounded chunks and SHA-256, keep the shared initial-read gate and three-way conflict retry, release transfers/generations, reject revocation during cleanup, and return no partial inventory.
- `src/main.js`: its checkout read now uses `fetchCheckout`; embedded lookup is limited to opaque IDs from the last complete project snapshot, with no path command or Git execution. Standalone keeps its HTTP route.
- Embedded opening/reveal/new-session action exports refuse locally without transport calls. Their DOM controls and shortcut visibility are deliberately left for the native/visibility UI slice; this report does not claim they are hidden or disabled visually.

The two request boundaries are intentionally separate: transport tests invoke the actual renderer client, protocol and synthetic service; they do not impersonate an Electron sender frame or claim a live MessageChannel is attached.

## Falsification and checks

- First action repeated the nine original RED tests: 0 pass / 9 fail (`/private/tmp/colony-channel-slice1-initial-red.log`). Expanded pre-implementation suite: 0 pass / 13 fail (`colony-channel-slice1-extended-red.log` in the same directory).
- Focused protocol review reproduced two real failures: repeated metadata references rejected and disposal waiting for a never-returning scan; 5 pass / 2 fail before repair (`colony-channel-slice1-review-red.log`).
- Pending-scan admission RED: 2 pass / 1 fail before reserving capacity (`colony-channel-scan-capacity-red.log`).
- Cleanup revocation RED: missing rejection before propagating revoked cleanup errors (`colony-channel-cleanup-revocation-red.log`).
- Optional undefined scanner metadata RED: protocol rejected ordinary optional fields before snapshot JSON normalization (`colony-channel-optional-fields-red.log`).
- Final full `npm test`: **234 pass / 0 fail**, exit 0; recorded in `/private/tmp/colony-channel-slice1-full-test-final.log`; includes all existing service/state/standalone tests and sealed artifact builder fixtures.
- Final production `npm run build`: **exit 0**; `/private/tmp/colony-channel-slice1-build-final.log`; existing bundle-size warning remains.
- Changed-module `node --check` and `git diff --check`: exit 0.

GitNexus impact attempts for the modified existing service/client/checkout symbols report Bot Crossing is not indexed. Direct references were inspected; the affected paths are state save/load, scene polling and checkout inspection. This is an explicit analysis-tool limitation, not a clean graph claim.

## Remaining acceptance

No issue-wide verification PASS: packaged Node worker ownership, source-toggle filtering, native sender/frame checks, pinned preload, actual MessageChannel, origin/network confinement, tab visibility, rendered scene and packaged macOS qualification are still separate slices. This change creates no embedded TCP listener and touches no real stores. The parent's combined mega smoke remains pending.

## Parent review and accepted repair

Parent read all five product files and replayed the protocol/inventory/renderer tests successfully. Review found valid opaque `transferId` state metadata being misread as a transfer descriptor, causing a persisted save to report failure. Two real transport/service REDs reproduced it. The narrow decoder discriminant now recognizes v3 state first and preserves all opaque metadata. Candidate focused62 tests pass; parent metadata/actual renderer replay passes. No additional broad rerun was needed after this bounded repair; previous full234/build evidence remains scoped to before the two-line discriminant change. Native channel/tab qualification remains pending.
