# Testing

Use Node >=22.13. Install with `npm ci`, then run `npm test` and `npm run build`. No lint/typecheck configuration or GitHub Actions workflow is present. Static checks are `node --check` for changed JS modules and `git diff --check`.

Tests create temporary synthetic harness stores and Git repositories. Production discovery never mutates harness stores or Git state. Live measurements must print aggregate counts/timings only.

## Real data smoke

Build first, then run `PORT=5287 BOT_CROSSING_HOST=127.0.0.1 npm run serve` on a free port. In another terminal:

```sh
BOT_CROSSING_LIVE_URL=http://127.0.0.1:5287 node tools/verify-live.mjs
```

This opt-in read-only check calls the real `/api/threads`, `/api/harnesses`, and `/api/state` routes, checks unique sessions/engine dedup and project-checkout membership, and prints cold/warm aggregate samples. Run it before opening a browser if measuring a fresh server's cold scan. Never start or restart another harness.

## Sanitized UI preview

`node tools/create-preview-fixture.mjs` prints paths to a temporary session fixture and Bot Crossing data directory. Launch the built server with `BOT_CROSSING_FIXTURE=<fixture>` and `BOT_CROSSING_DATA=<dataDir>` from that output on another free loopback port. Fixture mode is process configuration only, never a request parameter, and shows a persistent synthetic-preview banner.

Use the actual browser to check distinct same-name clones, main/arbitrary/unused worktrees, grouping and reset through reload, selected session cwd, search/harness/status/checkout filters, nested workers, archived parent navigation, missing-path disabled actions, and unknown activity. Stop only the preview server to check failed save and stale-state recovery. Inspect desktop and mobile screenshots. Do not invoke fixture New conversation actions against installed harnesses.

Recorded qualification and navigation limits: `docs/ai/runs/2026-09-18-multi-harness.md` and adapter investigation documents.
