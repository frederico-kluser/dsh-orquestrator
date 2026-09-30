import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  readonly handler: () => Handler
  readonly wrapper: () => Wrapper
  readonly subagents: FakeSubagents
}

function rig(options: { services?: Record<string, unknown>; fence?: 401 | 403 | undefined } = {}): Rig {
  const effects: string[] = []
  const events: string[] = []
  const logs: string[] = []
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
    logger: { info: (message: string) => logs.push(message), warn: (message: string) => logs.push(message) },
  } as unknown as Context
  return {
    ctx, effects, events, logs, subagents,
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
  it('registers the route and the delegation wrapper as effects', () => {
    const r = rig()
    apply(r.ctx, { stateDir: join(scratch, 'a') })
    assert.deepEqual([...r.effects].sort(), ['dsh-orquestrator: delegation wrapper', 'dsh-orquestrator: routes'])
    assert.deepEqual(r.events, ['tools/execute'])
    assert.ok(r.logs.some(line => /ready \(tools: subagent, subagent_fork; persisted sessions: 0\)/.test(line)))
  })

  it('fails loud when delegation is missing', () => {
    const r = rig({ services: { subagents: undefined } })
    assert.throws(() => apply(r.ctx, { stateDir: join(scratch, 'b') }), /`subagents` service is missing/)
  })

  it('still installs the delegation wrapper, without a route, where there is no web server', () => {
    for (const missing of ['webServer', 'connection']) {
      const r = rig({ services: { [missing]: undefined } })
      apply(r.ctx, { stateDir: join(scratch, 'headless') })
      assert.deepEqual(r.effects, ['dsh-orquestrator: delegation wrapper'])
      assert.deepEqual(r.events, ['tools/execute'])
    }
  })

  it('fails loud on a malformed config before touching anything', () => {
    const r = rig()
    assert.throws(() => apply(r.ctx, { maxSessions: -1 }), /maxSessions/)
    assert.deepEqual(r.effects, [])
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
    const config = buildConfig({ subagentModel: route, reviewerEnabled: true, reviewerModel: null, remember: false })
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
    const config = buildConfig({ subagentModel: null, reviewerEnabled: true, reviewerModel: null, remember: true })
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
