import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { apply, inject, name } from '../../src/index.ts'
import { CONFIG_ROUTE, SKILL_NAME, SUBAGENTS_ROUTE, buildConfig } from '../../src/shared.ts'
import { FakeSubagents, fakeAgent, textResult } from '../helpers.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

const scratch = mkdtempSync(join(tmpdir(), 'orq-wiring-'))
after(() => { rmSync(scratch, { recursive: true, force: true }) })

/** A lifecycle listener the tracker registered through `ctx.on`. */
type Listener = (info: never) => void

interface Rig {
  readonly ctx: Context
  readonly effects: string[]
  readonly events: string[]
  /** The listeners registered through `ctx.on`, by event name. */
  readonly listeners: Map<string, Listener>
  readonly logs: string[]
  /** The subset of `logs` that was logged at warn level. */
  readonly warnings: string[]
  /** The handler of a registered route (the configuration route unless another path is named). */
  readonly handler: (path?: string) => Handler
  /** The paths of the routes the plugin registered, in order. */
  readonly routes: string[]
  readonly subagents: FakeSubagents
}

function rig(options: { services?: Record<string, unknown>; fence?: 401 | 403 | undefined } = {}): Rig {
  const effects: string[] = []
  const events: string[] = []
  const listeners = new Map<string, Listener>()
  const logs: string[] = []
  const warnings: string[] = []
  const handlers = new Map<string, Handler>()
  const subagents = new FakeSubagents({ results: Array.from({ length: 8 }, () => textResult('ok')) })
  const services: Record<string, unknown> = {
    webServer: { register: (route: { path: string; handler: Handler }) => { handlers.set(route.path, route.handler); return () => { handlers.delete(route.path) } } },
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
    on: (event: string, listener: Listener) => { events.push(event); listeners.set(event, listener); return () => true },
    logger: { info: (message: string) => logs.push(message), warn: (message: string) => { logs.push(message); warnings.push(message) } },
  } as unknown as Context
  return {
    ctx, effects, events, listeners, logs, warnings, subagents,
    get routes() { return [...handlers.keys()] },
    handler: (path = CONFIG_ROUTE) => { const found = handlers.get(path); assert.ok(found, `the route ${path} was not registered`); return found },
  }
}

/** A skill registry double that records what is registered and unregistered. */
function fakeSkills() {
  const registered: { name: string; invocation?: { modelInvocable: boolean; userInvocable: boolean }; content: string }[] = []
  let disposed = 0
  return {
    registered,
    get disposed() { return disposed },
    register: (skill: { name: string; invocation?: { modelInvocable: boolean; userInvocable: boolean }; content: string }) => { registered.push(skill); return () => { disposed += 1 } },
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
  it('registers the routes, the subagent tracker and the start guard as effects, and listens to no tool', () => {
    const r = rig()
    apply(r.ctx, { stateDir: join(scratch, 'a') })
    assert.deepEqual([...r.effects].sort(), ['dsh-orquestrator: routes', 'dsh-orquestrator: start guard', 'dsh-orquestrator: subagent tracker'])
    assert.deepEqual(r.events, ['subagent/start', 'subagent/end'], 'no tools/execute wrapper: the guard is the only mechanism; the tracker only watches the lifecycle')
    assert.deepEqual(r.routes, [CONFIG_ROUTE, SUBAGENTS_ROUTE], 'the configuration route and the read-only subagent route')
    assert.ok(r.logs.some(line => /ready \(persisted sessions: 0; effort ceilings: on; start guard: on, explicit models override; skill: on, in the model catalog; tracked subagents: 0\)/.test(line)))
    assert.equal(Object.hasOwn(r.subagents, 'start'), true, 'the guard stands in the start door')
    assert.equal(Object.hasOwn(r.subagents, 'startContinuable'), true, 'and in the continuable door')
  })

  it('leaves the start doors alone with `children: false` (the enforcement off; the dialog still stores choices)', () => {
    const r = rig()
    apply(r.ctx, { stateDir: join(scratch, 'noguard'), children: false })
    assert.deepEqual([...r.effects], ['dsh-orquestrator: routes', 'dsh-orquestrator: subagent tracker'])
    assert.equal(Object.hasOwn(r.subagents, 'start'), false)
    assert.ok(r.logs.some(line => /start guard: off; /.test(line)))
  })

  it('keeps the start guard when the subagent tracker cannot be installed (the tracker is a convenience, the guard the purpose)', () => {
    const r = rig()
    const ctx = r.ctx as unknown as { on: (event: string) => never }
    ctx.on = () => { throw new Error('listeners are closed') }
    apply(r.ctx, { stateDir: join(scratch, 'tracker-fails') })
    assert.deepEqual(r.effects.filter(label => /guard/.test(label)), ['dsh-orquestrator: start guard'])
    assert.ok(r.warnings.some(line => /could not install the subagent tracker \(listeners are closed\)/.test(line)))
    assert.ok(r.logs.some(line => /ready \(/.test(line)), 'the plugin still loaded')
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
      assert.deepEqual(r.effects, ['dsh-orquestrator: start guard', 'dsh-orquestrator: subagent tracker'], 'the guard first: it is the plugin\'s purpose, the tracker a convenience')
      assert.deepEqual(r.routes, [], 'no web server (or no trust fence): no route at all')
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
    assert.ok(r.logs.some(line => /start guard: on, explicit models override; /.test(line)), 'and the plugin still loads, with the default it was left with')
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
    assert.ok(r.logs.some(line => /start guard: on, explicit models keep; /.test(line)))

  })
})

/**
 * Serve the plugin's routes of a rig over a real HTTP server, dispatching by path like DSH's web server does. The
 * routes are captured when the server starts, so a test can still ask a plugin that was unloaded since what its
 * handlers would say. A path nobody registered answers 404 instead of leaving the request hanging.
 */
async function serve(target: Rig): Promise<{ base: string; close: () => void }> {
  const routes = new Map(target.routes.map(path => [path, target.handler(path)]))
  const server = createServer((req, res) => {
    const handler = routes.get(new URL(String(req.url), 'http://localhost').pathname)
    if (handler === undefined) {
      res.statusCode = 404
      res.end()
      return
    }
    void Promise.resolve(handler(req, res)).catch(() => { res.statusCode = 500; res.end() })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, close: () => { server.close(); server.closeAllConnections() } }
}

/** Make a rig's `effect` keep the disposers it is given, so a test can unload the plugin. */
function keepDisposers(target: Rig): (() => void)[] {
  const disposers: (() => void)[] = []
  ;(target.ctx as unknown as { effect: (fn: () => unknown, label: string) => unknown }).effect = (fn, label) => {
    target.effects.push(label)
    const result = fn()
    if (typeof result === 'function') disposers.push(result as () => void)
    return result
  }
  return disposers
}

describe('the global skill', () => {
  const offerOf = async (target: Rig, sessionId = 's'): Promise<unknown> => {
    const web = await serve(target)
    try {
      const body = await (await fetch(`${web.base}${CONFIG_ROUTE}?sessionId=${sessionId}`)).json() as Record<string, unknown>
      return body['skill']
    } finally { web.close() }
  }

  it('is registered where DSH has a skill registry, and the configuration route says so', async () => {
    const skills = fakeSkills()
    const r = rig({ services: { skills } })
    apply(r.ctx, { stateDir: join(scratch, 'skill-on') })
    assert.deepEqual(r.effects.filter(label => /skill/.test(label)), ['dsh-orquestrator: skill'])
    assert.equal(skills.registered.length, 1)
    assert.equal(skills.registered[0]?.name, SKILL_NAME)
    assert.deepEqual(skills.registered[0]?.invocation, { modelInvocable: true, userInvocable: true })
    assert.match(skills.registered[0]?.content ?? '', /Do not read code yourself/)
    assert.deepEqual(await offerOf(r), { name: SKILL_NAME, available: true })
    assert.ok(r.logs.some(line => /registered the global skill "orchestrate-subagents" \(model-invocable: yes\)/.test(line)))
  })

  it('stays out of the model\'s catalog with `skill: { modelInvocable: false }`, and is still loaded by the token', () => {
    const skills = fakeSkills()
    const r = rig({ services: { skills } })
    apply(r.ctx, { stateDir: join(scratch, 'skill-token-only'), skill: { modelInvocable: false } })
    assert.deepEqual(skills.registered[0]?.invocation, { modelInvocable: false, userInvocable: true })
    assert.ok(r.logs.some(line => /skill: on, token only/.test(line)))
  })

  it('is offered as unavailable, and nothing is registered, where there is no skill registry', async () => {
    const r = rig()
    apply(r.ctx, { stateDir: join(scratch, 'skill-no-registry') })
    assert.equal(r.effects.some(label => /skill/.test(label)), false)
    assert.deepEqual(await offerOf(r), { name: SKILL_NAME, available: false }, 'so the dialog does not offer a token nothing would expand')
  })

  it('is not registered, and not offered at all, with `skill: false`', async () => {
    const skills = fakeSkills()
    const r = rig({ services: { skills } })
    apply(r.ctx, { stateDir: join(scratch, 'skill-off'), skill: false })
    assert.equal(skills.registered.length, 0)
    assert.equal(await offerOf(r), undefined, 'the answer carries no skill, exactly as a host older than 0.8 wrote it')
    assert.ok(r.logs.some(line => /skill: off;/.test(line)))
  })

  it('costs the skill, not the load, when the registry refuses it, and the dialog is told', async () => {
    const refusing = { register: () => { throw new Error('invalid skill name') } }
    const r = rig({ services: { skills: refusing } })
    apply(r.ctx, { stateDir: join(scratch, 'skill-refused') })
    assert.ok(r.warnings.some(line => /could not register the global skill "orchestrate-subagents": invalid skill name/.test(line)))
    assert.ok(r.logs.some(line => /ready \(/.test(line)), 'the plugin loaded')
    assert.deepEqual(await offerOf(r), { name: SKILL_NAME, available: false })
  })

  it('is unregistered, and no longer offered, when the plugin is disposed', async () => {
    const skills = fakeSkills()
    const r = rig({ services: { skills } })
    const disposers = keepDisposers(r)
    apply(r.ctx, { stateDir: join(scratch, 'skill-dispose') })
    assert.equal(skills.disposed, 0)
    // The server keeps the handlers the plugin had registered, so it can still say what the plugin would answer once unloaded.
    const web = await serve(r)
    try {
      const offer = async (): Promise<unknown> => ((await (await fetch(`${web.base}${CONFIG_ROUTE}?sessionId=s`)).json()) as Record<string, unknown>)['skill']
      assert.deepEqual(await offer(), { name: SKILL_NAME, available: true })
      for (const dispose of disposers) dispose()
      assert.equal(skills.disposed, 1)
      assert.deepEqual(await offer(), { name: SKILL_NAME, available: false })
    } finally { web.close() }
  })
})

describe('the skill offer and the loader that expands the token', () => {
  const offerFor = async (target: Rig, sessionId: string): Promise<unknown> => {
    const web = await serve(target)
    try {
      return ((await (await fetch(`${web.base}${CONFIG_ROUTE}?sessionId=${sessionId}`)).json()) as Record<string, unknown>)['skill']
    } finally { web.close() }
  }
  const available = { name: SKILL_NAME, available: true }
  const unavailable = { name: SKILL_NAME, available: false }
  /** An agent registry that knows these conversations, each as its own object (the scope DSH keys a tools lookup by). */
  const registry = (...ids: string[]): { get: (id: string) => object | undefined; agent: (id: string) => object | undefined } => {
    const known = new Map(ids.map(id => [id, { id, session: { header: {} } }]))
    return { get: id => known.get(id), agent: id => known.get(id) }
  }

  it('is offered when there is no tools service to ask: it cannot be told otherwise', async () => {
    const r = rig({ services: { skills: fakeSkills(), agents: registry('conv') } })
    apply(r.ctx, { stateDir: join(scratch, 'loader-no-tools') })
    assert.deepEqual(await offerFor(r, 'conv'), available)
  })

  it('is offered when the tools service has no `get` to ask with', async () => {
    const r = rig({ services: { skills: fakeSkills(), agents: registry('conv'), tools: {} } })
    apply(r.ctx, { stateDir: join(scratch, 'loader-no-get') })
    assert.deepEqual(await offerFor(r, 'conv'), available)
  })

  it('is not offered when the loader is not mounted for the conversation\'s agent: nothing would expand the token', async () => {
    const asked: unknown[][] = []
    const agents = registry('conv')
    const tools = { get: (...args: unknown[]) => { asked.push(args); return undefined } }
    const r = rig({ services: { skills: fakeSkills(), agents, tools } })
    apply(r.ctx, { stateDir: join(scratch, 'loader-absent') })
    assert.deepEqual(await offerFor(r, 'conv'), unavailable)
    assert.deepEqual(asked, [['skill', agents.agent('conv')]], 'asked about the skill tool, as that agent sees it: a lookup without the agent finds nothing where a preset mounts the loader')
  })

  it('is offered when the loader is mounted for the conversation\'s agent', async () => {
    const r = rig({ services: { skills: fakeSkills(), agents: registry('conv'), tools: { get: () => ({ name: 'skill' }) } } })
    apply(r.ctx, { stateDir: join(scratch, 'loader-present') })
    assert.deepEqual(await offerFor(r, 'conv'), available)
  })

  it('answers per conversation: the loader may be mounted for one agent and not for another', async () => {
    const agents = registry('with', 'without')
    const tools = { get: (_name: string, scope?: object) => (scope === agents.agent('with') ? { name: 'skill' } : undefined) }
    const r = rig({ services: { skills: fakeSkills(), agents, tools } })
    apply(r.ctx, { stateDir: join(scratch, 'loader-per-conversation') })
    assert.deepEqual(await offerFor(r, 'with'), available)
    assert.deepEqual(await offerFor(r, 'without'), unavailable)
  })

  it('is offered, without asking the tools service, for a conversation whose agent DSH has not loaded: it cannot tell which agent to ask about', async () => {
    let asked = 0
    const r = rig({ services: { skills: fakeSkills(), agents: registry(), tools: { get: () => { asked += 1; return undefined } } } })
    apply(r.ctx, { stateDir: join(scratch, 'loader-not-loaded') })
    assert.deepEqual(await offerFor(r, 'not-loaded-yet'), available)
    assert.equal(asked, 0)
  })

  it('is offered when the lookup throws, or when the agents service throws', async () => {
    const throwingTools = rig({ services: { skills: fakeSkills(), agents: registry('conv'), tools: { get: () => { throw new Error('registry disposed') } } } })
    apply(throwingTools.ctx, { stateDir: join(scratch, 'loader-throws') })
    assert.deepEqual(await offerFor(throwingTools, 'conv'), available)
    const throwingAgents = rig({ services: { skills: fakeSkills(), agents: { get: () => { throw new Error('registry disposed') } }, tools: { get: () => undefined } } })
    apply(throwingAgents.ctx, { stateDir: join(scratch, 'loader-agents-throw') })
    assert.deepEqual(await offerFor(throwingAgents, 'conv'), available)
  })

  it('never asks the tools service when the skill is not registered or is switched off: the answer does not depend on it', async () => {
    let asked = 0
    const tools = { get: () => { asked += 1; return {} } }
    const noRegistry = rig({ services: { agents: registry('conv'), tools } })
    apply(noRegistry.ctx, { stateDir: join(scratch, 'loader-no-registry') })
    assert.deepEqual(await offerFor(noRegistry, 'conv'), unavailable)
    const off = rig({ services: { skills: fakeSkills(), agents: registry('conv'), tools } })
    apply(off.ctx, { stateDir: join(scratch, 'loader-off'), skill: false })
    assert.equal(await offerFor(off, 'conv'), undefined)
    assert.equal(asked, 0)
  })

  it('asks again for every answer, so a loader that is mounted later is offered from then on', async () => {
    let mounted = false
    const r = rig({ services: { skills: fakeSkills(), agents: registry('conv'), tools: { get: () => (mounted ? {} : undefined) } } })
    apply(r.ctx, { stateDir: join(scratch, 'loader-later') })
    assert.deepEqual(await offerFor(r, 'conv'), unavailable)
    mounted = true
    assert.deepEqual(await offerFor(r, 'conv'), available)
  })
})

describe('the subagent ledger on the host', () => {
  const stateDir = join(scratch, 'ledger')
  const child = (id: string, parent: string) => ({
    id,
    session: {
      id,
      header: { parentSession: parent },
      requestHeader: () => ({ config: { provider: 'azure-opencode', model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'medium' } }),
    },
    options: { provider: 'openrouter', model: 'z-ai/glm-5.3' },
  })
  const agents = { get: (id: string) => (id.startsWith('child-') ? child(id, 'sess-p') : undefined) }
  const emit = (target: Rig, event: 'subagent/start' | 'subagent/end', info: Record<string, unknown>): void => {
    const listener = target.listeners.get(event) as ((info: unknown) => void) | undefined
    assert.ok(listener, `${event} has no listener`)
    listener(info)
  }
  const records = async (web: { base: string }, session: string): Promise<{ subagents: Record<string, unknown>[] }> => (
    await (await fetch(`${web.base}${SUBAGENTS_ROUTE}?sessionId=${session}`)).json()
  ) as { subagents: Record<string, unknown>[] }

  it('records a child at start and its outcome at end, and serves them on the subagents route', async () => {
    const r = rig({ services: { agents } })
    const disposers = keepDisposers(r)
    apply(r.ctx, { stateDir })
    const web = await serve(r)
    try {
      emit(r, 'subagent/start', { runId: 'r1', provider: 'spawn', id: 'child-1', local: true })
      emit(r, 'subagent/start', { runId: 'r2', provider: 'acp', id: 'remote-1', local: false })
      const running = (await records(web, 'sess-p')).subagents
      assert.equal(running.length, 1, 'a remote child has no session of its own and is not tracked')
      assert.deepEqual(
        { id: running[0]?.['id'], parentId: running[0]?.['parentId'], backend: running[0]?.['backend'], state: running[0]?.['state'], route: running[0]?.['route'] },
        { id: 'child-1', parentId: 'sess-p', backend: 'spawn', state: 'running', route: { provider: 'openrouter', model: 'z-ai/glm-5.3' } },
        'the model the live child was created with',
      )
      emit(r, 'subagent/end', { runId: 'r1', provider: 'spawn', id: 'child-1', local: true, stopReason: 'max-tokens' })
      const ended = (await records(web, 'sess-p')).subagents[0]
      assert.equal(ended?.['state'], 'failed')
      assert.equal(ended?.['stopReason'], 'max-tokens')
      assert.deepEqual(ended?.['route'], { provider: 'azure-opencode', model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'medium' }, 'the route the child actually requested last')
      assert.deepEqual((await records(web, 'someone-else')).subagents, [], 'only the children started under that session')
    } finally {
      web.close()
      for (const dispose of disposers) dispose()
    }
  })

  it('survives a restart, and a child still running when the host died loads as stopped', async () => {
    const dir = join(scratch, 'ledger-restart')
    const first = rig({ services: { agents } })
    const disposers = keepDisposers(first)
    apply(first.ctx, { stateDir: dir })
    emit(first, 'subagent/start', { runId: 'r1', provider: 'spawn', id: 'child-done', local: true })
    emit(first, 'subagent/end', { runId: 'r1', provider: 'spawn', id: 'child-done', local: true, stopReason: 'completed' })
    emit(first, 'subagent/start', { runId: 'r2', provider: 'spawn', id: 'child-live', local: true })
    for (const dispose of disposers) dispose() // unloading writes the pending change

    // What a restart is: the new process started after the child did. Both halves ran in this one process, so age the child.
    const file = join(dir, 'subagents.json')
    const written = JSON.parse(readFileSync(file, 'utf8')) as { subagents: Record<string, { startedAt: number }> }
    assert.equal(Object.keys(written.subagents).length, 2, 'unloading wrote both')
    written.subagents['child-live']!.startedAt = 1
    writeFileSync(file, JSON.stringify(written))

    const second = rig()
    apply(second.ctx, { stateDir: dir })
    assert.ok(second.logs.some(line => /tracked subagents: 2\)/.test(line)), second.logs.join(' | '))
    const web = await serve(second)
    try {
      const byId = Object.fromEntries((await records(web, 'sess-p')).subagents.map(record => [String(record['id']), record]))
      assert.equal(byId['child-done']?.['state'], 'done')
      assert.equal(byId['child-live']?.['state'], 'stopped')
      assert.equal(byId['child-live']?.['stopReason'], 'interrupted')
    } finally { web.close() }
  })

  it('keeps a child that is still running when the plugin is loaded again in the same process (a reload, a restart of its fiber), and takes its end', async () => {
    const dir = join(scratch, 'ledger-reload')
    const first = rig({ services: { agents } })
    const disposers = keepDisposers(first)
    apply(first.ctx, { stateDir: dir })
    emit(first, 'subagent/start', { runId: 'r1', provider: 'spawn', id: 'child-live', local: true })
    for (const dispose of disposers) dispose() // the old copy of the plugin is unloaded: it writes what it knows

    const second = rig({ services: { agents } })
    apply(second.ctx, { stateDir: dir })
    const web = await serve(second)
    try {
      assert.equal((await records(web, 'sess-p')).subagents[0]?.['state'], 'running', 'the child never stopped: its process is this one')
      emit(second, 'subagent/end', { runId: 'r1', provider: 'spawn', id: 'child-live', local: true, stopReason: 'completed' })
      const ended = (await records(web, 'sess-p')).subagents[0]
      assert.equal(ended?.['state'], 'done', 'and when it ends, the new copy of the plugin closes it')
      assert.equal(ended?.['stopReason'], 'completed')
    } finally { web.close() }
  })

  it('records a continuable child whose agent DSH has released before it emits the end: the route read at the start stays, the outcome is recorded', async () => {
    const resident = new Set(['child-1'])
    const releasing = { get: (id: string) => (resident.has(id) ? child(id, 'sess-p') : undefined) }
    const r = rig({ services: { agents: releasing } })
    const disposers = keepDisposers(r)
    apply(r.ctx, { stateDir: join(scratch, 'ledger-continuable') })
    const web = await serve(r)
    try {
      emit(r, 'subagent/start', { runId: 'epoch-1', provider: 'spawn', id: 'child-1', local: true })
      resident.delete('child-1') // a continuable child's handle is disposed, and the agent leaves the registry, before its end is emitted
      emit(r, 'subagent/end', { runId: 'epoch-1', provider: 'spawn', id: 'child-1', local: true, stopReason: 'max-tokens' })
      const [record] = (await records(web, 'sess-p')).subagents
      assert.equal(record?.['state'], 'failed')
      assert.equal(record?.['stopReason'], 'max-tokens')
      assert.deepEqual(record?.['route'], { provider: 'openrouter', model: 'z-ai/glm-5.3' }, 'not refined from the request header (the agent is gone), so the route the epoch started with')
      assert.equal(record?.['parentId'], 'sess-p')
    } finally {
      web.close()
      for (const dispose of disposers) dispose()
    }
  })

  it('does not close a resumed child with the end of its earlier run', async () => {
    const r = rig({ services: { agents } })
    const disposers = keepDisposers(r)
    apply(r.ctx, { stateDir: join(scratch, 'ledger-runs') })
    const web = await serve(r)
    try {
      emit(r, 'subagent/start', { runId: 'epoch-1', provider: 'spawn', id: 'child-1', local: true })
      emit(r, 'subagent/end', { runId: 'epoch-1', provider: 'spawn', id: 'child-1', local: true, stopReason: 'completed' })
      emit(r, 'subagent/start', { runId: 'epoch-2', provider: 'spawn', id: 'child-1', local: true })
      emit(r, 'subagent/end', { runId: 'epoch-1', provider: 'spawn', id: 'child-1', local: true, stopReason: 'error' })
      assert.equal((await records(web, 'sess-p')).subagents[0]?.['state'], 'running')
      emit(r, 'subagent/end', { runId: 'epoch-2', provider: 'spawn', id: 'child-1', local: true, stopReason: 'aborted' })
      assert.equal((await records(web, 'sess-p')).subagents[0]?.['state'], 'stopped')
    } finally {
      web.close()
      for (const dispose of disposers) dispose()
    }
  })

  it('stamps the answer with the host clock, so that the page judges the times of the records against the clock that wrote them', async () => {
    const r = rig({ services: { agents } })
    const disposers = keepDisposers(r)
    apply(r.ctx, { stateDir: join(scratch, 'ledger-clock') })
    const web = await serve(r)
    try {
      const before = Date.now()
      const body = await (await fetch(`${web.base}${SUBAGENTS_ROUTE}?sessionId=sess-p`)).json() as { now?: unknown }
      assert.equal(typeof body.now, 'number')
      assert.ok((body.now as number) >= before && (body.now as number) <= Date.now())
    } finally {
      web.close()
      for (const dispose of disposers) dispose()
    }
  })

  it('does not persist, and still serves, with `persist: false`', async () => {
    const dir = join(scratch, 'ledger-memory')
    const r = rig({ services: { agents } })
    const disposers = keepDisposers(r)
    apply(r.ctx, { stateDir: dir, persist: false })
    emit(r, 'subagent/start', { runId: 'r1', provider: 'spawn', id: 'child-1', local: true })
    for (const dispose of disposers) dispose()
    assert.throws(() => readFileSync(join(dir, 'subagents.json'), 'utf8'), /ENOENT/)
  })

  it('keeps the subagents route behind the trust fence', async () => {
    const r = rig({ fence: 401 })
    apply(r.ctx, { stateDir: join(scratch, 'ledger-fence') })
    const web = await serve(r)
    try {
      const answer = await fetch(`${web.base}${SUBAGENTS_ROUTE}?sessionId=sess-p`)
      assert.equal(answer.status, 401)
      assert.equal(await answer.text(), '')
    } finally { web.close() }
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
