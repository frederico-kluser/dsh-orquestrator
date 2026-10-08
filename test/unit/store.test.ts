import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { ConfigStore } from '../../src/store.ts'
import { OFF_CONFIG, buildConfig } from '../../src/shared.ts'
import { MAX_STATE_FILE_BYTES } from '../../src/state-file.ts'
import { holdFifoOpen, makeFifo } from '../hostile-fs.ts'

const route = { provider: 'openrouter', model: 'google/gemini-3.8-flash' }
const active = buildConfig({ subagentModel: route, workerEffort: 'high' })
const scratch = mkdtempSync(join(tmpdir(), 'orq-store-'))
after(() => { rmSync(scratch, { recursive: true, force: true }) })

describe('ConfigStore in memory', () => {
  it('stores, reads and clears', () => {
    const store = new ConfigStore({ maxSessions: 10 })
    assert.equal(store.get('s1'), undefined)
    store.set('s1', active)
    assert.deepEqual(store.get('s1'), active)
    assert.equal(store.size, 1)
    assert.equal(store.clear('s1'), true)
    assert.equal(store.clear('s1'), false)
    assert.equal(store.get('s1'), undefined)
  })

  it('prunes the least recently updated sessions beyond capacity', () => {
    let clock = 0
    const store = new ConfigStore({ maxSessions: 2, now: () => (clock += 1) })
    store.set('a', active)
    store.set('b', active)
    store.set('a', OFF_CONFIG) // refresh a: b is now the oldest
    store.set('c', active)
    assert.equal(store.get('b'), undefined)
    assert.deepEqual(store.get('a'), OFF_CONFIG)
    assert.deepEqual(store.get('c'), active)
  })

  it('resolves through the lineage, then the deployment default', () => {
    const store = new ConfigStore({ maxSessions: 10 })
    const parents: Record<string, string | undefined> = { child: 'root', grandchild: 'child', orphan: undefined }
    const parentOf = (id: string): string | undefined => parents[id]
    store.set('root', active)
    assert.deepEqual(store.resolve('grandchild', parentOf, null), active)
    assert.equal(store.resolve('orphan', parentOf, null), null)
    assert.deepEqual(store.resolve('orphan', parentOf, OFF_CONFIG), OFF_CONFIG)
    store.set('child', OFF_CONFIG)
    assert.deepEqual(store.resolve('grandchild', parentOf, active), OFF_CONFIG) // nearest wins
  })

  it('never loops on a cyclic lineage', () => {
    const store = new ConfigStore({ maxSessions: 10 })
    assert.equal(store.resolve('a', id => (id === 'a' ? 'b' : 'a'), null), null)
  })
})

describe('ConfigStore persistence', () => {
  it('survives a restart and writes the file owner-only', () => {
    const file = join(scratch, 'persist', 'sessions.json')
    const first = new ConfigStore({ file, maxSessions: 10 })
    first.set('s1', active)
    assert.equal((statSync(file).mode & 0o777), 0o600)
    assert.equal(readdirSync(join(scratch, 'persist')).some(name => name.endsWith('.tmp')), false)
    const second = new ConfigStore({ file, maxSessions: 10 })
    assert.deepEqual(second.get('s1'), active)
    second.clear('s1')
    assert.equal(new ConfigStore({ file, maxSessions: 10 }).get('s1'), undefined)
  })

  it('sets a corrupt file aside and starts empty, with a warning', () => {
    const file = join(scratch, 'corrupt-sessions.json')
    writeFileSync(file, '{ not json')
    const warnings: string[] = []
    const store = new ConfigStore({ file, maxSessions: 10, now: () => 42, logger: { warn: message => warnings.push(message) } })
    assert.equal(store.size, 0)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /moved to .*corrupt-42/)
    assert.equal(readdirSync(scratch).some(name => name === 'corrupt-sessions.json.corrupt-42'), true)
  })

  it('skips invalid entries but keeps the valid ones', () => {
    const file = join(scratch, 'mixed-sessions.json')
    writeFileSync(file, JSON.stringify({
      version: 1,
      sessions: { good: { config: active, updatedAt: 1 }, bad: { config: { version: 9 }, updatedAt: 2 }, worse: 'x' },
    }))
    const store = new ConfigStore({ file, maxSessions: 10 })
    assert.deepEqual(store.get('good'), active)
    assert.equal(store.get('bad'), undefined)
    assert.equal(store.size, 1)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 1)
  })

  it('logs instead of throwing when the state directory is unwritable', () => {
    const warnings: string[] = []
    // A regular file where the directory should be: mkdir fails with ENOTDIR.
    const blocker = join(scratch, 'blocker')
    writeFileSync(blocker, 'not a directory')
    const store = new ConfigStore({ file: join(blocker, 'sessions.json'), maxSessions: 10, logger: { warn: message => warnings.push(message) } })
    store.set('s', active)
    assert.deepEqual(store.get('s'), active)
    assert.equal(warnings.some(message => /cannot persist/.test(message)), true)
  })
})

describe('ConfigStore against a state directory that cannot be trusted', () => {
  /** A state file by hand, in a directory made for it. */
  function writeSessions(file: string, sessions: unknown): void {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ version: 1, sessions }))
  }

  it('never writes through a symbolic link planted at the temp file name', () => {
    const dir = join(scratch, 'planted-link')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'sessions.json')
    const victim = join(scratch, 'planted-link-victim.txt')
    writeFileSync(victim, 'PRECIOUS USER DATA\n', { mode: 0o644 })
    symlinkSync(victim, `${file}.${String(process.pid)}.tmp`)
    const warnings: string[] = []
    new ConfigStore({ file, maxSessions: 10, logger: { warn: message => warnings.push(message) } }).set('s1', active)
    assert.equal(readFileSync(victim, 'utf8'), 'PRECIOUS USER DATA\n')
    assert.equal(statSync(victim).mode & 0o777, 0o644)
    assert.equal(lstatSync(file).isFile(), true)
    assert.deepEqual(readdirSync(dir), ['sessions.json'])
    assert.deepEqual(warnings, [])
  })

  it('does not create the target of a dangling link planted at the temp file name', () => {
    const dir = join(scratch, 'dangling-link')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'sessions.json')
    const nowhere = join(scratch, 'dangling-link-target')
    symlinkSync(nowhere, `${file}.${String(process.pid)}.tmp`)
    new ConfigStore({ file, maxSessions: 10 }).set('s1', active)
    assert.equal(existsSync(nowhere), false)
    assert.equal(lstatSync(file).isFile(), true)
  })

  it('reads nothing through a symbolic link at the state path, and the first write replaces the link', () => {
    const dir = join(scratch, 'state-link')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'sessions.json')
    const victim = join(scratch, 'state-link-victim.json')
    writeSessions(victim, { leaked: { config: active, updatedAt: 1 } })
    const holding = readFileSync(victim, 'utf8')
    symlinkSync(victim, file)
    const warnings: string[] = []
    const store = new ConfigStore({ file, maxSessions: 10, logger: { warn: message => warnings.push(message) } })
    assert.equal(store.size, 0)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /cannot read .*sessions\.json: it is a symbolic link/)
    store.set('s1', active)
    assert.equal(lstatSync(file).isFile(), true)
    assert.equal(readFileSync(victim, 'utf8'), holding)
  })

  it('does not wait for a FIFO at the state path: it warns, starts empty, and the first write replaces it', async (t) => {
    const dir = join(scratch, 'state-fifo')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'sessions.json')
    if (!makeFifo(file)) {
      t.skip('mkfifo is not available here')
      return
    }
    const holder = await holdFifoOpen(file)
    try {
      const warnings: string[] = []
      const started = Date.now()
      const store = new ConfigStore({ file, maxSessions: 10, logger: { warn: message => warnings.push(message) } })
      assert.ok(Date.now() - started < 2000, 'it did not wait for anybody to write to the pipe')
      assert.equal(store.size, 0)
      assert.match(warnings[0] ?? '', /cannot read .*sessions\.json: it is not a regular file/)
      store.set('s1', active)
      assert.equal(lstatSync(file).isFile(), true)
    } finally {
      holder.kill()
    }
  })

  it('does not read a file over 16 MiB: it warns, starts empty, and the first write replaces it', () => {
    const dir = join(scratch, 'state-huge')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'sessions.json')
    writeFileSync(file, '')
    truncateSync(file, MAX_STATE_FILE_BYTES + 1)
    const warnings: string[] = []
    const store = new ConfigStore({ file, maxSessions: 10, logger: { warn: message => warnings.push(message) } })
    assert.equal(store.size, 0)
    assert.match(warnings[0] ?? '', /larger than 16777216 bytes/)
    store.set('s1', active)
    assert.ok(statSync(file).size < 10_000)
  })

  it('loads a huge file by inserting only the newest sessions: nothing is pruned one by one', () => {
    const file = join(scratch, 'state-many', 'sessions.json')
    const many: Record<string, unknown> = {}
    for (let index = 0; index < 20_000; index += 1) many[`s-${String(index)}`] = { config: active, updatedAt: index }
    writeSessions(file, many)
    const realDelete = Map.prototype.delete
    let deletions = 0
    Map.prototype.delete = function deleteCounting(this: Map<unknown, unknown>, key: unknown): boolean {
      deletions += 1
      return realDelete.call(this, key)
    }
    let store: ConfigStore
    try {
      store = new ConfigStore({ file, maxSessions: 50 })
    } finally {
      Map.prototype.delete = realDelete
    }
    assert.equal(deletions, 0)
    assert.equal(store.size, 50)
    assert.notEqual(store.get('s-19999'), undefined)
    assert.equal(store.get('s-19949'), undefined)
    assert.notEqual(store.get('s-19950'), undefined)
  })

  it('round-trips session ids that are special names of an object', () => {
    const file = join(scratch, 'state-proto', 'sessions.json')
    const first = new ConfigStore({ file, maxSessions: 10 })
    for (const id of ['__proto__', 'constructor', 'toString']) first.set(id, active)
    assert.deepEqual(Object.keys((JSON.parse(readFileSync(file, 'utf8')) as { sessions: object }).sessions).sort(), ['__proto__', 'constructor', 'toString'])
    const second = new ConfigStore({ file, maxSessions: 10 })
    assert.equal(second.size, 3)
    assert.deepEqual(second.get('__proto__'), active)
    assert.equal(({} as Record<string, unknown>)['config'], undefined, 'and nothing leaked into every object')
  })

  it('gives the file mode 0600 whatever the umask took away from the creation mode', () => {
    const dir = join(scratch, 'umask')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, 'sessions.json')
    const store = new ConfigStore({ file, maxSessions: 10 })
    const previous = process.umask(0o277)
    try {
      store.set('s1', active)
    } finally {
      process.umask(previous)
    }
    assert.equal(statSync(file).mode & 0o777, 0o600)
  })
})
