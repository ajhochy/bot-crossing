# Project state

## Current focus
Priority 1: Git project/checkout identity, inspector/grouping, saved state, and Hermes schema compatibility.

## Active branch / PR
`codex/project-checkout-identity` against fork main. Draft PR prepared; later Codex and Rhythm slices depend on this branch.

## In progress
Dependent adapter slices remain separate from this commit.

## Risks / known issues
Missing paths keep previously cached identity; entire moved clones need explicit grouping. Ambiguous legacy layout names are retained for review. Dirty-state checks are bounded and say unknown until inspected. Existing harness navigation is not requalified by this slice.

## Test status
161 tests and production build passed against the isolated staged tree. Rendered fixture checks cover grouping/reset/reload, exact cwd, missing and unused worktrees, filters and graceful failed-save recovery. Live resolver sample: 408 projects / 573 checkouts, cold 43 Git commands, warm zero. No CI workflow is configured.

## Next step
Review this foundation, then the dependent Codex and Rhythm draft PRs. No merges or harness writes.
