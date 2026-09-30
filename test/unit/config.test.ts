import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parsePluginConfig } from '../../src/config.ts'

describe('parsePluginConfig', () => {
  it('defaults to the two tools of the shipped standard preset', () => {
    const parsed = parsePluginConfig(undefined)
    assert.deepEqual(parsed.tools, [
      { name: 'subagent', provider: 'spawn', mode: 'continuable' },
      { name: 'subagent_fork', provider: 'fork', mode: 'continuable' },
    ])
    assert.equal(parsed.reviewerProvider, 'spawn')
    assert.equal(parsed.defaults, null)
    assert.equal(parsed.persist, true)
    assert.equal(parsed.workerHandoff, true)
    assert.equal(parsed.maxWorkerReportChars, 60_000)
    assert.equal(parsed.maxSessions, 500)
  })

  it('resolves explicit tools and rejects duplicates or bad modes', () => {
    const parsed = parsePluginConfig({ tools: [{ name: 'delegate', provider: 'spawn', mode: 'one-shot' }] })
    assert.deepEqual(parsed.tools, [{ name: 'delegate', provider: 'spawn', mode: 'one-shot' }])
    assert.throws(() => parsePluginConfig({ tools: [] }), /non-empty array/)
    assert.throws(() => parsePluginConfig({ tools: [{ name: 'a', provider: 'spawn' }, { name: 'a', provider: 'fork' }] }), /repeats "a"/)
    assert.throws(() => parsePluginConfig({ tools: [{ name: 'a', provider: 'spawn', mode: 'background' as never }] }), /continuable/)
    assert.throws(() => parsePluginConfig({ tools: [{ provider: 'spawn' }] }), /tools\[0\]\.name/)
    assert.throws(() => parsePluginConfig({ tools: [{ name: 'a' }] }), /tools\[0\]\.provider/)
  })

  it('builds headless defaults only when something is switched on', () => {
    assert.equal(parsePluginConfig({ defaults: {} }).defaults, null)
    const withModel = parsePluginConfig({ defaults: { subagentModel: { provider: 'p', model: 'm' } } })
    assert.deepEqual(withModel.defaults, {
      version: 1, subagentModel: { provider: 'p', model: 'm' }, reviewer: { enabled: false, model: null }, remember: true,
    })
    const withReviewer = parsePluginConfig({ defaults: { reviewer: { enabled: true, model: { provider: 'q', model: 'n' } } } })
    assert.deepEqual(withReviewer.defaults?.reviewer, { enabled: true, model: { provider: 'q', model: 'n' } })
  })

  it('fails loud on malformed values', () => {
    assert.throws(() => parsePluginConfig({ defaults: { subagentModel: { provider: 'p' } as never } }), /defaults\.subagentModel/)
    assert.throws(() => parsePluginConfig({ defaults: { reviewer: { enabled: 'yes' as never } } }), /defaults\.reviewer\.enabled/)
    assert.throws(() => parsePluginConfig({ maxSessions: 0 }), /maxSessions/)
    assert.throws(() => parsePluginConfig({ maxWorkerReportChars: 1.5 }), /maxWorkerReportChars/)
    assert.throws(() => parsePluginConfig({ persist: 'no' as never }), /persist/)
    assert.throws(() => parsePluginConfig({ reviewerProvider: '  ' }), /reviewerProvider/)
    assert.throws(() => parsePluginConfig({ stateDir: '' }), /stateDir/)
  })
})
