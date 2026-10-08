import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parsePluginConfig, removedConfigFields, unknownConfigFields } from '../../src/config.ts'

describe('parsePluginConfig', () => {
  it('defaults to: no defaults, persisted choices, effort ceilings on, a 64 000-token cap, the guard on', () => {
    const parsed = parsePluginConfig(undefined)
    assert.equal(parsed.defaults, null)
    assert.equal(parsed.persist, true)
    assert.equal(parsed.maxSessions, 500)
    assert.deepEqual(parsed.effort, { enabled: true })
    assert.deepEqual(parsed.limits, { worker: 64_000 })
    assert.deepEqual(parsed.guard, { enabled: true, explicitModel: 'override' })
    assert.deepEqual(parsed.skill, { enabled: true, modelInvocable: true })
  })

  it('resolves the effort ceiling and the token limit', () => {
    assert.deepEqual(parsePluginConfig({ effort: false }).effort, { enabled: false })
    assert.deepEqual(parsePluginConfig({ effort: { worker: 'low' } }).effort, { enabled: true, cap: 'low' })
    assert.deepEqual(parsePluginConfig({ effort: {} }).effort, { enabled: true })
    assert.deepEqual(parsePluginConfig({ limits: false }).limits, { worker: undefined })
    assert.deepEqual(parsePluginConfig({ limits: { workerMaxTokens: 8000 } }).limits, { worker: 8000 })
    assert.deepEqual(parsePluginConfig({ limits: { workerMaxTokens: false } }).limits, { worker: undefined })
    assert.deepEqual(parsePluginConfig({ limits: {} }).limits, { worker: 64_000 })
  })

  it('builds headless defaults only when something is switched on', () => {
    assert.equal(parsePluginConfig({ defaults: {} }).defaults, null)
    const withModel = parsePluginConfig({ defaults: { subagentModel: { provider: 'p', model: 'm' } } })
    assert.deepEqual(withModel.defaults, { version: 1, subagentModel: { provider: 'p', model: 'm' }, workerEffort: null })
    const withBoth = parsePluginConfig({ defaults: { subagentModel: { provider: 'p', model: 'm' }, workerEffort: 'low' } })
    assert.equal(withBoth.defaults?.workerEffort, 'low')
    // An effort alone is a choice too: the ceiling applies to the children on the main agent's model.
    assert.deepEqual(parsePluginConfig({ defaults: { workerEffort: 'medium' } }).defaults, { version: 1, subagentModel: null, workerEffort: 'medium' })
  })

  it('fails loud on malformed values', () => {
    assert.throws(() => parsePluginConfig({ defaults: { subagentModel: { provider: 'p' } as never } }), /defaults\.subagentModel/)
    assert.throws(() => parsePluginConfig({ maxSessions: 0 }), /maxSessions/)
    assert.throws(() => parsePluginConfig({ persist: 'no' as never }), /persist/)
    assert.throws(() => parsePluginConfig({ stateDir: '' }), /stateDir/)
    assert.throws(() => parsePluginConfig({ effort: { worker: 'turbo' } }), /effort\.worker/)
    assert.throws(() => parsePluginConfig({ defaults: { workerEffort: 'turbo', subagentModel: { provider: 'p', model: 'm' } } }), /defaults\.workerEffort/)
    assert.throws(() => parsePluginConfig({ effort: true as never }), /effort/)
    assert.throws(() => parsePluginConfig({ limits: { workerMaxTokens: 0 } }), /limits\.workerMaxTokens/)
    assert.throws(() => parsePluginConfig({ limits: true as never }), /limits/)
    assert.throws(() => parsePluginConfig({ children: true as never }), /children/)
    assert.throws(() => parsePluginConfig({ children: [] as never }), /children/)
    assert.throws(() => parsePluginConfig({ children: { explicitModel: 'sometimes' as never } }), /children\.explicitModel/)
    assert.throws(() => parsePluginConfig({ children: { explicitModels: 'keep' } as never }), /children\.explicitModels.*not a known field/)
  })

  it('turns the start guard on by default, overriding a model the caller names itself', () => {
    assert.deepEqual(parsePluginConfig(undefined).guard, { enabled: true, explicitModel: 'override' })
    assert.deepEqual(parsePluginConfig({ children: {} }).guard, { enabled: true, explicitModel: 'override' })
  })

  it('lets the operator keep a caller\'s model or switch the enforcement off', () => {
    assert.deepEqual(parsePluginConfig({ children: { explicitModel: 'keep' } }).guard, { enabled: true, explicitModel: 'keep' })
    assert.deepEqual(parsePluginConfig({ children: false }).guard, { enabled: false, explicitModel: 'override' })
  })

  it('rejects an empty `children:` key (YAML null) by name instead of crashing on it', () => {
    assert.throws(() => parsePluginConfig({ children: null as never }), /invalid config field "children": must be false or an object/)
  })

  it('registers the global skill by default, in the model\'s catalog too', () => {
    assert.deepEqual(parsePluginConfig(undefined).skill, { enabled: true, modelInvocable: true })
    assert.deepEqual(parsePluginConfig({}).skill, { enabled: true, modelInvocable: true })
    assert.deepEqual(parsePluginConfig({ skill: {} }).skill, { enabled: true, modelInvocable: true })
    assert.deepEqual(parsePluginConfig({ skill: { modelInvocable: true } }).skill, { enabled: true, modelInvocable: true })
  })

  it('lets the operator keep the skill out of the model\'s catalog, or not register it at all', () => {
    assert.deepEqual(parsePluginConfig({ skill: { modelInvocable: false } }).skill, { enabled: true, modelInvocable: false })
    assert.deepEqual(parsePluginConfig({ skill: false }).skill, { enabled: false, modelInvocable: true })
  })

  it('leaves the rest of the configuration alone when it resolves the skill', () => {
    const parsed = parsePluginConfig({ skill: false, children: { explicitModel: 'keep' }, limits: { workerMaxTokens: 8000 } })
    assert.deepEqual(parsed.guard, { enabled: true, explicitModel: 'keep' })
    assert.deepEqual(parsed.limits, { worker: 8000 })
    assert.deepEqual(parsed.effort, { enabled: true })
  })

  it('fails loud on a malformed skill block, naming the field', () => {
    assert.throws(() => parsePluginConfig({ skill: { modelInvokable: false } as never }), /invalid config field "skill\.modelInvokable": is not a known field \(modelInvocable\)/)
    assert.throws(() => parsePluginConfig({ skill: { modelInvocable: false, extra: 1 } as never }), /skill\.extra.*not a known field/)
    assert.throws(() => parsePluginConfig({ skill: { modelInvocable: 'no' as never } }), /invalid config field "skill\.modelInvocable": must be a boolean/)
    assert.throws(() => parsePluginConfig({ skill: { modelInvocable: 0 as never } }), /skill\.modelInvocable.*must be a boolean/)
    assert.throws(() => parsePluginConfig({ skill: { modelInvocable: null as never } }), /skill\.modelInvocable.*must be a boolean/)
    for (const value of [true, 'yes', 1, [], null]) {
      assert.throws(() => parsePluginConfig({ skill: value as never }), /invalid config field "skill": must be false or an object/, `skill: ${JSON.stringify(value)}`)
    }
  })

  it('still loads a patch file written for 0.4.0: the reviewer fields are ignored, never a load error', () => {
    const legacy = {
      tools: [{ name: 'subagent', provider: 'spawn', mode: 'continuable' }],
      reviewerProvider: 'spawn', reviewerContext: 'claims', structuredVerdict: false, workerHandoff: false, maxWorkerReportChars: 10,
      retryOnTokenLimit: false, workspaceChecks: false, sensitivePaths: ['db/**'],
      defaults: { subagentModel: { provider: 'p', model: 'm' }, workerEffort: 'low', reviewer: { enabled: true, model: { provider: 'q', model: 'n' }, effort: 'high' } },
      effort: { worker: 'low', reviewer: 'turbo' }, // even a level the reviewer never had to be valid
      limits: { workerMaxTokens: 8000, reviewerMaxTokens: 'big' },
    } as never
    const parsed = parsePluginConfig(legacy)
    assert.deepEqual(parsed.defaults, { version: 1, subagentModel: { provider: 'p', model: 'm' }, workerEffort: 'low' })
    assert.deepEqual(parsed.effort, { enabled: true, cap: 'low' })
    assert.deepEqual(parsed.limits, { worker: 8000 })
  })
})

describe('the fields the plugin warns about', () => {
  it('names the top-level fields it does not know, with a hint where a mis-indented one belongs', () => {
    assert.deepEqual(unknownConfigFields(undefined), [])
    assert.deepEqual(unknownConfigFields({ children: { explicitModel: 'keep' }, effort: false }), [])
    assert.deepEqual(unknownConfigFields({ explicitModel: 'keep' }), ['unknown config field "explicitModel" is ignored (did you mean children.explicitModel?)'])
    assert.deepEqual(unknownConfigFields({ workerMaxTokens: 1, subagentModel: {}, colour: 'blue' }), [
      'unknown config field "workerMaxTokens" is ignored (did you mean limits.workerMaxTokens?)',
      'unknown config field "subagentModel" is ignored (did you mean defaults.subagentModel?)',
      'unknown config field "colour" is ignored',
    ])
    assert.deepEqual(unknownConfigFields(null), [])
    assert.deepEqual(unknownConfigFields([]), [])
  })

  it('knows every field the configuration documents, and points each mis-indented block field at its block', () => {
    assert.deepEqual(unknownConfigFields({ defaults: {}, stateDir: 'x', persist: true, maxSessions: 1, effort: false, limits: false, children: false, skill: false }), [])
    assert.deepEqual(unknownConfigFields({ worker: 'low', workerEffort: 'low' }), [
      'unknown config field "worker" is ignored (did you mean effort.worker?)',
      'unknown config field "workerEffort" is ignored (did you mean defaults.workerEffort?)',
    ])
  })

  it('knows the skill block, and points a mis-indented modelInvocable at it', () => {
    assert.deepEqual(unknownConfigFields({ skill: false }), [])
    assert.deepEqual(unknownConfigFields({ skill: { modelInvocable: false } }), [])
    assert.deepEqual(unknownConfigFields({ modelInvocable: false }), ['unknown config field "modelInvocable" is ignored (did you mean skill.modelInvocable?)'])
    assert.deepEqual(unknownConfigFields({ skill: {}, modelInvocable: true, colour: 'blue' }), [
      'unknown config field "modelInvocable" is ignored (did you mean skill.modelInvocable?)',
      'unknown config field "colour" is ignored',
    ])
  })

  it('says, once per field, that a reviewer field of 0.4.0 does nothing now, and does not call it unknown', () => {
    const legacy = { tools: [], reviewerContext: 'auto', defaults: { reviewer: { enabled: true } }, effort: { reviewer: 'low' }, limits: { reviewerMaxTokens: 1 } }
    assert.deepEqual(unknownConfigFields(legacy), [])
    assert.deepEqual(removedConfigFields(legacy), [
      'config field "tools" belonged to the independent reviewer, removed in 0.5.0, and is ignored',
      'config field "reviewerContext" belonged to the independent reviewer, removed in 0.5.0, and is ignored',
      'config field "defaults.reviewer" belonged to the independent reviewer, removed in 0.5.0, and is ignored',
      'config field "effort.reviewer" belonged to the independent reviewer, removed in 0.5.0, and is ignored',
      'config field "limits.reviewerMaxTokens" belonged to the independent reviewer, removed in 0.5.0, and is ignored',
    ])
    assert.deepEqual(removedConfigFields({ defaults: {}, effort: false, limits: false }), [])
    assert.deepEqual(removedConfigFields(undefined), [])
    assert.deepEqual(removedConfigFields([]), [])
  })
})
