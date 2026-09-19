---
date: 2026-09-18
repo: bot-crossing
branch: codex/overview-and-thread-opening
pr: https://github.com/ajhochy/bot-crossing/pull/4
issues: []
status: pass
tags: [run, bot-crossing]
index: "[[bot-crossing]]"
---

# Overview, task card and native opening

## Files changed

- Project overview classifies existing Git repositories, existing non-Git workspaces, and historical
  locations. Historical locations are opt-in in both the project list and colony roster; IDs,
  preferences, grouping overrides and stored sessions are preserved.
- Task cards separate exact path and branch, collapse detailed evidence, retain parent inspection,
  and use full-width primary/terminal actions plus a two-column secondary row.
- Codex discovery recognizes installed desktop bundles independently of CLI availability. Checked
  OS dispatch preserves exact task IDs and returns failures to the caller.
- Rhythm opening uses a Bot-owned configured running Electron profile and a receiver capability
  marker. It passes local IDs through the existing deep link in non-owning interactive mode.
- Synthetic integration contracts exercise the real HTTP routes with only OS executables replaced.
  The opt-in Codex probe asserts the installed desktop's exact route receipt.

## Checks run

- Baseline: 172 tests passed. Final implementation: `npm test` — 185/185 passed, no skips.
- `npm run build` passed; existing >500 KB chunk warning remains.
- Changed JavaScript `node --check` and `git diff --check` passed.
- `ai-workflow checks --level issue` and `--level pr` each fail before running checks because the
  shared wrapper assumes an absent `typecheck` script. This repo has no TypeScript/lint setup;
  the documented native checks above were run directly. No wrapper PASS is claimed.
- Live UI showed 31 repositories and 45 workspaces; historical opt-in restored 332 additional
  locations (408 total), then reverted to 76 default rows. Search and project navigation checked.
- Desktop and 390x844 mobile card screenshots showed readable metadata and all actions without
  overlap. Details expansion and worker-to-parent navigation were exercised through actual controls.
- Actual Bot Crossing Open button selected a Codex worker. The repeatable native HTTP probe then
  verified fresh exact-route receipts for worker and parent, leaving the parent selected.
- Screenshots are private local artifacts: `overview-after.png`, `task-card-after.png`, and
  `task-card-mobile.png` under the task's Codex visualization directory. No private images or logs
  are committed.
- Live read-only HTTP smoke passed with 15,493 unique sessions, 408 retained location identities,
  575 checkouts and no warnings. Cold/warm samples were 31.3s/8.8s during concurrent qualification;
  these are observations, not performance guarantees.
- Rhythm receiver: 13 focused tests, 73 Electron tests and native sandbox cold/second-instance
  checks pass (companion branch). Main/preload source matches the running development shell.
- Qualified neutral live renderer installed with a private previous-build backup. Real Bot Open
  reached its requested URI; after the update reload, supported Google sign-in restored the session.
  Native accessibility URL and heading matched Bot's exact local session ID/title. A second target
  selected correctly without another reload; the previous target was restored. Live Electron main,
  API and engine process IDs remained unchanged and both services displayed healthy.
- Native screenshot `rhythm-opening-live.png` is in the same private visualization directory.
- Existing archive state remains intact (6,960 entries at final check).
- Fork draft #4 targets `codex/rhythm-session-graph`; draft status and base were verified.
  GitHub reports no check runs, consistent with the absence of a configured workflow.
- Dev Dashboard run recorded successfully at state revision 4218.

## Notes

The native Codex probe initially failed Bot Crossing's same-origin check because the probe omitted
an Origin header. Adding the browser-equivalent header repaired the harness; no application CSRF
change was needed. Unit OS-dispatch tests alone would not prove native selection, hence the separate
installed-desktop route receipt assertion.

The user approved the narrow Rhythm Electron renderer change after the original brief excluded
Rhythm source changes. The separate implementation must not restart or adopt live API/engine services.
The shipping Flutter app and terminal resume are outside this opening qualification.

The first warm-profile opening still used the old JavaScript: a fragment-only navigation does not
reload a running document after generated assets change. One normal renderer Reload picked up the
new assets. Existing Electron security policy invalidates authentication on full main-frame reload,
so normal Google sign-in was required once. No auth policy was weakened, no tokens were injected,
and no main/API/engine process was restarted. Ordinary later session links remain same-document
navigation and preserved authentication. This installation step is now documented.

## Run review

Disjoint repository ownership kept the Bot adapter/UI work separate from the Rhythm receiver.
Native selection evidence caught the stale loaded renderer that synthetic dispatch tests could
not detect. The same-origin probe and installation instructions now cover both findings.
The shared workflow wrapper's missing-script assumption and unavailable TodoWrite were recorded;
the durable plan and direct native checks supplied the required evidence. Pattern mining found
no recurring correctness failures. Related smoke interactions were consolidated into one
postmortem, a documented timing deviation. No global workflow or skill changes were made.
