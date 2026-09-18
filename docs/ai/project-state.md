# Project state

## Current focus
Priority 2 adds the Codex durable parent/worker graph and honest incremental lifecycle evidence to the project/checkout foundation.

## Active branch / PR
`codex/codex-session-graph` depends on `codex/project-checkout-identity` (draft fork PR #1).

## In progress
Rhythm/OpenCode integration remains a separate dependent slice.

## Risks / known issues
Exact Codex CLI resume syntax was checked against installed help; terminal resume was not exercised end to end. The app's internal navigation API selected a worker and its parent, but OS UUID deep-link targeting remains unverified and disabled. Synthetic fixtures cover transitions that were not forced in production.

## Test status
169 tests and production build pass on the isolated staged tree. Live current task appears once with three workers; 397 workers have nickname metadata and no worker remains Untitled thread. Oversized lifecycle and partial-write cases have regression coverage. No CI workflow configured.

## Next step
Review after PR #1; then review the Rhythm draft. No merges or harness writes.
