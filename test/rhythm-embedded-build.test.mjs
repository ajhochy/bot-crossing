/**
 * COL-01 builder contracts. The fixture copies only Bot Crossing build/runtime source into a
 * temporary checkout; it never opens or scans any real harness store. The actual builder is
 * invoked through npm's public script seam, and only its generated temporary artifact is read.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entrypoints = ['renderer', 'host', 'preload']
const excludedCanaries = [
  '.env',
  'data/colony.json',
  'data/native-openers.json',
  'data/identities.json',
  'data/archive-backup-contract.json',
  'private/transcripts/contract-fixture.json',
  'private/screenshots/contract-fixture.png',
  'public/audio/contract-fixture.wav',
  'dev/credentials-contract-fixture.json',
]

function run(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, CI: '1', npm_config_update_notifier: 'false' },
  })
}

function runBuilder(cwd) {
  return run('npm', ['run', 'build:rhythm-embedded'], cwd)
}

function diagnostic(result) {
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
}

async function copyTree(source, destination, filter = () => true) {
  await fs.cp(source, destination, {
    recursive: true,
    filter: (entry) => filter(path.relative(root, entry).split(path.sep).join('/')),
  })
}

async function makeCheckout({ canaries = false, unlicensedAsset = false } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'col-01-embedded-contract-'))
  const files = [
    'package.json', 'package-lock.json', 'index.html', 'vite.config.js',
    'README.md', 'LICENSE', 'TRADEMARKS.md', 'licenses', 'src', 'server', 'public/assets',
    'public/audio/README.md',
  ]
  for (const relative of files) {
    const source = path.join(root, relative)
    try {
      await fs.access(source)
      await copyTree(source, path.join(temp, relative))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  // Include the candidate implementation and its build helpers, but no test fixtures, local
  // data, screenshots, transcripts, or harness databases.
  const toolsDir = path.join(root, 'tools')
  for (const name of await fs.readdir(toolsDir)) {
    if (!/^build-[a-z0-9-]+\.mjs$/i.test(name)) continue
    await fs.mkdir(path.join(temp, 'tools'), { recursive: true })
    await fs.copyFile(path.join(toolsDir, name), path.join(temp, 'tools', name))
  }

  if (canaries) {
    for (const relative of excludedCanaries) {
      const target = path.join(temp, relative)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, `synthetic exclusion canary: ${relative}\n`)
    }
  }
  if (unlicensedAsset) {
    await fs.writeFile(path.join(temp, 'public/assets/unlicensed-contract-fixture.bin'), 'synthetic unlicensed asset\n')
  }

  const init = run('git', ['init', '-q'], temp)
  assert.equal(init.status, 0, `Could not initialize isolated synthetic checkout: ${diagnostic(init)}`)
  run('git', ['config', 'user.name', 'Contract Fixture'], temp)
  run('git', ['config', 'user.email', 'contract-fixture@example.invalid'], temp)
  const add = run('git', ['add', '-A'], temp)
  assert.equal(add.status, 0, `Could not stage synthetic fixture: ${diagnostic(add)}`)
  const commit = run('git', ['commit', '-qm', 'synthetic COL-01 contract fixture'], temp)
  assert.equal(commit.status, 0, `Could not commit synthetic fixture: ${diagnostic(commit)}`)
  const head = run('git', ['rev-parse', 'HEAD'], temp)
  assert.equal(head.status, 0, `Could not read synthetic fixture revision: ${diagnostic(head)}`)

  // Reuse already-installed dependencies when present; this is only a temp checkout link and
  // is excluded from artifact expectations. The contract never installs packages.
  try {
    await fs.access(path.join(root, 'node_modules'))
    await fs.symlink(path.join(root, 'node_modules'), path.join(temp, 'node_modules'), 'dir')
    await fs.appendFile(path.join(temp, '.git/info/exclude'), '\n/node_modules\n')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  return { root: temp, sourceCommit: head.stdout.trim(), dispose: () => fs.rm(temp, { recursive: true, force: true }) }
}

async function readArtifact(checkout) {
  const dir = path.join(checkout, 'build/rhythm-embedded')
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'))
  return { dir, manifest }
}

async function walkFiles(directory, relative = '') {
  const files = []
  for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const child = path.posix.join(relative, entry.name)
    const absolute = path.join(directory, child)
    const stat = await fs.lstat(absolute)
    assert.equal(stat.isSymbolicLink(), false, `Artifact must not contain symlink: ${child}`)
    if (stat.isDirectory()) files.push(...await walkFiles(directory, child))
    else if (stat.isFile()) files.push(child)
  }
  return files
}

async function assertIntegrity(artifact) {
  const { dir, manifest } = artifact
  assert.ok(manifest.integrity && typeof manifest.integrity === 'object', 'manifest.integrity must be a path-to-SRI map')
  const files = (await walkFiles(dir)).filter((relative) => relative !== 'manifest.json').sort()
  const keys = Object.keys(manifest.integrity).sort()
  assert.deepEqual(keys, files, 'integrity must cover every artifact file except manifest.json, which cannot self-hash')
  for (const relative of files) {
    assert.equal(path.isAbsolute(relative), false, `integrity path must be relative: ${relative}`)
    assert.equal(relative.split('/').includes('..'), false, `integrity path must stay inside artifact: ${relative}`)
    const expected = `sha256-${crypto.createHash('sha256').update(await fs.readFile(path.join(dir, relative))).digest('base64')}`
    assert.equal(manifest.integrity[relative], expected, `wrong SRI digest for ${relative}`)
  }
}

async function assertNoAbsoluteManifestPaths(manifest) {
  const inspect = (value, label) => {
    if (typeof value === 'string') {
      assert.equal(path.isAbsolute(value), false, `${label} must not contain an absolute path: ${value}`)
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => inspect(item, `${label}[${index}]`))
    } else if (value && typeof value === 'object') {
      Object.entries(value).forEach(([key, item]) => inspect(item, `${label}.${key}`))
    }
  }
  inspect(manifest, 'manifest')
  for (const role of entrypoints) {
    const relative = manifest.files?.[role]
    assert.equal(typeof relative, 'string', `manifest.files.${role} must be a path`)
    assert.equal(path.isAbsolute(relative), false, `${role} path must be relative`)
    assert.equal(relative.split(/[\\/]/).includes('..'), false, `${role} path must stay within artifact`)
  }
}

test('issue-1526-c1: a clean upstream checkout emits the pinned revision, Electron major, and three entry points without Rhythm', async (t) => {
  // Regression: an artifact may silently build from another revision or rely on an adjacent
  // Rhythm checkout. The observable failure is a missing/mismatched manifest or entry file.
  const checkout = await makeCheckout()
  t.after(checkout.dispose)
  const result = runBuilder(checkout.root)
  assert.equal(result.status, 0, `Builder must exist and succeed from this isolated Bot Crossing checkout:\n${diagnostic(result)}`)
  const artifact = await readArtifact(checkout.root)
  assert.equal(artifact.manifest.sourceCommit, checkout.sourceCommit, 'sourceCommit must be the exact revision built')
  assert.match(artifact.manifest.sourceCommit, /^[0-9a-f]{40}$/, 'sourceCommit must be a full Git SHA')
  assert.equal(artifact.manifest.electronMajor, 40, 'manifest must use Rhythm Electron 40.10.2 major')
  assert.equal(artifact.manifest.schemaVersion, 1)
  assert.equal(artifact.manifest.product, 'colony')
  assert.equal(artifact.manifest.dirty, false)
  assert.equal(artifact.manifest.sourceDirty, false)
  await assertNoAbsoluteManifestPaths(artifact.manifest)
  assert.equal(new Set(entrypoints.map((role) => artifact.manifest.files[role])).size, entrypoints.length,
    'renderer, host, and preload must be separate entry points')
  for (const role of entrypoints) {
    await fs.access(path.join(artifact.dir, artifact.manifest.files[role]))
  }
})

test('issue-1526-c2: identical pinned inputs reproduce identical integrity digests', async (t) => {
  // Regression: timestamps or nondeterministic build IDs change the seal for unchanged inputs.
  const checkout = await makeCheckout()
  t.after(checkout.dispose)
  const first = runBuilder(checkout.root)
  assert.equal(first.status, 0, `First deterministic build must succeed:\n${diagnostic(first)}`)
  const firstArtifact = await readArtifact(checkout.root)
  const firstIntegrity = firstArtifact.manifest.integrity
  await fs.rm(firstArtifact.dir, { recursive: true, force: true })
  const second = runBuilder(checkout.root)
  assert.equal(second.status, 0, `Second deterministic build must succeed:\n${diagnostic(second)}`)
  const secondArtifact = await readArtifact(checkout.root)
  assert.deepEqual(secondArtifact.manifest.integrity, firstIntegrity, 'same source inputs must reproduce identical seals')
})

test('issue-1526-c3: dirty sources cannot be sealed clean and emitted trees are sealed, contained, and private-data free', async (t) => {
  // Regression: a modified source can be mislabeled clean, or private paths/symlinks can leak
  // into an otherwise valid artifact. Canaries below are synthetic, never harness data.
  const dirty = await makeCheckout()
  t.after(dirty.dispose)
  await fs.appendFile(path.join(dirty.root, 'README.md'), '\nsynthetic dirty-tree marker\n')
  const dirtyResult = runBuilder(dirty.root)
  if (dirtyResult.status === 0) {
    const artifact = await readArtifact(dirty.root)
    assert.ok(artifact.manifest.dirty === true || artifact.manifest.sourceDirty === true,
      'dirty tree must set dirty or sourceDirty true')
    await assertIntegrity(artifact)
    await assertNoAbsoluteManifestPaths(artifact.manifest)
  } else {
    assert.match(diagnostic(dirtyResult), /dirty|working tree|uncommitted/i,
      `non-zero build must identify dirty source, not an unrelated setup failure:\n${diagnostic(dirtyResult)}`)
  }

  const privateFixture = await makeCheckout({ canaries: true })
  t.after(privateFixture.dispose)
  const privateResult = runBuilder(privateFixture.root)
  if (privateResult.status !== 0) {
    assert.match(diagnostic(privateResult), /excluded|private|developer data|forbidden/i,
      `private-data rejection must be deliberate, not a missing builder/setup failure:\n${diagnostic(privateResult)}`)
  } else {
    const artifact = await readArtifact(privateFixture.root)
    const files = await walkFiles(artifact.dir)
    for (const canary of excludedCanaries) {
      assert.equal(files.some((file) => file === canary || file.endsWith(`/${canary}`)), false,
        `excluded synthetic path leaked into artifact: ${canary}`)
    }
    await assertIntegrity(artifact)
    await assertNoAbsoluteManifestPaths(artifact.manifest)
  }
})

test('issue-1526-c4: shipped assets have an integrity-covered license inventory and recorded size baseline', async (t) => {
  // Regression: a shipped art/icon asset loses its notice, or its size drifts without a
  // recorded baseline. A new unlicensed synthetic asset must stop the build explicitly.
  const checkout = await makeCheckout()
  t.after(checkout.dispose)
  const result = runBuilder(checkout.root)
  assert.equal(result.status, 0, `Builder must emit a licensed artifact:\n${diagnostic(result)}`)
  const artifact = await readArtifact(checkout.root)
  await assertIntegrity(artifact)
  const files = await walkFiles(artifact.dir)
  const text = (await Promise.all(files.filter((file) => /\.(?:md|txt|json)$/i.test(file))
    .map((file) => fs.readFile(path.join(artifact.dir, file), 'utf8')))).join('\n')
  for (const license of ['MIT', 'CC0', 'Apache-2.0']) {
    assert.ok(text.includes(license), `artifact must contain applicable ${license} notice/inventory`)
  }
  assert.ok(Array.isArray(artifact.manifest.licenseInventory) && artifact.manifest.licenseInventory.length > 0,
    'manifest must record the shipped license inventory')
  assert.ok(Number.isSafeInteger(artifact.manifest.assetSizeBytes) && artifact.manifest.assetSizeBytes > 0,
    'manifest must record a positive asset size baseline in bytes')

  const unlicensed = await makeCheckout({ unlicensedAsset: true })
  t.after(unlicensed.dispose)
  const unlicensedResult = runBuilder(unlicensed.root)
  assert.notEqual(unlicensedResult.status, 0, 'builder must reject an unlicensed shipped asset')
  assert.match(diagnostic(unlicensedResult), /unlicensed|license inventory|licence inventory/i,
    `rejection must identify the missing asset licence:\n${diagnostic(unlicensedResult)}`)
})
