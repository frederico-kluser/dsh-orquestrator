/**
 * The start guard against the REAL delegation service of DSH: the built
 * `SubagentRuntime` inside a real Cordis context, the guard installed by one
 * plugin and `start()` called through another plugin's proxy of the service,
 * which is how the workflow engine reaches it. Unit tests with plain doubles
 * cannot show that the proxies see the wrapper; this does.
 *
 * Skipped unless DSH_CHECKOUT points at a checkout whose packages are built
 * (`pnpm run build`), like the source contract suite.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'
import { parsePluginConfig } from '../../src/config.ts'
import { childPolicyOf, planChild } from '../../src/effort.ts'
import { capFor, rankOf } from '../../src/models.ts'
import { installGuard, isGoverned, type GuardDeps } from '../../src/guard.ts'
import type { AgentLike, AgentOptionsLike, ContinuableStartSpecLike, ModelInfoLike, ModelInfoSourceLike, SubagentStartRequestLike, SubagentsLike } from '../../src/host-services.ts'
import { buildConfig } from '../../src/shared.ts'
import { ConfigStore } from '../../src/store.ts'

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

describe('the start guard on the real SubagentRuntime', { skip: skip ? 'set DSH_CHECKOUT to a built DeepSeek Harness checkout' : false }, () => {
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
})
