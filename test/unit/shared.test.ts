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
  const valid = { version: 1, subagentModel: route, workerEffort: null }

  it('round-trips a valid configuration', () => {
    assert.deepEqual(parseConfig(valid), valid)
    assert.deepEqual(parseConfig(JSON.parse(JSON.stringify(OFF_CONFIG))), OFF_CONFIG)
  })

  it('treats a missing model and a missing effort as null', () => {
    assert.deepEqual(parseConfig({ version: 1 }), { version: 1, subagentModel: null, workerEffort: null })
  })

  it('reads the reasoning effort', () => {
    assert.equal(parseConfig({ ...valid, workerEffort: 'low' })?.workerEffort, 'low')
    assert.equal(parseConfig({ ...valid, workerEffort: '' }), undefined)
    assert.equal(parseConfig({ ...valid, workerEffort: 3 }), undefined)
    assert.equal(parseConfig({ ...valid, workerEffort: 'a\nb' }), undefined)
  })

  it('loads what 0.4.0 and older wrote: the reviewer block and the `remember` flag are dropped, the model the user picked stays', () => {
    const legacy = { ...valid, workerEffort: 'high', reviewer: { enabled: true, model: { provider: 'p', model: 'm' }, effort: 'low' }, remember: true }
    assert.deepEqual(parseConfig(legacy), { version: 1, subagentModel: route, workerEffort: 'high' })
    // Whatever the reviewer block holds, even something malformed, it is no reason to lose the choice.
    assert.deepEqual(parseConfig({ ...valid, reviewer: 'garbage' }), valid)
    assert.deepEqual(parseConfig({ ...valid, reviewer: { enabled: 'no' } }), valid)
    // A reviewer-only record (no subagent model) becomes the inert configuration.
    assert.deepEqual(parseConfig({ version: 1, subagentModel: null, workerEffort: null, reviewer: { enabled: true, model: null, effort: null } }), OFF_CONFIG)
  })

  it('rejects a wrong version and malformed routes', () => {
    assert.equal(parseConfig({ ...valid, version: 2 }), undefined)
    assert.equal(parseConfig({ ...valid, subagentModel: { provider: 'p' } }), undefined)
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

  it('is true with a subagent model, and with an explicit effort alone', () => {
    assert.equal(isActive(buildConfig({ subagentModel: route })), true)
    assert.equal(isActive(buildConfig({ subagentModel: null, workerEffort: 'low' })), true)
  })
})

describe('buildConfig', () => {
  it('carries the model and the effort, and defaults the effort to the recommended level', () => {
    assert.deepEqual(buildConfig({ subagentModel: route }), { version: 1, subagentModel: route, workerEffort: null })
    assert.deepEqual(buildConfig({ subagentModel: route, workerEffort: 'low' }), { version: 1, subagentModel: route, workerEffort: 'low' })
  })
})

describe('routeKey', () => {
  it('joins provider and model', () => {
    assert.equal(routeKey(route), 'openrouter/google/gemini-3.8-flash')
  })
})
