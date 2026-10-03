import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parentOptionsOf, planChild, type ChildPolicy } from '../../src/effort.ts'
import type { AgentLike, ModelInfoLike, ModelInfoSourceLike } from '../../src/host-services.ts'
import { fakeAgent } from '../helpers.ts'

const ladder = (...ids: string[]): { efforts: { id: string }[] } => ({ efforts: ids.map(id => ({ id })) })

/** A model catalog by `provider/model`. */
function source(catalog: Record<string, ModelInfoLike | Error>): ModelInfoSourceLike & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    resolveModelInfo(provider, model) {
      asked.push(`${provider}/${model}`)
      const found = catalog[`${provider}/${model}`]
      if (found === undefined) return Promise.reject(new Error(`no ${provider}/${model}`))
      return found instanceof Error ? Promise.reject(found) : Promise.resolve(found)
    },
  }
}

const logs: string[] = []
const logger = { info: (message: string) => logs.push(`info:${message}`), warn: (message: string) => logs.push(`warn:${message}`) }
const signal = new AbortController().signal
const policy: ChildPolicy = { enabled: true, caps: {}, maxTokens: { worker: 64_000, reviewer: 32_000 } }

const DEEPSEEK = { provider: 'azure-opencode', model: 'DeepSeek-V4.1-Flash' }
const SONNET = { provider: 'azure-opencode-claude', model: 'claude-sonnet-5-5' }
const GLM = { provider: 'openrouter', model: 'z-ai/glm-5.3' }
const catalog = {
  'azure-opencode/DeepSeek-V4.1-Flash': { reasoning: { ...ladder('off', 'low', 'medium', 'high', 'xhigh', 'max'), defaultEffort: 'max' }, defaultMaxTokens: 384_000 },
  'azure-opencode-claude/claude-sonnet-5-5': { reasoning: { ...ladder('low', 'medium', 'high', 'xhigh', 'max'), defaultEffort: 'max' }, defaultMaxTokens: 128_000 },
  'openrouter/z-ai/glm-5.3': { reasoning: { ...ladder('low', 'high', 'max'), defaultEffort: 'max' }, defaultMaxTokens: 943_717 },
  'openrouter/plain-model': { defaultMaxTokens: 8000 },
  'openrouter/google/gemini-3.8-flash': { reasoning: { ...ladder('low', 'medium', 'high'), defaultEffort: 'low' }, defaultMaxTokens: 32_000 },
} satisfies Record<string, ModelInfoLike>

/** A parent on Sonnet at max with a 128K ceiling, as in the user's settings. */
function parent(overrides: Partial<AgentLike['options']> = {}): AgentLike {
  return { ...fakeAgent(), options: { ...SONNET, reasoningEffort: 'max', maxTokens: 128_000, ...overrides } }
}

describe('planChild with a picked route', () => {
  it('caps a worker that would think at max, and its output ceiling', async () => {
    const llm = source(catalog)
    const plan = await planChild({ source: llm, parent: parent(), route: DEEPSEEK, role: 'worker', explicitEffort: undefined, policy, signal, logger })
    assert.deepEqual(plan.options, { provider: 'azure-opencode', model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'medium', maxTokens: 64_000 })
    assert.equal(plan.effective, 'medium')
    assert.deepEqual(plan.ladder, ['off', 'low', 'medium', 'high', 'xhigh', 'max'])
    assert.match(plan.summary, /effort medium \(capped, ceiling medium\)/)
  })

  it('gives a DeepSeek Flash reviewer a lower ceiling than the worker, from the model profile', async () => {
    const plan = await planChild({ source: source(catalog), parent: parent(), route: DEEPSEEK, role: 'reviewer', explicitEffort: undefined, policy, signal, logger })
    assert.equal(plan.options?.reasoningEffort, 'low')
    assert.equal(plan.options?.maxTokens, 32_000)
  })

  it('lets a Sonnet reviewer think at high but not at max', async () => {
    const plan = await planChild({ source: source(catalog), parent: parent(), route: SONNET, role: 'reviewer', explicitEffort: undefined, policy, signal, logger })
    assert.equal(plan.options?.reasoningEffort, 'high')
  })

  it('keeps an explicit level, above the ceiling or not', async () => {
    const plan = await planChild({ source: source(catalog), parent: parent(), route: DEEPSEEK, role: 'worker', explicitEffort: 'xhigh', policy, signal, logger })
    assert.equal(plan.options?.reasoningEffort, 'xhigh')
    assert.match(plan.summary, /explicit/)
  })

  it('honors the operator ceiling over the model profile', async () => {
    const plan = await planChild({ source: source(catalog), parent: parent(), route: DEEPSEEK, role: 'reviewer', explicitEffort: undefined, policy: { ...policy, caps: { reviewer: 'high' } }, signal, logger })
    assert.equal(plan.options?.reasoningEffort, 'high')
  })

  it('leaves a route alone when its default is already within the ceiling and its ceiling is already low', async () => {
    const plan = await planChild({
      source: source(catalog), parent: parent(), route: { provider: 'openrouter', model: 'google/gemini-3.8-flash' }, role: 'worker', explicitEffort: undefined, policy, signal, logger,
    })
    assert.deepEqual(plan.options, { provider: 'openrouter', model: 'google/gemini-3.8-flash' })
    assert.equal(plan.effective, 'low')
  })

  it('walks a ladder that skips rungs (GLM offers low, high, max)', async () => {
    const plan = await planChild({ source: source(catalog), parent: parent(), route: GLM, role: 'worker', explicitEffort: undefined, policy, signal, logger })
    assert.equal(plan.options?.reasoningEffort, 'high') // the GLM profile allows the worker up to high
    const reviewer = await planChild({ source: source(catalog), parent: parent(), route: GLM, role: 'reviewer', explicitEffort: undefined, policy, signal, logger })
    assert.equal(reviewer.options?.reasoningEffort, 'low')
  })

  it('sends no effort to a model without reasoning levels, and drops an explicit one with a warning', async () => {
    logs.length = 0
    const plan = await planChild({
      source: source(catalog), parent: parent(), route: { provider: 'openrouter', model: 'plain-model' }, role: 'worker', explicitEffort: 'high', policy, signal, logger,
    })
    assert.deepEqual(plan.options, { provider: 'openrouter', model: 'plain-model' })
    assert.deepEqual(plan.ladder, [])
    assert.ok(logs.some(line => /does not offer reasoning effort "high"/.test(line)))
  })

  it('does not lower an output ceiling that is already below the cap', async () => {
    const plan = await planChild({
      source: source({ 'a/b': { reasoning: { ...ladder('low'), defaultEffort: 'low' }, defaultMaxTokens: 8000 } }),
      parent: parent(), route: { provider: 'a', model: 'b' }, role: 'worker', explicitEffort: undefined, policy, signal, logger,
    })
    assert.equal(plan.options?.maxTokens, undefined)
  })
})

describe('planChild inheriting the parent route', () => {
  it('lowers the parent\'s level only when it is above the ceiling, and keeps provider and model out of the options', async () => {
    const plan = await planChild({ source: source(catalog), parent: parent(), route: null, role: 'worker', explicitEffort: undefined, policy, signal, logger })
    assert.deepEqual(plan.options, { reasoningEffort: 'high', maxTokens: 64_000 }) // Sonnet's profile ceiling for a worker is high
    assert.deepEqual(plan.route, SONNET)
  })

  it('inherits untouched when the parent already runs within the ceiling', async () => {
    const plan = await planChild({
      source: source(catalog), parent: parent({ reasoningEffort: 'medium', maxTokens: 16_000 }), route: null, role: 'worker', explicitEffort: undefined, policy, signal, logger,
    })
    assert.equal(plan.options, undefined)
    assert.equal(plan.effective, 'medium')
  })

  it('reads the live route from the request header, as DSH does', async () => {
    const live: AgentLike = {
      ...parent(),
      session: { ...fakeAgent().session, requestHeader: () => ({ config: { provider: DEEPSEEK.provider, model: DEEPSEEK.model, reasoningEffort: 'max' } }) },
    }
    const llm = source(catalog)
    const plan = await planChild({ source: llm, parent: live, route: null, role: 'reviewer', explicitEffort: undefined, policy, signal, logger })
    assert.deepEqual(llm.asked, ['azure-opencode/DeepSeek-V4.1-Flash'])
    assert.equal(plan.options?.reasoningEffort, 'low')
  })

  it('uses the explicit level for an inherited route too', async () => {
    const plan = await planChild({ source: source(catalog), parent: parent(), route: null, role: 'worker', explicitEffort: 'low', policy, signal, logger })
    assert.equal(plan.options?.reasoningEffort, 'low')
  })
})

describe('planChild degrades to what the user picked', () => {
  it('with the policy off', async () => {
    const llm = source(catalog)
    const plan = await planChild({ source: llm, parent: parent(), route: { ...DEEPSEEK, reasoningEffort: 'max' }, role: 'worker', explicitEffort: 'max', policy: { ...policy, enabled: false }, signal, logger })
    assert.deepEqual(plan.options, { provider: 'azure-opencode', model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'max' })
    assert.deepEqual(llm.asked, [])
    assert.equal(plan.ladder, undefined)
  })

  it('without an LLM runtime, with nothing to say', async () => {
    assert.equal((await planChild({ source: undefined, parent: parent(), route: null, role: 'worker', explicitEffort: undefined, policy, signal, logger })).options, undefined)
    const picked = await planChild({ source: undefined, parent: parent(), route: DEEPSEEK, role: 'worker', explicitEffort: undefined, policy, signal, logger })
    assert.deepEqual(picked.options, { provider: 'azure-opencode', model: 'DeepSeek-V4.1-Flash' })
  })

  it('when the model cannot be described', async () => {
    logs.length = 0
    const plan = await planChild({ source: source({}), parent: parent(), route: DEEPSEEK, role: 'worker', explicitEffort: 'low', policy, signal, logger })
    assert.deepEqual(plan.options, { provider: 'azure-opencode', model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'low' })
    assert.ok(logs.some(line => /cannot describe azure-opencode\/DeepSeek-V4\.1-Flash/.test(line)))
  })

  it('propagates a cancellation that surfaces while the model is being described', async () => {
    const controller = new AbortController()
    const aborting: ModelInfoSourceLike = { resolveModelInfo: () => { controller.abort(new Error('user stop')); return Promise.reject(new Error('aborted')) } }
    await assert.rejects(planChild({ source: aborting, parent: parent(), route: DEEPSEEK, role: 'worker', explicitEffort: undefined, policy, signal: controller.signal, logger }), /user stop/)
  })
})

describe('parentOptionsOf', () => {
  it('falls back to creation options and drops a stale creation effort once a request header exists', () => {
    assert.deepEqual(parentOptionsOf(parent()), { ...SONNET, reasoningEffort: 'max', maxTokens: 128_000 })
    const live: AgentLike = { ...parent(), session: { ...fakeAgent().session, requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } }
    assert.deepEqual(parentOptionsOf(live), { provider: 'p', model: 'm', maxTokens: 128_000 })
  })
})
