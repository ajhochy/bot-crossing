/** Sanitized preview: creates disposable Git fixtures only inside a fresh OS temporary directory. */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-preview-')))
const main = path.join(dir, 'garden')
const worker = path.join(dir, 'isolated-worker')
const clone = path.join(dir, 'separate-clone', 'garden')
const scratch = path.join(dir, 'sketchbook')
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { stdio: 'pipe' })
await fs.mkdir(main)
git(main, 'init', '-qb', 'main')
git(main, '-c', 'user.name=Preview', '-c', 'user.email=preview@example.invalid', '-c', 'commit.gpgsign=false',
  'commit', '--allow-empty', '-qm', 'Synthetic preview')
git(main, 'worktree', 'add', '-qb', 'codex/worker', worker)
git(main, 'worktree', 'add', '-qb', 'codex/unused', path.join(dir, 'unused-worktree'))
await fs.mkdir(path.dirname(clone))
git(dir, 'clone', '-q', main, clone)
await fs.mkdir(scratch)
await fs.writeFile(path.join(worker, 'draft.txt'), 'Synthetic untracked file\n')
const now = Date.now()
const session = (id, title, cwd, harness, extra = {}) => ({
  id, title, cwd, projectPath: cwd, project: path.basename(cwd), harness,
  harnessName: { codex: 'Codex', 'claude-code': 'Claude Code', rhythm: 'Rhythm', hermes: 'Hermes' }[harness],
  createdAt: now - 3600000, lastActivityAt: now, archived: false, running: false,
  activity: 'quiet', activityEvidence: extra.running === true ? 'Synthetic fixture; turn started' :
    extra.activity === 'unknown' ? 'Synthetic fixture; current activity unavailable' : 'Synthetic fixture; completed turn', unread: null,
  sizeBytes: 30000, canOpen: false, openUnavailableReason: 'Synthetic preview: no real conversation to open', ...extra,
})
const rows = [
  session('codex:preview-parent', 'Build the garden', main, 'codex', { running: true, activity: 'running' }),
  session('claude-code:preview-main', 'Review the shared checkout', main, 'claude-code', { running: true, activity: 'running' }),
  session('codex:preview-worker', 'Plant the worker beds', worker, 'codex', { parentId: 'codex:preview-parent', running: true, activity: 'running' }),
  session('codex:preview-nested', 'Check the irrigation', worker, 'codex', { parentId: 'codex:preview-worker', hasError: true }),
  session('rhythm:preview-parent', 'Plan next season', main, 'rhythm', { archived: true, profile: 'planner' }),
  session('rhythm:preview-child', 'Inspect the greenhouse', worker, 'rhythm', { parentId: 'rhythm:preview-parent', running: true, activity: 'running', agentName: 'Gardener', profile: 'builder' }),
  session('hermes:default:clone', 'Independent clone notes', clone, 'hermes', { running: null, activity: 'unknown', profile: 'default' }),
  session('codex:preview-missing', 'Moved checkout record', path.join(dir, 'missing-garden'), 'codex', { running: null, activity: 'unknown' }),
  session('hermes:sketch:notes', 'Non-Git planting sketch', scratch, 'hermes', { profile: 'sketch' }),
]
const fixture = path.join(dir, 'sessions.json')
await fs.writeFile(fixture, JSON.stringify(rows, null, 2))
console.log(JSON.stringify({ fixture, dataDir: path.join(dir, 'colony'), root: dir }))
