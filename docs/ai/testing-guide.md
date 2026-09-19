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

## Native task opening

Codex desktop discovery checks its bundle ID and URL scheme (macOS), or the registered scheme
handler (Linux). `BOT_CROSSING_CODEX_APP` optionally overrides the macOS application path; an empty
value disables it. Missing CLI does not disable installed desktop opening. OS dispatch failures are
reported as errors. Terminal resume is a separate, still unqualified end-to-end path.

Rhythm Electron needs the companion renderer session-link update. When updating an already running
shell, reload its renderer once and complete normal Google sign-in before enabling this configuration;
fragment-only links do not refresh loaded assets. Configure only a known running
non-owning Electron profile in Bot Crossing's ignored `data/native-openers.json` (or the file named
by `BOT_CROSSING_NATIVE_OPENERS`):

```json
{
  "rhythm": {
    "shellPath": "/absolute/Rhythm/apps/electron",
    "userDataPath": "/absolute/separate-electron-profile",
    "executable": "/absolute/path/to/Electron"
  }
}
```

All paths must be absolute. Discovery requires the Electron shell package, the generated
`apps/web/dist/desktop-capabilities.json` marker, an executable, and a live profile lock. Opening
passes the exact local session ID to that profile in `--interactive-smoke` mode. It does not resume
an agent or start owning services. Missing configuration, old builds, and stopped profiles each have
an explicit unavailable reason. The shipping Flutter app is not an external navigation target.

To repeat Codex native verification with real existing tasks (it changes app selection only):

```sh
BOT_CROSSING_VERIFY_NATIVE_OPEN=1 BOT_CROSSING_CODEX_TEST_IDS=<worker-uuid>,<parent-uuid> node tools/verify-codex-opening.mjs
```

The final ID is left selected. The probe requires a fresh exact-route receipt from the desktop's own
logs, not just HTTP success. Keep private identifiers/logs and local opener configuration out of Git.

For UI smoke, compare the default repository/workspace sections with the historical toggle; verify
search and colony visibility follow it without changing archive state. Select a worker, expand Task
details, inspect its parent, and check all actions at desktop and 390px widths. Capture screenshots.
