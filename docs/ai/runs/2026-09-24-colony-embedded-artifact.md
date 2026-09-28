---
date: 2026-09-24
repo: bot-crossing
branch: codex/colony-embedded-artifact
pr: null
issues: [1526]
status: pending
tags: [run, bot-crossing]
---

# COL-01 embedded artifact builder

## Files

`tools/build-rhythm-embedded.mjs` builds the existing Vite renderer, copies the real scanner/API modules into a callable host, stages a narrow Electron preload, and seals every emitted file except `manifest.json` (which cannot hash itself). The asset allowlist covers four GLBs and one HDR; unknown assets fail. MIT, CC0 1.0, Apache 2.0, and the installed Three/Pictogrammers notices are staged and included in integrity. No harness store was an input to the builder.

## Checks

- `node --test test/rhythm-embedded-build.test.mjs`: 4/4 pass, including clean synthetic checkout, deterministic rebuild, dirty/private-data behavior, full integrity, and unlicensed asset rejection.
- Synthetic adapter, repository grouping, worker graph, and preferences suite: 89/89 pass. Its fixtures use temporary stores; the project-preferences fixture opens its own temporary loopback API socket. No live harness scan or existing service was used.
- `npm run build`: pass; existing large chunk warning.
- `npm run build:rhythm-embedded`: pass locally; manifest correctly reports `dirty: true` and `sourceDirty: true` because changes are uncommitted.
- `git diff --check`: pass.

## Artifact baseline and inputs

- Source HEAD during local build: `0f3e79d05aaeecec0091aff83d8547c11de2063c`; this is **not** the eventual clean pinned revision.
- Inputs declared in manifest: Electron `40.10.2` (major 40), Node `22.23.0` for the builder and `node:sqlite` support, minimum macOS `12.0`.
- 38 files covered by SRI `sha256-<base64>` entries; `manifest.json` is excluded from its own integrity map.
- Licensed model/HDR asset size baseline: 6,841,476 bytes. Total local artifact disk usage: approximately 10 MB.
- Local manifest SHA-256: `34f9991e0ba861cb074248cd47c6fba5c11ec8252eb45dd35a613173bf1309d5`. Its `integrity` map is the package comparison input; a clean pinned build will have a different manifest source revision and dirty flags.
- Reused the installed `/Users/ajhochhalter/Documents/bot-crossing/node_modules` through an ignored link in this isolated worktree; contract fixtures link to that same dependency installation. No package installation or real data copy occurred.

## Notes

The host entry exports `createEmbeddedHost({ dataDir, scan })`; it does not bind a port or scan on import. The future Rhythm receiver must own the private child channel, profile-scoped data directory, artifact verification, and Electron tab lifecycle. The preload exposes only product/runtime identity. No functional embedded tab, installed Electron run, signed package, or clean pinned artifact is claimed here.
The subsequent shared-state slice passed the full upstream suite (213 tests) and production build. Parent independently replayed 24 shared-state/service cases. Native rendering and private Electron IPC remain unverified. GitNexus detection was attempted but Bot Crossing is not indexed, so direct product-diff review supplies the available scope evidence.
