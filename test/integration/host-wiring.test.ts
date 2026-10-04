import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { apply, inject, name } from '../../src/index.ts'
import { CONFIG_ROUTE, buildConfig } from '../../src/shared.ts'
import { FakeSubagents, fakeAgent, textResult } from '../helpers.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

const scratch = mkdtempSync(join(tmpdir(), 'orq-wiring-'))
after(() => { rmSync(scratch, { recursive: true, force: true }) })

interface Rig {
  readonly ctx: Context
  readonly effects: string[]
  readonly events: string[]
  readonly logs: string[]
  /** The subset of `logs` that was logged at warn level. */
  readonly warnings: string[]
  readonly handler: () => Handler
  readonly subagents: FakeSubagents
}

function rig(options: { services?: Record<string, unknown>; fence?: 401 | 403 | undefined } = {}): Rig {
  const effects: string[] = []
  const events: string[] = []
  const logs: string[] = []
  const warnings: string[] = []
  let handler: Handler | undefined
  const subagents = new FakeSubagents({ results: Array.from({ length: 8 }, () => textResult('ok')) })
  const services: Record<string, unknown> = {
    webServer: { register: (route: { path: string; handler: Handler }) => { handler = route.handler; return () => undefined } },
    connection: { requestRejection: () => options.fence },
    subagents,
    ...options.services,
  }
  const ctx = {
    get: (service: string) => services[service],
    inject: (names: string[], callback: (scope: unknown) => void) => {
      if (names.every(service => services[service] !== undefined)) callback(ctx)
    },
    effect: (fn: () => unknown, label: string) => { effects.push(label); return fn() },
    on: (event: string) => { events.push(event); return () => true },
    logger: { info: (message: string) => logs.push(message), warn: (message: string) => { logs.push(message); warnings.push(message) } },
  } as unknown as Context
  return {
    ctx, effects, events, logs, warnings, subagents,
    handler: () => { assert.ok(handler, 'the route was not registered'); return handler },
  }
}

describe('plugin identity', () => {
  it('declares its name and the services it waits for (never logger)', () => {
    assert.equal(name, 'dsh-orquestrator')
    assert.deepEqual(inject, ['subagents'])
    assert.equal(inject.includes('logger'), false)
  })
})

describe('apply', () => {
  it('registers the route and the start guard as effects, and listens to no tool', () => {
    const r = rig()
    apply(r.ctx, { stateDir: join(scratch, 'a') })
    assert.deepEqual([...r.effects].sort(), ['dsh-orquestrator: routes', 'dsh-orquestrator: start guard'])
    assert.deepEqual(r.events, [], 'no tools/execute wrapper: the guard is the only mechanism')
    assert.ok(r.logs.some(line => /ready \(persisted sessions: 0; effort ceilings: on; start guard: on, explicit models override\)/.test(line)))
    assert.equal(Object.hasOwn(r.subagents, 'start'), true, 'the guard stands in the start door')
    assert.equal(Object.hasOwn(r.subagents, 'startContinuable'), true, 'and in the continuable door')
  })

  it('leaves the start doors alone with `children: false` (the enforcement off; the dialog still stores choices)', () => {
    const r = rig()
    apply(r.ctx, { stateDir: join(scratch, 'noguard'), children: false })
    assert.deepEqual([...r.effects], ['dsh-orquestrator: routes'])
    assert.equal(Object.hasOwn(r.subagents, 'start'), false)
    assert.ok(r.logs.some(line => /start guard: off\)/.test(line)))
  })

  it('removes the guard when the plugin is disposed', () => {
    const r = rig()
    const disposers: (() => void)[] = []
    ;(r.ctx as unknown as { effect: (fn: () => unknown, label: string) => unknown }).effect = (fn, label) => {
      r.effects.push(label)
      const result = fn()
      if (typeof result === 'function') disposers.push(result as () => void)
      return result
    }
    apply(r.ctx, { stateDir: join(scratch, 'dispose') })
    assert.equal(Object.hasOwn(r.subagents, 'start'), true)
    for (const dispose of disposers) dispose()
    assert.equal(Object.hasOwn(r.subagents, 'start'), false)
  })

  it('fails loud when delegation is missing', () => {
    const r = rig({ services: { subagents: undefined } })
    assert.throws(() => apply(r.ctx, { stateDir: join(scratch, 'b') }), /`subagents` service is missing/)
  })

  it('still installs the start guard, without a route, where there is no web server (headless, tui, sdk)', () => {
    for (const missing of ['webServer', 'connection']) {
      const r = rig({ services: { [missing]: undefined } })
      apply(r.ctx, { stateDir: join(scratch, 'headless') })
      assert.deepEqual(r.effects, ['dsh-orquestrator: start guard'])
    }
  })

  it('says so, once per field, when the config carries a field it does not know (a mis-indented `explicitModel: keep` would otherwise run as override)', () => {
    const r = rig()
    apply(r.ctx, { stateDir: join(scratch, 'unknown'), explicitModel: 'keep', colour: 'blue' } as never)
    const unknown = r.logs.filter(line => /unknown config field/.test(line))
    assert.deepEqual(r.warnings.filter(line => /unknown config field/.test(line)), unknown, 'logged at warn level, where an operator looks')
    assert.deepEqual(unknown, [
      'dsh-orquestrator: unknown config field "explicitModel" is ignored (did you mean children.explicitModel?)',
      'dsh-orquestrator: unknown config field "colour" is ignored',
    ])
    assert.ok(r.logs.some(line => /start guard: on, explicit models override\)/.test(line)), 'and the plugin still loads, with the default it was left with')
  })

  it('says, at warn level and once per field, that a reviewer field of 0.4.0 does nothing now, and still loads', () => {
    const r = rig()
    apply(r.ctx, { stateDir: join(scratch, 'legacy'), reviewerContext: 'claims', tools: [], defaults: { subagentModel: { provider: 'p', model: 'm' }, reviewer: { enabled: true } } } as never)
    const removed = r.warnings.filter(line => /removed in 0\.5\.0/.test(line))
    assert.deepEqual(removed, [
      'dsh-orquestrator: config field "reviewerContext" belonged to the independent reviewer, removed in 0.5.0, and is ignored',
      'dsh-orquestrator: config field "tools" belonged to the independent reviewer, removed in 0.5.0, and is ignored',
      'dsh-orquestrator: config field "defaults.reviewer" belonged to the independent reviewer, removed in 0.5.0, and is ignored',
    ])
    assert.equal(r.warnings.some(line => /unknown config field/.test(line)), false, 'a removed field is not "unknown"')
    assert.ok(r.logs.some(line => /ready \(/.test(line)), 'the plugin loaded')
  })

  it('fails loud on a malformed config before touching anything', () => {
    const r = rig()
    assert.throws(() => apply(r.ctx, { maxSessions: -1 }), /maxSessions/)
    assert.deepEqual(r.effects, [])
  })

  it('puts the guard on the plugin\'s own choices, lineage, defaults, LLM runtime, configuration and log', async () => {
    const dir = mkdtempSync(join(scratch, 'guard-wiring-'))
    const picked = { provider: 'openrouter', model: 'google/gemini-3.8-flash' }
    const fallback = { provider: 'azure-opencode', model: 'DeepSeek-V4.1-Flash' }
    const stored = buildConfig({ subagentModel: picked })
    writeFileSync(join(dir, 'sessions.json'), JSON.stringify({ version: 1, sessions: { 'sess-g': { config: stored, updatedAt: 1 } } }))
    const subagents = new FakeSubagents({ results: Array.from({ length: 6 }, () => textResult('ok')) })
    const llm = { resolveModelInfo: () => Promise.resolve({ reasoning: { efforts: ['low', 'medium', 'high', 'max'].map(id => ({ id })), defaultEffort: 'max' }, defaultMaxTokens: 384_000 }) }
    const agents = { get: (id: string) => (id === 'child' ? { session: { header: { parentSession: 'sess-g' } } } : undefined) }
    const r = rig({ services: { subagents, llm, agents } })
    apply(r.ctx, { stateDir: dir, children: { explicitModel: 'keep' }, defaults: { subagentModel: fallback } })

    const start = (session: string, agentOptions?: { provider: string; model: string }) => subagents.start('spawn', {
      prompt: [{ type: 'text', text: 'x' }], parent: fakeAgent(session), signal: new AbortController().signal, ...agentOptions === undefined ? {} : { agentOptions },
    })
    await start('sess-g')
    await start('child')
    await start('headless')
    await start('sess-g', { provider: 'openrouter-extra', model: 'xiaomi/mimo-v2.6-pro' })
    const [own, delegating, headless, named] = subagents.starts.map(started => started.request.agentOptions)
    assert.equal(own?.model, picked.model, 'the choice the route stored (the same store)')
    assert.equal(own?.maxTokens, 64_000, 'the LLM runtime was resolved, so the cap applies')
    assert.notEqual(own?.reasoningEffort, 'max', 'and so does the effort ceiling')
    assert.deepEqual(delegating, own, 'a child that delegates further inherits it (the agents service gives the lineage)')
    assert.equal(headless?.model, fallback.model, 'a session with no stored choice gets the deployment defaults')
    assert.equal(named?.model, 'xiaomi/mimo-v2.6-pro', 'children.explicitModel: keep reached the guard')
    assert.ok(r.logs.some(line => /child of session sess-g on provider spawn/.test(line)), 'the guard logs through the plugin\'s logger')
    assert.ok(r.logs.some(line => /start guard: on, explicit models keep\)/.test(line)))

  })
})

describe('end to end on the host', () => {
  let server: Server
  let base: string
  let r: Rig
  const stateDir = join(scratch, 'e2e')

  before(async () => {
    r = rig()
    apply(r.ctx, { stateDir })
    server = createServer((req, res) => { void r.handler()(req, res) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  })
  after(() => { server.close() })

  const route = { provider: 'openrouter', model: 'google/gemini-3.8-flash' }
  const start = (target: Rig, sessionId: string) => target.subagents.start('spawn', {
    prompt: [{ type: 'text', text: 'x' }], parent: fakeAgent(sessionId), signal: new AbortController().signal,
  })
  const post = (body: unknown) => fetch(`${base}${CONFIG_ROUTE}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  it('runs stock DSH until the user confirms the modal', async () => {
    await start(r, 'sess-a')
    assert.equal(r.subagents.starts[0]?.request.agentOptions, undefined)
  })

  it('puts the next child on the model stored through the route', async () => {
    const saved = await post({ sessionId: 'sess-a', config: buildConfig({ subagentModel: route }) })
    assert.equal(saved.status, 200)
    await start(r, 'sess-a')
    assert.deepEqual(r.subagents.starts[1]?.request.agentOptions, route)
  })

  it('persists the choice under the state directory, owner-only, without secrets', () => {
    const persisted = JSON.parse(readFileSync(join(stateDir, 'sessions.json'), 'utf8')) as { version: number; sessions: Record<string, { config: Record<string, unknown> }> }
    assert.equal(persisted.version, 1)
    assert.deepEqual(Object.keys(persisted.sessions), ['sess-a'])
    assert.deepEqual(Object.keys(persisted.sessions['sess-a']?.config ?? {}).sort(), ['subagentModel', 'version', 'workerEffort'], 'no reviewer block any more')
  })

  it('goes back to stock DSH after the user cancels (config null)', async () => {
    await post({ sessionId: 'sess-a', config: null })
    const before = r.subagents.starts.length
    await start(r, 'sess-a')
    assert.equal(r.subagents.starts[before]?.request.agentOptions, undefined)
  })

  it('a restarted host re-reads the persisted choice', async () => {
    await post({ sessionId: 'sess-b', config: buildConfig({ subagentModel: route }) })
    const again = rig()
    apply(again.ctx, { stateDir })
    assert.ok(again.logs.some(line => /persisted sessions: 1/.test(line)))
    await start(again, 'sess-b')
    assert.deepEqual(again.subagents.starts[0]?.request.agentOptions, route)
  })

  it('keeps the model a user picked with 0.4.0: a stored choice that still carries a reviewer block is read, and the block is dropped', async () => {
    const dir = mkdtempSync(join(scratch, 'migrate-'))
    const legacy = { version: 1, subagentModel: route, workerEffort: null, reviewer: { enabled: true, model: { provider: 'p', model: 'm' }, effort: null } }
    writeFileSync(join(dir, 'sessions.json'), JSON.stringify({ version: 1, sessions: { 'sess-old': { config: legacy, updatedAt: 1 }, 'sess-reviewer-only': { config: { ...legacy, subagentModel: null }, updatedAt: 2 } } }))
    const old = rig()
    apply(old.ctx, { stateDir: dir })
    assert.ok(old.logs.some(line => /persisted sessions: 2/.test(line)))
    await start(old, 'sess-old')
    assert.deepEqual(old.subagents.starts[0]?.request.agentOptions, route)
    // A choice that only had a reviewer has nothing left to apply: DSH starts the child as it always did.
    await start(old, 'sess-reviewer-only')
    assert.equal(old.subagents.starts[1]?.request.agentOptions, undefined)
  })
})
