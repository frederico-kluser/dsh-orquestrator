/**
 * The start guard and the subagent tracker against the REAL delegation service of DSH: the built
 * `SubagentRuntime` inside a real Cordis context, the guard installed by one
 * plugin and `start()` called through another plugin's proxy of the service,
 * which is how the workflow engine reaches it. Unit tests with plain doubles
 * cannot show that the proxies see the wrapper; this does.
 *
 * Skipped unless DSH_CHECKOUT points at a checkout whose packages are built
 * (`pnpm run build`), like the source contract suite.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parsePluginConfig } from '../../src/config.ts'
import { childPolicyOf, planChild } from '../../src/effort.ts'
import { capFor, rankOf } from '../../src/models.ts'
import { installGuard, isGoverned, type GuardDeps } from '../../src/guard.ts'
import type { AgentLike, AgentOptionsLike, ContinuableStartSpecLike, ModelInfoLike, ModelInfoSourceLike, SubagentStartRequestLike, SubagentsLike } from '../../src/host-services.ts'
import * as orquestrator from '../../src/index.ts'
import { CONFIG_ROUTE, SKILL_NAME, buildConfig } from '../../src/shared.ts'
import { ConfigStore } from '../../src/store.ts'
import { SubagentLedger, installSubagentTracker, type TrackerDeps } from '../../src/subagents.ts'

const checkout = process.env['DSH_CHECKOUT']
const libs = checkout === undefined ? undefined : {
  cordis: join(checkout, 'vendor/cordis/lib/index.js'),
  subagent: join(checkout, 'packages/subagent/subagent/lib/index.js'),
  projection: join(checkout, 'packages/session/session-projection/lib/index.js'),
}
const skip = libs === undefined || !Object.values(libs).every(path => existsSync(path))

interface CordisLike {
  plugin(plugin: unknown, config?: unknown): Promise<unknown>
  get(name: string): unknown
  subagents: SubagentsLike & { registerProvider(provider: unknown): () => void }
}

const DEEPSEEK = { provider: 'azure-opencode', model: 'DeepSeek-V4.1-Flash' }
const catalog: Record<string, ModelInfoLike> = {
  'azure-opencode/DeepSeek-V4.1-Flash': { reasoning: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'].map(id => ({ id })), defaultEffort: 'max' }, defaultMaxTokens: 384_000 },
}
const models: ModelInfoSourceLike = {
  resolveModelInfo: (provider, model) => {
    const found = catalog[`${provider}/${model}`]
    return found === undefined ? Promise.reject(new Error('unknown')) : Promise.resolve(found)
  },
}
const parent: AgentLike = {
  id: 'main',
  session: { id: 'main', header: {} },
  options: { provider: 'azure-opencode-claude', model: 'claude-sonnet-5-5', reasoningEffort: 'max' },
}

/** A real runtime in a real context, with a recording provider named `spawn`. */
async function runtime(): Promise<{ ctx: CordisLike; received: { agentOptions?: unknown; descriptor?: unknown }[] }> {
  const { Context } = await import(pathToFileURL((libs as { cordis: string }).cordis).href) as { Context: new () => CordisLike }
  const SubagentRuntime = (await import(pathToFileURL((libs as { subagent: string }).subagent).href) as { default: unknown }).default
  const Registry = (await import(pathToFileURL((libs as { projection: string }).projection).href) as { default: unknown }).default
  const ctx = new Context()
  await ctx.plugin(Registry)
  await ctx.plugin(SubagentRuntime)
  const received: { agentOptions?: unknown; descriptor?: unknown }[] = []
  ctx.subagents.registerProvider({
    name: 'spawn',
    capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: false,
    start: (request: { agentOptions?: unknown; descriptor?: unknown }) => {
      received.push(request)
      return Promise.resolve({ id: 'child-1', localAgent: undefined, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: () => Promise.resolve() })
    },
  })
  return { ctx, received }
}

function deps(subagents: SubagentsLike, overrides: Partial<GuardDeps> = {}): GuardDeps {
  const store = new ConfigStore({ maxSessions: 4 })
  store.set('main', buildConfig({ subagentModel: DEEPSEEK }))
  return {
    subagents, store, defaults: null, parentOf: () => undefined, config: parsePluginConfig(undefined),
    models: () => models, logger: { info: () => undefined, warn: () => undefined }, ...overrides,
  }
}

const startRequest = (): SubagentStartRequestLike => ({ prompt: [{ type: 'text', text: 'hi' }], parent, signal: new AbortController().signal })

describe('the start guard and the subagent tracker on the real SubagentRuntime', { skip: skip ? 'set DSH_CHECKOUT to a built DeepSeek Harness checkout' : false }, () => {
  it('governs start() called by another plugin through its own proxy of the service (the workflow engine path)', async () => {
    const { ctx, received } = await runtime()
    let dispose: (() => void) | undefined
    await ctx.plugin(function orquestrator(pluginCtx: CordisLike) { dispose = installGuard(deps(pluginCtx.get('subagents') as SubagentsLike)) })
    let engine: SubagentsLike | undefined
    await ctx.plugin(function workflowEngine(engineCtx: CordisLike) { engine = engineCtx.get('subagents') as SubagentsLike })
    assert.ok(engine && dispose)

    const run = await engine.start('spawn', startRequest())
    assert.equal(run.id, 'child-1')
    assert.deepEqual(received[0]?.agentOptions, { ...DEEPSEEK, reasoningEffort: 'medium', maxTokens: 64_000 })
    assert.ok(received[0]?.descriptor, 'DSH still resolved the one-shot descriptor around the guard')

    await ctx.subagents.start('spawn', startRequest()) // through the root context as well
    assert.deepEqual(received[1]?.agentOptions, received[0]?.agentOptions)
  })

  it('leaves a session without a choice exactly as DSH starts it, and stands down when the plugin is disposed', async () => {
    const { ctx, received } = await runtime()
    let dispose: (() => void) | undefined
    await ctx.plugin(function orquestrator(pluginCtx: CordisLike) { dispose = installGuard(deps(pluginCtx.get('subagents') as SubagentsLike)) })
    await ctx.subagents.start('spawn', { ...startRequest(), parent: { ...parent, id: 'other', session: { id: 'other', header: {} } } })
    assert.equal(received[0]?.agentOptions, undefined)

    assert.ok(dispose)
    dispose()
    await ctx.subagents.start('spawn', startRequest())
    assert.equal(received[1]?.agentOptions, undefined, 'after the disposer the choice no longer reaches the child')
  })

  it('governs startContinuable() before the continuation manager reads the request', async () => {
    const { ctx } = await runtime()
    const seen: ContinuableStartSpecLike[] = []
    // The real manager needs the agents service; a spy under the guard shows what would reach it.
    const instance = (ctx.get('subagents') as Record<symbol, object>)[Symbol.for('cordis.original')] as Record<string, unknown>
    Object.defineProperty(instance, 'startContinuable', {
      value: (spec: ContinuableStartSpecLike) => { seen.push(spec); return Promise.resolve({ childId: 'c-1', messageId: 'm-1' }) },
      configurable: true, writable: true,
    })
    await ctx.plugin(function orquestrator(pluginCtx: CordisLike) { installGuard(deps(pluginCtx.get('subagents') as SubagentsLike)) })
    let other: SubagentsLike | undefined
    await ctx.plugin(function teams(teamCtx: CordisLike) { other = teamCtx.get('subagents') as SubagentsLike })
    assert.ok(other)
    const spec: ContinuableStartSpecLike = { provider: 'spawn', label: 'a task', request: { prompt: [{ type: 'text', text: 'x' }], parent }, signal: new AbortController().signal }
    await other.startContinuable(spec)
    assert.deepEqual((seen[0]?.request as { agentOptions?: unknown }).agentOptions, { ...DEEPSEEK, reasoningEffort: 'medium', maxTokens: 64_000 })
    assert.equal(seen[0]?.label, 'a task')
  })

  it('plans a child once even when two guards stand in the real doors (the mark is on the copy the guard hands down), the newer configuration winning', async () => {
    const { ctx, received } = await runtime()
    await ctx.plugin(function older(pluginCtx: CordisLike) { installGuard(deps(pluginCtx.get('subagents') as SubagentsLike, { config: parsePluginConfig({ effort: { worker: 'high' } }) })) })
    await ctx.plugin(function newer(pluginCtx: CordisLike) { installGuard(deps(pluginCtx.get('subagents') as SubagentsLike, { config: parsePluginConfig({ effort: { worker: 'low' } }) })) })
    const req = startRequest()
    await ctx.subagents.start('spawn', req)
    assert.deepEqual(received[0]?.agentOptions, { ...DEEPSEEK, reasoningEffort: 'low', maxTokens: 64_000 })
    assert.equal(isGoverned(req), false, 'the caller\'s own request is never marked')
  })

  it('still lets DSH reject what DSH rejects (an unknown provider is the real start\'s error)', async () => {
    const { ctx } = await runtime()
    await ctx.plugin(function orquestrator(pluginCtx: CordisLike) { installGuard(deps(pluginCtx.get('subagents') as SubagentsLike)) })
    await assert.rejects(ctx.subagents.start('nobody', startRequest()), /no subagent provider registered for "nobody"/)
  })

  it('plans a child so that what DSH itself resolves for it stays within the ceilings, whatever the parent already runs on', async () => {
    const { resolveChildAgentOptions } = await import(pathToFileURL((libs as { subagent: string }).subagent).href) as {
      resolveChildAgentOptions: (parent: AgentLike, requested: AgentOptionsLike | undefined, depth: number) => AgentOptionsLike
    }
    const ladder = (...ids: string[]) => ({ efforts: ids.map(id => ({ id })) })
    const described: Record<string, ModelInfoLike> = {
      'azure-opencode-claude/claude-sonnet-5-5': { reasoning: { ...ladder('low', 'medium', 'high', 'xhigh', 'max'), defaultEffort: 'max' }, defaultMaxTokens: 128_000 },
      'azure-opencode/DeepSeek-V4.1-Flash': { reasoning: { ...ladder('off', 'low', 'medium', 'high', 'xhigh', 'max'), defaultEffort: 'max' }, defaultMaxTokens: 384_000 },
      'openrouter/google/gemini-3.8-flash': { reasoning: { ...ladder('low', 'medium', 'high'), defaultEffort: 'low' }, defaultMaxTokens: 32_000 },
      'openrouter/z-ai/glm-5.3': { reasoning: { ...ladder('low', 'high', 'max'), defaultEffort: 'max' }, defaultMaxTokens: 943_717 },
    }
    const source: ModelInfoSourceLike = { resolveModelInfo: (provider, model) => Promise.resolve(described[`${provider}/${model}`] as ModelInfoLike) }
    const SONNET = { provider: 'azure-opencode-claude', model: 'claude-sonnet-5-5' }
    const GEMINI = { provider: 'openrouter', model: 'google/gemini-3.8-flash' }
    const GLM = { provider: 'openrouter', model: 'z-ai/glm-5.3' } // same provider as Gemini: a sibling model is a CHANGED route
    // A parent that already ran a request (so its header owns route and effort), with or without a token limit of its own.
    const on = (route: { provider: string; model: string }, reasoningEffort: string, maxTokens?: number): AgentLike => ({
      id: 'p',
      session: { id: 'p', header: {}, requestHeader: () => ({ config: { ...route, reasoningEffort } }) },
      options: { ...route, reasoningEffort, ...maxTokens === undefined ? {} : { maxTokens } },
    })
    const policy = childPolicyOf(parsePluginConfig(undefined))
    const logger = { info: () => undefined, warn: () => undefined }
    for (const who of [on(SONNET, 'max', 128_000), on(SONNET, 'max'), on(DEEPSEEK, 'high', 128_000), on(GEMINI, 'high', 200_000), on(GEMINI, 'low', 8_000), on(GLM, 'max')]) {
      for (const route of [null, DEEPSEEK, GEMINI]) {
        const plan = await planChild({ source, parent: who, route, explicitEffort: undefined, policy, signal: new AbortController().signal, logger })
        const child = resolveChildAgentOptions(who, plan.options, 1) // what DSH would really create
        const found = described[`${child.provider}/${child.model}`] as ModelInfoLike
        const where = `${who.options.model} at ${who.options.reasoningEffort}, ${who.options.maxTokens ?? 'no'} limit -> ${route?.model ?? 'its own route'}`
        const effort = child.reasoningEffort ?? found.reasoning?.defaultEffort
        assert.ok(rankOf(effort ?? 'off') <= rankOf(capFor(child as { provider: string; model: string })), `${where}: the child thinks at ${String(effort)}`)
        assert.ok((child.maxTokens ?? found.defaultMaxTokens ?? 0) <= (policy.maxTokens ?? Infinity), `${where}: the child may write ${String(child.maxTokens)} tokens`)
      }
    }
  })
  it('feeds the subagent ledger from the REAL lifecycle events: a plugin\'s listener sees the start and the end of a one-shot child, whoever delegated', async () => {
    const { ctx } = await runtime()
    const outcomes: { stopReason: string }[] = [{ stopReason: 'completed' }, { stopReason: 'max-tokens' }, { stopReason: 'aborted' }]
    let started = 0
    // A provider whose children are in-process (`localAgent` present), like `spawn` and `fork`: only those are tracked.
    ctx.subagents.registerProvider({
      name: 'local',
      capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
      start: () => {
        const index = started
        started += 1
        return Promise.resolve({ id: `child-${String(index)}`, localAgent: {}, result: Promise.resolve({ output: [], ...outcomes[index] }), dispose: () => Promise.resolve() })
      },
    })
    const ledger = new SubagentLedger()
    const warnings: string[] = []
    const agents = { get: (id: string): AgentLike | undefined => (id.startsWith('child-')
      ? { id, session: { id, header: { parentSession: 'main' } }, options: { provider: 'azure-opencode', model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'medium' } }
      : undefined) }
    let stop: (() => void) | undefined
    await ctx.plugin(function orquestrator(pluginCtx: CordisLike) {
      stop = installSubagentTracker({ ctx: pluginCtx as unknown as TrackerDeps['ctx'], agents: () => agents, ledger, logger: { warn: (message: string) => warnings.push(message) } })
    })
    assert.ok(stop)

    // Through the root context, and through another plugin's own proxy of the service (the workflow engine path).
    await (await ctx.subagents.start('local', startRequest())).result
    let engine: SubagentsLike | undefined
    await ctx.plugin(function workflowEngine(engineCtx: CordisLike) { engine = engineCtx.get('subagents') as SubagentsLike })
    assert.ok(engine)
    await (await engine.start('local', startRequest())).result
    await (await ctx.subagents.start('local', startRequest())).result
    await new Promise(resolve => setImmediate(resolve)) // the end event is emitted from the result's continuation

    assert.deepEqual(warnings, [])
    assert.deepEqual(ledger.descendantsOf('main').map(record => [record.id, record.backend, record.state, record.stopReason, record.parentId]), [
      ['child-0', 'local', 'done', 'completed', 'main'],
      ['child-1', 'local', 'failed', 'max-tokens', 'main'],
      ['child-2', 'local', 'stopped', 'aborted', 'main'],
    ])
    assert.deepEqual(ledger.get('child-0')?.route, { provider: 'azure-opencode', model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'medium' }, 'the route the live child was created with')

    // A child on a remote backend (no agent of its own) is not tracked.
    ctx.subagents.registerProvider({
      name: 'remote',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: () => Promise.resolve({ id: 'remote-1', localAgent: undefined, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: () => Promise.resolve() }),
    })
    await (await ctx.subagents.start('remote', startRequest())).result
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(ledger.get('remote-1'), undefined)

    stop()
    await (await ctx.subagents.start('local', startRequest())).result.catch(() => undefined)
    assert.equal(ledger.size, 3, 'after the disposer the listeners are gone')
  })
})


// ---------------------------------------------------------------------------------------------------------------------
// The plugin on a REAL agent loop: real SubagentRuntime, real persistence, real AgentLoop, and a scripted model. What the
// tests above show with doubles for the children, these show with children DSH itself runs.
// ---------------------------------------------------------------------------------------------------------------------

/** The built packages the cases below need beyond the ones above (an agent loop, persistence, a spawn backend, the skill registry and loader). */
const endToEndPaths = [
  'packages/test-support/agent-loop-testkit/lib/index.js',
  'packages/core/agent-loop/lib/index.js',
  'packages/session/session-persistence-jsonl/lib/index.js',
  'packages/subagent/subagent-spawn-in-process/lib/index.js',
  'packages/core/session/lib/index.js',
  'packages/session-query/session-query/lib/index.js',
  'packages/llm/llm/lib/index.js',
  'packages/skill/skill/lib/index.js',
  'packages/skill/tool-skill/lib/index.js',
]
const skipEndToEnd = skip || !endToEndPaths.every(path => existsSync(join(checkout as string, path)))

/** What the cases read of a real agent. */
interface RealAgent {
  readonly ctx: { plugin(plugin: unknown, config?: unknown): Promise<unknown> }
  followup(message: unknown): unknown
  whenIdle(): Promise<void>
}

/** What the cases read of a real Cordis context. */
interface RealContext {
  plugin(plugin: unknown, config?: unknown): Promise<unknown>
  provide(name: string, value: unknown): void
  on(event: string, listener: (...args: never[]) => unknown): () => void
  get(name: string): unknown
  readonly fiber: { dispose(): Promise<void> }
  readonly agents: { get(id: string): unknown }
  readonly agentLoop: { create(id: unknown, options: Record<string, unknown>): Promise<RealAgent> }
  readonly llm: { registerAdapter(providers: string[], adapter: unknown): () => void }
  readonly subagents: {
    startContinuable(spec: unknown): Promise<{ childId: string }>
    sendMessage(parent: unknown, childId: string, content: unknown[], options: { signal: AbortSignal }): Promise<unknown>
  }
}

type RouteHandler = (req: unknown, res: unknown) => unknown

/** A real context with the real services of a conversation that delegates, and one scripted model. */
interface World {
  readonly ctx: RealContext
  readonly parent: RealAgent
  /** Every request the scripted model received. */
  readonly requests: { readonly messages: readonly { readonly content?: readonly { readonly text?: string }[] }[] }[]
  /** The routes a plugin registered on the fake web server. */
  readonly routes: Map<string, RouteHandler>
  readonly toolSkill: unknown
  userMessage(text: string): unknown
  close(): Promise<void>
}

/** A model reply of one text block that ends the turn (`finish: 'stop'`). */
const reply = (words: string): unknown[] => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: words },
  { type: 'block-end', index: 0, block: { type: 'text', text: words } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: words.length } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** A model reply that is cut off at the output-token ceiling (`finish: 'max-tokens'`). */
const cutOff = (words: string): unknown[] => [...reply(words).slice(0, 4), { type: 'finish', reason: { kind: 'max-tokens' } }]

async function world(options: {
  /** One entry per model request, in order. */
  readonly script: readonly (readonly unknown[])[]
  /** Park the conversation's own agent, so that what a child reports back never starts a turn that would eat the script. */
  readonly park?: boolean
  /** Mount DSH's skill registry, and (with `global`) its loader for every agent. */
  readonly skills?: 'registry' | 'global'
  /** The id of the conversation's agent. */
  readonly id?: string
}): Promise<World> {
  const load = (relative: string): Promise<Record<string, unknown>> => import(pathToFileURL(join(checkout as string, relative)).href) as Promise<Record<string, unknown>>
  const { Context } = await load('vendor/cordis/lib/index.js') as { Context: new () => RealContext }
  const testkit = await load('packages/test-support/agent-loop-testkit/lib/index.js') as { mountAgentLoopTestDependencies(ctx: RealContext): Promise<void> }
  const llm = await load('packages/llm/llm/lib/index.js') as { LlmAdapter: new () => object; createUserMessage(input: unknown): unknown }
  const session = await load('packages/core/session/lib/index.js') as { SessionId(id: string): unknown }
  const SessionQueryEngine = (await load('packages/session-query/session-query/lib/index.js'))['default'] as new () => object
  const toolSkill = await load('packages/skill/tool-skill/lib/index.js')

  // The scripted model: each request consumes the next entry and is recorded.
  const requests: World['requests'] = []
  const script = options.script.map(entry => [...entry])
  class Scripted extends llm.LlmAdapter {
    resolveModel(provider: string, model: string): Promise<unknown> {
      return Promise.resolve({ provider, id: model, name: model })
    }

    async *stream(request: World['requests'][number]): AsyncIterable<unknown> {
      requests.push(request)
      const next = script.shift()
      if (next === undefined) throw new Error('the scripted model has no reply left')
      yield* next
    }
  }
  // DSH's own tests use the same stand-in: a session query whose search faces are not configured.
  class SessionQuery extends SessionQueryEngine {
    searchSessions(): Promise<never> { return Promise.reject(new Error('session search is not configured in this test')) }
    searchEvents(): Promise<never> { return Promise.reject(new Error('event search is not configured in this test')) }
  }

  const ctx = new Context()
  const root = mkdtempSync(join(tmpdir(), 'orq-real-'))
  await testkit.mountAgentLoopTestDependencies(ctx)
  await ctx.plugin((await load('packages/session/session-persistence-jsonl/lib/index.js'))['default'], { root })
  await ctx.plugin((await load('packages/core/agent-loop/lib/index.js'))['default'], { agents: [] })
  await ctx.plugin(SessionQuery)
  await ctx.plugin(await load('packages/subagent/subagent/lib/index.js').then(lib => lib['default']), {})
  await ctx.plugin(await load('packages/subagent/subagent-spawn-in-process/lib/index.js'), { providerName: 'spawn' })
  if (options.skills !== undefined) await ctx.plugin((await load('packages/skill/skill/lib/index.js'))['default'])
  if (options.skills === 'global') await ctx.plugin(toolSkill)
  // A web server and a trust fence the plugin can register its routes on, which is what the browser would reach them through.
  const routes = new Map<string, RouteHandler>()
  await ctx.plugin({
    name: 'fake-web',
    apply(scope: RealContext) {
      scope.provide('webServer', { register: (route: { path: string; handler: RouteHandler }) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } })
      scope.provide('connection', { requestRejection: () => undefined })
    },
  })
  ctx.llm.registerAdapter(['mock'], new Scripted())
  const parent = await ctx.agentLoop.create(session.SessionId(options.id ?? 'parent'), { provider: 'mock', model: 'mock' })
  if (options.park === true) ctx.on('agent/pre-step', (async ({ agent }: { agent: unknown }, next: () => unknown) => agent === parent ? { kind: 'reject' } : next()) as never)
  return {
    ctx, parent, requests, routes, toolSkill,
    userMessage: text => llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    close: async () => {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** Wait for something a real runtime does in its own time, and say what was awaited when it does not happen. */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}

describe('the subagent tracker on a REAL continuable child (what the standard preset\'s subagent tools start)', { skip: skipEndToEnd ? 'set DSH_CHECKOUT to a built DeepSeek Harness checkout' : false }, () => {
  it('pairs each epoch\'s start and end by runId over three epochs of one child, keeps one record whose start is reset each time, and finds the agent already gone at every end', async () => {
    const w = await world({ script: [reply('first answer'), cutOff('cut off'), reply('third answer')], park: true })
    try {
      let tick = 1000
      const ledger = new SubagentLedger({ now: () => (tick += 1) })
      const warnings: string[] = []
      await w.ctx.plugin(function tracker(scope: RealContext) {
        installSubagentTracker({ ctx: scope as unknown as TrackerDeps['ctx'], agents: () => scope.get('agents') as TrackerDeps['agents'] extends () => infer R ? R : never, ledger, logger: { warn: message => warnings.push(message) } })
      })
      // What the world looks like from a plain listener at each edge, next to what the tracker recorded.
      const wire: { event: 'start' | 'end'; runId: string; id: string; provider: string; local: boolean; stopReason?: string; agentResolvable: boolean }[] = []
      w.ctx.on('subagent/start', ((info: { runId: string; id: string; provider: string; local: boolean }) => {
        wire.push({ event: 'start', runId: info.runId, id: info.id, provider: info.provider, local: info.local, agentResolvable: w.ctx.agents.get(info.id) !== undefined })
      }) as never)
      w.ctx.on('subagent/end', ((info: { runId: string; id: string; provider: string; local: boolean; stopReason: string }) => {
        wire.push({ event: 'end', runId: info.runId, id: info.id, provider: info.provider, local: info.local, stopReason: info.stopReason, agentResolvable: w.ctx.agents.get(info.id) !== undefined })
      }) as never)
      const ends = (): number => wire.filter(edge => edge.event === 'end').length
      const signal = new AbortController().signal

      const started = await w.ctx.subagents.startContinuable({ provider: 'spawn', label: 'child task', request: { prompt: [{ type: 'text', text: 'child task' }], parent: w.parent }, signal })
      await until(() => ends() === 1, 'the first epoch to end')
      const first = ledger.get(started.childId)
      await w.ctx.subagents.sendMessage(w.parent, started.childId, [{ type: 'text', text: 'again' }], { signal }) // the child was released: a cold resume
      await until(() => ends() === 2, 'the second epoch to end')
      const second = ledger.get(started.childId)
      await w.ctx.subagents.sendMessage(w.parent, started.childId, [{ type: 'text', text: 'and again' }], { signal })
      await until(() => ends() === 3, 'the third epoch to end')
      const third = ledger.get(started.childId)

      assert.deepEqual(wire.map(edge => edge.event), ['start', 'end', 'start', 'end', 'start', 'end'])
      const runs = [wire[0], wire[2], wire[4]].map(edge => edge?.runId)
      assert.equal(new Set(runs).size, 3, 'every epoch is a run of its own')
      assert.deepEqual([wire[1]?.runId, wire[3]?.runId, wire[5]?.runId], runs, 'and each end carries the runId of the start before it')
      assert.deepEqual(wire.map(edge => [edge.id, edge.provider, edge.local]), Array.from({ length: 6 }, () => [started.childId, 'spawn', true]))
      assert.deepEqual(wire.map(edge => edge.stopReason), [undefined, 'completed', undefined, 'max-tokens', undefined, 'completed'])
      // The limit the ledger documents: a continuable child is released before its end is emitted, so the end cannot read the agent.
      assert.deepEqual(wire.map(edge => edge.agentResolvable), [true, false, true, false, true, false])

      assert.deepEqual(warnings, [])
      assert.equal(ledger.size, 1, 'one child, one record, however many epochs')
      const route = { provider: 'mock', model: 'mock' }
      // The clock ticks once per start and once per end: exact times show that no edge was seen twice or lost.
      assert.deepEqual(first, { id: started.childId, parentId: 'parent', backend: 'spawn', route, state: 'done', stopReason: 'completed', startedAt: 1001, endedAt: 1002 })
      assert.deepEqual(second, { id: started.childId, parentId: 'parent', backend: 'spawn', route, state: 'failed', stopReason: 'max-tokens', startedAt: 1003, endedAt: 1004 })
      assert.deepEqual(third, { id: started.childId, parentId: 'parent', backend: 'spawn', route, state: 'done', stopReason: 'completed', startedAt: 1005, endedAt: 1006 })
      assert.deepEqual(ledger.descendantsOf('parent').map(record => record.id), [started.childId])
    } finally {
      await w.close()
    }
  })
})

/** The body of the skill file: what follows its frontmatter, as `scripts/gen-skill.mjs` embeds it (no leading blank lines, no trailing whitespace). */
function skillBody(): string {
  const text = readFileSync(fileURLToPath(new URL('../../skills/orchestrate-subagents/SKILL.md', import.meta.url)), 'utf8').replaceAll('\r\n', '\n')
  const frontmatter = /^---\n[\s\S]*?\n---\n/.exec(text)
  assert.ok(frontmatter, 'the skill file starts with its frontmatter')
  return text.slice(frontmatter[0].length).replace(/^\n+/, '').trimEnd()
}

/** What a request to the model carried, flattened to the text of its messages. */
const messagesOf = (request: World['requests'][number] | undefined): string[] => (request?.messages ?? []).map(message => (message.content ?? []).map(block => block.text ?? '').join(''))

describe('the global skill on the REAL skill registry and loader, with the plugin\'s own apply()', { skip: skipEndToEnd ? 'set DSH_CHECKOUT to a built DeepSeek Harness checkout' : false }, () => {
  const TOKEN = `please refactor module X\n/${SKILL_NAME}`

  /** Mount the plugin the way DSH does, and ask the configuration route what it would tell the page about a conversation. */
  async function mount(w: World, config: Record<string, unknown> = {}): Promise<(sessionId: string) => Promise<unknown>> {
    await w.ctx.plugin({ name: orquestrator.name, inject: orquestrator.inject, apply: orquestrator.apply }, { persist: false, ...config })
    return async (sessionId) => {
      const handler = w.routes.get(CONFIG_ROUTE)
      assert.ok(handler, 'the plugin registered its configuration route')
      const answer = { body: '', setHeader: () => undefined, end(body?: string) { this.body = body ?? '' } }
      await handler({ method: 'GET', url: `${CONFIG_ROUTE}?sessionId=${sessionId}`, headers: {} }, answer)
      return (JSON.parse(answer.body) as { skill?: unknown }).skill
    }
  }

  /** Send a message the way the web client does, wait for the turn, and return what the model was shown. */
  async function send(w: World, text: string): Promise<string[]> {
    const before = w.requests.length
    w.parent.followup(w.userMessage(text))
    await w.parent.whenIdle()
    assert.equal(w.requests.length, before + 1, 'the message made one model request')
    return messagesOf(w.requests.at(-1))
  }

  const injectedBlock = (messages: readonly string[]): string | undefined => messages.find(message => message.startsWith(`<skill_content name="${SKILL_NAME}">`))
  const catalogLists = (messages: readonly string[]): boolean => messages.some(message => message.includes(`- \`${SKILL_NAME}\`:`))

  it('makes DSH inject the whole body of the skill file for a message that ends with the token, and lists the skill in the model\'s catalog', async () => {
    const w = await world({ script: [reply('ok')], skills: 'global', id: 'main' })
    try {
      const offer = await mount(w)
      const messages = await send(w, TOKEN)
      const block = injectedBlock(messages)
      assert.ok(block, 'DSH injected the skill\'s instructions')
      assert.ok(block.includes(`<skill_instructions>\n${skillBody()}\n</skill_instructions>`), 'the whole body of skills/orchestrate-subagents/SKILL.md, verbatim')
      assert.equal(catalogLists(messages), true, 'the model\'s catalog lists it')
      assert.deepEqual(await offer('main'), { name: SKILL_NAME, available: true })
    } finally {
      await w.close()
    }
  })

  it('with `modelInvocable: false` the token still loads the skill and the model\'s catalog does not list it', async () => {
    const w = await world({ script: [reply('ok')], skills: 'global', id: 'main' })
    try {
      await mount(w, { skill: { modelInvocable: false } })
      const messages = await send(w, TOKEN)
      assert.ok(injectedBlock(messages)?.includes(`<skill_instructions>\n${skillBody()}\n</skill_instructions>`))
      assert.equal(catalogLists(messages), false)
    } finally {
      await w.close()
    }
  })

  it('does nothing for a message that merely mentions the skill, and nothing for a token that is not at the start of a word', async () => {
    const w = await world({ script: [reply('ok'), reply('ok')], skills: 'global', id: 'main' })
    try {
      await mount(w)
      assert.equal(injectedBlock(await send(w, `tell me about ${SKILL_NAME} please`)), undefined)
      assert.equal(injectedBlock(await send(w, `see/${SKILL_NAME}`)), undefined)
    } finally {
      await w.close()
    }
  })

  it('without DSH\'s loader nothing expands the token, and the host says the skill is not available for that conversation', async () => {
    const w = await world({ script: [reply('ok')], skills: 'registry', id: 'main' })
    try {
      const offer = await mount(w)
      const messages = await send(w, TOKEN)
      assert.equal(injectedBlock(messages), undefined, 'the registry alone holds the skill: no loader, no injection')
      assert.equal(catalogLists(messages), false)
      assert.deepEqual(await offer('main'), { name: SKILL_NAME, available: false }, 'so the dialog does not offer a token that does nothing')
      assert.deepEqual(await offer('nobody'), { name: SKILL_NAME, available: true }, 'a conversation DSH has not loaded cannot be asked: the offer stays, fail-open')
    } finally {
      await w.close()
    }
  })

  it('finds the loader a preset mounts in the agent\'s own scope (the web profile\'s way) only when it asks about that agent: why the offer is per conversation', async () => {
    const w = await world({ script: [reply('ok')], skills: 'registry', id: 'main' })
    try {
      await w.parent.ctx.plugin(w.toolSkill) // in the agent's scope, not for everyone
      const tools = w.ctx.get('tools') as { get(name: string, scope?: object): unknown }
      assert.equal(tools.get('skill'), undefined, 'a lookup without the agent finds nothing, though this agent has the loader')
      assert.notEqual(tools.get('skill', w.ctx.agents.get('main') as object), undefined)
      const offer = await mount(w)
      assert.deepEqual(await offer('main'), { name: SKILL_NAME, available: true }, 'the plugin asks about the conversation\'s own agent')
      const messages = await send(w, TOKEN)
      assert.ok(injectedBlock(messages)?.includes(`<skill_instructions>\n${skillBody()}\n</skill_instructions>`), 'and the token does expand there')
    } finally {
      await w.close()
    }
  })

  it('offers nothing at all, and registers nothing, with `skill: false`', async () => {
    const w = await world({ script: [reply('ok')], skills: 'global', id: 'main' })
    try {
      const offer = await mount(w, { skill: false })
      assert.equal(await offer('main'), undefined)
      assert.equal(catalogLists(await send(w, 'hello')), false, 'the model\'s catalog has no such skill either')
    } finally {
      await w.close()
    }
  })
})
