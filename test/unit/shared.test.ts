import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { OFF_CONFIG, buildConfig, isActive, parseConfig, parseModelRoute, routeKey } from '../../src/shared.ts'

const route = { provider: 'openrouter', model: 'google/gemini-3.8-flash' }

describe('parseModelRoute', () => {
  it('accepts provider and model, with an optional effort', () => {
    assert.deepEqual(parseModelRoute(route), route)
    assert.deepEqual(parseModelRoute({ ...route, reasoningEffort: 'high' }), { ...route, reasoningEffort: 'high' })
  })

  it('rejects empty, non-string, oversized and control-character ids', () => {
    assert.equal(parseModelRoute({ provider: '', model: 'x' }), undefined)
    assert.equal(parseModelRoute({ provider: 'p', model: 3 }), undefined)
    assert.equal(parseModelRoute({ provider: 'p', model: 'x'.repeat(257) }), undefined)
    assert.equal(parseModelRoute({ provider: 'p', model: 'a\nb' }), undefined)
    assert.equal(parseModelRoute({ ...route, reasoningEffort: '' }), undefined)
    assert.equal(parseModelRoute(null), undefined)
    assert.equal(parseModelRoute([route]), undefined)
  })

  it('drops unknown fields instead of carrying them along', () => {
    assert.deepEqual(parseModelRoute({ ...route, extra: 'x' }), route)
  })
})

describe('parseConfig', () => {
  const valid = { version: 1, subagentModel: route, workerEffort: null, reviewer: { enabled: true, model: null, effort: null }, remember: false }

  it('round-trips a valid configuration', () => {
    assert.deepEqual(parseConfig(valid), valid)
    assert.deepEqual(parseConfig(JSON.parse(JSON.stringify(OFF_CONFIG))), OFF_CONFIG)
  })

  it('treats a missing model as null', () => {
    const parsed = parseConfig({ version: 1, reviewer: { enabled: false }, remember: true })
    assert.deepEqual(parsed, { version: 1, subagentModel: null, workerEffort: null, reviewer: { enabled: false, model: null, effort: null }, remember: true })
  })

  it('reads the reasoning efforts, and loads a configuration written before they existed', () => {
    const withEfforts = parseConfig({ ...valid, workerEffort: 'low', reviewer: { enabled: true, model: null, effort: 'high' } })
    assert.equal(withEfforts?.workerEffort, 'low')
    assert.equal(withEfforts?.reviewer.effort, 'high')
    const legacy = { version: 1, subagentModel: route, reviewer: { enabled: true, model: null }, remember: false }
    assert.deepEqual(parseConfig(legacy), valid)
    assert.equal(parseConfig({ ...valid, workerEffort: '' }), undefined)
    assert.equal(parseConfig({ ...valid, workerEffort: 3 }), undefined)
    assert.equal(parseConfig({ ...valid, reviewer: { enabled: true, model: null, effort: 'a\nb' } }), undefined)
  })

  it('rejects a wrong version, missing flags and malformed routes', () => {
    assert.equal(parseConfig({ ...valid, version: 2 }), undefined)
    assert.equal(parseConfig({ ...valid, remember: 'yes' }), undefined)
    assert.equal(parseConfig({ ...valid, reviewer: { enabled: 'no' } }), undefined)
    assert.equal(parseConfig({ ...valid, subagentModel: { provider: 'p' } }), undefined)
    assert.equal(parseConfig({ ...valid, reviewer: { enabled: true, model: { model: 'm' } } }), undefined)
    assert.equal(parseConfig('nope'), undefined)
    assert.equal(parseConfig(undefined), undefined)
  })
})

describe('isActive', () => {
  it('is false for null, undefined and the inert configuration', () => {
    assert.equal(isActive(null), false)
    assert.equal(isActive(undefined), false)
    assert.equal(isActive(OFF_CONFIG), false)
  })

  it('is true with a subagent model or the reviewer', () => {
    assert.equal(isActive(buildConfig({ subagentModel: route, reviewerEnabled: false, reviewerModel: null, remember: false })), true)
    assert.equal(isActive(buildConfig({ subagentModel: null, reviewerEnabled: true, reviewerModel: null, remember: false })), true)
  })
})

describe('buildConfig', () => {
  it('drops the reviewer model while the reviewer is off', () => {
    const built = buildConfig({ subagentModel: null, reviewerEnabled: false, reviewerModel: route, remember: true })
    assert.equal(built.reviewer.model, null)
    assert.equal(built.reviewer.enabled, false)
    assert.equal(built.remember, true)
  })

  it('keeps the reviewer model while it is on', () => {
    const built = buildConfig({ subagentModel: route, reviewerEnabled: true, reviewerModel: route, remember: false })
    assert.deepEqual(built.reviewer, { enabled: true, model: route, effort: null })
  })

  it('carries the efforts, and drops the reviewer effort while the reviewer is off', () => {
    const on = buildConfig({ subagentModel: null, reviewerEnabled: true, reviewerModel: null, remember: false, workerEffort: 'low', reviewerEffort: 'high' })
    assert.equal(on.workerEffort, 'low')
    assert.equal(on.reviewer.effort, 'high')
    const off = buildConfig({ subagentModel: null, reviewerEnabled: false, reviewerModel: null, remember: false, workerEffort: 'low', reviewerEffort: 'high' })
    assert.equal(off.reviewer.effort, null)
  })
})

describe('routeKey', () => {
  it('joins provider and model', () => {
    assert.equal(routeKey(route), 'openrouter/google/gemini-3.8-flash')
  })
})
