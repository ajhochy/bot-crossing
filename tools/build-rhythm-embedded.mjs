import { build } from 'vite'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const destination = path.join(root, 'build/rhythm-embedded')
const stage = `${destination}.tmp-${process.pid}`
const assetSources = new Map([
  ['crew.glb', 'CC0-1.0'],
  ['forest.glb', 'CC0-1.0'],
  ['nature.glb', 'CC0-1.0'],
  ['spacebase.glb', 'CC0-1.0'],
  ['lighting/studio_small_09_1k.hdr', 'CC0-1.0'],
])
const allowedAssetExtras = new Set(['CREDITS.md', 'lighting/README.md'])

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

async function safeCopy(source, target) {
  const stat = await fs.lstat(source)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected regular build input: ${path.relative(root, source)}`)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.copyFile(source, target)
}

async function copyServer(relative = '') {
  const sourceDir = path.join(root, 'server', relative)
  for (const entry of (await fs.readdir(sourceDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const next = path.join(relative, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Symlink in server source: ${next}`)
    if (entry.isDirectory()) await copyServer(next)
    else if (entry.isFile() && entry.name !== 'serve.mjs' && /\.(mjs|cjs|js)$/.test(entry.name)) {
      await safeCopy(path.join(sourceDir, entry.name), path.join(stage, 'server', next))
    }
  }
}

async function walkFiles(dir, relative = '') {
  const found = []
  for (const entry of (await fs.readdir(path.join(dir, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const next = path.posix.join(relative, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Symlink in artifact: ${next}`)
    if (entry.isDirectory()) found.push(...await walkFiles(dir, next))
    else if (entry.isFile()) found.push(next)
    else throw new Error(`Unsupported artifact entry: ${next}`)
  }
  return found
}

async function main() {
  if (process.versions.node !== '22.23.0') throw new Error(`Embedded build requires Node 22.23.0, got ${process.versions.node}`)
  const sourceCommit = git(['rev-parse', 'HEAD'])
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Cannot identify exact source revision')
  const sourceDirty = Boolean(git(['status', '--porcelain=v1', '--untracked-files=all']))

  // Public assets are an allowlist. A newly added file is rejected until its licence is reviewed.
  const assetDir = path.join(root, 'public/assets')
  const actualAssets = await walkFiles(assetDir)
  const unexpected = actualAssets.filter(file => !assetSources.has(file) && !allowedAssetExtras.has(file))
  if (unexpected.length) throw new Error(`Unlicensed asset or missing license inventory: ${unexpected.join(', ')}`)
  for (const file of assetSources.keys()) {
    if (!actualAssets.includes(file)) throw new Error(`Licensed asset missing: ${file}`)
  }

  await fs.rm(stage, { recursive: true, force: true })
  try {
    await build({
      configFile: false,
      root,
      base: '/',
      publicDir: false,
      logLevel: 'error',
      build: { outDir: path.join(stage, 'renderer'), emptyOutDir: true, target: 'esnext' },
    })
    for (const file of actualAssets) {
      await safeCopy(path.join(assetDir, file), path.join(stage, 'renderer/assets', file))
    }
    await copyServer()
    await safeCopy(path.join(root, 'LICENSE'), path.join(stage, 'licenses/Bot-Crossing-MIT.txt'))
    await safeCopy(path.join(root, 'licenses/CC0-1.0.txt'), path.join(stage, 'licenses/CC0-1.0.txt'))
    await safeCopy(path.join(root, 'licenses/Apache-2.0.txt'), path.join(stage, 'licenses/Apache-2.0.txt'))
    for (const [name, target] of [['three', 'three-MIT.txt'], ['@mdi/js', 'mdi-Apache-2.0.txt']]) {
      const packageRoot = path.join(root, 'node_modules', name)
      const pkg = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'))
      const expected = name === 'three' ? 'MIT' : 'Apache-2.0'
      if (pkg.license !== expected) throw new Error(`Unexpected ${name} licence: ${pkg.license}`)
      await safeCopy(path.join(packageRoot, 'LICENSE'), path.join(stage, 'licenses', target))
    }
    const inventory = [
      { component: 'Bot Crossing renderer and scanner host', license: 'MIT', notice: 'licenses/Bot-Crossing-MIT.txt' },
      { component: 'three', license: 'MIT', notice: 'licenses/three-MIT.txt' },
      { component: '@mdi/js icons', license: 'Apache-2.0', notice: 'licenses/mdi-Apache-2.0.txt', licenseText: 'licenses/Apache-2.0.txt' },
      ...[...assetSources].map(([file, license]) => ({ component: `renderer/assets/${file}`, license, notice: 'licenses/CC0-1.0.txt' })),
    ]
    await fs.writeFile(path.join(stage, 'licenses/inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`)
    await fs.writeFile(path.join(stage, 'package.json'), '{"type":"module","private":true}\n')
    const files = {
      renderer: 'renderer/index.html',
      host: 'server/embedded-host.mjs',
      preload: 'server/embedded-preload.cjs',
      worker: 'server/embedded-worker.mjs',
    }
    for (const entry of Object.values(files)) await fs.access(path.join(stage, entry))
    const allFiles = await walkFiles(stage)
    const integrity = Object.fromEntries(await Promise.all(allFiles.map(async file => [
      file,
      `sha256-${createHash('sha256').update(await fs.readFile(path.join(stage, file))).digest('base64')}`,
    ])))
    const actualAssetSizeBytes = (await Promise.all([...assetSources.keys()].map(file => fs.stat(path.join(stage, 'renderer/assets', file)))))
      .reduce((total, stat) => total + stat.size, 0)
    if (!actualAssetSizeBytes) throw new Error('Empty licensed asset inventory')
    const manifest = {
      schemaVersion: 1,
      product: 'colony',
      sourceCommit,
      electronMajor: 40,
      electronVersion: '40.10.2',
      nodeVersion: '22.23.0',
      minimumMacOSVersion: '12.0',
      dirty: sourceDirty,
      sourceDirty,
      files,
      licenseInventory: inventory,
      assetSizeBytes: actualAssetSizeBytes,
      integrity,
    }
    await fs.writeFile(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await fs.rm(destination, { recursive: true, force: true })
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.rename(stage, destination)
    console.log(`Embedded Colony: ${allFiles.length} sealed files, ${actualAssetSizeBytes} asset bytes, ${sourceCommit}${sourceDirty ? ' (dirty)' : ''}`)
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true })
    throw error
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
