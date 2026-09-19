# Project state

## Current focus
Overview counts, selected task-card cleanup and exact Codex/Rhythm Electron opening.

## Active branch / PR
`codex/overview-and-thread-opening`, based on `codex/rhythm-session-graph`; follow-up fork draft [#4](https://github.com/ajhochy/bot-crossing/pull/4). Prior fork draft stack remains [#1](https://github.com/ajhochy/bot-crossing/pull/1),
[#2](https://github.com/ajhochy/bot-crossing/pull/2), [#3](https://github.com/ajhochy/bot-crossing/pull/3).
The approved Rhythm receiver change is isolated on its own `codex/electron-session-opening` branch.

## Completed locally
Code, rendered UI and native opening are verified. Draft #4 is published without merging;
the Dev Dashboard run was recorded at revision 4218. Bot Crossing is serving the current built
UI and native-opening server on its existing loopback port. The separate Rhythm receiver's
broader repository gate and companion draft publication are still running.

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
