import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const root = fileURLToPath(new URL('../', import.meta.url))

test('sealed artifact declares and authenticates its private worker and protocol dependencies', async () => {
  assert.equal(await fs.stat(path.join(root, 'server/embedded-worker.mjs')).then(stat => stat.isFile()).catch(() => false), true,
    'Worker artifact contract requires the actual private worker entry')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-worker-artifact-'))
  const run = (command, args) => execFileSync(command, args, { cwd: dir, stdio: 'pipe', timeout: 60_000 })
  try {
    for (const relative of ['package.json', 'package-lock.json', 'index.html', 'LICENSE', 'licenses', 'src', 'server', 'public/assets']) {
      await fs.cp(path.join(root, relative), path.join(dir, relative), { recursive: true })
    }
    await fs.mkdir(path.join(dir, 'tools'))
    for (const name of await fs.readdir(path.join(root, 'tools'))) {
      if (/^build-[a-z0-9-]+\.mjs$/i.test(name)) await fs.copyFile(path.join(root, 'tools', name), path.join(dir, 'tools', name))
    }
    run('git', ['init', '-q'])
    run('git', ['add', '-A'])
    run('git', ['-c', 'user.name=Contract Fixture', '-c', 'user.email=contract@example.invalid', 'commit', '-qm', 'synthetic worker artifact'])
    await fs.symlink(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir')
    await fs.appendFile(path.join(dir, '.git/info/exclude'), '\n/node_modules\n')
    run(process.execPath, ['tools/build-rhythm-embedded.mjs'])
    const artifact = path.join(dir, 'build/rhythm-embedded')
    const manifest = JSON.parse(await fs.readFile(path.join(artifact, 'manifest.json'), 'utf8'))
    assert.equal(manifest.files.worker, 'server/embedded-worker.mjs')
    for (const relative of [manifest.files.worker, 'server/embedded-scanner.mjs', 'server/embedded-protocol.mjs', 'server/embedded-service.mjs', 'server/state-store.mjs', 'server/state-model.mjs']) {
      const content = await fs.readFile(path.join(artifact, relative))
      assert.equal(manifest.integrity[relative], `sha256-${createHash('sha256').update(content).digest('base64')}`)
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
