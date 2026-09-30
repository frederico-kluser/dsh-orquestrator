import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { ConfigStore } from '../../src/store.ts'
import { OFF_CONFIG, buildConfig } from '../../src/shared.ts'

const route = { provider: 'openrouter', model: 'google/gemini-3.8-flash' }
const active = buildConfig({ subagentModel: route, reviewerEnabled: true, reviewerModel: null, remember: false })
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
