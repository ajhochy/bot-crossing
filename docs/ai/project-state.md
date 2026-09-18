# Project state

## Current focus
Three dependent draft slices implement the multi-harness colony. No merge or upstream submission.

## Active branch / PR
Final stack branch: `codex/rhythm-session-graph`; depends on `codex/codex-session-graph`, then `codex/project-checkout-identity` against fork main.

## In progress
Implementation and local verification finished. Draft publication is tracked in the current plan.

## Risks / known issues
Codex CLI invocation shape is verified, terminal resume is not qualified end to end. Codex desktop UUID opening and Rhythm external conversation opening are unavailable. Persisted Rhythm activity is not a live heartbeat. Ambiguous legacy layouts remain preserved for review. See the run report for movement, status-budget, and historical-data limits.

## Test status
172 synthetic/API tests and production build pass. Real HTTP smoke passes with 15,475 unique sessions and no warnings; rendered fixture checks and live project filtering pass. No GitHub Actions configuration exists. See `runs/2026-09-18-multi-harness.md` and the acceptance contract for evidence boundaries.

## Next step
Review the draft stack in dependency order. No deployment or harness modifications are required to use the local viewer.
