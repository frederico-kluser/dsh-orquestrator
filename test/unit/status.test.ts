import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CatalogGroupLike, CurrentSelectionLike } from '../../src/client/host-types.ts'
import { describeConfig } from '../../src/client/status.ts'
import { buildConfig, type OrchestratorConfig } from '../../src/shared.ts'

const groups: readonly CatalogGroupLike[] = [{
  id: 'openrouter',
  name: 'OpenRouter',
  models: [
    {
      id: 'google/gemini-3.8-flash',
      name: 'Gemini 3.8 Flash',
      reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' },
    },
    { id: 'moonshotai/kimi-k3', name: 'Kimi K3' },
  ],
}]
const current: CurrentSelectionLike = { provider: 'azure', model: 'DeepSeek-V4.1-Flash' }
const withModel = (effort?: string): OrchestratorConfig => buildConfig({
  subagentModel: { provider: 'openrouter', model: 'google/gemini-3.8-flash', ...effort === undefined ? {} : { reasoningEffort: effort } },
  workerEffort: effort ?? null,
})

describe('describeConfig', () => {
  it('reports the inert status when nothing is stored', () => {
    for (const config of [null, buildConfig({ subagentModel: null }), buildConfig({ subagentModel: null, workerEffort: null })]) {
      const status = describeConfig(config, groups, current)
      assert.deepEqual(status, { ownModel: false, explicitEffort: false, model: '', effort: '' })
    }
  })

  it('names the own model and marks the effort as recommended when only a model is stored', () => {
    const status = describeConfig(buildConfig({ subagentModel: { provider: 'openrouter', model: 'google/gemini-3.8-flash' } }), groups, current)
    assert.equal(status.ownModel, true)
    assert.equal(status.explicitEffort, false)
    assert.equal(status.model, 'Gemini 3.8 Flash')
    assert.equal(status.effort, '')
  })

  it('resolves an explicit effort to the catalog level name of that model', () => {
    const status = describeConfig(withModel('high'), groups, current)
    assert.equal(status.ownModel, true)
    assert.equal(status.explicitEffort, true)
    assert.equal(status.model, 'Gemini 3.8 Flash')
    assert.equal(status.effort, 'High')
  })

  it('an effort-only choice keeps the main model and resolves its level', () => {
    const status = describeConfig(buildConfig({ subagentModel: null, workerEffort: 'x' }), groups, current)
    assert.equal(status.ownModel, false)
    assert.equal(status.explicitEffort, true)
    assert.equal(status.effort, 'x') // the main route has no ladder here: the raw id stands
  })

  it('falls back to raw ids when the catalog lacks the model or the level', () => {
    const unknown = buildConfig({
      subagentModel: { provider: 'openrouter', model: 'acme/mystery-9000', reasoningEffort: 'ultra' },
      workerEffort: 'ultra',
    })
    const status = describeConfig(unknown, groups, current)
    assert.equal(status.model, 'acme/mystery-9000') // not in the catalog: the id stands
    assert.equal(status.effort, 'ultra')
  })

  it('names a catalog model that has no reasoning ladder', () => {
    const status = describeConfig(buildConfig({ subagentModel: { provider: 'openrouter', model: 'moonshotai/kimi-k3' } }), groups, current)
    assert.equal(status.model, 'Kimi K3')
    assert.equal(status.explicitEffort, false)
  })
})
