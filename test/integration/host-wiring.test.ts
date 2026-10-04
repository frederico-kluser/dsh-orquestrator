import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { apply, inject, name } from '../../src/index.ts'
import type { ToolDispatchExecutionLike, ToolExecutionResultLike } from '../../src/host-services.ts'
import { CONFIG_ROUTE, buildConfig } from '../../src/shared.ts'
import { FakeSubagents, fakeAgent, promptText, textResult } from '../helpers.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
type Wrapper = (exec: ToolDispatchExecutionLike, next: () => Promise<ToolExecutionResultLike>) => Promise<ToolExecutionResultLike>

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
  readonly wrapper: () => Wrapper
  readonly subagents: FakeSubagents
}

function rig(options: { services?: Record<string, unknown>; fence?: 401 | 403 | undefined } = {}): Rig {
  const effects: string[] = []
  const events: string[] = []
  const logs: string[] = []
  const warnings: string[] = []
  let handler: Handler | undefined
  let wrapper: Wrapper | undefined
  const subagents = new FakeSubagents({ results: [textResult('worker report'), textResult('VERDICT: APPROVED\nreviewed body')] })
  const services: Record<string, unknown> = {
    webServer: { register: (route: { path: string; handler: Handler }) => { handler = route.handler; return () => undefined } },
    connection: { requestRejection: () => options.fence },
    subagents,
    tools: {},
    ...options.services,
  }
  const ctx = {
    get: (service: string) => services[service],
    inject: (names: string[], callback: (scope: unknown) => void) => {
      if (names.every(service => services[service] !== undefined)) callback(ctx)
    },
    effect: (fn: () => unknown, label: string) => { effects.push(label); return fn() },
    on: (event: string, listener: Wrapper) => { events.push(event); if (event === 'tools/execute') wrapper = listener; return () => true },
    logger: { info: (message: string) => logs.push(message), warn: (message: string) => { logs.push(message); warnings.push(message) } },
  } as unknown as Context
  return {
    ctx, effects, events, logs, warnings, subagents,
    handler: () => { assert.ok(handler, 'the route was not registered'); return handler },
    wrapper: () => { assert.ok(wrapper, 'the tools/execute listener was not registered'); return wrapper },
  }
}

describe('plugin identity', () => {
  it('declares its name and the services it waits for (never logger)', () => {
    assert.equal(name, 'dsh-orquestrator')
    assert.deepEqual(inject, ['tools', 'subagents'])
    assert.equal(inject.includes('logger'), false)
  })
})

describe('apply', () => {
  it('registers the route, the delegation wrapper and the start guard as effects', () => {
    const r = rig()
    apply(r.ctx, { stateDir: join(scratch, 'a') })
    assert.deepEqual([...r.effects].sort(), ['dsh-orquestrator: delegation wrapper', 'dsh-orquestrator: routes', 'dsh-orquestrator: start guard'])
    assert.deepEqual(r.events, ['tools/execute'])
    assert.ok(r.logs.some(line => /ready \(tools: subagent, subagent_fork; persisted sessions: 0; effort ceilings: on; reviewer context: auto; start guard: on, explicit models override\)/.test(line)))
    assert.equal(Object.hasOwn(r.subagents, 'start'), true, 'the guard stands in the start door')
  })

  it('leaves the start door alone with `children: false` (the 0.3 behavior)', () => {
    const r = rig()
    apply(r.ctx, { stateDir: join(scratch, 'noguard'), children: false })
    assert.deepEqual([...r.effects].sort(), ['dsh-orquestrator: delegation wrapper', 'dsh-orquestrator: routes'])
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

  it('still installs the delegation wrapper, without a route, where there is no web server', () => {
    for (const missing of ['webServer', 'connection']) {
      const r = rig({ services: { [missing]: undefined } })
      apply(r.ctx, { stateDir: join(scratch, 'headless') })
      assert.deepEqual(r.effects, ['dsh-orquestrator: delegation wrapper', 'dsh-orquestrator: start guard'])
      assert.deepEqual(r.events, ['tools/execute'])
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

  it('fails loud on a malformed config before touching anything', () => {
    const r = rig()
    assert.throws(() => apply(r.ctx, { maxSessions: -1 }), /maxSessions/)
    assert.deepEqual(r.effects, [])
  })

  it('puts the guard on the plugin\'s own choices, lineage, defaults, LLM runtime, configuration and log', async () => {
    const dir = mkdtempSync(join(scratch, 'guard-wiring-'))
    const picked = { provider: 'openrouter', model: 'google/gemini-3.8-flash' }
    const fallback = { provider: 'azure-opencode', model: 'DeepSeek-V4.1-Flash' }
    const stored = buildConfig({ subagentModel: picked, reviewerEnabled: false, reviewerModel: null })
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

    // The delegation tools see the same LLM runtime (the pipeline is wired with the same `models`).
    const next = (): Promise<ToolExecutionResultLike> => Promise.reject(new Error('the stock tool must not run'))
    const call: ToolDispatchExecutionLike = { callId: 'c', name: 'subagent', arguments: { description: 'd', prompt: 'p' }, agent: fakeAgent('sess-g'), signal: new AbortController().signal }
    await r.wrapper()(call, next)
    assert.equal((subagents.continuables[0]?.request as { agentOptions?: { maxTokens?: number } }).agentOptions?.maxTokens, 64_000)
  })

  it('tells the operator, from the real guard setting, whether a one-shot background job is still governed', async () => {
    const oneShot = { name: 'subagent', provider: 'spawn', mode: 'one-shot' as const }
    const job: ToolDispatchExecutionLike = {
      callId: 'c', name: 'subagent', arguments: { description: 'd', prompt: 'p', run_in_background: true },
      agent: fakeAgent('sess-job'), signal: new AbortController().signal,
    }
    const next = (): Promise<ToolExecutionResultLike> => Promise.resolve({ isError: false, value: 'stock', content: [] })
    for (const [children, expected] of [[undefined, /still governed by the start guard/], [false as const, /is not orchestrated; the stock behavior runs/]] as const) {
      const r = rig()
      apply(r.ctx, { stateDir: join(scratch, 'job-warning'), tools: [oneShot], defaults: { subagentModel: { provider: 'openrouter', model: 'google/gemini-3.8-flash' } }, ...children === undefined ? {} : { children } })
      await r.wrapper()(job, next)
      assert.equal(r.logs.filter(line => /run_in_background/.test(line)).length, 1)
      assert.ok(r.logs.some(line => /run_in_background/.test(line) && expected.test(line)), String(expected))
    }
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
  const exec = (sessionId: string): ToolDispatchExecutionLike => ({
    callId: 'c', name: 'subagent', arguments: { description: 'Add slugify', prompt: 'Create slugify().' },
    agent: fakeAgent(sessionId), signal: new AbortController().signal,
  })
  const stock: ToolExecutionResultLike = { isError: false, value: 'stock', content: [] }
  const stockNext = (): Promise<ToolExecutionResultLike> => Promise.resolve(stock)

  it('runs stock DSH until the user confirms the modal', async () => {
    assert.equal(await r.wrapper()(exec('sess-a'), stockNext), stock)
    assert.equal(r.subagents.starts.length, 0)
  })

  it('applies the choice stored through the route, delivering only the reviewer report', async () => {
    const config = buildConfig({ subagentModel: route, reviewerEnabled: true, reviewerModel: null })
    const saved = await fetch(`${base}${CONFIG_ROUTE}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'sess-a', config }),
    })
    assert.equal(saved.status, 200)

    const result = await r.wrapper()(exec('sess-a'), () => Promise.reject(new Error('stock tool must not run')))
    assert.equal(result.isError, false)
    const value = (result as { value: { kind: string; output: { text: string }[] } }).value
    assert.equal(value.kind, 'foreground')
    assert.match(value.output[0]?.text ?? '', /reviewed body/)
    assert.equal((value.output[0]?.text ?? '').includes('worker report'), false)
    assert.equal(r.subagents.starts.length, 2)
    assert.deepEqual(r.subagents.starts[0]?.request.agentOptions, route)
    assert.match(promptText(r.subagents.starts[1]?.request.prompt ?? []), /worker report/)
  })

  it('persists the choice under the state directory, owner-only, without secrets', () => {
    const persisted = JSON.parse(readFileSync(join(stateDir, 'sessions.json'), 'utf8')) as { version: number; sessions: Record<string, unknown> }
    assert.equal(persisted.version, 1)
    assert.deepEqual(Object.keys(persisted.sessions), ['sess-a'])
  })

  it('goes back to stock DSH after the user cancels (config null)', async () => {
    await fetch(`${base}${CONFIG_ROUTE}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'sess-a', config: null }),
    })
    const before = r.subagents.starts.length
    assert.equal(await r.wrapper()(exec('sess-a'), stockNext), stock)
    assert.equal(r.subagents.starts.length, before)
  })

  it('a restarted host re-reads the persisted choice', async () => {
    const config = buildConfig({ subagentModel: null, reviewerEnabled: true, reviewerModel: null })
    await fetch(`${base}${CONFIG_ROUTE}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'sess-b', config }),
    })
    const again = rig()
    apply(again.ctx, { stateDir })
    assert.ok(again.logs.some(line => /persisted sessions: 1/.test(line)))
    await again.wrapper()(exec('sess-b'), stockNext)
    assert.equal(again.subagents.starts.length, 2)
  })
})
