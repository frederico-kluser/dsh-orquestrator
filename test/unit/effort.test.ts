import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { describe, it } from 'node:test'
import { ChoiceUnusableError, assertChoiceUsable, parentOptionsOf, planChild, type ChildPlan, type ChildPolicy } from '../../src/effort.ts'
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

describe('planChild with a picked route that is the parent\'s own route', () => {
  const gemini = { provider: 'openrouter', model: 'google/gemini-3.8-flash' }

  it('sees the effort the child will inherit (DSH clears it only when the route changes), so the ceiling still holds', async () => {
    // The route's own default (low) is within the worker ceiling; the parent runs at high, which the child would inherit.
    const plan = await planChild({
      source: source(catalog), parent: parent({ ...gemini, reasoningEffort: 'high' }), route: gemini, role: 'worker', explicitEffort: undefined, policy, signal, logger,
    })
    assert.equal(plan.options?.reasoningEffort, 'medium')
    assert.equal(plan.effective, 'medium')
  })

  it('leaves it alone when the parent already runs within the ceiling', async () => {
    const plan = await planChild({
      source: source(catalog), parent: parent({ ...gemini, reasoningEffort: 'low' }), route: gemini, role: 'worker', explicitEffort: undefined, policy, signal, logger,
    })
    assert.equal(plan.options?.reasoningEffort, undefined)
  })

  it('caps the token limit the child will inherit from the parent, on the same route and on a changed one (DSH hands the limit down either way)', async () => {
    const roomy = source({ 'openrouter/google/gemini-3.8-flash': { ...catalog['openrouter/google/gemini-3.8-flash'], defaultMaxTokens: 400_000 } })
    const same = await planChild({ source: roomy, parent: parent({ ...gemini, reasoningEffort: 'low', maxTokens: 200_000 }), route: gemini, role: 'worker', explicitEffort: undefined, policy, signal, logger })
    assert.equal(same.options?.maxTokens, 64_000, 'the parent\'s own 200 000 is what the child would run with')
    const changed = await planChild({ source: roomy, parent: parent({ ...SONNET, maxTokens: 200_000 }), route: gemini, role: 'worker', explicitEffort: undefined, policy, signal, logger })
    assert.equal(changed.options?.maxTokens, 64_000, 'and so it is on a changed route: only the effort is cleared there')
    const none = await planChild({ source: roomy, parent: withoutLimit({ ...SONNET }), route: gemini, role: 'worker', explicitEffort: undefined, policy, signal, logger })
    assert.equal(none.options?.maxTokens, 64_000, 'with no limit of its own the child gets the route\'s declared 400 000, capped the same')
  })

  it('still treats a different route as a change: the parent\'s level is cleared and the route default is what counts', async () => {
    const plan = await planChild({
      source: source(catalog), parent: parent({ ...SONNET, reasoningEffort: 'max' }), route: gemini, role: 'worker', explicitEffort: undefined, policy, signal, logger,
    })
    assert.equal(plan.options?.reasoningEffort, undefined, 'the Gemini default (low) is within the ceiling')
  })

  it('treats a route as unchanged only when provider AND model are both the parent\'s: a sibling model, or the same model id on another provider, resolves its own default', async () => {
    const sibling = await planChild({
      source: source(catalog), parent: parent({ ...GLM, reasoningEffort: 'max' }), route: gemini, role: 'worker', explicitEffort: undefined, policy, signal, logger,
    })
    assert.equal(sibling.options?.reasoningEffort, undefined, 'same provider, another model: the parent\'s max is cleared and the Gemini default (low) counts')
    const elsewhere = await planChild({
      source: source(catalog), parent: parent({ provider: 'azure-opencode', model: gemini.model, reasoningEffort: 'max' }), route: gemini, role: 'worker', explicitEffort: undefined, policy, signal, logger,
    })
    assert.equal(elsewhere.options?.reasoningEffort, undefined, 'same model id, another provider')
  })
})

/** The user's real deployment: the route's 128K ceiling is the adapter's default, not a creation option, so the parent carries no limit of its own. */
const withoutLimit = (overrides: Partial<AgentLike['options']> = {}): AgentLike => parent({ maxTokens: undefined, ...overrides })

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
      source: source(catalog), parent: withoutLimit(), route: { provider: 'openrouter', model: 'google/gemini-3.8-flash' }, role: 'worker', explicitEffort: undefined, policy, signal, logger,
    })
    assert.deepEqual(plan.options, { provider: 'openrouter', model: 'google/gemini-3.8-flash' })
    assert.equal(plan.effective, 'low')
  })

  it('gives a route the limit it can honor when the parent\'s own token limit would be handed down to it (DSH inherits it on every route)', async () => {
    // The parent has a 128K creation limit; Gemini allows 32K, so the child would be refused at 128K.
    const plan = await planChild({
      source: source(catalog), parent: parent(), route: { provider: 'openrouter', model: 'google/gemini-3.8-flash' }, role: 'worker', explicitEffort: undefined, policy, signal, logger,
    })
    assert.deepEqual(plan.options, { provider: 'openrouter', model: 'google/gemini-3.8-flash', maxTokens: 32_000 })
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
      source: source(catalog), parent: withoutLimit(), route: { provider: 'openrouter', model: 'plain-model' }, role: 'worker', explicitEffort: 'high', policy, signal, logger,
    })
    assert.deepEqual(plan.options, { provider: 'openrouter', model: 'plain-model' })
    assert.deepEqual(plan.ladder, [])
    assert.ok(logs.some(line => /does not offer reasoning effort "high"/.test(line)))
  })

  it('does not lower an output ceiling that is already below the cap', async () => {
    const small = source({ 'a/b': { reasoning: { ...ladder('low'), defaultEffort: 'low' }, defaultMaxTokens: 8000 } })
    const plan = await planChild({ source: small, parent: withoutLimit(), route: { provider: 'a', model: 'b' }, role: 'worker', explicitEffort: undefined, policy, signal, logger })
    assert.equal(plan.options?.maxTokens, undefined, 'the route\'s own 8000 is what the child gets')
    // A parent with a limit of its own hands it down on every route: the child would run at 128K on an 8K model.
    const inherited = await planChild({ source: small, parent: parent(), route: { provider: 'a', model: 'b' }, role: 'worker', explicitEffort: undefined, policy, signal, logger })
    assert.equal(inherited.options?.maxTokens, 8000, 'never above what the model itself allows')
  })
})

describe('planChild when the model cannot be described or the call is cancelled', () => {
  it('says why in `unresolved` and degrades to the user\'s pick (a model the catalog no longer knows)', async () => {
    logs.length = 0
    const plan = await planChild({
      source: source({}), parent: withoutLimit(), route: { provider: 'azure-opencode', model: 'Retired-Model' }, role: 'worker', explicitEffort: 'high', policy, signal, logger,
    })
    assert.deepEqual(plan.options, { provider: 'azure-opencode', model: 'Retired-Model', reasoningEffort: 'high' })
    assert.match(plan.unresolved ?? '', /no azure-opencode\/Retired-Model/)
    assert.ok(logs.some(line => /cannot describe azure-opencode\/Retired-Model/.test(line)))
  })

  it('has no `unresolved` when nothing went wrong, when the policy is off or when there is no LLM runtime', async () => {
    const ok = await planChild({ source: source(catalog), parent: parent(), route: DEEPSEEK, role: 'worker', explicitEffort: undefined, policy, signal, logger })
    assert.equal(ok.unresolved, undefined)
    const off = await planChild({ source: source({}), parent: parent(), route: DEEPSEEK, role: 'worker', explicitEffort: undefined, policy: { ...policy, enabled: false }, signal, logger })
    assert.equal(off.unresolved, undefined)
    const none = await planChild({ source: undefined, parent: parent(), route: DEEPSEEK, role: 'worker', explicitEffort: undefined, policy, signal, logger })
    assert.equal(none.unresolved, undefined)
  })

  it('does not wait for a lookup that ignores the signal once the caller cancelled, and rejects with an Error whatever the reason was', async () => {
    const controller = new AbortController()
    const stuck: ModelInfoSourceLike = { resolveModelInfo: () => new Promise(() => undefined) }
    const pending = planChild({ source: stuck, parent: parent(), route: DEEPSEEK, role: 'worker', explicitEffort: undefined, policy, signal: controller.signal, logger })
    controller.abort('the workflow was cancelled') // a string reason, as the workflow engine aborts with
    await assert.rejects(pending, (error: unknown) => error instanceof Error && error.message === 'the workflow was cancelled')
  })

  it('rejects at once for a call that is already cancelled, without asking the runtime', async () => {
    const controller = new AbortController()
    controller.abort(new Error('already cancelled'))
    const llm = source(catalog)
    await assert.rejects(planChild({ source: llm, parent: parent(), route: DEEPSEEK, role: 'worker', explicitEffort: undefined, policy, signal: controller.signal, logger }), /already cancelled/)
    assert.deepEqual(llm.asked, [])
  })

  it('leaves no listener on the caller\'s signal, whether the lookup worked or failed: a workflow shares one signal across all its agents', async () => {
    const controller = new AbortController()
    for (let child = 0; child < 12; child += 1) {
      await planChild({ source: source(catalog), parent: parent(), route: DEEPSEEK, role: 'worker', explicitEffort: undefined, policy, signal: controller.signal, logger })
      await planChild({ source: source({}), parent: parent(), route: DEEPSEEK, role: 'worker', explicitEffort: undefined, policy, signal: controller.signal, logger })
    }
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  })

  it('names a cancellation after its reason: the Error itself, a string, or a generic message for anything else', async () => {
    const aborted = (reason: unknown): Promise<unknown> => {
      const controller = new AbortController()
      controller.abort(reason)
      return planChild({ source: source(catalog), parent: parent(), route: DEEPSEEK, role: 'worker', explicitEffort: undefined, policy, signal: controller.signal, logger })
    }
    const original = new Error('the user cancelled')
    await assert.rejects(aborted(original), (error: unknown) => error === original)
    await assert.rejects(aborted('stop'), { message: 'stop' })
    await assert.rejects(aborted(''), { message: 'the call was aborted' })
    await assert.rejects(aborted(42), { message: 'the call was aborted' })
  })
})

describe('assertChoiceUsable: refusing a confirmed route the runtime can no longer call', () => {
  const gone = { provider: 'azure-opencode', model: 'Retired-Model-9' }
  const described = (unresolved?: string): ChildPlan => ({ options: undefined, route: gone, ladder: undefined, effective: undefined, summary: 's', ...unresolved === undefined ? {} : { unresolved } })

  it('lets a route through when its description worked', async () => {
    await assertChoiceUsable(source({}), gone, described(), signal)
  })

  it('refuses a route that failed its description and the check that gates storing a route, with the runtime\'s own reason', async () => {
    const llm = { ...source({}), resolveCallConfig: () => Promise.reject(new Error('pi-ai provider "azure-opencode" has no configured model "Retired-Model-9"')) }
    await assert.rejects(assertChoiceUsable(llm, gone, described('no such model in the catalog'), signal), (error: unknown) => (
      error instanceof ChoiceUnusableError
      && /azure-opencode\/Retired-Model-9 cannot be used \(pi-ai provider "azure-opencode" has no configured model "Retired-Model-9"\)/.test(error.message)
      && /Open \/orquestrar to pick another model, or cancel the dialog/.test(error.message)
    ))
  })

  it('keeps the user\'s pick when only the description failed (an adapter that can call a model it cannot describe)', async () => {
    const asked: unknown[] = []
    const llm = { ...source({}), resolveCallConfig: (config: unknown) => { asked.push(config); return Promise.resolve({}) } }
    await assertChoiceUsable(llm, gone, described('this adapter does not describe models'), signal)
    assert.deepEqual(asked, [{ provider: 'azure-opencode', model: 'Retired-Model-9' }])
  })

  it('takes the failed description as the reason when the runtime has no such check', async () => {
    await assert.rejects(assertChoiceUsable(source({}), gone, described('no azure-opencode/Retired-Model-9'), signal), /cannot be used \(no azure-opencode\/Retired-Model-9\)/)
    await assert.rejects(assertChoiceUsable(undefined, gone, described('route or runtime unknown'), signal), ChoiceUnusableError)
  })

  it('lets a cancellation through instead of refusing the route', async () => {
    const controller = new AbortController()
    const llm = { ...source({}), resolveCallConfig: () => new Promise<never>(() => undefined) }
    const pending = assertChoiceUsable(llm, gone, described('gone'), controller.signal)
    controller.abort('the call was cancelled')
    await assert.rejects(pending, (error: unknown) => error instanceof Error && !(error instanceof ChoiceUnusableError) && error.message === 'the call was cancelled')
  })

  it('is named, so a log line or a rejection says what it is', async () => {
    await assert.rejects(assertChoiceUsable(undefined, gone, described('gone'), signal), { name: 'ChoiceUnusableError' })
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

  it('inherits the effort of the latest request header, not the route\'s default, when the parent changed its level mid-session', async () => {
    const live: AgentLike = {
      ...parent(),
      session: { ...fakeAgent().session, requestHeader: () => ({ config: { provider: SONNET.provider, model: SONNET.model, reasoningEffort: 'low' } }) },
    }
    const plan = await planChild({ source: source(catalog), parent: live, route: null, role: 'worker', explicitEffort: undefined, policy, signal, logger })
    assert.equal(plan.effective, 'low')
    assert.equal(plan.options?.reasoningEffort, undefined, 'already within the ceiling: nothing to override')
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
