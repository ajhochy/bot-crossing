# Multi-harness colony implementation

## Intent and boundaries
Show the logical project, repository, exact checkout, harness, parent task, and worker without requiring users to decode worktree folder names. Preserve the colony art and existing interactions. All discovery is read-only; only Bot Crossing storage contains preferences and identity caches. No cleanup/deletion actions, harness migrations, live service restarts, or upstream PRs.

## Clarification interview
Skipped: the supplied brief specifies priorities, safety boundaries, branch strategy, draft PR destination, and rendered verification. No unresolved product decision blocks implementation.

## Ordered slices
1. `codex/project-checkout-identity`: Git common-directory identity, checkout inventory/cache, reversible grouping, state migration, inspector/filters/navigation, Hermes schema compatibility.
2. `codex/codex-session-graph`: reconcile Codex SQLite and rollouts before building nested parent/worker relationships; incremental lifecycle evidence and honest unknown states; retain session IDs and exact checkout/navigation.
3. `codex/rhythm-session-graph`: dedicated read-only Rhythm integration and engine deduplication; standalone OpenCode retained; offline diagnostics and navigation capabilities.

Each later draft PR targets the preceding branch in the user's fork. No merge. Source changes and fixtures in this repository only.

## Model
- Repository identity is a canonical common Git directory, never a remote or basename. Independent clones default to separate logical projects.
- Checkout identity is the canonical worktree root; all linked worktrees are inventoried once per repository, including arbitrary locations. Session cwd is retained independently.
- Stable opaque project keys drive layout; labels remain human-readable. Bot Crossing grouping overrides map repository or checkout IDs to a selected project, and reset reverses them.
- Filesystem evidence and a Bot Crossing-owned identity cache preserve previously observed missing paths. A missing historical cwd never implies an active owner.
- Activity carries evidence and an unknown state. Shared checkout means concurrent observed running sessions, with historical conversation counts labeled separately.
- Existing name-keyed layouts are copied to unambiguous stable IDs; original keys and archive/viewed state are retained. Ambiguous migration stays explicit.

## Acceptance matrix
| ID | Observable acceptance | Evidence |
| --- | --- | --- |
| P1-1 | Linked worktrees across harnesses share a zone with distinct exact checkout entries | Temporary Git worktrees + API + rendered inspector |
| P1-2 | Same-name independent repositories and clones stay distinct; symlink/nested cwd resolves correctly | Temporary repository regression tests |
| P1-3 | Group/reset survives save/reload and keeps selected session cwd | State API/merge tests + rendered UI |
| P1-4 | Missing, non-Git and stale paths remain visible with unknown evidence | Fixture tests + UI |
| P1-5 | Discovery never changes worktrees, branches, index or user files | Before/after synthetic Git evidence |
| P1-6 | Prior layout, archived, viewed and hidden state survive migration | State/migration regressions |
| H-1 | Old/new Hermes schemas scan independently, with profile diagnostics and honest activity | Synthetic SQLite profiles + live counts |
| P2-1 | Children attach exactly once, including nested/orphan/archived parent cases | Sanitized SQLite/rollout fixtures |
| P2-2 | Running/completed/interrupted/unknown transitions are represented honestly | Lifecycle regression fixtures + live aggregate discovery |
| P2-3 | Parent and worker navigation preserve session and checkout | CLI/app verification or explicit unavailable reason |
| P3-1 | Rhythm parent/children appear once, standalone OpenCode remains | Sanitized fixture + live aggregate mapping |
| P3-2 | Profile identity and offline/errors remain understandable | Fixture tests + rendered UI |
| P3-3 | Rhythm navigation uses a verified mechanism or says unavailable | Source/runtime inspection + UI |
| V-1 | Full tests and production build pass | npm test; npm run build |
| V-2 | Cold/warm realistic scans remain usable | Aggregate timings, counts, Git cache metrics |
| V-3 | Actual UI shows grouping, filters, workers and reload persistence | Loopback browser interaction |

## Prior art and investigation
Baseline d05ac2f verified clean. The existing scanner disambiguates display names but uses them as identity. Existing errands flatten children with inherited parent cwd and an unconditional running flag; this cannot represent durable workers. Existing state uses optimistic concurrency and three-way merge; extend those mechanisms rather than adding a competing writer. Harness specialists investigate local primary-source metadata in parallel. Git metadata, local CLI help and installed UI are the authorities; README claims are not assumed current.

## Verification checklist
- [x] Verify baseline/remote/clean checkout and read source conventions.
- [x] Record plan and acceptance matrix.
- [x] Author failing observable regression contracts before implementation.
- [x] Implement and verify Priority 1 plus Hermes compatibility.
- [x] Implement and verify Priority 2.
- [x] Implement and verify Priority 3.
- [x] Full production build, realistic scan measurements and browser verification.
- [x] Review commits and prepare draft fork PR stack in dependency order; record limitations.
- [x] Confirm draft PRs #1, #2, #3 and record the final Dev Dashboard run (revision 4208).
