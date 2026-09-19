# Rhythm Electron exact-session opening

The user approved a narrow Rhythm Electron renderer fix after the original brief excluded Rhythm
source changes. It lives on the separate `codex/electron-session-opening` branch. No API, engine,
database schema, Flutter, protocol-registration or session-lifecycle changes are required.

## Receiver contract

The existing host accepts `rhythm://app/index.html#/agents?sessionId=<local-id>` through initial argv,
second-instance and open-URL handling. The renderer previously ignored `sessionId`, and first-page
list hydration could replace a requested off-page ID with the first unrelated session.

The companion renderer now validates the local ID (alphanumeric, underscore or hyphen, at most 128
characters), resolves it through the existing session-detail GET, and selects its appropriate rail
scope. Initial links, later hash changes, off-page/background/archived sessions, failed reads and
out-of-order responses have behavioral coverage. It shows a failed-open state instead of claiming an
unrelated fallback was selected. Opening does not send prompts, resume agents or approve actions.

The built renderer supplies `desktop-capabilities.json` with version 1 and `agentSessionDeepLink:true`.
Bot Crossing reads that marker from disk; it does not fetch it through a browser protocol.

## Bot Crossing integration

Ignored Bot-owned `data/native-openers.json` identifies the exact Electron executable, shell and
separate running user-data profile. Discovery checks shell package identity, the capability marker,
executable access and a live profile lock. The `/api/open` route invokes Electron with that profile,
`--interactive-smoke`, and the exact Rhythm local ID. OS argv is never a shell string. The second
process must exit successfully; failures/timeouts are surfaced. SDK IDs are never opening targets.

Configuration instructions and the stopped/unpatched states are in [testing-guide.md](testing-guide.md#native-task-opening).
Only this qualified profile enables the button. The shipping Flutter application has no external
session URL handler and remains outside this implementation.

## Qualification and runtime handoff

The separate Rhythm branch exercises actual renderer state and the existing gateway. Native tests
use the real sandbox API/engine and an isolated Electron profile. Cold URL and second-instance tests
assert exact displayed session, reuse of the same main process/window, no HTTP mutations, and
unchanged service PIDs. Test-only mock keychain avoids an OS keychain startup block.

A live renderer build must remove inherited Vite API, engine, token and production values and set
only `VITE_RHYTHM_GATEWAY_MODE=live`. Synthetic test tokens must not enter the copied build.
The existing Electron protocol reads generated `apps/web/dist` assets from disk on document load,
but fragment-only links retain the already loaded JavaScript. After replacing generated assets,
perform one normal renderer Reload. Existing host security policy invalidates auth on full navigation,
so complete normal Google sign-in again. Then same-profile session links use the patched renderer
without further reloads. Electron main/API/engine stay running. Preserve a backup of the previous
generated assets for rollback.
The renderer update can discard an unsent draft; the observed live app was idle on Planner.

Live handoff and installed-window evidence are recorded in the [run report](runs/2026-09-18-overview-opening.md).
This is development Electron qualification; it does not qualify a signed distributable or replace the
shipping Flutter app. The draft companion PR carries its separate checks and release boundaries.
