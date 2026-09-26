---
date: 2026-09-26
repo: bot-crossing
branch: codex/colony-embedded-artifact
pr: 5
issues: [product-direction]
status: in_progress
tags: [run, bot-crossing]
---

# Original UI restore

## Phase 0 acceptance contract

- `node --test test/embedded-host-intents.test.mjs test/embedded-renderer-transport.test.mjs` — RED as required. The embedded HUD mount assertion failed (`false !== true`) before implementation. The process timed out after reporting the expected failure because the Vite test server remained open on assertion failure.
- Contract: `docs/ai/contracts/task-bot-crossing-original-ui.json`.

## Files

- Restored the original HUD in embedded mode, with New conversation disabled and titled because Rhythm has no corresponding action.
- Routed Open/Enter and Reveal through the closed `action.run` bridge using current inventory thread IDs.
- Extended the sealed protocol schema for `action.run`; host interception remains mandatory and the worker never receives actions.

## Checks

- `node --test test/embedded-host-intents.test.mjs test/embedded-renderer-transport.test.mjs` — 16 passed, 0 failed.
- `npm test` — 283 passed, 0 failed.
- `npm run build` — passed; Vite transformed 67 modules. Existing large-chunk warning remains.

## Notes

Bot Crossing is not available in the GitNexus index; impact analysis is recorded in the final notes as unavailable.
