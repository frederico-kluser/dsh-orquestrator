import assert from 'node:assert/strict'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import type {
  AgentLike, AgentOptionsLike, AgentRegistryLike, SubagentRunEndInfoLike, SubagentRunInfoLike,
} from '../../src/host-services.ts'
import { MAX_SUBAGENTS_PER_RESPONSE, type ModelRoute, type SubagentRecord } from '../../src/shared.ts'
import { MAX_STATE_FILE_BYTES } from '../../src/state-file.ts'
import { defaultStateFile } from '../../src/store.ts'
import {
  DEFAULT_MAX_SUBAGENTS, SubagentLedger, defaultLedgerFile, installSubagentTracker,
  type TrackerDeps,
} from '../../src/subagents.ts'
import { fakeAgent } from '../helpers.ts'
import { holdFifoOpen, makeFifo } from '../hostile-fs.ts'

const routeA: ModelRoute = { provider: 'azure-opencode', model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'medium' }
const routeB: ModelRoute = { provider: 'openrouter-extra', model: 'xiaomi/mimo-v2.6-pro' }
const scratch = mkdtempSync(join(tmpdir(), 'orq-ledger-'))
after(() => { rmSync(scratch, { recursive: true, force: true }) })

/** A clock that moves one millisecond per reading, so every update gets a time of its own. */
function ticking(from = 0): () => number {
  let time = from
  return () => { time += 1; return time }
}

/** Start a child with the fields that rarely matter defaulted. */
function begin(ledger: SubagentLedger, id: string, parentId: string | null = null, route: ModelRoute | null = null, backend = 'spawn'): void {
  ledger.start({ id, parentId, backend, route })
}

/** A record as the ledger file stores it. */
function stored(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, parentId: 'root', backend: 'spawn', route: null, state: 'done', stopReason: 'completed', startedAt: 1, endedAt: 2, ...over }
}

/** Write a ledger file by hand, creating its directory. */
function writeLedgerFile(file: string, subagents: unknown, version: unknown = 1): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ version, subagents }))
}

describe('SubagentLedger in memory', () => {
  it('records a start as a running child', () => {
    const ledger = new SubagentLedger({ now: () => 100 })
    ledger.start({ id: 'c1', parentId: 'root', backend: 'spawn', route: routeA })
    assert.deepEqual(ledger.get('c1'), {
      id: 'c1', parentId: 'root', backend: 'spawn', route: routeA, state: 'running', stopReason: null, startedAt: 100, endedAt: null,
    })
    assert.equal(ledger.size, 1)
    assert.equal(ledger.get('other'), undefined)
  })

  for (const [stopReason, state] of [
    ['completed', 'done'],
    ['aborted', 'stopped'],
    ['error', 'failed'],
    ['max-tokens', 'failed'],
    ['refusal', 'failed'],
    ['a-reason-a-backend-added-later', 'failed'],
  ] as const) {
    it(`ends a run with the stop reason ${stopReason} as ${state}, keeping parent, backend and route`, () => {
      let clock = 100
      const ledger = new SubagentLedger({ now: () => clock })
      begin(ledger, 'c1', 'root', routeA, 'fork')
      clock = 250
      ledger.finish('c1', { stopReason })
      assert.deepEqual(ledger.get('c1'), {
        id: 'c1', parentId: 'root', backend: 'fork', route: routeA, state, stopReason, startedAt: 100, endedAt: 250,
      })
    })
  }

  it('goes back to running when a finished child is resumed, with the newest parent, backend and route', () => {
    let clock = 100
    const ledger = new SubagentLedger({ now: () => clock })
    begin(ledger, 'c1', 'p1', routeA, 'spawn')
    clock = 150
    ledger.finish('c1', { stopReason: 'aborted' })
    clock = 200
    begin(ledger, 'c1', 'p2', routeB, 'fork')
    assert.deepEqual(ledger.get('c1'), {
      id: 'c1', parentId: 'p2', backend: 'fork', route: routeB, state: 'running', stopReason: null, startedAt: 200, endedAt: null,
    })
    assert.equal(ledger.size, 1)
  })

  it('keeps the parent and the route it knows when a later start does not know them', () => {
    const ledger = new SubagentLedger({ now: ticking() })
    begin(ledger, 'c1', 'p1', routeA)
    ledger.finish('c1', { stopReason: 'completed' })
    begin(ledger, 'c1', null, null)
    assert.equal(ledger.get('c1')?.parentId, 'p1')
    assert.deepEqual(ledger.get('c1')?.route, routeA)
    assert.equal(ledger.get('c1')?.state, 'running')
  })

  it('ignores the end of a child it never saw start', () => {
    const ledger = new SubagentLedger({ now: ticking() })
    ledger.finish('ghost', { stopReason: 'completed', route: routeA })
    assert.equal(ledger.size, 0)
    assert.equal(ledger.get('ghost'), undefined)
  })

  it('keeps the route when the outcome names none, replaces it when the outcome names one', () => {
    const ledger = new SubagentLedger({ now: ticking() })
    const finishWith = (outcome: { stopReason: string; route?: ModelRoute | null }): ModelRoute | null | undefined => {
      begin(ledger, 'c1', 'root', routeA)
      ledger.finish('c1', outcome)
      return ledger.get('c1')?.route
    }
    assert.deepEqual(finishWith({ stopReason: 'completed' }), routeA, 'no route given')
    assert.deepEqual(finishWith({ stopReason: 'completed', route: undefined }), routeA, 'route undefined')
    assert.deepEqual(finishWith({ stopReason: 'completed', route: null }), routeA, 'route null')
    assert.deepEqual(finishWith({ stopReason: 'completed', route: { provider: '', model: 'x' } }), routeA, 'a route that is not one')
    assert.deepEqual(finishWith({ stopReason: 'error', route: routeB }), routeB, 'a route given')
    assert.deepEqual(ledger.get('c1')?.stopReason, 'error')
  })

  it('stores a copy of the route it is given', () => {
    const ledger = new SubagentLedger({ now: ticking() })
    const given = { provider: 'p', model: 'm' }
    begin(ledger, 'c1', 'root', given)
    given.model = 'changed-by-the-caller'
    assert.equal(ledger.get('c1')?.route?.model, 'm')
  })

  it('prunes the least recently updated records beyond capacity', () => {
    const ledger = new SubagentLedger({ maxRecords: 2, now: ticking() })
    begin(ledger, 'a')
    begin(ledger, 'b')
    ledger.finish('a', { stopReason: 'completed' }) // refresh a: b is now the oldest
    begin(ledger, 'c')
    assert.equal(ledger.get('b'), undefined)
    assert.equal(ledger.get('a')?.state, 'done')
    assert.equal(ledger.get('c')?.state, 'running')
    assert.equal(ledger.size, 2)
  })

  it('counts a repeated start as an update for the pruning order', () => {
    const ledger = new SubagentLedger({ maxRecords: 2, now: ticking() })
    begin(ledger, 'a')
    begin(ledger, 'b')
    begin(ledger, 'a') // a was resumed: b is now the oldest
    begin(ledger, 'c')
    assert.equal(ledger.get('b'), undefined)
    assert.notEqual(ledger.get('a'), undefined)
    assert.notEqual(ledger.get('c'), undefined)
  })

  it('keeps DEFAULT_MAX_SUBAGENTS records unless told otherwise, and falls back to it for an unusable capacity', () => {
    assert.equal(DEFAULT_MAX_SUBAGENTS, 2000)
    for (const maxRecords of [undefined, 0, -5, 2.5, Number.NaN]) {
      const ledger = new SubagentLedger({ ...maxRecords === undefined ? {} : { maxRecords }, now: ticking() })
      for (let index = 0; index <= DEFAULT_MAX_SUBAGENTS; index += 1) begin(ledger, `c-${String(index)}`)
      assert.equal(ledger.size, DEFAULT_MAX_SUBAGENTS, `capacity ${String(maxRecords)}`)
      assert.equal(ledger.get('c-0'), undefined, 'the oldest is the one dropped')
      assert.notEqual(ledger.get(`c-${String(DEFAULT_MAX_SUBAGENTS)}`), undefined)
    }
  })

  it('hands out copies from get, so a caller cannot change the ledger', () => {
    const ledger = new SubagentLedger({ now: ticking() })
    begin(ledger, 'c1', 'root', routeA)
    const copy = ledger.get('c1') as { state: string; route: { model: string } }
    copy.state = 'failed'
    copy.route.model = 'hacked'
    assert.equal(ledger.get('c1')?.state, 'running')
    assert.equal(ledger.get('c1')?.route?.model, routeA.model)
  })
})

describe('SubagentLedger.descendantsOf', () => {
  /** A ledger holding one child per `[id, parentId, startedAt]`. */
  function seeded(spec: readonly (readonly [string, string | null, number])[]): SubagentLedger {
    let clock = 0
    const ledger = new SubagentLedger({ now: () => clock })
    for (const [id, parentId, at] of spec) {
      clock = at
      begin(ledger, id, parentId)
    }
    return ledger
  }
  const idsOf = (records: readonly SubagentRecord[]): string[] => records.map(record => record.id)

  it('returns the direct children and the deeper ones, never the root itself', () => {
    const ledger = seeded([['root', 'top', 5], ['c1', 'root', 10], ['c2', 'root', 20], ['g1', 'c1', 15], ['gg1', 'g1', 30]])
    assert.deepEqual(idsOf(ledger.descendantsOf('root')), ['c1', 'g1', 'c2', 'gg1'])
    assert.deepEqual(idsOf(ledger.descendantsOf('top')), ['root', 'c1', 'g1', 'c2', 'gg1'])
    assert.deepEqual(idsOf(ledger.descendantsOf('c1')), ['g1', 'gg1'])
    assert.deepEqual(ledger.descendantsOf('gg1'), [])
  })

  it('ignores unrelated trees and unknown roots', () => {
    const ledger = seeded([['c1', 'root', 10], ['u1', 'other', 11], ['u2', 'u1', 12], ['orphan', null, 13]])
    assert.deepEqual(idsOf(ledger.descendantsOf('root')), ['c1'])
    assert.deepEqual(idsOf(ledger.descendantsOf('other')), ['u1', 'u2'])
    assert.deepEqual(ledger.descendantsOf('nobody'), [])
    assert.deepEqual(ledger.descendantsOf('orphan'), [])
  })

  it('orders by start time, equal starts by id', () => {
    const ledger = seeded([['z', 'root', 5], ['late', 'root', 9], ['b', 'root', 5], ['early', 'root', 1], ['a', 'root', 5]])
    assert.deepEqual(idsOf(ledger.descendantsOf('root')), ['early', 'a', 'b', 'z', 'late'])
  })

  it('survives a parent chain that loops back on itself', () => {
    const ledger = seeded([['a', 'b', 1], ['b', 'a', 2], ['c', 'b', 3], ['solo', 'solo-parent', 4]])
    assert.deepEqual(idsOf(ledger.descendantsOf('a')), ['b', 'c'])
    assert.deepEqual(idsOf(ledger.descendantsOf('b')), ['a', 'c'])
    assert.deepEqual(idsOf(ledger.descendantsOf('c')), [])
    assert.deepEqual(idsOf(ledger.descendantsOf('solo-parent')), ['solo'])
  })

  it('survives a record that is its own parent', () => {
    const ledger = seeded([['x', 'x', 1], ['y', 'root', 2]])
    assert.deepEqual(ledger.descendantsOf('x'), [])
    assert.deepEqual(idsOf(ledger.descendantsOf('root')), ['y'])
  })

  it('stops 16 levels below the root', () => {
    const chain: [string, string | null, number][] = []
    for (let level = 1; level <= 20; level += 1) chain.push([`c${String(level)}`, level === 1 ? 'root' : `c${String(level - 1)}`, level])
    const ids = idsOf(seeded(chain).descendantsOf('root'))
    assert.equal(ids.length, 16)
    assert.equal(ids[0], 'c1')
    assert.equal(ids.at(-1), 'c16')
  })

  it('keeps the newest records when more qualify than one answer carries, still oldest first', () => {
    const spare = 7
    const spec: [string, string | null, number][] = []
    for (let index = 0; index < MAX_SUBAGENTS_PER_RESPONSE + spare; index += 1) spec.push([`c-${String(index).padStart(4, '0')}`, 'root', index + 1])
    const records = seeded(spec).descendantsOf('root')
    assert.equal(records.length, MAX_SUBAGENTS_PER_RESPONSE)
    assert.equal(records[0]?.id, `c-${String(spare).padStart(4, '0')}`)
    assert.equal(records.at(-1)?.id, `c-${String(MAX_SUBAGENTS_PER_RESPONSE + spare - 1).padStart(4, '0')}`)
    assert.deepEqual(records.map(record => record.startedAt), [...records.map(record => record.startedAt)].sort((a, b) => a - b))
  })

  it('hands out copies, so a caller cannot change the ledger', () => {
    const ledger = new SubagentLedger({ now: ticking() })
    begin(ledger, 'c1', 'root', routeA)
    const [first] = ledger.descendantsOf('root') as unknown as [{ state: string; route: { model: string } }]
    first.state = 'failed'
    first.route.model = 'hacked'
    ledger.descendantsOf('root').length = 0
    const [again] = ledger.descendantsOf('root')
    assert.equal(again?.state, 'running')
    assert.equal(again?.route?.model, routeA.model)
    assert.equal(ledger.get('c1')?.state, 'running')
  })
})

describe('SubagentLedger persistence', () => {
  it('writes the file owner-only in an owner-only directory, atomically', () => {
    const dir = join(scratch, 'owner-only')
    const file = join(dir, 'subagents.json')
    const ledger = new SubagentLedger({ file, now: () => 100, saveDelayMs: 0 })
    begin(ledger, 'c1', 'root', routeA)
    ledger.flush()
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.equal(readdirSync(dir).some(name => name.endsWith('.tmp')), false)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      version: 1,
      subagents: { c1: { id: 'c1', parentId: 'root', backend: 'spawn', route: routeA, state: 'running', stopReason: null, startedAt: 100, endedAt: null } },
    })
  })

  it('survives a restart, with the recency order of the records', () => {
    const file = join(scratch, 'restart', 'subagents.json')
    const first = new SubagentLedger({ file, now: ticking(), saveDelayMs: 0 })
    begin(first, 'a', 'root', routeA)
    begin(first, 'b', 'root', routeB, 'fork')
    begin(first, 'c', 'a')
    first.finish('a', { stopReason: 'completed' })
    first.finish('b', { stopReason: 'error' })
    first.finish('c', { stopReason: 'aborted', route: routeB })
    first.flush()
    const second = new SubagentLedger({ file, maxRecords: 2, now: () => 9000, saveDelayMs: 0 })
    assert.equal(second.get('a'), undefined, 'a was the least recently updated: pruned after loading')
    assert.deepEqual(second.get('b'), first.get('b'))
    assert.deepEqual(second.get('c'), first.get('c'))
    begin(second, 'd')
    assert.equal(second.get('b'), undefined, 'b is now the least recently updated')
    assert.notEqual(second.get('c'), undefined)
    second.flush()
  })

  it('turns a record that was still running into a stopped one, ended now', () => {
    const file = join(scratch, 'interrupted', 'subagents.json')
    const first = new SubagentLedger({ file, now: ticking(), saveDelayMs: 0 })
    begin(first, 'was-running', 'root', routeA)
    begin(first, 'was-done', 'root')
    first.finish('was-done', { stopReason: 'completed' })
    first.flush()
    const second = new SubagentLedger({ file, now: () => 9000, saveDelayMs: 0 })
    assert.deepEqual(second.get('was-running'), {
      id: 'was-running', parentId: 'root', backend: 'spawn', route: routeA, state: 'stopped', stopReason: 'interrupted', startedAt: 1, endedAt: 9000,
    })
    assert.deepEqual(second.get('was-done'), first.get('was-done'))
  })

  it('rebuilds the recency order from when each record last changed (its end, else its start), then prunes beyond capacity', () => {
    const file = join(scratch, 'recency', 'subagents.json')
    // By start time x is the oldest; by last change it is the newest. r never ended, so it counts from its start.
    writeLedgerFile(file, {
      x: stored('x', { startedAt: 10, endedAt: 300 }),
      y: stored('y', { startedAt: 100, endedAt: 150 }),
      r: stored('r', { startedAt: 175, endedAt: null, state: 'running', stopReason: null }),
      z: stored('z', { startedAt: 190, endedAt: 200 }),
    })
    const ledger = new SubagentLedger({ file, maxRecords: 3, now: ticking(1000), saveDelayMs: 0 })
    assert.equal(ledger.size, 3)
    assert.equal(ledger.get('y'), undefined, 'the least recently updated one is the one pruned')
    begin(ledger, 'n')
    assert.equal(ledger.get('r'), undefined, 'then r, the next oldest')
    for (const kept of ['z', 'x', 'n']) assert.notEqual(ledger.get(kept), undefined, kept)
    begin(ledger, 'm')
    assert.equal(ledger.get('z'), undefined, 'then z')
    assert.notEqual(ledger.get('x'), undefined, 'x, which ended last, outlives them all')
    ledger.flush()
  })

  for (const [label, content] of [
    ['text that is not JSON', '{ not json'],
    ['a JSON value that is not an object', '42'],
    ['an unsupported version', JSON.stringify({ version: 2, subagents: {} })],
    ['a list where the map should be', JSON.stringify({ version: 1, subagents: [] })],
    ['no map at all', JSON.stringify({ version: 1 })],
  ] as const) {
    it(`sets a file with ${label} aside and starts empty, with a warning`, () => {
      const file = join(scratch, `aside-${label.replaceAll(' ', '-')}`, 'subagents.json')
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, content)
      const warnings: string[] = []
      const ledger = new SubagentLedger({ file, now: () => 42, saveDelayMs: 0, logger: { warn: message => warnings.push(message) } })
      assert.equal(ledger.size, 0)
      assert.equal(warnings.length, 1)
      assert.match(warnings[0] ?? '', /moved to .*subagents\.json\.corrupt-42/)
      assert.deepEqual(readdirSync(dirname(file)), ['subagents.json.corrupt-42'])
      begin(ledger, 'fresh')
      ledger.flush()
      assert.deepEqual(readdirSync(dirname(file)).sort(), ['subagents.json', 'subagents.json.corrupt-42'])
    })
  }

  it('skips invalid entries but keeps the valid ones, and does not set the file aside', () => {
    const file = join(scratch, 'mixed', 'subagents.json')
    writeLedgerFile(file, {
      good: stored('good'),
      bare: { id: 'bare', backend: 'spawn', state: 'running', startedAt: 5 },
      badState: stored('badState', { state: 'weird' }),
      badTime: stored('badTime', { startedAt: -1 }),
      badRoute: stored('badRoute', { route: { provider: 'p' } }),
      notARecord: 'x',
      nothing: null,
      other: stored('someone-else'),
    })
    const warnings: string[] = []
    const ledger = new SubagentLedger({ file, now: () => 7, logger: { warn: message => warnings.push(message) } })
    assert.deepEqual(ledger.get('good'), stored('good'))
    assert.deepEqual(ledger.get('bare'), {
      id: 'bare', parentId: null, backend: 'spawn', route: null, state: 'stopped', stopReason: 'interrupted', startedAt: 5, endedAt: 7,
    })
    assert.equal(ledger.size, 2)
    assert.deepEqual(warnings, [])
    assert.deepEqual(readdirSync(dirname(file)), ['subagents.json'])
  })

  it('logs instead of throwing when the state directory is unwritable, and does not repeat the same warning at once', () => {
    const warnings: string[] = []
    // A regular file where the directory should be: mkdir fails with ENOTDIR.
    const blocker = join(scratch, 'blocker')
    writeFileSync(blocker, 'not a directory')
    const ledger = new SubagentLedger({ file: join(blocker, 'subagents.json'), saveDelayMs: 0, logger: { warn: message => warnings.push(message) } })
    // Reading through a file that is not a directory is ENOTDIR, not "no file yet": reported, then the ledger starts empty.
    assert.equal(warnings.filter(message => /cannot read/.test(message)).length, 1)
    const persistWarnings = (): string[] => warnings.filter(message => /cannot persist/.test(message))
    begin(ledger, 's', 'root')
    assert.doesNotThrow(() => { ledger.flush() })
    assert.equal(ledger.get('s')?.state, 'running')
    assert.equal(persistWarnings().length, 1)
    ledger.flush() // the write failed, so it is still pending and is tried again: the same warning is not logged again
    assert.equal(persistWarnings().length, 1)
  })

  it('writes through a temp file named after the process, so two processes never interleave', () => {
    const file = join(scratch, 'pid-temp', 'subagents.json')
    // Occupy the temp name with a directory: only a write that goes through exactly that name fails.
    mkdirSync(`${file}.${String(process.pid)}.tmp`, { recursive: true })
    const warnings: string[] = []
    const ledger = new SubagentLedger({ file, saveDelayMs: 0, logger: { warn: message => warnings.push(message) } })
    begin(ledger, 'c1')
    assert.doesNotThrow(() => { ledger.flush() })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /cannot persist/)
    assert.equal(existsSync(file), false)
    rmSync(`${file}.${String(process.pid)}.tmp`, { recursive: true })
    begin(ledger, 'c2')
    ledger.flush()
    assert.equal(existsSync(file), true)
  })

  it('reports a file it cannot read, and leaves no temp file behind when the write fails', () => {
    const warnings: string[] = []
    // A directory where the file should be: reading it fails, and so does renaming a file over it.
    const file = join(scratch, 'a-directory-not-a-file')
    mkdirSync(file)
    const ledger = new SubagentLedger({ file, saveDelayMs: 0, logger: { warn: message => warnings.push(message) } })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /cannot read/)
    begin(ledger, 's')
    assert.doesNotThrow(() => { ledger.flush() })
    assert.equal(warnings.length, 2)
    assert.match(warnings[1] ?? '', /cannot persist/)
    assert.equal(existsSync(`${file}.${String(process.pid)}.tmp`), false)
  })

  it('writes by itself once the delay has passed, without a flush', async () => {
    const file = join(scratch, 'by-itself', 'subagents.json')
    const ledger = new SubagentLedger({ file, saveDelayMs: 5 })
    begin(ledger, 'c1', 'root')
    assert.equal(existsSync(file), false)
    const deadline = Date.now() + 5000
    while (!existsSync(file) && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5))
    assert.equal((JSON.parse(readFileSync(file, 'utf8')) as { subagents: Record<string, unknown> }).subagents['c1'] !== undefined, true)
    ledger.flush()
  })
})

/** One timer the fake clock was asked for. */
interface FakeTimer {
  readonly delay: number
  readonly callback: () => void
  unrefs: number
  cleared: boolean
  fired: boolean
}

/**
 * Replace the global timers for the span of one synchronous test, so a debounce can be driven without waiting and
 * the timers it asks for inspected. With `unref: false` the handles are plain numbers, like a fake clock's.
 */
function withFakeTimers(body: (clock: { readonly timers: readonly FakeTimer[]; fire(): void }) => void, options: { readonly unref?: boolean } = {}): void {
  const globals = globalThis as unknown as { setTimeout: unknown; clearTimeout: unknown }
  const real = { setTimeout: globals.setTimeout, clearTimeout: globals.clearTimeout }
  const timers: FakeTimer[] = []
  globals.setTimeout = (callback: () => void, delay: number): unknown => {
    const timer: FakeTimer = { delay, callback, unrefs: 0, cleared: false, fired: false }
    timers.push(timer)
    const id = timers.length
    return options.unref === false ? id : { id, unref() { timer.unrefs += 1; return this } }
  }
  globals.clearTimeout = (handle: unknown): void => {
    const id = typeof handle === 'number' ? handle : (handle as { id: number }).id
    const timer = timers[id - 1]
    if (timer !== undefined) timer.cleared = true
  }
  try {
    body({
      timers,
      fire() {
        for (const timer of timers) {
          if (timer.cleared || timer.fired) continue
          timer.fired = true
          timer.callback()
        }
      },
    })
  } finally {
    globals.setTimeout = real.setTimeout
    globals.clearTimeout = real.clearTimeout
  }
}

describe('SubagentLedger write debounce', () => {
  it('coalesces a burst of updates into one delayed write that holds all of them', () => {
    withFakeTimers((clock) => {
      const file = join(scratch, 'burst', 'subagents.json')
      const ledger = new SubagentLedger({ file, now: ticking(), saveDelayMs: 40 })
      for (let index = 0; index < 50; index += 1) begin(ledger, `c-${String(index)}`, 'root')
      for (let index = 0; index < 50; index += 1) ledger.finish(`c-${String(index)}`, { stopReason: 'completed' })
      assert.equal(clock.timers.length, 1, 'one timer for the whole burst')
      assert.equal(clock.timers[0]?.delay, 40)
      assert.equal(clock.timers[0]?.unrefs, 1, 'the pending write must not keep the process alive')
      assert.equal(existsSync(file), false, 'nothing is written before the delay is up')
      clock.fire()
      const written = JSON.parse(readFileSync(file, 'utf8')) as { subagents: Record<string, { state: string }> }
      assert.equal(Object.keys(written.subagents).length, 50)
      assert.equal(Object.values(written.subagents).every(record => record.state === 'done'), true)
      rmSync(file)
      ledger.flush()
      assert.equal(existsSync(file), false, 'that one write covered the whole burst: nothing is left to flush')
      begin(ledger, 'later', 'root')
      assert.equal(clock.timers.length, 2, 'a change after the write schedules the next one')
      ledger.flush()
      assert.equal(existsSync(file), true)
    })
  })

  it('waits 250 ms when no delay is given', () => {
    withFakeTimers((clock) => {
      const ledger = new SubagentLedger({ file: join(scratch, 'default-delay', 'subagents.json'), now: ticking() })
      begin(ledger, 'c1')
      assert.equal(clock.timers[0]?.delay, 250)
      ledger.flush()
    })
  })

  it('keeps a delay of 0 and falls back to 250 ms for a delay no timer could use', () => {
    withFakeTimers((clock) => {
      const delays: number[] = []
      for (const saveDelayMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 40]) {
        const ledger = new SubagentLedger({ file: join(scratch, 'delays', `${String(delays.length)}`, 'subagents.json'), saveDelayMs, now: ticking() })
        begin(ledger, 'c1')
        delays.push(clock.timers.at(-1)?.delay ?? -1)
        ledger.flush()
      }
      assert.deepEqual(delays, [0, 250, 250, 250, 40])
    })
  })

  it('writes at once on flush and cancels the pending timer', () => {
    withFakeTimers((clock) => {
      const file = join(scratch, 'flush', 'subagents.json')
      const ledger = new SubagentLedger({ file, now: ticking(), saveDelayMs: 60_000 })
      begin(ledger, 'c1', 'root')
      begin(ledger, 'c2', 'root')
      assert.equal(existsSync(file), false)
      ledger.flush()
      assert.equal(Object.keys((JSON.parse(readFileSync(file, 'utf8')) as { subagents: object }).subagents).length, 2)
      assert.equal(clock.timers[0]?.cleared, true)
      rmSync(file)
      clock.fire()
      assert.equal(existsSync(file), false, 'the cancelled timer does not write again')
    })
  })

  it('does nothing on flush when nothing changed or no file is set', () => {
    withFakeTimers((clock) => {
      const file = join(scratch, 'nothing-dirty', 'subagents.json')
      new SubagentLedger({ file }).flush()
      assert.equal(existsSync(file), false)
      assert.equal(existsSync(dirname(file)), false)
      assert.equal(clock.timers.length, 0)

      const memory = new SubagentLedger({ now: ticking() })
      begin(memory, 'c1', 'root')
      memory.finish('c1', { stopReason: 'completed' })
      memory.flush()
      assert.equal(clock.timers.length, 0, 'an in-memory ledger never schedules a write')
      assert.equal(memory.get('c1')?.state, 'done')
    })
  })

  it('works with a timer handle that has no unref', () => {
    withFakeTimers((clock) => {
      const file = join(scratch, 'no-unref', 'subagents.json')
      const ledger = new SubagentLedger({ file, now: ticking(), saveDelayMs: 10 })
      assert.doesNotThrow(() => { begin(ledger, 'c1') })
      clock.fire()
      assert.equal(existsSync(file), true)
    }, { unref: false })
  })

  it('does not load anything it will not write: loading schedules no write', () => {
    withFakeTimers((clock) => {
      const file = join(scratch, 'load-quiet', 'subagents.json')
      writeLedgerFile(file, { run: stored('run', { state: 'running', stopReason: null, endedAt: null }) })
      const ledger = new SubagentLedger({ file, now: () => 5 })
      assert.equal(ledger.get('run')?.state, 'stopped')
      assert.equal(clock.timers.length, 0)
    })
  })
})

describe('SubagentLedger against a state directory that cannot be trusted', () => {
  it('never writes through a symbolic link planted at the temp file name', () => {
    const dir = join(scratch, 'planted-link')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'subagents.json')
    const victim = join(scratch, 'planted-link-victim.txt')
    writeFileSync(victim, 'PRECIOUS USER DATA\n', { mode: 0o644 })
    symlinkSync(victim, `${file}.${String(process.pid)}.tmp`)
    const warnings: string[] = []
    const ledger = new SubagentLedger({ file, saveDelayMs: 0, logger: { warn: message => warnings.push(message) } })
    begin(ledger, 'c1', 'root', routeA)
    ledger.flush()
    assert.equal(readFileSync(victim, 'utf8'), 'PRECIOUS USER DATA\n', 'what the link pointed at is untouched')
    assert.equal(statSync(victim).mode & 0o777, 0o644, 'and so is its mode')
    assert.equal(lstatSync(file).isFile(), true, 'the ledger is a regular file, not the link')
    assert.deepEqual(readdirSync(dir), ['subagents.json'], 'no temp file and no link left behind')
    assert.deepEqual(warnings, [])
    assert.notEqual(new SubagentLedger({ file }).get('c1'), undefined)
  })

  it('does not create the target of a dangling link planted at the temp file name', () => {
    const dir = join(scratch, 'dangling-link')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'subagents.json')
    const nowhere = join(scratch, 'dangling-link-target')
    symlinkSync(nowhere, `${file}.${String(process.pid)}.tmp`)
    const ledger = new SubagentLedger({ file, saveDelayMs: 0 })
    begin(ledger, 'c1')
    ledger.flush()
    assert.equal(existsSync(nowhere), false, 'a write through the link would have created it')
    assert.equal(lstatSync(file).isFile(), true)
  })

  it('reads nothing through a symbolic link at the state path, and the first write replaces the link', () => {
    const dir = join(scratch, 'state-link')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'subagents.json')
    const victim = join(scratch, 'state-link-victim.json')
    const holding = JSON.stringify({ version: 1, subagents: { leaked: stored('leaked') } })
    writeFileSync(victim, holding)
    symlinkSync(victim, file)
    const warnings: string[] = []
    const ledger = new SubagentLedger({ file, saveDelayMs: 0, logger: { warn: message => warnings.push(message) } })
    assert.equal(ledger.size, 0, 'nothing was read through the link')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /cannot read .*subagents\.json: it is a symbolic link/)
    begin(ledger, 'c1')
    ledger.flush()
    assert.equal(lstatSync(file).isFile(), true, 'the link is gone, replaced by a file of the ledger\'s own')
    assert.equal(readFileSync(victim, 'utf8'), holding, 'what it pointed at was not written to')
    assert.deepEqual(Object.keys((JSON.parse(readFileSync(file, 'utf8')) as { subagents: object }).subagents), ['c1'])
  })

  it('does not wait for a FIFO at the state path: it warns, starts empty, and the first write replaces it', async (t) => {
    const dir = join(scratch, 'state-fifo')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'subagents.json')
    if (!makeFifo(file)) {
      t.skip('mkfifo is not available here')
      return
    }
    const holder = await holdFifoOpen(file)
    try {
      const warnings: string[] = []
      const started = Date.now()
      const ledger = new SubagentLedger({ file, saveDelayMs: 0, logger: { warn: message => warnings.push(message) } })
      assert.ok(Date.now() - started < 2000, 'it did not wait for anybody to write to the pipe')
      assert.equal(ledger.size, 0)
      assert.equal(warnings.length, 1)
      assert.match(warnings[0] ?? '', /cannot read .*subagents\.json: it is not a regular file/)
      begin(ledger, 'c1')
      ledger.flush()
      assert.equal(lstatSync(file).isFile(), true, 'the pipe is replaced by a file')
      assert.equal(warnings.length, 1, 'and the write does not repeat the warning')
    } finally {
      holder.kill()
    }
  })

  it('does not read a file over 16 MiB: it warns, starts empty, and the first write replaces it', () => {
    const dir = join(scratch, 'state-huge')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'subagents.json')
    writeFileSync(file, '')
    truncateSync(file, MAX_STATE_FILE_BYTES + 1) // sparse: it costs nothing to make, and would cost a lot to read
    const warnings: string[] = []
    const ledger = new SubagentLedger({ file, saveDelayMs: 0, logger: { warn: message => warnings.push(message) } })
    assert.equal(ledger.size, 0)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /larger than 16777216 bytes/)
    begin(ledger, 'c1')
    ledger.flush()
    assert.ok(statSync(file).size < 10_000, 'the oversized file is gone, replaced by a small one')
  })

  it('loads a huge file by inserting only the newest records: nothing is pruned one by one', () => {
    const file = join(scratch, 'state-many', 'subagents.json')
    const many: Record<string, unknown> = {}
    for (let index = 0; index < 20_000; index += 1) many[`c-${String(index)}`] = stored(`c-${String(index)}`, { startedAt: index, endedAt: index + 1 })
    writeLedgerFile(file, many)
    const realDelete = Map.prototype.delete
    let deletions = 0
    Map.prototype.delete = function deleteCounting(this: Map<unknown, unknown>, key: unknown): boolean {
      deletions += 1
      return realDelete.call(this, key)
    }
    let ledger: SubagentLedger
    try {
      ledger = new SubagentLedger({ file, maxRecords: 50 })
    } finally {
      Map.prototype.delete = realDelete
    }
    assert.equal(deletions, 0, 'the old way inserted 20 000 records and pruned them one by one')
    assert.equal(ledger.size, 50)
    assert.notEqual(ledger.get('c-19999'), undefined, 'the newest are the ones kept')
    assert.equal(ledger.get('c-19949'), undefined)
    assert.notEqual(ledger.get('c-19950'), undefined)
  })

  it('round-trips ids that are special names of an object', () => {
    const file = join(scratch, 'state-proto', 'subagents.json')
    const first = new SubagentLedger({ file, now: ticking(), saveDelayMs: 0 })
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      begin(first, id, 'root')
      first.finish(id, { stopReason: 'completed' })
    }
    first.flush()
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { subagents: Record<string, unknown> }
    assert.deepEqual(Object.keys(onDisk.subagents).sort(), ['__proto__', 'constructor', 'hasOwnProperty', 'toString'])
    const second = new SubagentLedger({ file })
    assert.equal(second.size, 4)
    assert.equal(second.get('__proto__')?.state, 'done')
    assert.equal(({} as Record<string, unknown>)['completed'], undefined, 'and nothing leaked into every object')
  })

  it('gives the file mode 0600 whatever the umask took away from the creation mode', () => {
    const dir = join(scratch, 'umask')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, 'subagents.json')
    const ledger = new SubagentLedger({ file, saveDelayMs: 0 })
    begin(ledger, 'c1')
    const previous = process.umask(0o277) // a creation mode of 0600 becomes 0400
    try {
      ledger.flush()
    } finally {
      process.umask(previous)
    }
    assert.equal(statSync(file).mode & 0o777, 0o600)
  })
})

describe('SubagentLedger and the process that wrote a running record', () => {
  const runningFile = (name: string, startedAt: number): string => {
    const file = join(scratch, name, 'subagents.json')
    writeLedgerFile(file, { x: stored('x', { state: 'running', stopReason: null, endedAt: null, startedAt }) })
    return file
  }

  it('keeps a child that started after this process did: the plugin was loaded again in the same process, the child is alive', () => {
    const ledger = new SubagentLedger({ file: runningFile('boot-alive', 2000), bootedAt: 1000, now: () => 5000, saveDelayMs: 0 })
    assert.equal(ledger.get('x')?.state, 'running')
    assert.equal(ledger.get('x')?.stopReason, null)
    ledger.finish('x', { stopReason: 'completed' })
    assert.equal(ledger.get('x')?.state, 'done', 'and its end, which still comes, closes it')
  })

  it('keeps a child that started in the same millisecond as the process', () => {
    assert.equal(new SubagentLedger({ file: runningFile('boot-same-ms', 1000), bootedAt: 1000, now: () => 5000 }).get('x')?.state, 'running')
  })

  it('stops a child that started before this process did, ended now', () => {
    const ledger = new SubagentLedger({ file: runningFile('boot-dead', 999), bootedAt: 1000, now: () => 5000 })
    assert.deepEqual(
      [ledger.get('x')?.state, ledger.get('x')?.stopReason, ledger.get('x')?.endedAt],
      ['stopped', 'interrupted', 5000],
    )
  })

  it('stops a child that started in the future: a clock that went back cannot have a live child', () => {
    const ledger = new SubagentLedger({ file: runningFile('boot-future', 9000), bootedAt: 1000, now: () => 5000 })
    assert.equal(ledger.get('x')?.stopReason, 'interrupted')
  })

  it('takes the start of the process from its uptime when it is not told', () => {
    const justNow = new SubagentLedger({ file: runningFile('boot-uptime-now', Date.now()) })
    assert.equal(justNow.get('x')?.state, 'running', 'a child that started a moment ago started after this process')
    const anHourAgo = new SubagentLedger({ file: runningFile('boot-uptime-old', Date.now() - 3_600_000) })
    assert.equal(anHourAgo.get('x')?.state, 'stopped', 'one that started an hour ago started before this test process')
  })

  it('keeps the children of a ledger that this process wrote and loaded again (what a reload of the plugin does)', () => {
    const file = join(scratch, 'boot-reload', 'subagents.json')
    const first = new SubagentLedger({ file, saveDelayMs: 0 })
    begin(first, 'live', 'main', routeA)
    first.flush()
    const second = new SubagentLedger({ file, saveDelayMs: 0 })
    assert.equal(second.get('live')?.state, 'running')
    second.finish('live', { stopReason: 'completed' })
    assert.equal(second.get('live')?.state, 'done')
  })
})

describe('SubagentLedger when a write fails', () => {
  it('stays pending: the next flush tries again, and writes once the directory is usable', () => {
    const blocker = join(scratch, 'retry-blocker')
    writeFileSync(blocker, 'not a directory')
    const file = join(blocker, 'subagents.json')
    const warnings: string[] = []
    const ledger = new SubagentLedger({ file, saveDelayMs: 0, logger: { warn: message => warnings.push(message) } })
    begin(ledger, 'c1', 'root')
    ledger.flush()
    assert.equal(warnings.some(message => /cannot persist/.test(message)), true)
    rmSync(blocker) // the disk is fine again
    ledger.flush()
    assert.equal(existsSync(file), true, 'the change that could not be written was kept, and is written now')
    assert.notEqual(new SubagentLedger({ file }).get('c1'), undefined)
  })

  it('says a failing write once a minute, however often it is tried', () => {
    let time = 1000
    const blocker = join(scratch, 'warn-blocker')
    writeFileSync(blocker, 'not a directory')
    const warnings: string[] = []
    const ledger = new SubagentLedger({ file: join(blocker, 'subagents.json'), now: () => time, saveDelayMs: 0, logger: { warn: message => warnings.push(message) } })
    const persistWarnings = (): number => warnings.filter(message => /cannot persist/.test(message)).length
    begin(ledger, 'c1')
    for (let attempt = 0; attempt < 20; attempt += 1) {
      time += 100
      begin(ledger, `c-${String(attempt)}`)
      ledger.flush()
    }
    assert.equal(persistWarnings(), 1, 'twenty failures within a few seconds: one line')
    time += 60_000
    begin(ledger, 'later')
    ledger.flush()
    assert.equal(persistWarnings(), 2, 'a minute on, it is worth saying again')
  })

  it('says it again when it fails anew after a write that worked', () => {
    const dir = join(scratch, 'warn-again')
    const file = join(dir, 'subagents.json')
    const warnings: string[] = []
    // A constant clock: only what the ledger remembers can tell the second failure from a repeat of the first.
    const ledger = new SubagentLedger({ file, now: () => 1000, saveDelayMs: 0, logger: { warn: message => warnings.push(message) } })
    const persistWarnings = (): number => warnings.filter(message => /cannot persist/.test(message)).length
    mkdirSync(file, { recursive: true }) // a directory where the file goes: the rename fails
    begin(ledger, 'c1')
    ledger.flush()
    assert.equal(persistWarnings(), 1)
    rmSync(file, { recursive: true })
    ledger.flush() // the change is still pending, and this time it is written
    assert.equal(lstatSync(file).isFile(), true)
    rmSync(file)
    mkdirSync(file) // the same trouble again
    begin(ledger, 'c2')
    ledger.flush()
    assert.equal(persistWarnings(), 2, 'the write that worked cleared what was remembered, so this is news')
  })
})

describe('SubagentLedger shared by two processes on one state directory', () => {
  /** Two ledgers on one file stand for two DSH processes. A shared clock stands for the wall clock they share. */
  function twoProcesses(name: string, options: { readonly maxRecords?: number } = {}): {
    file: string
    a: SubagentLedger
    b: SubagentLedger
    at: (time: number) => void
    onDisk: () => Record<string, { state: string; endedAt: number | null }>
  } {
    let time = 1000
    const file = join(scratch, name, 'subagents.json')
    const common = { file, now: () => time, saveDelayMs: 0, bootedAt: 0, ...options }
    return {
      file,
      a: new SubagentLedger(common),
      b: new SubagentLedger(common),
      at: (next) => { time = next },
      onDisk: () => (JSON.parse(readFileSync(file, 'utf8')) as { subagents: Record<string, { state: string; endedAt: number | null }> }).subagents,
    }
  }

  it('keeps the records the other process wrote when it writes its own', () => {
    const { a, b, at, onDisk } = twoProcesses('union-basic')
    begin(a, 'a1', 'main')
    a.finish('a1', { stopReason: 'completed' })
    a.flush()
    at(2000)
    begin(b, 'b1', 'main')
    b.finish('b1', { stopReason: 'error' })
    b.flush()
    assert.deepEqual(Object.keys(onDisk()).sort(), ['a1', 'b1'], 'b did not drop what a wrote')
    assert.equal(b.get('a1')?.state, 'done', 'and knows it now')
    at(3000)
    begin(a, 'a2', 'main')
    a.flush()
    assert.deepEqual(Object.keys(onDisk()).sort(), ['a1', 'a2', 'b1'], 'nor did a drop what b wrote')
    assert.equal(a.get('b1')?.state, 'failed')
    assert.deepEqual(a.descendantsOf('main').map(record => record.id), ['a1', 'b1', 'a2'])
  })

  it('does not let the file overrule a child that is running here', () => {
    const { file, a, at, onDisk } = twoProcesses('union-running')
    begin(a, 'x', 'main')
    at(1500)
    writeLedgerFile(file, { x: stored('x', { startedAt: 900, endedAt: 5000, state: 'failed', stopReason: 'error' }) })
    a.flush()
    assert.equal(a.get('x')?.state, 'running', 'it is alive here, whatever the file says')
    assert.equal(onDisk()['x']?.state, 'running')
  })

  it('takes a later change of a child that is finished here, and keeps its own when the file\'s is older or equal', () => {
    const { file, a, at, onDisk } = twoProcesses('union-newest')
    begin(a, 'newer')
    begin(a, 'older')
    begin(a, 'tied')
    at(2000)
    for (const id of ['newer', 'older', 'tied']) a.finish(id, { stopReason: 'completed' })
    writeLedgerFile(file, {
      newer: stored('newer', { parentId: null, startedAt: 1000, endedAt: 2001, state: 'failed', stopReason: 'error' }),
      older: stored('older', { parentId: null, startedAt: 1000, endedAt: 1999, state: 'failed', stopReason: 'error' }),
      tied: stored('tied', { parentId: null, startedAt: 1000, endedAt: 2000, state: 'failed', stopReason: 'error' }),
    })
    begin(a, 'trigger')
    a.flush()
    assert.deepEqual(['newer', 'older', 'tied'].map(id => a.get(id)?.state), ['failed', 'done', 'done'])
    assert.deepEqual(['newer', 'older', 'tied'].map(id => onDisk()[id]?.state), ['failed', 'done', 'done'])
  })

  it('prunes to capacity after folding the file in, the least recently changed first', () => {
    const { file, a, at, onDisk } = twoProcesses('union-capacity', { maxRecords: 3 })
    for (const id of ['a1', 'a2', 'a3']) { begin(a, id); a.finish(id, { stopReason: 'completed' }) }
    at(5000)
    writeLedgerFile(file, Object.fromEntries(['b1', 'b2'].map((id, index) => [id, stored(id, { startedAt: 4000 + index, endedAt: 4100 + index })])))
    begin(a, 'a4')
    a.flush()
    assert.deepEqual(Object.keys(onDisk()).sort(), ['a4', 'b1', 'b2'], 'the three most recently changed of the five, a4 being the newest')
    assert.equal(a.size, 3)
  })

  it('keeps the records that changed last when the file adds one that is older than its own, whatever order they arrive in', () => {
    const { file, a, at, onDisk } = twoProcesses('union-older', { maxRecords: 3 })
    at(4000)
    for (const id of ['m1', 'm2', 'm3']) { begin(a, id); at(4001 + Number(id.slice(1))); a.finish(id, { stopReason: 'completed' }) }
    writeLedgerFile(file, { f1: stored('f1', { startedAt: 90, endedAt: 100 }) }) // older than everything here
    begin(a, 'trigger')
    at(9000)
    a.flush()
    assert.deepEqual(Object.keys(onDisk()).sort(), ['m2', 'm3', 'trigger'], 'the old record from the file is the one that goes, not one of this process\'s own')
    assert.equal(a.get('f1'), undefined)
  })

  it('sets a corrupt file it meets at a write aside, and writes its own', () => {
    const { file, a, at } = twoProcesses('union-corrupt')
    begin(a, 'a1')
    a.flush()
    writeFileSync(file, '{ not json')
    at(2000)
    begin(a, 'a2')
    a.flush()
    assert.equal(readdirSync(dirname(file)).some(name => name.startsWith('subagents.json.corrupt-')), true)
    assert.deepEqual(Object.keys((JSON.parse(readFileSync(file, 'utf8')) as { subagents: object }).subagents).sort(), ['a1', 'a2'])
  })

  it('reads nothing through a link swapped in for the file between two writes, and replaces it', () => {
    const { file, a, at } = twoProcesses('union-link')
    begin(a, 'a1')
    a.flush()
    const victim = join(scratch, 'union-link-victim.json')
    const holding = JSON.stringify({ version: 1, subagents: { leaked: stored('leaked') } })
    writeFileSync(victim, holding)
    rmSync(file)
    symlinkSync(victim, file)
    at(2000)
    begin(a, 'a2')
    a.flush()
    assert.equal(lstatSync(file).isFile(), true)
    assert.equal(readFileSync(victim, 'utf8'), holding)
    assert.deepEqual(Object.keys((JSON.parse(readFileSync(file, 'utf8')) as { subagents: object }).subagents).sort(), ['a1', 'a2'], 'leaked was never read')
  })

  it('does not read a file over 16 MiB planted between two writes either', () => {
    const { file, a, at } = twoProcesses('union-huge')
    begin(a, 'a1')
    a.flush()
    rmSync(file)
    writeFileSync(file, '')
    truncateSync(file, MAX_STATE_FILE_BYTES + 1)
    at(2000)
    begin(a, 'a2')
    a.flush()
    assert.ok(statSync(file).size < 10_000)
    assert.equal(a.size, 2)
  })

  it('shows a child another process still runs as interrupted only until that process says otherwise', () => {
    let time = 1000
    const file = join(scratch, 'union-owner', 'subagents.json')
    const process1 = new SubagentLedger({ file, now: () => time, saveDelayMs: 0, bootedAt: 0 })
    begin(process1, 'x', 'main')
    process1.flush() // x is running, in process 1
    time = 3000
    const process2 = new SubagentLedger({ file, now: () => time, saveDelayMs: 0, bootedAt: 2000 }) // started after x did
    assert.equal(process2.get('x')?.stopReason, 'interrupted', 'it cannot tell that process 1 is alive')
    begin(process2, 'y', 'main')
    process2.flush()
    const state = (): string | undefined => (JSON.parse(readFileSync(file, 'utf8')) as { subagents: Record<string, { state: string }> }).subagents['x']?.state
    assert.equal(state(), 'stopped')
    time = 3500
    begin(process1, 'z', 'main')
    process1.flush()
    assert.equal(process1.get('x')?.state, 'running', 'process 1 never saw its own child stopped')
    assert.equal(state(), 'running', 'and what it writes says so again')
    time = 4000
    process1.finish('x', { stopReason: 'completed' })
    process1.flush()
    time = 4500
    begin(process2, 'w', 'main')
    process2.flush()
    assert.equal(process2.get('x')?.state, 'done', 'process 2 takes the end, which is later than what it assumed')
  })
})

describe('SubagentLedger pairs an end with its run', () => {
  const run = (ledger: SubagentLedger, id: string, runId?: string): void => {
    ledger.start({ id, parentId: 'main', backend: 'spawn', route: routeA, ...runId === undefined ? {} : { runId } })
  }

  it('ignores the end of an earlier run of a child that has started again', () => {
    const ledger = new SubagentLedger({ now: ticking() })
    run(ledger, 'c1', 'r1')
    ledger.finish('c1', { stopReason: 'completed', runId: 'r1' })
    run(ledger, 'c1', 'r2')
    ledger.finish('c1', { stopReason: 'error', runId: 'r1' }) // r1 ends late, after r2 began
    assert.equal(ledger.get('c1')?.state, 'running', 'the run that is going on is not closed by another run\'s end')
    assert.equal(ledger.get('c1')?.stopReason, null)
    ledger.finish('c1', { stopReason: 'max-tokens', runId: 'r2' })
    assert.equal(ledger.get('c1')?.state, 'failed')
  })

  it('closes the current run for an end that names no run, and for a run it knows nothing about', () => {
    const ledger = new SubagentLedger({ now: ticking() })
    run(ledger, 'c1', 'r1')
    ledger.finish('c1', { stopReason: 'completed' })
    assert.equal(ledger.get('c1')?.state, 'done', 'an end without a run id')
    run(ledger, 'c2') // started without one
    ledger.finish('c2', { stopReason: 'completed', runId: 'whatever' })
    assert.equal(ledger.get('c2')?.state, 'done', 'a child started without a run id accepts any end')
    run(ledger, 'c3', 'r1')
    run(ledger, 'c3') // started again without one: the old run id is forgotten, so this end (of some other run) is taken
    ledger.finish('c3', { stopReason: 'completed', runId: 'r9' })
    assert.equal(ledger.get('c3')?.state, 'done')
  })

  it('accepts the end of a child it loaded from the file: no run is known for it', () => {
    const file = join(scratch, 'run-loaded', 'subagents.json')
    const first = new SubagentLedger({ file, saveDelayMs: 0 })
    run(first, 'live', 'r1')
    first.flush()
    const second = new SubagentLedger({ file, saveDelayMs: 0 }) // the plugin was loaded again; the child is alive
    second.finish('live', { stopReason: 'completed', runId: 'r1' })
    assert.equal(second.get('live')?.state, 'done')
  })

  it('does the same through the tracker: the late end of an earlier run does not close the new one', () => {
    const rig = trackerRig()
    rig.agents.set('c1', childAgent('c1', 'main', routeA))
    rig.start(started('c1', { runId: 'run-1' }))
    rig.end(ended('c1', 'completed', { runId: 'run-1' }))
    rig.start(started('c1', { runId: 'run-2' }))
    rig.end(ended('c1', 'completed', { runId: 'run-1' })) // a repeat of the first end
    assert.equal(rig.ledger.get('c1')?.state, 'running')
    rig.end(ended('c1', 'aborted', { runId: 'run-2' }))
    assert.equal(rig.ledger.get('c1')?.state, 'stopped')
  })
})

describe('SubagentLedger ordering of a resumed child', () => {
  it('orders by the latest start: a child that is resumed moves to the end of its session\'s list', () => {
    let clock = 0
    const ledger = new SubagentLedger({ now: () => clock })
    clock = 10
    begin(ledger, 'a', 'root')
    clock = 20
    begin(ledger, 'b', 'root')
    assert.deepEqual(ledger.descendantsOf('root').map(record => record.id), ['a', 'b'])
    clock = 30
    ledger.finish('a', { stopReason: 'completed' })
    begin(ledger, 'a', 'root') // resumed
    assert.deepEqual(ledger.descendantsOf('root').map(record => [record.id, record.startedAt]), [['b', 20], ['a', 30]])
  })
})

describe('defaultLedgerFile', () => {
  it('takes an explicit state directory', () => {
    assert.equal(defaultLedgerFile(join(scratch, 'explicit')), join(scratch, 'explicit', 'subagents.json'))
  })

  it('lives next to the session store, under the DSH home', () => {
    const saved = process.env['DSH_HOME']
    process.env['DSH_HOME'] = join(scratch, 'home')
    try {
      assert.equal(defaultLedgerFile(), join(scratch, 'home', 'dsh-orquestrator', 'subagents.json'))
      assert.equal(dirname(defaultLedgerFile()), dirname(defaultStateFile()))
      assert.equal(dirname(defaultLedgerFile(join(scratch, 'x'))), dirname(defaultStateFile(join(scratch, 'x'))))
    } finally {
      if (saved === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = saved
    }
  })
})

/** What the tracker tests drive: the tracker wired to a fake context, a fake agent registry and a real ledger. */
interface TrackerRig {
  readonly ledger: SubagentLedger
  readonly agents: Map<string, AgentLike>
  readonly warnings: string[]
  /** Events the tracker registered a listener for, in order. */
  readonly registered: string[]
  /** Events whose listener was removed, in order. */
  readonly removed: string[]
  /** Deliver a `subagent/start` to the listener the tracker registered. */
  readonly start: (info: SubagentRunInfoLike) => void
  /** Deliver a `subagent/end` to the listener the tracker registered. */
  readonly end: (info: SubagentRunEndInfoLike) => void
  readonly dispose: () => void
}

function trackerRig(options: {
  readonly ledger?: SubagentLedger
  readonly registry?: () => AgentRegistryLike | undefined
  /** Make the n-th (1-based) registration throw. */
  readonly failRegistration?: number
} = {}): TrackerRig {
  const handlers = new Map<string, (info: never) => void>()
  const registered: string[] = []
  const removed: string[] = []
  const warnings: string[] = []
  const agents = new Map<string, AgentLike>()
  const ledger = options.ledger ?? new SubagentLedger({ now: ticking(1000) })
  const deps: TrackerDeps = {
    ctx: {
      on(event, handler) {
        registered.push(event)
        if (registered.length === options.failRegistration) throw new Error(`cannot listen to ${event}`)
        handlers.set(event, handler)
        return () => { removed.push(event); handlers.delete(event) }
      },
    },
    agents: options.registry ?? (() => ({ get: (id: string) => agents.get(id) })),
    ledger,
    logger: { warn: message => warnings.push(message) },
  }
  const dispose = installSubagentTracker(deps)
  const deliver = <T>(event: string, info: T): void => {
    const handler = handlers.get(event)
    assert.ok(handler, `no ${event} listener is registered`)
    const listener = handler as (info: T) => void
    listener(info)
  }
  return {
    ledger, agents, warnings, registered, removed, dispose,
    start: info => { deliver('subagent/start', info) },
    end: info => { deliver('subagent/end', info) },
  }
}

const started = (id: string, over: Partial<SubagentRunInfoLike> = {}): SubagentRunInfoLike => ({ runId: `run-${id}`, provider: 'spawn', id, local: true, ...over })
const ended = (id: string, stopReason: string, over: Partial<SubagentRunEndInfoLike> = {}): SubagentRunEndInfoLike => ({ ...started(id), stopReason, ...over })

/** Record what the tracker hands to a ledger, while the ledger still does its work. */
function spied(ledger: SubagentLedger): { readonly starts: unknown[]; readonly finishes: unknown[] } {
  const starts: unknown[] = []
  const finishes: unknown[] = []
  const start = ledger.start.bind(ledger)
  const finish = ledger.finish.bind(ledger)
  ledger.start = (info) => { starts.push(info); start(info) }
  ledger.finish = (id, outcome) => { finishes.push([id, outcome]); finish(id, outcome) }
  return { starts, finishes }
}

/** A child agent: its session parent, the options it was created with and, optionally, the config its last request logged. */
function childAgent(id: string, parentSession: string | undefined, options: AgentOptionsLike, logged?: AgentOptionsLike): AgentLike {
  const base = fakeAgent(id, parentSession)
  return { ...base, options, session: { ...base.session, ...logged === undefined ? {} : { requestHeader: () => ({ config: logged }) } } }
}

describe('installSubagentTracker', () => {
  it('listens to subagent/start and subagent/end', () => {
    const rig = trackerRig()
    assert.deepEqual(rig.registered, ['subagent/start', 'subagent/end'])
  })

  it('records a local child with the parent session and the route from the agent options', () => {
    const rig = trackerRig()
    rig.agents.set('c1', childAgent('c1', 'main', { provider: 'azure-opencode', model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'medium', maxTokens: 64_000 }))
    rig.start(started('c1', { provider: 'fork' }))
    assert.deepEqual(rig.ledger.get('c1'), {
      id: 'c1', parentId: 'main', backend: 'fork', route: routeA, state: 'running', stopReason: null, startedAt: 1001, endedAt: null,
    })
    assert.deepEqual(rig.warnings, [])
  })

  for (const [label, options, route] of [
    ['an empty effort is left out', { provider: 'p', model: 'm', reasoningEffort: '' }, { provider: 'p', model: 'm' }],
    ['an absent effort is left out', { provider: 'p', model: 'm' }, { provider: 'p', model: 'm' }],
    ['a route needs a provider', { model: 'm' }, null],
    ['a route needs a model', { provider: 'p' }, null],
    ['an empty provider is no provider', { provider: '', model: 'm' }, null],
    ['an empty model is no model', { provider: 'p', model: '' }, null],
  ] as const) {
    it(`reads the route from the options: ${label}`, () => {
      const ledger = new SubagentLedger({ now: ticking(1000) })
      const { starts } = spied(ledger)
      const rig = trackerRig({ ledger })
      rig.agents.set('c1', childAgent('c1', 'main', options))
      rig.start(started('c1'))
      assert.deepEqual(starts, [{ id: 'c1', parentId: 'main', backend: 'spawn', route, runId: 'run-c1' }], 'what the tracker hands to the ledger')
      assert.deepEqual(ledger.get('c1')?.route, route)
    })
  }

  it('ignores a remote child, at start and at end', () => {
    const rig = trackerRig()
    rig.start(started('remote-1', { provider: 'acp', local: false }))
    assert.equal(rig.ledger.size, 0)

    rig.agents.set('c1', childAgent('c1', 'main', routeA))
    rig.start(started('c1'))
    rig.end(ended('c1', 'error', { local: false }))
    assert.equal(rig.ledger.get('c1')?.state, 'running', 'an end that says remote is not for this child')

    rig.start({ runId: 'run-x', provider: 'spawn', id: 'no-local-flag' } as unknown as SubagentRunInfoLike)
    assert.equal(rig.ledger.get('no-local-flag'), undefined, 'only an explicit local: true counts')
    assert.deepEqual(rig.warnings, [])
  })

  it('records a child the agent registry does not know, with no parent and no route', () => {
    const rig = trackerRig()
    rig.start(started('unknown'))
    assert.deepEqual(rig.ledger.get('unknown'), {
      id: 'unknown', parentId: null, backend: 'spawn', route: null, state: 'running', stopReason: null, startedAt: 1001, endedAt: null,
    })
    const noRegistry = trackerRig({ registry: () => undefined })
    noRegistry.start(started('c1'))
    assert.equal(noRegistry.ledger.get('c1')?.parentId, null)
    assert.equal(noRegistry.ledger.get('c1')?.route, null)
  })

  it('records a child whose session has no parent session without a parent', () => {
    const rig = trackerRig()
    rig.agents.set('c1', childAgent('c1', undefined, routeA))
    rig.start(started('c1'))
    assert.equal(rig.ledger.get('c1')?.parentId, null)
    assert.deepEqual(rig.ledger.get('c1')?.route, routeA)
  })

  it('refines the route at the end from the config of the last request, and sets the state', () => {
    const rig = trackerRig()
    const logged = { provider: 'openrouter-extra', model: 'xiaomi/mimo-v2.6-pro', reasoningEffort: 'low' }
    rig.agents.set('c1', childAgent('c1', 'main', routeA, logged))
    rig.start(started('c1'))
    assert.deepEqual(rig.ledger.get('c1')?.route, routeA)
    rig.end(ended('c1', 'completed'))
    assert.deepEqual(rig.ledger.get('c1'), {
      id: 'c1', parentId: 'main', backend: 'spawn', route: logged, state: 'done', stopReason: 'completed', startedAt: 1001, endedAt: 1002,
    })
  })

  for (const [stopReason, state] of [['completed', 'done'], ['aborted', 'stopped'], ['error', 'failed'], ['max-tokens', 'failed'], ['refusal', 'failed']] as const) {
    it(`sets the state ${state} from the stop reason ${stopReason}`, () => {
      const rig = trackerRig()
      rig.agents.set('c1', childAgent('c1', 'main', routeA))
      rig.start(started('c1'))
      rig.end(ended('c1', stopReason))
      assert.equal(rig.ledger.get('c1')?.state, state)
      assert.equal(rig.ledger.get('c1')?.stopReason, stopReason)
    })
  }

  it('keeps the route recorded at start when the agent is gone at the end or its request names no route', () => {
    const rig = trackerRig()
    const cases: [string, (id: string) => void][] = [
      ['gone', (id) => { rig.agents.delete(id) }],
      ['no request logged yet', (id) => { rig.agents.set(id, { ...childAgent(id, 'main', routeA), session: { ...childAgent(id, 'main', routeA).session, requestHeader: () => undefined } }) }],
      ['a header without a config', (id) => { rig.agents.set(id, { ...childAgent(id, 'main', routeA), session: { ...childAgent(id, 'main', routeA).session, requestHeader: () => ({}) } }) }],
      ['a config with no model', (id) => { rig.agents.set(id, childAgent(id, 'main', routeA, { provider: 'p' })) }],
      ['no requestHeader at all', (id) => { rig.agents.set(id, childAgent(id, 'main', routeA)) }],
    ]
    for (const [label, arrange] of cases) {
      const id = `c-${label}`
      rig.agents.set(id, childAgent(id, 'main', routeA))
      rig.start(started(id))
      arrange(id)
      rig.end(ended(id, 'error'))
      assert.deepEqual(rig.ledger.get(id)?.route, routeA, label)
      assert.equal(rig.ledger.get(id)?.state, 'failed', label)
    }
    assert.deepEqual(rig.warnings, [])
  })

  it('names a route to the ledger at the end only when the last request logged a usable one', () => {
    const ledger = new SubagentLedger({ now: ticking() })
    const { finishes } = spied(ledger)
    const rig = trackerRig({ ledger })
    rig.agents.set('gone', childAgent('gone', 'main', routeA))
    rig.start(started('gone'))
    rig.agents.delete('gone')
    rig.end(ended('gone', 'completed'))
    rig.agents.set('no-config', childAgent('no-config', 'main', routeA, { provider: 'p' }))
    rig.start(started('no-config'))
    rig.end(ended('no-config', 'error'))
    rig.agents.set('logged', childAgent('logged', 'main', routeA, routeB))
    rig.start(started('logged'))
    rig.end(ended('logged', 'aborted'))
    assert.deepEqual(finishes, [
      ['gone', { stopReason: 'completed', runId: 'run-gone' }],
      ['no-config', { stopReason: 'error', runId: 'run-no-config' }],
      ['logged', { stopReason: 'aborted', runId: 'run-logged', route: routeB }],
    ])
  })

  it('ignores the end of a child it never saw start (the plugin loaded mid-run)', () => {
    const rig = trackerRig()
    rig.agents.set('ghost', childAgent('ghost', 'main', routeA))
    rig.end(ended('ghost', 'completed'))
    assert.equal(rig.ledger.size, 0)
    assert.deepEqual(rig.warnings, [])
  })

  it('records a resumed child again, as running with its new run', () => {
    const rig = trackerRig()
    rig.agents.set('c1', childAgent('c1', 'main', routeA))
    rig.start(started('c1', { runId: 'run-1' }))
    rig.end(ended('c1', 'completed', { runId: 'run-1' }))
    assert.equal(rig.ledger.get('c1')?.state, 'done')
    rig.agents.set('c1', childAgent('c1', 'main', routeB))
    rig.start(started('c1', { runId: 'run-2' }))
    assert.deepEqual(rig.ledger.get('c1'), {
      id: 'c1', parentId: 'main', backend: 'spawn', route: routeB, state: 'running', stopReason: null, startedAt: 1003, endedAt: null,
    })
    assert.equal(rig.ledger.size, 1)
  })

  it('shows the whole tree of a session through the ledger', () => {
    const rig = trackerRig()
    rig.agents.set('c1', childAgent('c1', 'main', routeA))
    rig.agents.set('g1', childAgent('g1', 'c1', routeB))
    rig.agents.set('c2', childAgent('c2', 'main', routeB))
    rig.agents.set('elsewhere', childAgent('elsewhere', 'someone-else', routeB))
    for (const id of ['c1', 'g1', 'c2', 'elsewhere']) rig.start(started(id))
    rig.end(ended('g1', 'error'))
    assert.deepEqual(rig.ledger.descendantsOf('main').map(record => [record.id, record.state]), [['c1', 'running'], ['g1', 'failed'], ['c2', 'running']])
  })

  it('contains a throwing agent registry and logs it, at start and at end', () => {
    const rig = trackerRig({ registry: () => { throw new Error('registry down') } })
    assert.doesNotThrow(() => { rig.start(started('c1')) })
    assert.doesNotThrow(() => { rig.end(ended('c1', 'completed')) })
    assert.deepEqual(rig.warnings, ['dsh-orquestrator: subagent tracker: registry down', 'dsh-orquestrator: subagent tracker: registry down'])
    assert.equal(rig.ledger.size, 0)

    const lookup = trackerRig({ registry: () => ({ get: () => { throw 'plain text' } }) })
    assert.doesNotThrow(() => { lookup.start(started('c1')) })
    assert.deepEqual(lookup.warnings, ['dsh-orquestrator: subagent tracker: plain text'])
  })

  it('contains an agent whose request header throws, and keeps the child as it was', () => {
    const rig = trackerRig()
    rig.agents.set('c1', childAgent('c1', 'main', routeA))
    rig.start(started('c1'))
    const agent = childAgent('c1', 'main', routeA)
    rig.agents.set('c1', { ...agent, session: { ...agent.session, requestHeader: () => { throw new Error('header unreadable') } } })
    assert.doesNotThrow(() => { rig.end(ended('c1', 'completed')) })
    assert.deepEqual(rig.warnings, ['dsh-orquestrator: subagent tracker: header unreadable'])
    assert.equal(rig.ledger.get('c1')?.state, 'running')
  })

  it('removes both listeners and writes the pending change on dispose', () => {
    const file = join(scratch, 'tracker-dispose', 'subagents.json')
    const rig = trackerRig({ ledger: new SubagentLedger({ file, now: ticking(), saveDelayMs: 60_000 }) })
    rig.agents.set('c1', childAgent('c1', 'main', routeA))
    rig.start(started('c1'))
    assert.equal(existsSync(file), false, 'still inside the write delay')
    rig.dispose()
    assert.deepEqual(rig.removed, ['subagent/start', 'subagent/end'])
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).subagents.c1.id, 'c1')
  })

  it('removes the first listener again when the second cannot be registered', () => {
    const attempt = (): TrackerRig => trackerRig({ failRegistration: 2 })
    assert.throws(attempt, /cannot listen to subagent\/end/)
    const removed: string[] = []
    assert.throws(() => installSubagentTracker({
      ctx: {
        on(event) {
          if (event === 'subagent/end') throw new Error('refused')
          return () => { removed.push(event) }
        },
      },
      agents: () => undefined,
      ledger: new SubagentLedger(),
      logger: { warn: () => undefined },
    }), /refused/)
    assert.deepEqual(removed, ['subagent/start'])
  })
})
