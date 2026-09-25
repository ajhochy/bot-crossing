# Colony worker and preload — bounded next slice

2026-09-24. Follows accepted `/private/tmp/colony-private-channel-plan.md` and source transport slice. Product files remain frozen for parent integration, except the separately authorized one-line transfer descriptor collision repair. No worker/scanner/preload implementation in this planning output.

## Goal and boundaries

Run the real read-only task scanner in a single owned child using private parent IPC, and provide the scene with only a bounded document-owned request wrapper. Do not start a listener, import standalone HTTP, execute Git, probe desktop applications with subprocesses, or expose opening/new-session/terminal/reveal operations. Native frame authorization and owned-child supervision stay in the separate Rhythm receiver.

No additional user interview is needed: the parent supplied the exact accepted behavior and boundaries. Existing worker/channel architecture is reused; no new dependency or unrelated research swarm is needed for this bounded continuation.

## Source-scanner seam

New `server/embedded-scanner.mjs`:

```
createEmbeddedScanner({ dataDir, sources, loadSource = loadEmbeddedSource, now = Date.now })
  -> { scan(): Promise<{threads, projects, warnings, scannedAt}>, dispose() }
sources = [{ id: <closed known harness ID>, enabled: boolean, paths?: <per-source schema> }]
```

Construction is inert. The default registry is a fixed map of known IDs to lazy imports; do not import `server/harnesses/index.mjs` or call global `detectedHarnesses()`. A disabled source must not be imported, detected, diagnosed or scanned. Validate duplicate IDs, unknown IDs, unrecognized path keys and non-absolute enabled-source paths before any adapter read.

Only enabled sources invoke `detect`, read-only `scanThreads`, and diagnostic collection. Keep per-source failures and last-good observations local to the scanner instance. Ten concurrent scans share one underlying scan. Disposal immediately rejects callers and prevents delayed results from becoming snapshots; it does not delete source files or caches. Retain existing identity/deduplication functions, extracting pure ones from `scan.mjs` if importing it would load the global registry.

Source errors name the affected source and preserve healthy results. An adapter returning an empty set while reporting a malformed/locked-store diagnostic is still a source failure, not a healthy empty source. Do not swallow diagnostics after the scan. Normalize opening capabilities to unavailable and omit executable command delegates in embedded snapshots.

### Actual adapter safety, not just a wrapper

The current Codex `scanThreads()` calls `codexDesktop()`, which can execute `/usr/bin/plutil` or Linux desktop probes. Rhythm's scanner calls `rhythmDesktop()` before even using its cache. Disabling scene buttons or overriding returned `canOpen` does not prevent these hidden subprocesses.

Add an explicit read-only observation option or injected inert capability reader to these existing adapters, defaulting to their current standalone behavior. Embedded scanning must use the inert option on every scan/diagnostic/cache path. Audit the remaining enabled adapters similarly. Do not monkeypatch subprocess APIs in product code; the test guard exists only to falsify accidental calls.

`createProjectResolver` needs explicit `gitEnabled: false` (or equivalent no-command observer) for the embedded path. Preserve filesystem-derived checkout paths and identity evidence where available, with dirty/branch enrichment unknown. It must not call `git`, `xcrun`, a desktop capability probe or any shell delegate. Standalone keeps its current Git behavior. An absent `.git` or unavailable Git must still yield useful path-level project grouping.

### Paths without parent environment mutation

Worker source configuration is trusted parent-only input. Initial path examples:

- Hermes `{home: <absolute Hermes home>}`
- Codex `{home: <absolute Codex home>}`
- Rhythm/OpenCode `{database: <absolute database>}`
- Claude Code `{home: <absolute CLI home>, desktopSessions: <absolute desktop sessions dir>}`
- Other supported adapters require equally explicit closed path mappings before being enabled.

Existing adapters capture environment/default homes at import. Either construct them with explicit paths, or install a narrowly allowlisted source environment once inside the new worker before lazy import; never mutate Rhythm's environment or copy inherited credentials. Changes of source configuration replace the worker/epoch; no hot ambient path switching after imports. Disabled adapters must not fall back to host-home defaults. Do not silently map unknown source IDs to another source.

## Worker seam and ownership

New absolute `server/embedded-worker.mjs` is the child entry, launched only by the future Rhythm supervisor with the verified packaged Node executable. Import/construction does not scan. It requires a private parent IPC channel and accepts exactly one init message:

```
{ type: 'colony:init', v: 1, documentId, dataDir, sources }
```

On valid configuration and protocol compatibility, reply:

```
{ type: 'colony:ready', v: 1, product: 'colony', documentId, capabilities: [...] }
```

An invalid handshake returns bounded `{type:'colony:error', error:{code,message}}` and stays unavailable/exits. It does not first import/read source adapters. Readiness means configuration is accepted; the first `inventory.page` causes the first source read.

After init, requests and replies are the existing protocol envelopes directly, without an extra nested wrapper that would evade the full-frame budget. Route only through `createProtocolSession`; renderer cannot set `dataDir`, sources, environment, file paths or configuration epoch. The parent-only dispose control is `{type:'colony:dispose',v:1,documentId}`. Wrong-document controls and second init messages cannot retarget the process. Disconnect/dispose closes the protocol/scanner and exits cleanly; no stale reply can be emitted after disposal. The process never binds or reclaims ports and never signals other PIDs.

The Rhythm supervisor still owns launch serialization, missing packaged binary refusal, startup deadline/retry limits and TERM/KILL of its exact child. These are NOT proven by an upstream worker test. Initial tests use the current absolute Node 22.23 executable; packaged-Node/native sentinel proof remains receiver acceptance.

## Preload seam

Update existing `server/embedded-preload.cjs` to expose only:

```
Object.freeze({ product: 'colony', protocolVersion: 1, electronMajor, request(method,payload) })
```

No raw port, ipcRenderer, process, filesystem, fetch/URL/native opener, auth token, shell method or arbitrary channel is exposed. The wrapper is installed synchronously so an invalid/missing connection never causes the renderer to fall back to HTTP.

Main transfers exactly one port on `colony:port`, with `{v:1,documentId}`. The isolated preload refuses secondary frames, invalid config or multiple ports. Only one attachment is permitted for the entire preload/document lifetime. Any repeated attachment closes both ports, rejects pending work and permanently revokes the document, including when the new port names a different document. It records the document identity internally, generates bounded correlation IDs and never lets the scene supply them.

Validate closed method/payload schemas before posting. Enforce complete JSON-envelope control/chunk limits, 32 pending requests, bounded handshake/request timeout and exact response identity/version/schema/size. A foreign-document or malformed reply closes the port and rejects pending requests; an old/unsolicited ID cannot resolve another call. Pagehide, messageerror, port close and explicit main revocation reject pending calls and forbid new posts. Do not silently wait forever for a port after revocation.

Electron sandbox preload cannot require arbitrary local modules like ordinary Node. Keep the narrow validation wrapper self-contained or bundle its shared pure validator into the final preload; do not add a privileged runtime `require('./...')` fallback. Runtime imports must remain within the Electron sandbox allowlist.

The native receiver separately authenticates actual sender/frame/origin and transfers the port to an exact current `WebFrameMain`. VM preload tests demonstrate JavaScript wrapper behavior only; they do not prove frame isolation or runtime sandbox security.

## Artifact contract

Add `manifest.files.worker = 'server/embedded-worker.mjs'`. The existing builder copies server modules and seals every file, so scanner/protocol/service/state dependencies must all be present with matching SRI. No bare source or developer fallback. The Rhythm resolver/receiver must require the declared worker to be a verified manifest member before spawning; a hard-coded unchecked path is insufficient.

The artifact builder test runs in a temporary synthetic checkout and reuses installed dependencies, never changes the integration artifact or pins. Actual node-binary packaging remains the Rhythm owner.

## Ordered implementation and current RED

| Order | Scope | Files | Observable evidence |
|---|---|---|---|
| 1 | Explicit source scanner + inert adapter capabilities + no-Git observer | embedded-scanner, targeted adapters and projects; pure scan helpers if needed | disabled source load count zero; healthy data with failed source warning; concurrent calls share one scan; disposal refuses delayed result |
| 2 | Real private worker | embedded-worker + bootstrap helpers | actual Node child reads synthetic Hermes/Codex/Rhythm stores, no sockets or subprocesses, hashes unchanged; bad handshake never ready; dispose exits |
| 3 | Narrow preload | embedded-preload, pure validation bundle only if required | request correlation, method/size refusal before post, pagehide and foreign-document revocation |
| 4 | Sealed entry declaration | builder manifest role | temporary artifact worker/dependency SRI and exact worker role |

New runnable tests:

- `test/embedded-scanner-contract.test.mjs`: 3 tests, actual proposed scanner factory, fixture adapter boundary.
- `test/embedded-preload-contract.test.mjs`: 8 tests executing the actual preload source inside VM with a fake Electron transport boundary.
- `test/embedded-worker-contract.test.mjs`: 6 tests launching the actual private entry once implemented; synthetic SQLite stores only. A child-only pre-import guard rejects all subprocess spawn/exec/fork and TCP/UDP bind calls.
- `test/embedded-worker-artifact-contract.test.mjs`: 1 test building an isolated synthetic artifact once the worker exists.
- `test/support/colony-worker-guard.cjs`: test-only falsification guard; never shipped as a production mechanism.

Command: `node --test test/embedded-scanner-contract.test.mjs test/embedded-preload-contract.test.mjs test/embedded-worker-contract.test.mjs test/embedded-worker-artifact-contract.test.mjs`

Observed **18 failed, 0 passed** before implementation. Failure mechanisms: missing scanner factory, missing private worker entry, absent preload request wrapper. Assertions are runnable RED seams, not module import crashes. Log `/private/tmp/colony-worker-preload-contract-red.log`.

## Independently repaired collision

The actual state transport treated any own `transferId` field as a chunk descriptor. Two new regression tests reproduced valid opaque metadata failing reads and successful disk writes being reported as failures. The parent authorized the minimal repair: recognize complete `version:3` state before descriptor interpretation. No unknown field is renamed or removed. Focused state/protocol/client regression run: **62/62**, `/private/tmp/colony-collision-focused-final.log`. Frozen repaired `src/game/embedded-api.js` SHA-256: `68996d52d8c9e3bef04ec30243eaf5f329a1d8a6d3c9eae947c69343894198b4`.

No further product edits were made after that repair. Native frame, lifecycle ownership across crashes, installed artifact and rendered tab remain explicitly unverified.


Parent review additions are now executable RED: requests before init; second/reconfigured init retaining original source; owner IPC disconnect exit; malformed, multiple-port and repeated-document preload attachments; oversized whole response; and 32-pending admission limit. Worker cleanup checks both exitCode and signalCode and waits for an actual exit after TERM or KILL before removing fixture files. The child-only guard also refuses JS filesystem access under the synthetic disabled-source root, in addition to the scanner factory's disabled-loader assertion. Native SQLite internals are not instrumented by that JS guard; the stronger disabled-source invariant remains that the adapter is never loaded or invoked.

## Accepted implementation review refinements

Implemented 2026-09-24. Initial scene requests wait for the first port under the shared 32-request quota; handshake expires after 10 seconds, operations after 60 seconds. After exposing the wrapper, preload sends `colony:scene-ready` with `{v:1,product:"colony"}`; the receiver must authenticate its exact sender before transferring the port. Worker readiness includes fixed `capabilities: ["inventory-v1", "state-v1"]`. Missing enabled stores produce named warnings and preserve last-good observations as stale.

Known protocol errors carry an exact bounded `[colony:<known-code>] ` prefix as well as `code`. The renderer reconstructs only the eight closed known codes and strips the prefix for display, because Electron can discard custom Error properties. Tests exercise real saveState conflict merging and revoked inventory cleanup after stripping custom properties. This is not native Electron serialization proof.
