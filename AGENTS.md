# Bot Crossing fork

Read docs/ai/current-plan.md and docs/ai/project-state.md, then the relevant adapter/game/UI files. Preserve the colony aesthetic and existing style (ES modules, two spaces, single quotes).

Harness stores are read-only. Never migrate databases, edit transcripts, or create/delete/reset/prune worktrees during discovery. Read-only Git metadata/status commands are allowed. Save only Bot Crossing-owned state/caches. Tests use temporary synthetic data; never commit private inventories or transcripts.

Run npm test and npm run build, then verify changed UI on a free loopback port. Use codex/ branches and draft PRs targeting this fork; no merges or upstream PRs. Record factual verification and gaps in docs/ai/project-state.md.

## Worktree hygiene
Once a branch's work is committed and pushed to a PR, remove its worktree immediately (`git worktree remove <path> && git worktree prune`) and squash-delete the local branch. Never leave worktrees checked out after PR creation; idle worktrees keep compiling, watching, and eating disk. One active worktree per task, gone when the PR opens.
