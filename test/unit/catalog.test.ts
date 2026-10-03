import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { adviseEffort, ladderOf, loadCatalog, modelName } from '../../src/client/catalog.ts'
import type { CatalogGroupLike, ModelDirectoriesLike, RemoteSessionLike } from '../../src/client/host-types.ts'

const groups: CatalogGroupLike[] = [
  { id: 'openrouter', name: 'OpenRouter', models: [{ id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash' }] },
  { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }] },
]
const current = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }

const directories = (state: { status: string; groups: CatalogGroupLike[]; error: string | null } | Error): ModelDirectoriesLike => ({
  directoryFor: () => ({
    load: () => (state instanceof Error ? Promise.reject(state) : Promise.resolve({ current, ...state })),
    store: { getSnapshot: () => ({ current, groups: [], status: 'idle', error: null }) },
  }),
})
const remote = (answer: Awaited<ReturnType<RemoteSessionLike['modelCatalog']>> | Error): RemoteSessionLike => ({
  modelCatalog: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)),
})

describe('loadCatalog', () => {
  it('prefers the per-session model directory and reports the current route', async () => {
    const result = await loadCatalog({ modelDirectories: () => directories({ status: 'ready', groups, error: null }) }, 's')
    assert.equal(result.status, 'ready')
    assert.equal(result.groups, groups)
    assert.deepEqual(result.current, current)
  })

  it('falls back to the global remote catalog when the directory fails or is empty', async () => {
    const remoteOk = remote({ ok: true, value: { default: current, groups } })
    for (const dir of [directories(new Error('no scope')), directories({ status: 'error', groups: [], error: 'boom' }), directories({ status: 'ready', groups: [], error: null })]) {
      const result = await loadCatalog({ modelDirectories: () => dir, remoteSession: () => remoteOk }, 's')
      assert.equal(result.status, 'ready')
      assert.equal(result.groups, groups)
    }
  })

  it('works with the remote catalog alone', async () => {
    const result = await loadCatalog({ remoteSession: () => remote({ ok: true, value: { default: current, groups } }) }, 's')
    assert.equal(result.status, 'ready')
  })

  it('reports an error state naming the last failure when nothing answers', async () => {
    const both = await loadCatalog({ modelDirectories: () => directories(new Error('no scope')), remoteSession: () => remote({ ok: false, error: { message: 'host down' } }) }, 's')
    assert.deepEqual([both.status, both.error, both.groups.length], ['error', 'host down', 0])
    const thrown = await loadCatalog({ remoteSession: () => remote(new Error('network')) }, 's')
    assert.equal(thrown.error, 'network')
    const none = await loadCatalog({}, 's')
    assert.equal(none.status, 'error')
    assert.match(none.error ?? '', /no model catalog/)
  })

  it('turns a resolver that throws (Cordis refuses an un-injected service) into an error state, never an exception', async () => {
    const refuse = (): never => { throw new Error('cannot get property "remote" without inject') }
    const state = await loadCatalog({ modelDirectories: refuse, remoteSession: refuse }, 's')
    assert.equal(state.status, 'error')
    assert.match(state.error ?? '', /without inject/)
    // a throwing directory resolver still lets the remote catalog answer
    const rescued = await loadCatalog({ modelDirectories: refuse, remoteSession: () => remote({ ok: true, value: { default: current, groups } }) }, 's')
    assert.equal(rescued.status, 'ready')
  })
})

describe('modelName', () => {
  it('names a route from the catalog and falls back to the raw model id', () => {
    assert.equal(modelName(groups, { provider: 'openrouter', model: 'google/gemini-3.8-flash' }), 'Gemini 3.8 Flash')
    assert.equal(modelName(groups, { provider: 'openrouter', model: 'unknown' }), 'unknown')
    assert.equal(modelName(groups, { provider: 'ghost', model: 'm' }), 'm')
  })
})

const named = (...ids: string[]): { efforts: { id: string; name: string }[] } => ({ efforts: ids.map(id => ({ id, name: `${id.charAt(0).toUpperCase()}${id.slice(1)}` })) })
const withLadders: CatalogGroupLike[] = [
  {
    id: 'azure-opencode',
    name: 'Azure OpenCode (DeepSeek)',
    models: [{ id: 'DeepSeek-V4.1-Flash', name: 'DeepSeek V4.1 Flash (Azure)', reasoning: { ...named('off', 'low', 'medium', 'high', 'xhigh', 'max'), defaultEffort: 'max' } }],
  },
  {
    id: 'azure-opencode-claude',
    name: 'Azure OpenCode (Claude)',
    models: [
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 (Azure)', reasoning: { ...named('low', 'medium', 'high', 'xhigh', 'max'), defaultEffort: 'max' } },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
    ],
  },
]

describe('ladderOf', () => {
  it('finds the reasoning levels of a route, and nothing for an unknown or non-reasoning one', () => {
    assert.deepEqual(ladderOf(withLadders, { provider: 'azure-opencode', model: 'DeepSeek-V4.1-Flash' })?.efforts.map(effort => effort.id), ['off', 'low', 'medium', 'high', 'xhigh', 'max'])
    assert.equal(ladderOf(withLadders, { provider: 'azure-opencode-claude', model: 'claude-haiku-4-5' }), undefined)
    assert.equal(ladderOf(withLadders, { provider: 'nope', model: 'x' }), undefined)
  })
})

describe('adviseEffort', () => {
  it('shows the same level the host will use: the profile ceiling for the role, below the route default of max', () => {
    const worker = adviseEffort(withLadders, { provider: 'azure-opencode', model: 'DeepSeek-V4.1-Flash' }, 'worker')
    assert.equal(worker.level?.id, 'medium')
    assert.equal(worker.level?.name, 'Medium')
    const reviewer = adviseEffort(withLadders, { provider: 'azure-opencode', model: 'DeepSeek-V4.1-Flash' }, 'reviewer')
    assert.equal(reviewer.level?.id, 'low')
    assert.equal(adviseEffort(withLadders, { provider: 'azure-opencode-claude', model: 'claude-sonnet-5-5' }, 'reviewer').level?.id, 'high')
  })

  it('uses the main agent\'s own level when the child inherits its route', () => {
    const route = { provider: 'azure-opencode-claude', model: 'claude-sonnet-5-5' }
    assert.equal(adviseEffort(withLadders, route, 'worker', 'medium').level?.id, 'medium') // already within the ceiling: kept
    assert.equal(adviseEffort(withLadders, route, 'worker', 'max').level?.id, 'high') // above it: lowered
  })

  it('has no ladder for a model without reasoning levels', () => {
    assert.deepEqual(adviseEffort(withLadders, { provider: 'azure-opencode-claude', model: 'claude-haiku-4-5' }, 'reviewer'), { ladder: undefined, level: undefined })
  })
})
