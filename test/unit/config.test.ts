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
    assert.equal(parsed.reviewerContext, 'auto')
    assert.equal(parsed.structuredVerdict, true)
    assert.deepEqual(parsed.effort, { enabled: true, caps: {} })
    assert.deepEqual(parsed.limits, { worker: 64_000, reviewer: 32_000 })
    assert.equal(parsed.retryOnTokenLimit, true)
    assert.equal(parsed.workspaceChecks, true)
    assert.deepEqual(parsed.sensitivePaths, [])
  })

  it('resolves the effort ceilings, the token limits and the reviewer context', () => {
    assert.deepEqual(parsePluginConfig({ effort: false }).effort, { enabled: false, caps: {} })
    assert.deepEqual(parsePluginConfig({ effort: { worker: 'low', reviewer: 'high' } }).effort, { enabled: true, caps: { worker: 'low', reviewer: 'high' } })
    assert.deepEqual(parsePluginConfig({ effort: { reviewer: 'xhigh' } }).effort, { enabled: true, caps: { reviewer: 'xhigh' } })
    assert.deepEqual(parsePluginConfig({ limits: false }).limits, { worker: undefined, reviewer: undefined })
    assert.deepEqual(parsePluginConfig({ limits: { workerMaxTokens: 8000, reviewerMaxTokens: false } }).limits, { worker: 8000, reviewer: undefined })
    assert.deepEqual(parsePluginConfig({ limits: { workerMaxTokens: 8000 } }).limits, { worker: 8000, reviewer: 32_000 })
    for (const mode of ['auto', 'isolated', 'claims'] as const) assert.equal(parsePluginConfig({ reviewerContext: mode }).reviewerContext, mode)
    assert.equal(parsePluginConfig({ structuredVerdict: false, retryOnTokenLimit: false, workspaceChecks: false }).structuredVerdict, false)
  })

  it('compiles the extra sensitive-path globs', () => {
    const parsed = parsePluginConfig({ sensitivePaths: ['db/migrations/**', 'Makefile.ci'] })
    assert.equal(parsed.sensitivePaths.length, 2)
    assert.equal(parsed.sensitivePaths[0]?.test('db/migrations/001_init.sql'), true)
    assert.equal(parsed.sensitivePaths[1]?.test('ops/makefile.ci'), true)
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
      version: 1, subagentModel: { provider: 'p', model: 'm' }, workerEffort: null, reviewer: { enabled: false, model: null, effort: null }, remember: true,
    })
    const withReviewer = parsePluginConfig({ defaults: { reviewer: { enabled: true, model: { provider: 'q', model: 'n' } } } })
    assert.deepEqual(withReviewer.defaults?.reviewer, { enabled: true, model: { provider: 'q', model: 'n' }, effort: null })
    const withEfforts = parsePluginConfig({ defaults: { subagentModel: { provider: 'p', model: 'm' }, workerEffort: 'low', reviewer: { enabled: true, effort: 'high' } } })
    assert.equal(withEfforts.defaults?.workerEffort, 'low')
    assert.equal(withEfforts.defaults?.reviewer.effort, 'high')
  })

  it('fails loud on malformed values', () => {
    assert.throws(() => parsePluginConfig({ defaults: { subagentModel: { provider: 'p' } as never } }), /defaults\.subagentModel/)
    assert.throws(() => parsePluginConfig({ defaults: { reviewer: { enabled: 'yes' as never } } }), /defaults\.reviewer\.enabled/)
    assert.throws(() => parsePluginConfig({ maxSessions: 0 }), /maxSessions/)
    assert.throws(() => parsePluginConfig({ maxWorkerReportChars: 1.5 }), /maxWorkerReportChars/)
    assert.throws(() => parsePluginConfig({ persist: 'no' as never }), /persist/)
    assert.throws(() => parsePluginConfig({ reviewerProvider: '  ' }), /reviewerProvider/)
    assert.throws(() => parsePluginConfig({ stateDir: '' }), /stateDir/)
    assert.throws(() => parsePluginConfig({ effort: { worker: 'turbo' } }), /effort\.worker/)
    assert.throws(() => parsePluginConfig({ defaults: { workerEffort: 'turbo', subagentModel: { provider: 'p', model: 'm' } } }), /defaults\.workerEffort/)
    assert.throws(() => parsePluginConfig({ effort: true as never }), /effort/)
    assert.throws(() => parsePluginConfig({ limits: { workerMaxTokens: 0 } }), /limits\.workerMaxTokens/)
    assert.throws(() => parsePluginConfig({ limits: { reviewerMaxTokens: 'big' as never } }), /limits\.reviewerMaxTokens/)
    assert.throws(() => parsePluginConfig({ reviewerContext: 'sometimes' as never }), /reviewerContext/)
    assert.throws(() => parsePluginConfig({ sensitivePaths: [''] }), /sensitivePaths/)
    assert.throws(() => parsePluginConfig({ structuredVerdict: 'yes' as never }), /structuredVerdict/)
  })
})
