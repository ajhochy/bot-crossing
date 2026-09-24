---
date: 2026-09-24
repo: bot-crossing
branch: codex/colony-embedded-artifact
pr: 5
issues: [1527, 1528]
status: partial
tags: [run, bot-crossing]
---

## Files

- `server/embedded-worker.mjs`: one immutable explicit-source init over private parent IPC; lazy scan; protocol dispatch; disposal and parent disconnect exit.
- `server/embedded-scanner.mjs`: closed lazy registry, explicit source path validation, enabled sources only, instance-local stale observations and diagnostics, coalescing/cancellation, no opening delegates.
- `server/scan-identity.mjs`: pure existing disambiguation/dedup helpers extracted unchanged and reused by standalone and embedded scanners.
- `server/projects.mjs`: `gitEnabled:false` retains filesystem Git identity with unknown status, without executing Git. Standalone default remains true.
- Codex/Rhythm adapters accept inert native capability observation; standalone defaults remain unchanged. Rhythm diagnostic honors this option too.
- `server/embedded-preload.cjs`: Electron-only sandbox import, metadata plus bounded closed request wrapper, exact response correlation, 32 pending cap, request/handshake expiry, irrevocable one-document/one-port lifetime.
- Builder declares the sealed worker role; existing integrity inventory includes all worker dependencies.
- Four contract suites and child-only forbidden-operation guard use disposable synthetic stores; accepted plan and supporting issue contract stored canonically.

## Checks

- First implementation command: `node --test test/embedded-scanner-contract.test.mjs test/embedded-preload-contract.test.mjs test/embedded-worker-contract.test.mjs test/embedded-worker-artifact-contract.test.mjs`: **18 RED**; `/private/tmp/colony-worker-implementation-red.log`.
- Same focused command after implementation: **20/20 pass**, including two added no-Git identity and irreversible document-lifetime regressions; `/private/tmp/colony-worker-focused-final.log`.
- `npm test`: **256/256 pass**, `/private/tmp/colony-worker-full-test.log`. Includes standalone, shared state, service lifecycle, protocol/client and artifact builder fixtures.
- `npm run build`: **exit 0**, `/private/tmp/colony-worker-build.log`; pre-existing large bundle advisory remains.
- Actual Node children read fixture Hermes, Codex and Rhythm databases through private IPC; source hashes unchanged and Hermes gains no SQLite sidecars. Guard refuses subprocess spawn/exec/fork and TCP/UDP listeners, and JS filesystem access under disabled-source sentinel. No actual harness scans or host stores used.
- `git diff --check`: exit 0.
- GitNexus impact attempts for scanThreads, createProjectResolver and builder main could not resolve Bot Crossing (unindexed); evidence `/private/tmp/colony-worker-impact-*.log`. This is an unavailable index, not a low-risk result. Direct source review found standalone + embedded callers; changes preserve default adapter/resolver behavior. Pure helpers were moved verbatim. No commit or push performed.

## Notes and remaining acceptance

This is upstream source/fixture verification only. VM preload tests cannot authenticate actual Electron frames, sandbox privilege isolation or assets. The native Rhythm receiver must verify the declared worker, launch the packaged Node with a sanitized environment, authorize the exact current WebFrameMain/document, transfer one private port, revoke and dispose on tab lifecycle, and supervise only its owned child. Native renderer/tab smoke, installed/pinned-runtime proof, and frame/epoch hostile probes remain mandatory; no issue-wide PASS.

Explicit adapter paths are installed only inside the owned worker before lazy imports. Disabled adapters are neither imported nor invoked. Source changes require a new worker, and a new document requires a fresh preload; a replacement port cannot revive a revoked preload. State APIs retain existing strict shared store CAS/chunk/liveness protection. No new-session, shell, opener, TCP, Git or capability delegates are added to the embedded surface.

## Parent review repair receipt

- Reproduced five review failures: missing readiness capabilities, initial request/port race, missing-source warning/stale retention, handshake quota/expiry, and cleanup revocation code. Separate Error-property-loss regression initially failed. Evidence: `/private/tmp/colony-worker-review-red.log`, `/private/tmp/colony-worker-error-codes-red.log`.
- Fixed preload handshake admission: queued initial calls count toward the same 32-request cap, wait at most 10 seconds for the one lifetime port, and reject on pagehide/expiry. `colony:scene-ready` is sent after wrapper installation; worker ready declares `inventory-v1,state-v1`.
- Preload emits bounded exact known error markers. Renderer transport reconstructs only known codes and strips the prefix; actual `api.js` saveState merges a stale save with concurrent remote archives even when Error custom properties are stripped, and actual inventory cleanup propagates revoked lifetime. Missing enabled sources warn and retain stale observations.
- Final command: `node --test test/embedded-preload-contract.test.mjs test/embedded-scanner-contract.test.mjs test/embedded-worker-contract.test.mjs test/embedded-worker-artifact-contract.test.mjs test/embedded-renderer-transport.test.mjs test/embedded-protocol-contract.test.mjs test/embedded-state-metadata-collision.test.mjs`: **45/45 pass**, `/private/tmp/colony-worker-review-focused-final.log`. The worker-specific four suites contain 25 tests.
- Full **256/256** and production build receipts above precede these bounded review fixes. Per parent test budget, ran only focused and adjacent regression suites afterward; the focused artifact contract also builds a synthetic current artifact. Final syntax checks on worker/scanner/preload/renderer transport and `git diff --check` pass.
- Additional GitNexus attempts on revoke, scanThreads and createEmbeddedTransport returned the same unindexed repository failure (`/private/tmp/colony-review-impact-*.log`). No native proof or issue-wide PASS implied.
- Dev Dashboard recorded pending source slice: revision 5267.

## Parent integration review

Parent reviewed every product diff and independently ran the same seven focused suites: **45/45 pass**, no skipped tests. Evidence: `/Users/ajhochhalter/Documents/rhythm-orchestration-evidence/2026-09-24-repair4/colony-worker-parent.log`. GitNexus detect-changes was attempted and unavailable for the unindexed Bot Crossing repository; direct diff review covers the embedded worker/preload and unchanged standalone defaults. Native receiver and final artifact pin remain pending.
