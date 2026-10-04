import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parsePluginConfig, type Config } from '../../src/config.ts'
import { ChoiceUnusableError, governedOptions, installGuard, isPlanned, markPlanned, startContinuablePlanned, startPlanned, type GuardDeps } from '../../src/guard.ts'
import type { AgentLike, ModelInfoLike, ModelInfoSourceLike, SubagentStartRequestLike } from '../../src/host-services.ts'
import { OFF_CONFIG, buildConfig, type OrchestratorConfig } from '../../src/shared.ts'
import { ConfigStore } from '../../src/store.ts'
import { FakeSubagents, fakeAgent, textResult } from '../helpers.ts'

const DEEPSEEK = { provider: 'azure-opencode', model: 'DeepSeek-V4.1-Flash' }
const MIMO = { provider: 'openrouter-extra', model: 'xiaomi/mimo-v2.6-pro' }
const ladder = (...ids: string[]): { efforts: { id: string }[] } => ({ efforts: ids.map(id => ({ id })) })

const catalog: Record<string, ModelInfoLike> = {
  'azure-opencode/DeepSeek-V4.1-Flash': { reasoning: { ...ladder('off', 'low', 'medium', 'high', 'xhigh', 'max'), defaultEffort: 'max' }, defaultMaxTokens: 384_000 },
  'azure-opencode-claude/claude-sonnet-5-5': { reasoning: { ...ladder('low', 'medium', 'high', 'xhigh', 'max'), defaultEffort: 'max' }, defaultMaxTokens: 128_000 },
  'openrouter-extra/xiaomi/mimo-v2.6-pro': { reasoning: { ...ladder('low', 'medium', 'high', 'max'), defaultEffort: 'max' }, defaultMaxTokens: 131_072 },
}
const llm: ModelInfoSourceLike = {
  resolveModelInfo(provider, model) {
    const found = catalog[`${provider}/${model}`]
    return found === undefined ? Promise.reject(new Error(`no ${provider}/${model}`)) : Promise.resolve(found)
  },
}

/** The user's main agent: Sonnet 5.5 at max with a 128K ceiling. */
function sonnet(id = 'main'): AgentLike {
  return { ...fakeAgent(id), options: { provider: 'azure-opencode-claude', model: 'claude-sonnet-5-5', reasoningEffort: 'max', maxTokens: 128_000 } }
}

const picked = (over: Partial<Parameters<typeof buildConfig>[0]> = {}): OrchestratorConfig => buildConfig({ subagentModel: DEEPSEEK, reviewerEnabled: false, reviewerModel: null, ...over })

interface RigOptions {
  readonly config?: Config
  /** The choice stored for session `main`; omitted means none. */
  readonly stored?: OrchestratorConfig
  readonly defaults?: OrchestratorConfig | null
  readonly capabilities?: ConstructorParameters<typeof FakeSubagents>[0]['capabilities']
  readonly routeDefaults?: ConstructorParameters<typeof FakeSubagents>[0]['routeDefaults']
  readonly parentOf?: (id: string) => string | undefined
  readonly models?: () => ModelInfoSourceLike | undefined
}

function rig(options: RigOptions = {}) {
  const subagents = new FakeSubagents({
    results: Array.from({ length: 40 }, () => textResult('ok')),
    ...options.capabilities === undefined ? {} : { capabilities: options.capabilities },
    ...options.routeDefaults === undefined ? {} : { routeDefaults: options.routeDefaults },
  })
  const store = new ConfigStore({ maxSessions: 10 })
  if (options.stored !== undefined) store.set('main', options.stored)
  const logs: string[] = []
  const deps: GuardDeps = {
    subagents,
    store,
    defaults: options.defaults ?? null,
    parentOf: options.parentOf ?? (() => undefined),
    config: parsePluginConfig(options.config),
    models: options.models ?? (() => llm),
    logger: { info: message => logs.push(`info:${message}`), warn: message => logs.push(`warn:${message}`) },
  }
  const dispose = installGuard(deps)
  return { subagents, store, logs, deps, dispose }
}

function request(over: Partial<SubagentStartRequestLike> = {}): SubagentStartRequestLike {
  return { prompt: [{ type: 'text', text: 'do it' }], parent: sonnet(), signal: new AbortController().signal, ...over }
}

const lastOptions = (r: ReturnType<typeof rig>) => r.subagents.starts.at(-1)?.request.agentOptions

describe('installGuard', () => {
  it('puts an own start and startContinuable on the service and takes them off with the disposer', async () => {
    const subagents = new FakeSubagents({ results: [textResult('a'), textResult('b')] })
    assert.equal(Object.hasOwn(subagents, 'start'), false)
    const dispose = installGuard({
      subagents, store: new ConfigStore({ maxSessions: 1 }), defaults: null, parentOf: () => undefined,
      config: parsePluginConfig(undefined), models: () => llm, logger: { info: () => undefined, warn: () => undefined },
    })
    assert.equal(Object.hasOwn(subagents, 'start'), true)
    assert.equal(Object.hasOwn(subagents, 'startContinuable'), true)
    await subagents.start('spawn', request())
    dispose()
    dispose() // idempotent
    assert.equal(Object.hasOwn(subagents, 'start'), false)
    assert.equal(Object.hasOwn(subagents, 'startContinuable'), false)
    await subagents.start('spawn', request())
    assert.equal(subagents.starts.length, 2)
  })

  it('fails loud when the service cannot be wrapped, and leaves nothing half wrapped', () => {
    const logger = { info: () => undefined, warn: () => undefined }
    const base = { store: new ConfigStore({ maxSessions: 1 }), defaults: null, parentOf: () => undefined, config: parsePluginConfig(undefined), models: () => llm, logger }
    assert.throws(() => installGuard({ ...base, subagents: {} as never }), /no start\(\) to guard/)
    const originalStart = () => Promise.resolve(undefined)
    const onlyStart = { start: originalStart }
    assert.throws(() => installGuard({ ...base, subagents: onlyStart as never }), /no startContinuable\(\) to guard/)
    assert.equal(onlyStart.start, originalStart, 'the first wrapper was rolled back')
    assert.throws(() => installGuard({ ...base, subagents: Object.freeze(new FakeSubagents({ results: [] })) }), TypeError)
  })

  it('wraps the instance behind a Cordis service proxy, whichever proxy a caller reads it through', async () => {
    const instance = new FakeSubagents({ results: Array.from({ length: 5 }, () => textResult('ok')) })
    const original = Symbol.for('cordis.original')
    const proxyFor = (): FakeSubagents => new Proxy(instance, {
      get: (target, prop, receiver) => (prop === original ? target : Reflect.get(target, prop, receiver)) as unknown,
    })
    const store = new ConfigStore({ maxSessions: 4 })
    store.set('main', picked())
    const dispose = installGuard({
      subagents: proxyFor(), store, defaults: null, parentOf: () => undefined,
      config: parsePluginConfig(undefined), models: () => llm, logger: { info: () => undefined, warn: () => undefined },
    })
    // The "workflow engine" holds its own proxy of the same service.
    await proxyFor().start('spawn', request())
    assert.equal(instance.starts[0]?.request.agentOptions?.model, 'DeepSeek-V4.1-Flash')
    dispose()
    await proxyFor().start('spawn', request())
    assert.equal(instance.starts[1]?.request.agentOptions, undefined)
  })

  it('stays out of the way when stacked guards are removed in any order', async () => {
    const subagents = new FakeSubagents({ results: Array.from({ length: 6 }, () => textResult('ok')) })
    const store = new ConfigStore({ maxSessions: 4 })
    store.set('main', picked())
    const logs: string[] = []
    const deps: GuardDeps = {
      subagents, store, defaults: null, parentOf: () => undefined, config: parsePluginConfig(undefined),
      models: () => llm, logger: { info: message => logs.push(message), warn: message => logs.push(message) },
    }
    const first = installGuard(deps)
    const second = installGuard(deps)
    first() // the older guard goes first: it turns inert in place, the newer one keeps governing
    logs.length = 0
    await subagents.start('spawn', request())
    assert.equal(subagents.starts.at(-1)?.request.agentOptions?.model, 'DeepSeek-V4.1-Flash')
    assert.equal(logs.filter(line => /child of session/.test(line)).length, 1, 'planned once, not twice')
    second()
    await subagents.start('spawn', request())
    assert.equal(subagents.starts.at(-1)?.request.agentOptions, undefined, 'both gone: stock behavior')
  })

  it('keeps the shape of the service property: off Object.keys over a prototype method, enumerable over an own one, and puts back exactly what it found', () => {
    const logger = { info: () => undefined, warn: () => undefined }
    const base = { store: new ConfigStore({ maxSessions: 1 }), defaults: null, parentOf: () => undefined, config: parsePluginConfig(undefined), models: () => llm, logger }
    const klass = new FakeSubagents({ results: [] })
    const keys = Object.keys(klass)
    const disposeClass = installGuard({ ...base, subagents: klass })
    assert.deepEqual(Object.keys(klass), keys, 'a class method stays out of Object.keys and spreads')
    disposeClass()

    const plain = { start: () => Promise.resolve(undefined), startContinuable: () => Promise.resolve(undefined), getProvider: () => undefined }
    const before = Object.getOwnPropertyDescriptors(plain)
    const disposePlain = installGuard({ ...base, subagents: plain as never })
    assert.equal(Object.getOwnPropertyDescriptor(plain, 'start')?.enumerable, true, 'an own enumerable method stays enumerable under the wrapper')
    disposePlain()
    assert.deepEqual(Object.getOwnPropertyDescriptors(plain), before, 'value, writable, enumerable and configurable are all put back')
  })

  it('turns inert in place when something else wrapped the property by plain assignment', async () => {
    const subagents = new FakeSubagents({ results: [textResult('a'), textResult('b')] })
    const store = new ConfigStore({ maxSessions: 4 })
    store.set('main', picked())
    const dispose = installGuard({
      subagents, store, defaults: null, parentOf: () => undefined, config: parsePluginConfig(undefined),
      models: () => llm, logger: { info: () => undefined, warn: () => undefined },
    })
    const guarded = subagents.start.bind(subagents)
    let layers = 0
    subagents.start = (provider, req) => { layers += 1; return guarded(provider, req) } // another plugin wraps over the guard
    dispose()
    await subagents.start('spawn', request())
    assert.equal(layers, 1)
    assert.equal(subagents.starts[0]?.request.agentOptions, undefined, 'the older guard is inert, not governing from underneath')
  })

  it('wraps the instance behind a service proxy and never touches the proxy itself', async () => {
    const instance = new FakeSubagents({ results: Array.from({ length: 3 }, () => textResult('ok')) })
    const refuse = (what: string) => (): never => { throw new Error(`the guard must not ${what} the proxy`) }
    const proxy = new Proxy(instance, {
      get: (target, prop, receiver) => (prop === Symbol.for('cordis.original') ? target : Reflect.get(target, prop, receiver)) as unknown,
      defineProperty: refuse('define a property on'),
      getOwnPropertyDescriptor: refuse('describe a property of'),
      deleteProperty: refuse('delete a property of'),
    })
    const store = new ConfigStore({ maxSessions: 4 })
    store.set('main', picked())
    const dispose = installGuard({
      subagents: proxy, store, defaults: null, parentOf: () => undefined, config: parsePluginConfig(undefined),
      models: () => llm, logger: { info: () => undefined, warn: () => undefined },
    })
    await instance.start('spawn', request())
    assert.equal(instance.starts[0]?.request.agentOptions?.model, 'DeepSeek-V4.1-Flash')
    dispose()
    assert.equal(Object.hasOwn(instance, 'start'), false)

    // A proxy symbol that yields nothing usable means there is no proxy: the service itself is wrapped.
    const bare = new FakeSubagents({ results: [textResult('ok')] })
    Object.defineProperty(bare, Symbol.for('cordis.original'), { value: null })
    installGuard({
      subagents: bare, store, defaults: null, parentOf: () => undefined, config: parsePluginConfig(undefined),
      models: () => llm, logger: { info: () => undefined, warn: () => undefined },
    })
    await bare.start('spawn', request())
    assert.equal(bare.starts[0]?.request.agentOptions?.model, 'DeepSeek-V4.1-Flash')
  })

  it('stays out of the way for continuable starts too when stacked guards are removed in any order', async () => {
    const subagents = new FakeSubagents({ results: [] })
    const store = new ConfigStore({ maxSessions: 4 })
    store.set('main', picked())
    const logs: string[] = []
    const deps: GuardDeps = {
      subagents, store, defaults: null, parentOf: () => undefined, config: parsePluginConfig(undefined),
      models: () => llm, logger: { info: message => logs.push(message), warn: message => logs.push(message) },
    }
    const first = installGuard(deps)
    const second = installGuard(deps)
    first() // the older guard goes first: inert in place
    logs.length = 0
    const spec = () => ({ provider: 'spawn', label: 'a task', request: { prompt: [{ type: 'text', text: 'x' }], parent: sonnet() }, signal: new AbortController().signal })
    await subagents.startContinuable(spec())
    assert.equal(logs.filter(line => /child of session/.test(line)).length, 1, 'planned once, not twice')
    second()
    await subagents.startContinuable(spec())
    assert.equal((subagents.continuables.at(-1)?.request as { agentOptions?: unknown }).agentOptions, undefined, 'both gone: stock behavior')
  })

  it('refuses a start that is not callable the way it refuses a missing one', () => {
    const base = { store: new ConfigStore({ maxSessions: 1 }), defaults: null, parentOf: () => undefined, config: parsePluginConfig(undefined), models: () => llm, logger: { info: () => undefined, warn: () => undefined } }
    const odd = { start: 'not a function', startContinuable: () => Promise.resolve(undefined) }
    assert.throws(() => installGuard({ ...base, subagents: odd as never }), /no start\(\) to guard/)
    assert.equal(odd.start, 'not a function')
  })

  it('says once that it stands in the doors, and what it does to a model the caller names', () => {
    const r = rig({ config: { children: { explicitModel: 'keep' } } })
    assert.equal(r.logs.filter(line => /^info:.*start guard on .*a model the caller names itself: keep/.test(line)).length, 1)
  })

  it('uses the registry of warned providers it is given instead of making its own', async () => {
    const subagents = new FakeSubagents({ results: [textResult('a'), textResult('b')], capabilities: { codex: { agentOptions: false, persona: false }, acp: { agentOptions: false, persona: false } } })
    const store = new ConfigStore({ maxSessions: 4 })
    store.set('main', picked())
    const warnings: string[] = []
    const warned = new Set(['codex'])
    installGuard({
      subagents, store, defaults: null, parentOf: () => undefined, config: parsePluginConfig(undefined),
      models: () => llm, logger: { info: () => undefined, warn: message => warnings.push(message) }, warned,
    })
    await subagents.start('codex', request())
    await subagents.start('acp', request())
    assert.equal(warnings.length, 1, 'codex was already warned about elsewhere')
    assert.match(warnings[0] ?? '', /"acp"/)
    assert.deepEqual([...warned].sort(), ['acp', 'codex'])
  })

  it('puts back an accessor or a read-only method exactly as it found it', () => {
    const base = { store: new ConfigStore({ maxSessions: 1 }), defaults: null, parentOf: () => undefined, config: parsePluginConfig(undefined), models: () => llm, logger: { info: () => undefined, warn: () => undefined } }
    const method = () => Promise.resolve(undefined)
    const service = {}
    Object.defineProperty(service, 'start', { get: () => method, enumerable: true, configurable: true })
    Object.defineProperty(service, 'startContinuable', { value: method, writable: false, enumerable: false, configurable: true })
    const before = Object.getOwnPropertyDescriptors(service)
    installGuard({ ...base, subagents: service as never })()
    assert.deepEqual(Object.getOwnPropertyDescriptors(service), before)
  })
})

describe('a child the plugin did not start itself', () => {
  it('is left exactly as it is when the session has no confirmed choice', async () => {
    const r = rig()
    const req = request()
    await r.subagents.start('spawn', req)
    assert.equal(r.subagents.starts[0]?.request, req)
  })

  it('is left alone when the stored choice is the inert one', async () => {
    const r = rig({ stored: OFF_CONFIG })
    const req = request()
    await r.subagents.start('spawn', req)
    assert.equal(r.subagents.starts[0]?.request, req)
  })

  it('runs on the picked subagent model with the effort ceiling and the token cap (a workflow agent with no model of its own)', async () => {
    const r = rig({ stored: picked() })
    const req = request()
    await r.subagents.start('spawn', req)
    assert.deepEqual(lastOptions(r), { provider: 'azure-opencode', model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'medium', maxTokens: 64_000 })
    assert.equal(req.agentOptions, undefined, 'the caller\'s request is not mutated')
    assert.equal(r.subagents.starts[0]?.request.prompt, req.prompt, 'everything else passes through')
    assert.ok(r.logs.some(line => /child of session main on provider spawn: worker: azure-opencode\/DeepSeek-V4\.1-Flash, effort medium/.test(line)))
  })

  it('honors the effort the user picked, above the ceiling, and still caps the output', async () => {
    const r = rig({ stored: picked({ workerEffort: 'max' }) })
    await r.subagents.start('spawn', request())
    assert.deepEqual(lastOptions(r), { provider: 'azure-opencode', model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'max', maxTokens: 64_000 })
  })

  it('runs on the user\'s model when the caller named another one (override, the default), and drops what was chosen for that other model', async () => {
    const r = rig({ stored: picked() })
    await r.subagents.start('spawn', request({ agentOptions: { ...MIMO, reasoningEffort: 'low' } }))
    assert.deepEqual(lastOptions(r), { provider: 'azure-opencode', model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'medium', maxTokens: 64_000 })
  })

  it('never raises a token limit the caller set, even when the user\'s model wins (an operator\'s tool row, a team roster)', async () => {
    const r = rig({ stored: picked() })
    await r.subagents.start('spawn', request({ agentOptions: { ...MIMO, maxTokens: 4_096 } }))
    assert.deepEqual(lastOptions(r), { provider: 'azure-opencode', model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'medium', maxTokens: 4_096 })
    await r.subagents.start('spawn', request({ agentOptions: { maxTokens: 500_000 } }))
    assert.equal(lastOptions(r)?.maxTokens, 64_000, 'a larger one is capped')
    const uncapped = rig({ stored: picked(), config: { limits: false } })
    await uncapped.subagents.start('spawn', request({ agentOptions: { maxTokens: 4_096 } }))
    assert.equal(lastOptions(uncapped)?.maxTokens, 4_096, 'and with the operator\'s cap off the caller\'s own limit still stands')
  })

  it('keeps the model the caller named, under the same ceilings, with `children.explicitModel: keep`', async () => {
    const r = rig({ stored: picked(), config: { children: { explicitModel: 'keep' } } })
    await r.subagents.start('spawn', request({ agentOptions: MIMO }))
    assert.deepEqual(lastOptions(r), { provider: 'openrouter-extra', model: 'xiaomi/mimo-v2.6-pro', reasoningEffort: 'low', maxTokens: 64_000 })
  })

  it('completes a route the caller named by model only from the parent\'s provider', async () => {
    const r = rig({ stored: picked(), config: { children: { explicitModel: 'keep' } } })
    const parent: AgentLike = { ...sonnet(), options: { provider: 'openrouter-extra', model: 'z-ai/anything', reasoningEffort: 'max' } }
    await r.subagents.start('spawn', request({ parent, agentOptions: { model: 'xiaomi/mimo-v2.6-pro' } }))
    assert.deepEqual(lastOptions(r), { provider: 'openrouter-extra', model: 'xiaomi/mimo-v2.6-pro', reasoningEffort: 'low', maxTokens: 64_000 })
  })

  it('never resurrects an effort the planner dropped: a level the model does not offer would fail the child\'s first model call', async () => {
    // A route whose own default is already within the ceiling: the planner sends no effort at all.
    const lowDefault: ModelInfoLike = { reasoning: { ...ladder('low', 'medium', 'high', 'max'), defaultEffort: 'low' }, defaultMaxTokens: 131_072 }
    const keep = rig({ stored: picked(), config: { children: { explicitModel: 'keep' } }, models: () => ({ resolveModelInfo: () => Promise.resolve(lowDefault) }) })
    await keep.subagents.start('spawn', request({ agentOptions: { ...MIMO, reasoningEffort: 'xhigh' } }))
    assert.deepEqual(lastOptions(keep), { provider: 'openrouter-extra', model: 'xiaomi/mimo-v2.6-pro', maxTokens: 64_000 })
    assert.ok(keep.logs.some(line => /warn:.*does not offer reasoning effort "xhigh"/.test(line)))

    // A model with no reasoning levels at all.
    const plain: ModelInfoLike = { defaultMaxTokens: 131_072 }
    const none = rig({ stored: picked(), config: { children: { explicitModel: 'keep' } }, models: () => ({ resolveModelInfo: () => Promise.resolve(plain) }) })
    await none.subagents.start('spawn', request({ agentOptions: { ...MIMO, reasoningEffort: 'high' } }))
    assert.equal(lastOptions(none)?.reasoningEffort, undefined)

    // The same in a reviewer-only choice, where the child stays on the parent's route.
    const reviewerOnly = rig({ stored: buildConfig({ subagentModel: null, reviewerEnabled: true, reviewerModel: null }), models: () => ({ resolveModelInfo: () => Promise.resolve(plain) }) })
    await reviewerOnly.subagents.start('spawn', request({ agentOptions: { reasoningEffort: 'high' } }))
    assert.equal(lastOptions(reviewerOnly)?.reasoningEffort, undefined)
  })

  it('keeps a smaller token limit the caller asked for', async () => {
    const r = rig({ stored: picked(), config: { children: { explicitModel: 'keep' } } })
    await r.subagents.start('spawn', request({ agentOptions: { ...MIMO, maxTokens: 8_000 } }))
    assert.equal(lastOptions(r)?.maxTokens, 8_000)
  })

  it('stays on the parent\'s model, under the ceilings, when the user picked only a reviewer', async () => {
    const r = rig({ stored: buildConfig({ subagentModel: null, reviewerEnabled: true, reviewerModel: null }) })
    await r.subagents.start('spawn', request())
    assert.deepEqual(lastOptions(r), { reasoningEffort: 'high', maxTokens: 64_000 }, 'Sonnet is capped at high for a worker; no route is named')
  })

  it('does not take a model away from a caller when the user picked none', async () => {
    const r = rig({ stored: buildConfig({ subagentModel: null, reviewerEnabled: true, reviewerModel: null }) })
    await r.subagents.start('spawn', request({ agentOptions: MIMO }))
    assert.deepEqual(lastOptions(r), { provider: 'openrouter-extra', model: 'xiaomi/mimo-v2.6-pro', reasoningEffort: 'low', maxTokens: 64_000 })
  })

  it('uses the choice of the nearest ancestor session (a child that delegates further)', async () => {
    const r = rig({ stored: picked(), parentOf: id => (id === 'child' ? 'main' : undefined) })
    await r.subagents.start('spawn', request({ parent: sonnet('child') }))
    assert.equal(lastOptions(r)?.model, 'DeepSeek-V4.1-Flash')
  })

  it('uses the deployment defaults for a session with no stored choice (headless)', async () => {
    const r = rig({ defaults: picked() })
    await r.subagents.start('spawn', request({ parent: sonnet('headless-1') }))
    assert.equal(lastOptions(r)?.model, 'DeepSeek-V4.1-Flash')
  })

  it('leaves a provider that cannot take agent options alone, and says so', async () => {
    const r = rig({ stored: picked(), capabilities: { codex: { agentOptions: false, persona: false } } })
    const req = request()
    await r.subagents.start('codex', req)
    assert.equal(r.subagents.starts[0]?.request, req)
    assert.ok(r.logs.some(line => /warn:.*provider "codex" cannot run a child on another model/.test(line)))
  })

  it('warns once per provider, not once per child (a workflow of thirty agents)', async () => {
    const r = rig({ stored: picked(), capabilities: { codex: { agentOptions: false, persona: false }, acp: { agentOptions: false, persona: false } } })
    for (let child = 0; child < 5; child += 1) await r.subagents.start('codex', request())
    await r.subagents.start('acp', request())
    await r.subagents.start('codex', request())
    const warnings = r.logs.filter(line => line.startsWith('warn:'))
    assert.equal(warnings.length, 2)
    assert.ok(warnings[0]?.includes('"codex"') && warnings[1]?.includes('"acp"'))
  })

  it('leaves an unknown provider to DSH, which reports it', async () => {
    const r = rig({ stored: picked(), capabilities: { ghost: undefined } })
    const req = request()
    await r.subagents.start('ghost', req)
    assert.equal(r.subagents.starts[0]?.request, req)
    assert.equal(r.logs.some(line => line.startsWith('warn:')), false)
  })

  it('leaves a call without a usable parent alone', async () => {
    const r = rig({ stored: picked() })
    const orphan = { prompt: [{ type: 'text', text: 'x' }], signal: new AbortController().signal } as unknown as SubagentStartRequestLike
    await r.subagents.start('spawn', orphan)
    assert.equal(r.subagents.starts[0]?.request, orphan)
    const odd = request({ parent: { id: 'x' } as unknown as AgentLike })
    await r.subagents.start('spawn', odd)
    assert.equal(r.subagents.starts[1]?.request, odd)
  })

  it('never breaks the delegation: a plan that cannot be made becomes a log line and the stock start', async () => {
    const r = rig({ stored: picked(), models: () => { throw new Error('llm service went away') } })
    const req = request()
    await r.subagents.start('spawn', req)
    assert.equal(r.subagents.starts[0]?.request, req)
    assert.ok(r.logs.some(line => /warn:.*could not apply the confirmed choice.*llm service went away/.test(line)))
  })

  it('degrades to the user\'s own pick when the model cannot be described', async () => {
    const r = rig({ stored: picked({ workerEffort: 'high' }), models: () => undefined })
    await r.subagents.start('spawn', request())
    assert.deepEqual(lastOptions(r), { provider: 'azure-opencode', model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'high' })
  })

  it('lets a cancellation through instead of swallowing it', async () => {
    const controller = new AbortController()
    const r = rig({
      stored: picked(),
      models: () => ({ resolveModelInfo: () => { controller.abort(new Error('the user cancelled')); return Promise.reject(new Error('lookup failed')) } }),
    })
    await assert.rejects(r.subagents.start('spawn', request({ signal: controller.signal })), /the user cancelled/)
    assert.equal(r.subagents.starts.length, 0)
  })

  it('governs a continuable child through its request', async () => {
    const r = rig({ stored: picked() })
    const spec = { provider: 'spawn', label: 'a task', childId: 'c-1', request: { prompt: [{ type: 'text', text: 'x' }], parent: sonnet() }, signal: new AbortController().signal }
    await r.subagents.startContinuable(spec)
    const seen = r.subagents.continuables[0] as typeof spec & { request: { agentOptions?: unknown } }
    assert.deepEqual(seen.request.agentOptions, { provider: 'azure-opencode', model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'medium', maxTokens: 64_000 })
    assert.equal(seen.provider, 'spawn')
    assert.equal(seen.label, 'a task')
    assert.equal(seen.childId, 'c-1')
    assert.equal(seen.signal, spec.signal)
    assert.equal((spec.request as { agentOptions?: unknown }).agentOptions, undefined, 'the caller\'s spec is not mutated')
  })

  it('completes a route the caller named by model only from the provider the parent runs on now, not the one it was created with', async () => {
    const r = rig({ stored: picked(), config: { children: { explicitModel: 'keep' } } })
    const created = sonnet()
    const switched: AgentLike = { ...created, session: { ...created.session, requestHeader: () => ({ config: { provider: 'openrouter-extra', model: 'z-ai/anything' } }) } }
    await r.subagents.start('spawn', request({ parent: switched, agentOptions: { model: 'xiaomi/mimo-v2.6-pro' } }))
    assert.deepEqual(lastOptions(r), { provider: 'openrouter-extra', model: 'xiaomi/mimo-v2.6-pro', reasoningEffort: 'low', maxTokens: 64_000 })
  })

  it('does not keep a route it cannot complete: the user\'s pick runs instead', async () => {
    const r = rig({ stored: picked(), config: { children: { explicitModel: 'keep' } } })
    const expected = { provider: 'azure-opencode', model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'medium', maxTokens: 64_000 }
    const noProvider: AgentLike = { ...sonnet(), options: { model: 'claude-sonnet-5-5' } }
    await r.subagents.start('spawn', request({ parent: noProvider, agentOptions: { model: 'xiaomi/mimo-v2.6-pro' } }))
    assert.deepEqual(lastOptions(r), expected, 'a model with no provider to lend it')
    const noModel: AgentLike = { ...sonnet(), options: { provider: 'azure-opencode-claude' } }
    await r.subagents.start('spawn', request({ parent: noModel, agentOptions: { provider: 'openrouter-extra' } }))
    assert.deepEqual(lastOptions(r), expected, 'a provider with no model to lend it')
  })

  it('honors an effort the caller named for the model it keeps, even above the ceiling (a named level is explicit)', async () => {
    const r = rig({ stored: picked(), config: { children: { explicitModel: 'keep' } } })
    await r.subagents.start('spawn', request({ agentOptions: { ...MIMO, reasoningEffort: 'high' } }))
    assert.deepEqual(lastOptions(r), { provider: 'openrouter-extra', model: 'xiaomi/mimo-v2.6-pro', reasoningEffort: 'high', maxTokens: 64_000 }, 'the ceiling of a MiMo worker is low')
  })

  it('does not forward an effort the kept model does not offer: the recommended level replaces it, and the planner\'s warning reaches the log', async () => {
    const r = rig({ stored: picked(), config: { children: { explicitModel: 'keep' } } })
    await r.subagents.start('spawn', request({ agentOptions: { ...MIMO, reasoningEffort: 'xhigh' } }))
    assert.equal(lastOptions(r)?.reasoningEffort, 'low')
    assert.ok(r.logs.some(line => /^warn:.*xiaomi\/mimo-v2\.6-pro does not offer reasoning effort "xhigh"/.test(line)))
  })

  it('caps a token limit the caller raised above the ceiling', async () => {
    const r = rig({ stored: picked(), config: { children: { explicitModel: 'keep' } } })
    await r.subagents.start('spawn', request({ agentOptions: { ...MIMO, maxTokens: 200_000 } }))
    assert.equal(lastOptions(r)?.maxTokens, 64_000)
  })

  it('lets a token limit the caller asked for stand when the operator turned the cap off', async () => {
    const r = rig({ stored: picked(), config: { children: { explicitModel: 'keep' }, limits: false } })
    await r.subagents.start('spawn', request({ agentOptions: { ...MIMO, maxTokens: 8_000 } }))
    assert.deepEqual(lastOptions(r), { provider: 'openrouter-extra', model: 'xiaomi/mimo-v2.6-pro', reasoningEffort: 'low', maxTokens: 8_000 })
  })

  it('keeps a smaller token limit the caller asked for when the user picked only a reviewer', async () => {
    const r = rig({ stored: buildConfig({ subagentModel: null, reviewerEnabled: true, reviewerModel: null }) })
    await r.subagents.start('spawn', request({ agentOptions: { maxTokens: 8_000 } }))
    assert.deepEqual(lastOptions(r), { reasoningEffort: 'high', maxTokens: 8_000 })
  })

  it('honors an effort the caller named for the parent\'s own route when the user picked only a reviewer', async () => {
    const r = rig({ stored: buildConfig({ subagentModel: null, reviewerEnabled: true, reviewerModel: null }) })
    await r.subagents.start('spawn', request({ agentOptions: { reasoningEffort: 'max' } }))
    assert.deepEqual(lastOptions(r), { reasoningEffort: 'max', maxTokens: 64_000 }, 'a named level is explicit: above the ceiling of high for Sonnet')
  })

  it('honors the worker effort stored next to a reviewer-only choice (the deployment `defaults` can carry one)', async () => {
    const r = rig({ stored: buildConfig({ subagentModel: null, workerEffort: 'max', reviewerEnabled: true, reviewerModel: null }) })
    await r.subagents.start('spawn', request())
    assert.deepEqual(lastOptions(r), { reasoningEffort: 'max', maxTokens: 64_000 })
  })

  it('honors the effort carried by the picked route when the dialog set none', async () => {
    const r = rig({ stored: picked({ subagentModel: { ...DEEPSEEK, reasoningEffort: 'high' } }) })
    await r.subagents.start('spawn', request())
    assert.deepEqual(lastOptions(r), { ...DEEPSEEK, reasoningEffort: 'high', maxTokens: 64_000 }, 'above the ceiling of medium: it was asked for')
  })

  it('leaves the request exactly as it is when the plan has nothing to override', async () => {
    const r = rig({ stored: buildConfig({ subagentModel: null, reviewerEnabled: true, reviewerModel: null }), models: () => undefined })
    const req = request()
    await r.subagents.start('spawn', req)
    assert.equal(r.subagents.starts[0]?.request, req)
    assert.equal(r.logs.some(line => /child of session/.test(line)), false, 'a child nothing was changed for is not announced')
  })

  it('hands what is not a request object straight to DSH, which reports it, without a warning of its own', async () => {
    const r = rig({ stored: picked() })
    await r.subagents.start('spawn', null as never)
    await r.subagents.start('spawn', undefined as never)
    assert.equal(r.subagents.starts[0]?.request, null)
    assert.equal(r.subagents.starts[1]?.request, undefined)
    const noRequest = { provider: 'spawn', label: 'x', signal: new AbortController().signal } as never
    await r.subagents.startContinuable(undefined as never)
    await r.subagents.startContinuable(noRequest)
    assert.equal(r.subagents.continuables[1], noRequest)
    assert.equal(r.logs.some(line => line.startsWith('warn:')), false)
  })

  it('leaves a call alone whose parent carries no session, even where deployment defaults govern every session', async () => {
    const r = rig({ defaults: picked() })
    const odd = request({ parent: { id: 'x' } as unknown as AgentLike })
    await r.subagents.start('spawn', odd)
    assert.equal(r.subagents.starts[0]?.request, odd)
    assert.equal(r.logs.some(line => line.startsWith('warn:')), false, 'not even an attempt to plan it')
  })

  it('still governs a request that carries no cancellation signal, and still never breaks it', async () => {
    const unsignalled = (): SubagentStartRequestLike => ({ prompt: [{ type: 'text', text: 'x' }], parent: sonnet() } as unknown as SubagentStartRequestLike)
    const working = rig({ stored: picked() })
    await working.subagents.start('spawn', unsignalled())
    assert.deepEqual(lastOptions(working), { ...DEEPSEEK, reasoningEffort: 'medium', maxTokens: 64_000 })
    const broken = rig({ stored: picked(), models: () => { throw new Error('llm service went away') } })
    const req = unsignalled()
    await broken.subagents.start('spawn', req)
    assert.equal(broken.subagents.starts[0]?.request, req)
    assert.ok(broken.logs.some(line => /warn:.*llm service went away/.test(line)))
  })

  it('leaves a continuable child of a provider that cannot take agent options exactly as it is, and says so', async () => {
    const r = rig({ stored: picked(), capabilities: { codex: { agentOptions: false, persona: false } } })
    const spec = { provider: 'codex', label: 'a task', request: { prompt: [{ type: 'text', text: 'x' }], parent: sonnet() }, signal: new AbortController().signal }
    await r.subagents.startContinuable(spec)
    assert.equal(r.subagents.continuables[0], spec)
    assert.ok(r.logs.some(line => /warn:.*provider "codex" cannot run a child on another model/.test(line)))
  })

  it('never breaks a continuable delegation either: a plan that cannot be made becomes a log line and the stock spec, untouched', async () => {
    const r = rig({ stored: picked(), models: () => { throw new Error('llm service went away') } })
    const spec = { provider: 'spawn', label: 'a task', request: { prompt: [{ type: 'text', text: 'x' }], parent: sonnet() }, signal: new AbortController().signal }
    await r.subagents.startContinuable(spec)
    assert.equal(r.subagents.continuables[0], spec)
    assert.ok(r.logs.some(line => /warn:.*could not apply the confirmed choice.*llm service went away/.test(line)))
  })

  it('lets a cancellation through on a continuable start too', async () => {
    const controller = new AbortController()
    const r = rig({
      stored: picked(),
      models: () => ({ resolveModelInfo: () => { controller.abort(new Error('the user cancelled')); return Promise.reject(new Error('lookup failed')) } }),
    })
    const spec = { provider: 'spawn', label: 'a task', request: { prompt: [{ type: 'text', text: 'x' }], parent: sonnet() }, signal: controller.signal }
    await assert.rejects(r.subagents.startContinuable(spec), /the user cancelled/)
    assert.equal(r.subagents.continuables.length, 0)
  })

  it('resolves the LLM runtime at every start: it may appear after the plugin loaded', async () => {
    let runtime: ModelInfoSourceLike | undefined
    const r = rig({ stored: picked(), models: () => runtime })
    await r.subagents.start('spawn', request())
    assert.deepEqual(lastOptions(r), DEEPSEEK, 'no runtime yet: only the user\'s pick')
    runtime = llm
    await r.subagents.start('spawn', request())
    assert.deepEqual(lastOptions(r), { ...DEEPSEEK, reasoningEffort: 'medium', maxTokens: 64_000 })
  })

  it('hands back what DSH answered and starts on the provider it was asked for, governed or not', async () => {
    const r = rig({ stored: picked() })
    const spec = () => ({ provider: 'fork', label: 'a task', request: { prompt: [{ type: 'text', text: 'x' }], parent: sonnet() }, signal: new AbortController().signal })
    assert.equal(await r.subagents.start('fork', request()), r.subagents.starts[0]?.run, 'governed')
    assert.equal((await startPlanned(r.subagents, 'fork', request())).id, 'run-2', 'planned by the pipeline')
    assert.deepEqual(r.subagents.starts.map(started => started.provider), ['fork', 'fork'])
    assert.deepEqual(await r.subagents.startContinuable(spec()), { childId: 'child-1' }, 'governed')
    assert.deepEqual(await startContinuablePlanned(r.subagents, spec()), { childId: 'child-2' }, 'planned by the pipeline')
  })

  it('names what it failed on in the warning: an Error\'s message, or whatever else was thrown', async () => {
    const thrown = (value: unknown): never => { throw value }
    const failed = rig({ stored: picked(), models: () => thrown(new Error('llm service went away')) })
    await failed.subagents.start('spawn', request())
    assert.ok(failed.logs.some(line => /^warn:.*to a child \(llm service went away\); DSH starts it/.test(line)))
    const odd = rig({ stored: picked(), models: () => thrown('plain string') })
    await odd.subagents.start('spawn', request())
    assert.ok(odd.logs.some(line => /^warn:.*to a child \(plain string\); DSH starts it/.test(line)))
  })

  it('rejects a cancellation with an Error even when what surfaced was not one', async () => {
    const thrown = (value: unknown): never => { throw value }
    const controller = new AbortController()
    const r = rig({ stored: picked(), models: () => { controller.abort('the user cancelled'); return thrown('lookup failed') } })
    await assert.rejects(r.subagents.start('spawn', request({ signal: controller.signal })), (error: unknown) => error instanceof Error)
    assert.equal(r.subagents.starts.length, 0)
  })
})

describe('a child the plugin planned itself', () => {
  it('is never planned a second time (the pipeline\'s own starts)', async () => {
    const r = rig({ stored: picked() })
    const own = request({ agentOptions: MIMO })
    assert.equal(isPlanned(own), false)
    await startPlanned(r.subagents, 'spawn', own)
    assert.equal(isPlanned(own), true)
    assert.equal(r.subagents.starts[0]?.request, own)
    assert.deepEqual(lastOptions(r), MIMO)
  })

  it('applies to a request that carries no options at all (a reviewer that keeps the worker\'s route)', async () => {
    const r = rig({ stored: picked() })
    const own = request()
    await startPlanned(r.subagents, 'spawn', own)
    assert.equal(lastOptions(r), undefined)
  })

  it('applies to continuable starts, marked on the spec or on its request', async () => {
    const r = rig({ stored: picked() })
    const mk = () => ({ provider: 'spawn', label: 'l', request: { prompt: [{ type: 'text', text: 'x' }], parent: sonnet() }, signal: new AbortController().signal })
    await startContinuablePlanned(r.subagents, mk())
    const viaRequest = mk()
    markPlanned(viaRequest.request)
    await r.subagents.startContinuable(viaRequest)
    const viaSpec = mk()
    markPlanned(viaSpec)
    await r.subagents.startContinuable(viaSpec)
    for (const seen of r.subagents.continuables) assert.equal((seen.request as { agentOptions?: unknown }).agentOptions, undefined)
  })

  it('is known to a reloaded copy of the plugin: the registry of planned requests is process-wide', async () => {
    const reloaded = await import(new URL('../../src/guard.ts?reloaded', import.meta.url).href) as typeof import('../../src/guard.ts')
    assert.notEqual(reloaded.markPlanned, markPlanned, 'a second, separate copy of the module')
    const ours = request()
    markPlanned(ours)
    assert.equal(reloaded.isPlanned(ours), true)
    const theirs = request()
    reloaded.markPlanned(theirs)
    assert.equal(isPlanned(theirs), true)
  })
})

describe('governedOptions', () => {
  it('answers undefined, never throws, when nothing applies', async () => {
    const r = rig()
    assert.equal(await governedOptions(r.deps, 'spawn', { parent: sonnet(), agentOptions: undefined, signal: new AbortController().signal }), undefined)
    assert.equal(await governedOptions(r.deps, 'spawn', { parent: undefined, agentOptions: undefined, signal: new AbortController().signal }), undefined)
  })

  it('needs no registry of warned providers when called directly: it simply warns every time', async () => {
    const r = rig({ stored: picked(), capabilities: { codex: { agentOptions: false, persona: false } } })
    const input = { parent: sonnet(), agentOptions: undefined, signal: new AbortController().signal }
    assert.equal(await governedOptions(r.deps, 'codex', input), undefined)
    assert.equal(await governedOptions(r.deps, 'codex', input), undefined)
    assert.equal(r.logs.filter(line => line.startsWith('warn:')).length, 2)
  })
})

describe('a confirmed model the LLM runtime no longer knows', () => {
  const retired: ModelInfoSourceLike = { resolveModelInfo: (provider, model) => Promise.reject(new Error(`no model ${provider}/${model} in the catalog`)) }

  it('rejects the start with a message that says what to do, instead of forcing the dead route onto the child', async () => {
    const r = rig({ stored: picked(), models: () => retired })
    await assert.rejects(
      r.subagents.start('spawn', request()),
      (error: unknown) => error instanceof ChoiceUnusableError
        && /azure-opencode\/DeepSeek-V4\.1-Flash cannot be used \(no model azure-opencode\/DeepSeek-V4\.1-Flash in the catalog\)/.test(error.message)
        && /Open \/orquestrar to pick another model, or cancel the dialog/.test(error.message),
    )
    assert.equal(r.subagents.starts.length, 0, 'no child started on the dead route, and none on the main agent\'s model either')
  })

  it('rejects a continuable start the same way, and a headless deployment default the same way', async () => {
    const r = rig({ stored: picked(), models: () => retired })
    const spec = { provider: 'spawn', label: 'a task', request: { prompt: [{ type: 'text', text: 'x' }], parent: sonnet() }, signal: new AbortController().signal }
    await assert.rejects(r.subagents.startContinuable(spec), ChoiceUnusableError)
    assert.equal(r.subagents.continuables.length, 0)
    const headless = rig({ defaults: picked(), models: () => retired })
    await assert.rejects(headless.subagents.start('spawn', request({ parent: sonnet('headless-1') })), ChoiceUnusableError)
  })

  it('refuses only a route the runtime cannot call: one that merely cannot be described keeps the user\'s pick', async () => {
    const callable: ModelInfoSourceLike = { ...retired, resolveCallConfig: () => Promise.resolve({}) }
    const kept = rig({ stored: picked(), models: () => callable })
    await kept.subagents.start('spawn', request())
    assert.deepEqual(lastOptions(kept), DEEPSEEK)
    const dead: ModelInfoSourceLike = { ...retired, resolveCallConfig: () => Promise.reject(new Error('has no configured model')) }
    const refused = rig({ stored: picked(), models: () => dead })
    await assert.rejects(refused.subagents.start('spawn', request()), /cannot be used \(has no configured model\)/)
  })

  it('leaves a model the CALLER named (keep) to DSH: it is not the user\'s choice to defend', async () => {
    const r = rig({ stored: picked(), config: { children: { explicitModel: 'keep' } }, models: () => retired })
    await r.subagents.start('spawn', request({ agentOptions: MIMO }))
    assert.deepEqual(lastOptions(r), MIMO, 'the named route stands, as it would without the plugin')
  })

  it('is not raised for a session that confirmed nothing, for an unusable model nobody picked, or when there is no LLM runtime', async () => {
    const none = rig({ models: () => retired })
    await none.subagents.start('spawn', request())
    assert.equal(lastOptions(none), undefined)
    const reviewerOnly = rig({ stored: buildConfig({ subagentModel: null, reviewerEnabled: true, reviewerModel: null }), models: () => retired })
    await reviewerOnly.subagents.start('spawn', request())
    const noRuntime = rig({ stored: picked(), models: () => undefined })
    await noRuntime.subagents.start('spawn', request())
    assert.deepEqual(lastOptions(noRuntime), DEEPSEEK)
  })

  it('does not hide a cancellation behind it', async () => {
    const controller = new AbortController()
    const r = rig({ stored: picked(), models: () => ({ resolveModelInfo: () => { controller.abort('the workflow was cancelled'); return Promise.reject(new Error('gone')) } }) })
    await assert.rejects(r.subagents.start('spawn', request({ signal: controller.signal })), (error: unknown) => error instanceof Error && !(error instanceof ChoiceUnusableError) && error.message === 'the workflow was cancelled')
  })
})

describe('the mark on a planned request', () => {
  it('survives a wrapper stacked above the guard that copies the request: the pipeline\'s reviewer is never re-planned as a worker', async () => {
    const r = rig({ stored: picked() })
    const guarded = r.subagents.start.bind(r.subagents)
    r.subagents.start = (provider, req) => guarded(provider, { ...req }) // telemetry, permissions: anything that normalizes with a spread
    const reviewer = request({ agentOptions: { ...MIMO, reasoningEffort: 'medium', maxTokens: 32_000 } })
    await startPlanned(r.subagents, 'spawn', reviewer)
    assert.deepEqual(lastOptions(r), { ...MIMO, reasoningEffort: 'medium', maxTokens: 32_000 }, 'still on MiMo, not on the worker\'s DeepSeek')
    assert.equal(r.logs.some(line => /child of session/.test(line)), false)
  })

  it('also carries over a request that cannot take a property (a frozen one): the registry alone says planned', async () => {
    const r = rig({ stored: picked() })
    const frozen = Object.freeze(request({ agentOptions: MIMO }))
    markPlanned(frozen)
    assert.equal(isPlanned(frozen), true)
    await r.subagents.start('spawn', frozen)
    assert.equal(r.subagents.starts[0]?.request, frozen)
  })

  it('is put on what the guard hands to DSH, so a second live guard (another copy of the plugin) plans each child once and the NEWER configuration wins', async () => {
    const subagents = new FakeSubagents({ results: Array.from({ length: 4 }, () => textResult('ok')) })
    const store = new ConfigStore({ maxSessions: 4 })
    store.set('main', picked())
    const logs: string[] = []
    const make = (config: Config): GuardDeps => ({
      subagents, store, defaults: null, parentOf: () => undefined, config: parsePluginConfig(config),
      models: () => llm, logger: { info: message => logs.push(message), warn: message => logs.push(message) },
    })
    installGuard(make({ effort: { worker: 'high' } })) // the older copy
    installGuard(make({ effort: { worker: 'low' } })) // the newer copy, outermost
    await subagents.start('spawn', request())
    assert.equal(subagents.starts[0]?.request.agentOptions?.reasoningEffort, 'low', 'the outer, newer guard planned it')
    assert.equal(logs.filter(line => /child of session/.test(line)).length, 1, 'and the inner one saw a planned request')
    assert.equal(isPlanned(subagents.starts[0]?.request ?? {}), true)
  })

  it('never marks the caller\'s own request: the same request object may be started again under another choice', async () => {
    const r = rig({ stored: picked() })
    const req = request()
    await r.subagents.start('spawn', req)
    assert.equal(isPlanned(req), false)
    r.store.clear('main')
    await r.subagents.start('spawn', req)
    assert.equal(r.subagents.starts[1]?.request, req, 'now untouched')
  })

  it('is shared with a reloaded copy of the plugin: a frozen request through the registry, a copy of a request through the mark itself', async () => {
    const reloaded = await import(new URL('../../src/guard.ts?reloaded-mark', import.meta.url).href) as typeof import('../../src/guard.ts')
    const frozen = Object.freeze(request())
    markPlanned(frozen)
    assert.equal(reloaded.isPlanned(frozen), true, 'the registry is process-wide')
    const marked = markPlanned(request())
    assert.equal(reloaded.isPlanned({ ...marked }), true, 'the mark is a registered symbol, so the other copy reads it on a copy of the request')
  })
})

describe('a provider that runs on a route of its own (the SDK provider)', () => {
  const sdk = { routeDefaults: { sdk: { provider: 'openrouter', model: 'google/gemini-3.8-flash' } } }

  it('is left alone when no subagent model is picked: its child does not run on the parent\'s model, so there is nothing to plan against', async () => {
    const r = rig({ stored: buildConfig({ subagentModel: null, reviewerEnabled: true, reviewerModel: null }), ...sdk })
    const req = request()
    await r.subagents.start('sdk', req)
    assert.equal(r.subagents.starts[0]?.request, req)
  })

  it('takes the picked route, effort and cap like any other provider', async () => {
    const r = rig({ stored: picked(), ...sdk })
    await r.subagents.start('sdk', request())
    assert.deepEqual(lastOptions(r), { ...DEEPSEEK, reasoningEffort: 'medium', maxTokens: 64_000 })
  })

  it('completes a route the caller named by model only from the provider\'s own route, not the parent\'s', async () => {
    const r = rig({ stored: buildConfig({ subagentModel: null, reviewerEnabled: true, reviewerModel: null }), config: { effort: false, limits: false }, ...sdk })
    await r.subagents.start('sdk', request({ agentOptions: { model: 'google/gemini-3.8-pro' } }))
    assert.deepEqual(lastOptions(r), { provider: 'openrouter', model: 'google/gemini-3.8-pro' })
  })
})

describe('the effort and the limit a caller names', () => {
  it('applies the effort stored next to a choice with no subagent model to a model the caller named, when that model offers it', async () => {
    const r = rig({ stored: buildConfig({ subagentModel: null, workerEffort: 'high', reviewerEnabled: true, reviewerModel: null }), config: { children: { explicitModel: 'keep' } } })
    await r.subagents.start('spawn', request({ agentOptions: MIMO }))
    assert.equal(lastOptions(r)?.reasoningEffort, 'high', 'asked for in the dialog, and MiMo offers it')
  })

  it('does not carry the effort the user chose for THEIR model over to a model the caller kept', async () => {
    const r = rig({ stored: picked({ workerEffort: 'max' }), config: { children: { explicitModel: 'keep' } } })
    await r.subagents.start('spawn', request({ agentOptions: MIMO }))
    assert.equal(lastOptions(r)?.reasoningEffort, 'low', 'the ceiling of a MiMo worker, not the max picked for DeepSeek')
  })

  it('strips an effort the caller named when the plan has nothing else to say and the model offers no levels', async () => {
    const plain: ModelInfoLike = { defaultMaxTokens: 8_000 }
    const r = rig({ stored: buildConfig({ subagentModel: null, reviewerEnabled: true, reviewerModel: null }), models: () => ({ resolveModelInfo: () => Promise.resolve(plain) }) })
    const parent: AgentLike = { ...sonnet(), options: { provider: 'openrouter', model: 'plain', maxTokens: undefined } }
    await r.subagents.start('spawn', request({ parent, agentOptions: { reasoningEffort: 'high' } }))
    assert.deepEqual(lastOptions(r), {}, 'nothing left to override, and no level the model would refuse')
    const bare = rig({ stored: buildConfig({ subagentModel: null, reviewerEnabled: true, reviewerModel: null }), models: () => ({ resolveModelInfo: () => Promise.resolve(plain) }) })
    const untouched = request({ parent })
    await bare.subagents.start('spawn', untouched)
    assert.equal(bare.subagents.starts[0]?.request, untouched, 'and with no level named the request is left exactly as it is')
  })
})
