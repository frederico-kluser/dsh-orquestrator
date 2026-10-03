import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parsePluginConfig } from '../../src/config.ts'
import type { ToolDispatchExecutionLike, ToolExecutionResultLike } from '../../src/host-services.ts'
import { OFF_CONFIG, buildConfig } from '../../src/shared.ts'
import { ConfigStore } from '../../src/store.ts'
import { createToolWrapper } from '../../src/tool-wrapper.ts'
import { FakeSubagents, fakeAgent, textResult } from '../helpers.ts'

const cheap = { provider: 'openrouter', model: 'google/gemini-3.8-flash' }
const reviewed = buildConfig({ subagentModel: cheap, reviewerEnabled: true, reviewerModel: null })
const parsed = parsePluginConfig(undefined)
const targets = new Map(parsed.tools.map(tool => [tool.name, tool] as const))
const untouched: ToolExecutionResultLike = { isError: false, value: 'stock', content: [] }

function setup(options: { store?: ConfigStore; defaults?: typeof reviewed | null; results?: Parameters<typeof FakeSubagents.prototype.start>[0][] } = {}) {
  const subagents = new FakeSubagents({ results: [textResult('worker report'), textResult('VERDICT: APPROVED\nreviewed body')] })
  const warnings: string[] = []
  const store = options.store ?? new ConfigStore({ maxSessions: 10 })
  const wrapper = createToolWrapper({
    targets,
    store,
    defaults: options.defaults ?? null,
    parentOf: () => undefined,
    pipeline: () => ({ subagents, config: parsed, logger: { info: () => undefined, warn: message => warnings.push(message) } }),
    logger: { info: () => undefined, warn: message => warnings.push(message) },
  })
  return { subagents, store, wrapper, warnings }
}

const exec = (over: Partial<ToolDispatchExecutionLike> = {}): ToolDispatchExecutionLike => ({
  callId: 'c1',
  name: 'subagent',
  arguments: { description: 'd', prompt: 'p' },
  agent: fakeAgent('sess-1'),
  signal: new AbortController().signal,
  ...over,
})
const next = (): Promise<ToolExecutionResultLike> => Promise.resolve(untouched)

describe('delegation wrapper', () => {
  it('delegates to the stock tool when no choice is stored (cancelled modal / never asked)', async () => {
    const { wrapper, subagents } = setup()
    assert.equal(await wrapper(exec(), next), untouched)
    assert.equal(subagents.starts.length + subagents.continuables.length, 0)
  })

  it('delegates when the stored choice is the inert one', async () => {
    const { wrapper, store } = setup()
    store.set('sess-1', OFF_CONFIG)
    assert.equal(await wrapper(exec(), next), untouched)
  })

  it('leaves other tools, agentless calls and malformed arguments to the stock tool', async () => {
    const { wrapper, store } = setup()
    store.set('sess-1', reviewed)
    assert.equal(await wrapper(exec({ name: 'bash' }), next), untouched)
    const { agent: _agent, ...agentless } = exec()
    assert.equal(await wrapper(agentless, next), untouched)
    assert.equal(await wrapper(exec({ arguments: { description: 'only' } }), next), untouched)
  })

  it('substitutes an orchestrated foreground result with the reviewer report', async () => {
    const { wrapper, store, subagents } = setup()
    store.set('sess-1', reviewed)
    const result = await wrapper(exec(), () => Promise.reject(new Error('the stock tool must not run')))
    assert.equal(result.isError, false)
    const value = (result as { value: { kind: string; output: { text: string }[] } }).value
    assert.equal(value.kind, 'foreground')
    assert.match(value.output[0]?.text ?? '', /reviewed body/)
    assert.equal(subagents.starts.length, 2)
  })

  it('applies a parent session choice to a delegating child (lineage)', async () => {
    const subagents = new FakeSubagents({ results: [textResult('w'), textResult('VERDICT: APPROVED\nr')] })
    const store = new ConfigStore({ maxSessions: 10 })
    store.set('root', reviewed)
    const wrapper = createToolWrapper({
      targets, store, defaults: null,
      parentOf: id => (id === 'child' ? 'root' : undefined),
      pipeline: () => ({ subagents, config: parsed, logger: { info: () => undefined, warn: () => undefined } }),
      logger: { info: () => undefined, warn: () => undefined },
    })
    const result = await wrapper(exec({ agent: fakeAgent('child', 'root') }), next)
    assert.equal(result.isError, false)
    assert.equal(subagents.starts.length, 2)
  })

  it('uses the deployment defaults for sessions with no stored choice (headless)', async () => {
    const { wrapper, subagents } = setup({ defaults: reviewed })
    await wrapper(exec({ agent: fakeAgent('headless-1') }), next)
    assert.equal(subagents.starts.length, 2)
  })

  it('orchestrates subagent_fork on its own provider', async () => {
    const { wrapper, store, subagents } = setup()
    store.set('sess-1', buildConfig({ subagentModel: cheap, reviewerEnabled: false, reviewerModel: null }))
    const result = await wrapper(exec({ name: 'subagent_fork' }), next)
    assert.deepEqual((result as { value: unknown }).value, { kind: 'continuable', subagentId: 'child-1' })
    assert.equal(subagents.continuables[0]?.provider, 'fork')
  })

  it('does not orchestrate the background JOB path of a one-shot tool, and warns once', async () => {
    const oneShot = createToolWrapper({
      targets: new Map([['subagent', { name: 'subagent', provider: 'spawn', mode: 'one-shot' as const }]]),
      store: (() => { const s = new ConfigStore({ maxSessions: 10 }); s.set('sess-1', reviewed); return s })(),
      defaults: null,
      parentOf: () => undefined,
      pipeline: () => { throw new Error('pipeline must not be built') },
      logger: { info: () => undefined, warn: message => warnings.push(message) },
    })
    const warnings: string[] = []
    const background = exec({ arguments: { description: 'd', prompt: 'p', run_in_background: true } })
    assert.equal(await oneShot(background, next), untouched)
    assert.equal(await oneShot(background, next), untouched)
    assert.equal(warnings.length, 1)
  })

  it('turns a failing worker into a thrown error the registry reports to the model', async () => {
    const subagents = new FakeSubagents({ results: [textResult('nope', 'error', 'provider down')] })
    const store = new ConfigStore({ maxSessions: 10 })
    store.set('sess-1', reviewed)
    const wrapper = createToolWrapper({
      targets, store, defaults: null, parentOf: () => undefined,
      pipeline: () => ({ subagents, config: parsed, logger: { info: () => undefined, warn: () => undefined } }),
      logger: { info: () => undefined, warn: () => undefined },
    })
    await assert.rejects(wrapper(exec(), next), /provider down/)
  })
})
