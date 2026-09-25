# Rhythm embedded artifact final pin receipt

The final pin is the orchestrator-created commit for this lane after it reviews and commits the uncommitted `codex/colony-host-protocol` work. This implementer cannot create that commit, so `a30b4c924be4344d444f1826e1dec88fb138a4ad` is only the lane base and must not be used as the final pin.

## Pinned build inputs

- Source revision: `<ORCHESTRATOR_COMMIT_FOR_THIS_LANE>`
- Electron: `40.10.2` (`electronMajor: 40`)
- Node: `22.22.0` (the Rhythm CI packager patch)
- Minimum macOS: `12.0`

## Clean qualification command

Run from a fresh clone with Node 22.22.0. The dependency install is intentionally reserved for the orchestrator because implementer worktrees share symlinked dependencies.

```sh
git checkout <ORCHESTRATOR_COMMIT_FOR_THIS_LANE>
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

## Implementer candidate receipt

The in-worktree build is evidence only for this uncommitted candidate. It cannot qualify the final pin because its source revision remains the base commit, its dirty flags must be true, and the available runtime is Node 22.23.0 rather than the required Node 22.22.0. The orchestrator must replace this section with the clean-clone receipt after committing the lane.
