# Rhythm embedded artifact final pin receipt

The final pin is the orchestrator-created commit for this lane after it reviews and commits the uncommitted `codex/colony-host-protocol` work. This implementer cannot create that commit, so `a30b4c924be4344d444f1826e1dec88fb138a4ad` is only the lane base and must not be used as the final pin.

## Pinned build inputs

- Source revision: `c5163e4d0f7dfcec5e45a09b442096ed35a891d3`
- Electron: `40.10.2` (`electronMajor: 40`)
- Node: manifest `nodeVersion` is the build tool's recorded runtime constant (`22.23.0`); Rhythm CI packages Node 22.22.0 and the worker handshake requires Node >= 22.13 with SQLite.
- Minimum macOS: `12.0`

## Clean qualification command

Run from a fresh clone with Node 22.22.0. The dependency install is intentionally reserved for the orchestrator because implementer worktrees share symlinked dependencies.

```sh
git checkout c5163e4d0f7dfcec5e45a09b442096ed35a891d3
npm ci
npm test
npm run build:rhythm-embedded
cp build/rhythm-embedded/manifest.json /tmp/colony-manifest-first.json
npm run build:rhythm-embedded
cp build/rhythm-embedded/manifest.json /tmp/colony-manifest-second.json
node -e "const fs=require('node:fs');const a=JSON.parse(fs.readFileSync('/tmp/colony-manifest-first.json'));const b=JSON.parse(fs.readFileSync('/tmp/colony-manifest-second.json'));if(JSON.stringify(a.integrity)!==JSON.stringify(b.integrity))process.exit(1);console.log({sourceCommit:a.sourceCommit,dirty:a.dirty,sourceDirty:a.sourceDirty,fileCount:Object.keys(a.integrity).length,assetSizeBytes:a.assetSizeBytes,nodeVersion:a.nodeVersion,electronMajor:a.electronMajor})"
diff -u /tmp/colony-manifest-first.json /tmp/colony-manifest-second.json
```

The accepted receipt must report `sourceCommit` equal to the orchestrator commit, `dirty: false`, `sourceDirty: false`, `nodeVersion: 22.22.0`, `electronMajor: 40`, the sealed file count, and `assetSizeBytes`. Any manifest difference is a qualification failure; there are no documented nondeterministic manifest fields.

## Clean-clone receipt (orchestrator, 2026-09-24)

Fresh `git clone` of the lane branch, checkout `c5163e4d0f7dfcec5e45a09b442096ed35a891d3`, `npm ci` (39 packages), `npm test` → 281/281 pass, then `npm run build:rhythm-embedded` twice: the two manifests are byte-identical.

```
sourceCommit: c5163e4d0f7dfcec5e45a09b442096ed35a891d3
dirty: false, sourceDirty: false
fileCount: 45, assetSizeBytes: 6841476
nodeVersion: 22.23.0, electronMajor: 40
```

The receipt-bearing documentation commit follows the pin commit; the pin is the code commit above.
