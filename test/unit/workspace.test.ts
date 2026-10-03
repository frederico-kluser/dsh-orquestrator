import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  classifyPath, defaultIo, describeFacts, diffSnapshots, globToRegExp, parseStatus, snapshotWorkspace, type WorkspaceIo, type WorkspaceSnapshot,
} from '../../src/workspace.ts'

/** A scripted workspace: a repo root, a `git status` output and file contents. */
function fakeIo(options: { root?: string; status: string; files: Record<string, string | number>; failGit?: string }): WorkspaceIo {
  return {
    git(args) {
      if (options.failGit !== undefined && args.includes(options.failGit)) return Promise.reject(new Error('git: boom\nmore'))
      if (args[0] === 'rev-parse') return Promise.resolve(`${options.root ?? '/repo'}\n`)
      return Promise.resolve(options.status)
    },
    readFile(path) {
      const value = options.files[path.replace(`${options.root ?? '/repo'}/`, '')]
      return typeof value === 'string' ? Promise.resolve(new TextEncoder().encode(value)) : Promise.reject(new Error('unexpected read'))
    },
    size(path) {
      const value = options.files[path.replace(`${options.root ?? '/repo'}/`, '')]
      if (value === undefined) return Promise.resolve(undefined)
      return Promise.resolve(typeof value === 'number' ? value : value.length)
    },
  }
}

const ok = (snapshot: WorkspaceSnapshot): ReadonlyMap<string, string> => {
  assert.equal(snapshot.ok, true)
  return snapshot.ok ? snapshot.entries : new Map()
}

describe('parseStatus', () => {
  it('reads NUL-separated porcelain records, including renames', () => {
    const raw = ' M src/a.ts\0?? new file.ts\0R  src/new.ts\0src/old.ts\0 D gone.ts\0'
    assert.deepEqual(parseStatus(raw), ['src/a.ts', 'new file.ts', 'src/new.ts', 'gone.ts'])
    assert.deepEqual(parseStatus(''), [])
  })
})

describe('snapshotWorkspace', () => {
  it('fingerprints dirty files by content and marks deleted ones', async () => {
    const snapshot = await snapshotWorkspace('/repo', fakeIo({ status: ' M a.ts\0?? b.ts\0 D c.ts\0', files: { 'a.ts': 'one', 'b.ts': 'two' } }))
    const entries = ok(snapshot)
    assert.equal(entries.size, 3)
    assert.equal(entries.get('c.ts'), 'deleted')
    assert.notEqual(entries.get('a.ts'), entries.get('b.ts'))
    assert.match(entries.get('a.ts') ?? '', /^[0-9a-f]{40}$/)
  })

  it('fingerprints very large files by size instead of reading them', async () => {
    const snapshot = await snapshotWorkspace('/repo', fakeIo({ status: '?? big.bin\0', files: { 'big.bin': 50 * 1024 * 1024 } }))
    assert.equal(ok(snapshot).get('big.bin'), `size:${String(50 * 1024 * 1024)}`)
  })

  it('degrades to ok:false without a directory, without git, or when git fails', async () => {
    assert.deepEqual(await snapshotWorkspace(undefined, fakeIo({ status: '', files: {} })), { ok: false, reason: 'the session has no working directory' })
    const failed = await snapshotWorkspace('/repo', fakeIo({ status: '', files: {}, failGit: 'status' }))
    assert.deepEqual(failed, { ok: false, reason: 'git: boom' })
    const notRepo: WorkspaceIo = { ...fakeIo({ status: '', files: {} }), git: () => Promise.resolve('\n') }
    assert.deepEqual(await snapshotWorkspace('/tmp', notRepo), { ok: false, reason: 'not a git repository' })
  })

  it('marks a snapshot truncated past the entry cap', async () => {
    const names = Array.from({ length: 2005 }, (_, index) => `f${String(index)}.txt`)
    const files = Object.fromEntries(names.map(name => [name, 'x']))
    const snapshot = await snapshotWorkspace('/repo', fakeIo({ status: `${names.map(name => `?? ${name}`).join('\0')}\0`, files }))
    assert.equal(snapshot.ok && snapshot.truncated, true)
    assert.equal(ok(snapshot).size, 2000)
  })
})

describe('diffSnapshots', () => {
  const snap = (entries: Record<string, string>, truncated = false): WorkspaceSnapshot => ({ ok: true, entries: new Map(Object.entries(entries)), truncated })

  it('reports files added, edited, deleted and reverted, and ignores the untouched', () => {
    const before = snap({ 'same.ts': 'h1', 'edited.ts': 'h2', 'reverted.ts': 'h3' })
    const after = snap({ 'same.ts': 'h1', 'edited.ts': 'h9', 'added.ts': 'h4', 'gone.ts': 'deleted' })
    const facts = diffSnapshots(before, after)
    assert.deepEqual(facts?.changed, ['added.ts', 'edited.ts', 'gone.ts', 'reverted.ts'])
    assert.equal(facts?.truncated, false)
  })

  it('is undefined when either snapshot is unavailable, and carries truncation', () => {
    assert.equal(diffSnapshots({ ok: false, reason: 'x' }, snap({})), undefined)
    assert.equal(diffSnapshots(snap({}), { ok: false, reason: 'x' }), undefined)
    assert.equal(diffSnapshots(snap({}, true), snap({ 'a.ts': 'h' }))?.truncated, true)
  })

  it('flags test, runner and CI files among the changes', () => {
    const facts = diffSnapshots(snap({}), snap({
      'src/app.ts': '1', 'test/app.test.ts': '2', 'conftest.py': '3', '.github/workflows/ci.yml': '4', 'package.json': '5', 'docs/db/schema.sql': '6',
    }), [globToRegExp('docs/db/**')])
    assert.deepEqual(facts?.flagged, [
      { path: '.github/workflows/ci.yml', kind: 'ci' },
      { path: 'conftest.py', kind: 'runner-config' },
      { path: 'docs/db/schema.sql', kind: 'runner-config' },
      { path: 'package.json', kind: 'runner-config' },
      { path: 'test/app.test.ts', kind: 'test' },
    ])
  })
})

describe('classifyPath', () => {
  it('recognizes the files a worker could weaken to fake a pass', () => {
    for (const path of ['tests/a.py', 'src/__tests__/x.ts', 'a.spec.js', 'pkg/foo_test.go', 'test_util.py', 'e2e/flow.ts']) assert.equal(classifyPath(path), 'test', path)
    for (const path of ['conftest.py', 'sub/pytest.ini', 'jest.config.ts', 'apps/web/vitest.config.mts', '.mocharc.json', 'pyproject.toml', 'Makefile', 'package.json']) assert.equal(classifyPath(path), 'runner-config', path)
    for (const path of ['.github/workflows/test.yml', '.gitlab-ci.yml', 'azure-pipelines.yml', '.circleci/config.yml', 'Jenkinsfile']) assert.equal(classifyPath(path), 'ci', path)
    for (const path of ['src/app.ts', 'README.md', 'docs/testing.md', 'src/contest.ts', 'latest.txt']) assert.equal(classifyPath(path), undefined, path)
  })
})

describe('globToRegExp', () => {
  it('supports * within a segment and ** across segments, case-insensitively', () => {
    const star = globToRegExp('db/*.sql')
    assert.equal(star.test('db/init.sql'), true)
    assert.equal(star.test('db/deep/init.sql'), false)
    const deep = globToRegExp('migrations/**')
    assert.equal(deep.test('app/Migrations/2026/001.sql'), true)
    assert.equal(globToRegExp('a.b').test('axb'), false)
  })
})

describe('describeFacts', () => {
  it('lists what changed and what to scrutinize', () => {
    const text = describeFacts({
      changed: ['src/a.ts', 'test/a.test.ts'],
      flagged: [{ path: 'test/a.test.ts', kind: 'test' }],
      truncated: true,
    })
    assert.match(text, /Files changed while the worker ran \(2\): src\/a\.ts, test\/a\.test\.ts/)
    assert.match(text, /Inspect each of these diffs[^:]*: test\/a\.test\.ts \(test\)/)
    assert.match(text, /may be incomplete/)
  })

  it('says plainly when nothing changed, and bounds a long list', () => {
    assert.match(describeFacts({ changed: [], flagged: [], truncated: false }), /did not change while the worker ran/)
    const many = Array.from({ length: 90 }, (_, index) => `f${String(index)}.ts`)
    const text = describeFacts({ changed: many, flagged: [], truncated: false })
    assert.match(text, /\(90\)/)
    assert.match(text, /and 30 more/)
  })
})

describe('against a real git repository', () => {
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })

  it('measures what a worker changed, from a subdirectory too', async (context) => {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' })
    } catch {
      context.skip('git is not installed')
      return
    }
    const root = mkdtempSync(join(tmpdir(), 'orq-ws-'))
    try {
      git(root, 'init', '-q', '-b', 'main')
      git(root, 'config', 'user.email', 'orq@example.invalid')
      git(root, 'config', 'user.name', 'orq')
      mkdirSync(join(root, 'src'))
      writeFileSync(join(root, 'src', 'keep.ts'), 'export const keep = 1\n')
      writeFileSync(join(root, 'README.md'), '# repo\n')
      git(root, 'add', '.')
      git(root, 'commit', '-q', '-m', 'init')
      writeFileSync(join(root, 'README.md'), '# repo, dirty before the worker\n')

      const before = await snapshotWorkspace(join(root, 'src'), defaultIo)
      writeFileSync(join(root, 'src', 'slug.ts'), 'export const slug = 2\n')
      mkdirSync(join(root, 'test'))
      writeFileSync(join(root, 'test', 'slug.test.ts'), 'assert(true)\n')
      writeFileSync(join(root, 'src', 'keep.ts'), 'export const keep = 3\n')
      const after = await snapshotWorkspace(join(root, 'src'), defaultIo)

      const facts = diffSnapshots(before, after)
      assert.deepEqual(facts?.changed, ['src/keep.ts', 'src/slug.ts', 'test/slug.test.ts'])
      assert.deepEqual(facts?.flagged, [{ path: 'test/slug.test.ts', kind: 'test' }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports a directory that is not a repository without throwing', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orq-nogit-'))
    try {
      const snapshot = await snapshotWorkspace(directory, defaultIo)
      assert.equal(snapshot.ok, false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
