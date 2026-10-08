import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CONFIG_ROUTE, LEGACY_REVIEWER, MAX_SUBAGENTS_PER_RESPONSE, OFF_CONFIG, ROUTE_PREFIX, SKILL_NAME, SUBAGENTS_ROUTE,
  buildConfig, isActive, parseConfig, parseModelRoute, parseSkillOffer, parseSubagentRecord, parseSubagentsPayload, routeKey,
  subagentStateOf, toWireConfig,
} from '../../src/shared.ts'
import { legacyParseConfig } from '../legacy-wire.ts'

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

describe('the wire shape every version accepts', () => {
  const samples = [
    ['a model and an effort', buildConfig({ subagentModel: route, workerEffort: 'high' })],
    ['a model only', buildConfig({ subagentModel: route })],
    ['an effort only', buildConfig({ subagentModel: null, workerEffort: 'low' })],
    ['a route that carries its own effort', buildConfig({ subagentModel: { ...route, reasoningEffort: 'xhigh' } })],
    ['the inert configuration', OFF_CONFIG],
  ] as const

  it('adds the disabled legacy reviewer block and leaves the input alone', () => {
    const config = buildConfig({ subagentModel: route, workerEffort: 'low' })
    const wire = toWireConfig(config)
    assert.deepEqual(wire, { version: 1, subagentModel: route, workerEffort: 'low', reviewer: { enabled: false, model: null, effort: null } })
    assert.equal(wire.reviewer, LEGACY_REVIEWER)
    assert.equal('reviewer' in config, false, 'the configuration itself never carries it')
    assert.throws(() => { (LEGACY_REVIEWER as { enabled: boolean }).enabled = true }, TypeError, 'frozen: nobody can switch the legacy reviewer on')
  })

  it('is what 0.2 to 0.4 accept, so a half that is one version behind can still save and read', () => {
    for (const [name, config] of samples) {
      const old = legacyParseConfig(toWireConfig(config))
      assert.notEqual(old, undefined, `0.4 refuses ${name}`)
      assert.equal(old?.reviewer.enabled, false, name)
      assert.deepEqual(old?.subagentModel, config.subagentModel, name)
      assert.equal(old?.workerEffort, config.workerEffort, name)
    }
  })

  it('is exactly the shape the old halves refuse without the block (why it is there)', () => {
    for (const [name, config] of samples) assert.equal(legacyParseConfig(config), undefined, `0.4 would have accepted ${name} without the block`)
  })

  it('reads back as the same configuration here (the block is dropped, nothing else changes)', () => {
    for (const [name, config] of samples) assert.deepEqual(parseConfig(toWireConfig(config)), config, name)
  })
})

describe('routeKey', () => {
  it('joins provider and model', () => {
    assert.equal(routeKey(route), 'openrouter/google/gemini-3.8-flash')
  })
})

describe('the routes and the skill name', () => {
  it('keeps the paths the two halves agree on, and a skill name its own grammar accepts', () => {
    assert.equal(ROUTE_PREFIX, '/dsh-orquestrator')
    assert.equal(CONFIG_ROUTE, '/dsh-orquestrator/config')
    assert.equal(SUBAGENTS_ROUTE, '/dsh-orquestrator/subagents')
    assert.equal(SKILL_NAME, 'orchestrate-subagents')
    assert.deepEqual(parseSkillOffer({ name: SKILL_NAME, available: true }), { name: SKILL_NAME, available: true })
  })
})

describe('parseSkillOffer', () => {
  it('reads a name and whether the skill is available', () => {
    assert.deepEqual(parseSkillOffer({ name: 'orchestrate-subagents', available: true }), { name: 'orchestrate-subagents', available: true })
    assert.deepEqual(parseSkillOffer({ name: 'x', available: false }), { name: 'x', available: false })
  })

  it('drops fields it does not know instead of carrying them along', () => {
    assert.deepEqual(parseSkillOffer({ name: 'a-b', available: true, extra: 'x', path: '/etc/passwd' }), { name: 'a-b', available: true })
  })

  it('takes a name of 64 characters and refuses one of 65', () => {
    assert.deepEqual(parseSkillOffer({ name: 'a'.repeat(64), available: true }), { name: 'a'.repeat(64), available: true })
    assert.equal(parseSkillOffer({ name: 'a'.repeat(65), available: true }), null)
  })

  it('is DSH\'s skill-name grammar: lowercase words and digits joined by single hyphens', () => {
    for (const name of ['a', 'a1', '1a', 'orchestrate-subagents', 'a-b-c', '0-9']) assert.notEqual(parseSkillOffer({ name, available: true }), null, name)
    for (const name of ['', 'Upper', 'two words', 'under_score', '-lead', 'trail-', 'double--hyphen', 'dot.name', 'slash/name', 'ä', 'new\nline', ' a']) {
      assert.equal(parseSkillOffer({ name, available: true }), null, JSON.stringify(name))
    }
  })

  it('needs a boolean `available`, and a name that is a string', () => {
    for (const available of ['true', 1, 0, null, undefined, {}]) assert.equal(parseSkillOffer({ name: 'a', available }), null, String(available))
    assert.equal(parseSkillOffer({ name: 'a' }), null)
    for (const name of [1, null, undefined, ['a'], {}]) assert.equal(parseSkillOffer({ name, available: true }), null, String(name))
  })

  it('answers null for anything that is not an object: a host that predates the skill sends nothing', () => {
    for (const value of [undefined, null, 'orchestrate-subagents', 5, true, [], [{ name: 'a', available: true }]]) assert.equal(parseSkillOffer(value), null, String(value))
  })
})

describe('subagentStateOf', () => {
  it('maps a normal completion to done and a cancellation to stopped', () => {
    assert.equal(subagentStateOf('completed'), 'done')
    assert.equal(subagentStateOf('aborted'), 'stopped')
  })

  it('counts every other ending as a failure, including a reason a backend adds later', () => {
    for (const reason of ['error', 'max-tokens', 'refusal', 'a-reason-nobody-has-met', '', 'COMPLETED', 'interrupted']) assert.equal(subagentStateOf(reason), 'failed', reason)
  })
})

describe('parseSubagentRecord', () => {
  const record = {
    id: 'child-1', parentId: 'main', backend: 'spawn', route: { provider: 'azure-opencode', model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'medium' },
    state: 'done', stopReason: 'completed', startedAt: 1000, endedAt: 2000,
  }

  it('round-trips a record, route included', () => {
    assert.deepEqual(parseSubagentRecord(record), record)
    assert.deepEqual(parseSubagentRecord(JSON.parse(JSON.stringify(record))), record)
  })

  it('reads a running child: no stop reason, no end', () => {
    const running = { ...record, state: 'running', stopReason: null, endedAt: null }
    assert.deepEqual(parseSubagentRecord(running), running)
  })

  it('takes absent nullable fields as null, so a record written without them still loads', () => {
    assert.deepEqual(parseSubagentRecord({ id: 'a', backend: 'spawn', state: 'running', startedAt: 5 }), {
      id: 'a', parentId: null, backend: 'spawn', route: null, state: 'running', stopReason: null, startedAt: 5, endedAt: null,
    })
  })

  it('drops fields it does not know, and normalizes the route', () => {
    const parsed = parseSubagentRecord({ ...record, extra: 'x', route: { ...record.route, apiKey: 'sk-secret' } })
    assert.deepEqual(parsed, record)
    assert.equal('extra' in (parsed ?? {}), false)
  })

  it('knows the four states and nothing else', () => {
    for (const state of ['running', 'done', 'failed', 'stopped']) assert.notEqual(parseSubagentRecord({ ...record, state }), undefined, state)
    for (const state of ['', 'Done', 'finished', 'interrupted', 1, null, undefined, ['done']]) assert.equal(parseSubagentRecord({ ...record, state }), undefined, String(state))
  })

  it('takes an id, a parent, a backend and a stop reason of 256 characters and refuses 257, an empty one, or a control character', () => {
    for (const field of ['id', 'parentId', 'backend', 'stopReason'] as const) {
      assert.notEqual(parseSubagentRecord({ ...record, [field]: 'x'.repeat(256) }), undefined, `${field} at 256`)
      assert.equal(parseSubagentRecord({ ...record, [field]: 'x'.repeat(257) }), undefined, `${field} at 257`)
      assert.equal(parseSubagentRecord({ ...record, [field]: '' }), undefined, `${field} empty`)
      assert.equal(parseSubagentRecord({ ...record, [field]: 'a\nb' }), undefined, `${field} with a newline`)
      assert.equal(parseSubagentRecord({ ...record, [field]: 'a\u007fb' }), undefined, `${field} with DEL`)
      assert.equal(parseSubagentRecord({ ...record, [field]: 5 }), undefined, `${field} a number`)
    }
  })

  it('needs an id and a backend, but not a parent, a stop reason or a route', () => {
    const { id, backend, ...rest } = record
    assert.equal(parseSubagentRecord(rest), undefined)
    assert.equal(parseSubagentRecord({ id, ...rest }), undefined)
    assert.equal(parseSubagentRecord({ backend, ...rest }), undefined)
    assert.notEqual(parseSubagentRecord({ ...record, parentId: null, stopReason: null, route: null }), undefined)
  })

  it('refuses a malformed route instead of keeping the record without it', () => {
    for (const route of [{ provider: 'p' }, { model: 'm' }, { provider: '', model: 'm' }, { provider: 'p', model: 'm', reasoningEffort: '' }, 'p/m', 5, []]) {
      assert.equal(parseSubagentRecord({ ...record, route }), undefined, JSON.stringify(route))
    }
  })

  it('takes times that are finite and not negative', () => {
    for (const startedAt of [0, 1, 1.5, 1_800_000_000_000]) assert.notEqual(parseSubagentRecord({ ...record, startedAt }), undefined, String(startedAt))
    for (const startedAt of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '1000', null, undefined, {}]) {
      assert.equal(parseSubagentRecord({ ...record, startedAt }), undefined, String(startedAt))
    }
    for (const endedAt of [-1, Number.NaN, Number.POSITIVE_INFINITY, '2000', {}]) assert.equal(parseSubagentRecord({ ...record, endedAt }), undefined, String(endedAt))
    assert.notEqual(parseSubagentRecord({ ...record, endedAt: 0 }), undefined)
  })

  it('answers undefined for anything that is not an object', () => {
    for (const value of [undefined, null, 'child-1', 5, true, [], [record]]) assert.equal(parseSubagentRecord(value), undefined, String(value))
  })

  it('does not let a hostile key reach the prototype', () => {
    const parsed = parseSubagentRecord(JSON.parse('{"id":"a","backend":"spawn","state":"running","startedAt":1,"__proto__":{"state":"done"},"constructor":{"x":1}}'))
    assert.equal(parsed?.state, 'running')
    assert.equal(({} as Record<string, unknown>)['state'], undefined)
  })
})

describe('parseSubagentsPayload', () => {
  const record = (id: string): Record<string, unknown> => ({
    id, parentId: 'main', backend: 'spawn', route: null, state: 'done', stopReason: 'completed', startedAt: 1, endedAt: 2,
  })

  it('reads the session and its records, and has no `now` when the host sent none', () => {
    const parsed = parseSubagentsPayload({ sessionId: 'main', subagents: [record('a'), record('b')] })
    assert.deepEqual(parsed?.subagents.map(entry => entry.id), ['a', 'b'])
    assert.equal(parsed?.sessionId, 'main')
    assert.equal('now' in (parsed ?? {}), false, 'a host older than 0.8.x sends no clock')
  })

  it('reads the host clock', () => {
    assert.equal(parseSubagentsPayload({ sessionId: 'main', subagents: [], now: 1_800_000_000_123 })?.now, 1_800_000_000_123)
    assert.equal(parseSubagentsPayload({ sessionId: 'main', subagents: [], now: 0 })?.now, 0)
  })

  it('leaves out a clock that is not a time, instead of refusing the answer', () => {
    for (const now of [-1, Number.NaN, Number.POSITIVE_INFINITY, '1800000000000', null, {}, [], true]) {
      const parsed = parseSubagentsPayload({ sessionId: 'main', subagents: [record('a')], now })
      assert.equal(parsed?.subagents.length, 1, String(now))
      assert.equal('now' in (parsed ?? {}), false, String(now))
    }
  })

  it('drops a record that is malformed and keeps the others, in order', () => {
    const parsed = parseSubagentsPayload({ sessionId: 'main', subagents: [record('a'), { ...record('bad'), state: 'weird' }, 'x', null, record('c')] })
    assert.deepEqual(parsed?.subagents.map(entry => entry.id), ['a', 'c'])
  })

  it('carries at most MAX_SUBAGENTS_PER_RESPONSE records, however many it is sent', () => {
    const sent = Array.from({ length: MAX_SUBAGENTS_PER_RESPONSE + 5 }, (_, index) => record(`c-${String(index)}`))
    const parsed = parseSubagentsPayload({ sessionId: 'main', subagents: sent })
    assert.equal(parsed?.subagents.length, MAX_SUBAGENTS_PER_RESPONSE)
    assert.equal(parsed?.subagents[0]?.id, 'c-0')
    assert.equal(parsed?.subagents.at(-1)?.id, `c-${String(MAX_SUBAGENTS_PER_RESPONSE - 1)}`)
    assert.equal(parseSubagentsPayload({ sessionId: 'main', subagents: sent.slice(0, MAX_SUBAGENTS_PER_RESPONSE) })?.subagents.length, MAX_SUBAGENTS_PER_RESPONSE, 'exactly the cap is all kept')
  })

  it('refuses what is not a session id and a list', () => {
    for (const value of [undefined, null, 'main', 5, [], { subagents: [] }, { sessionId: 'main' }, { sessionId: 'main', subagents: 'x' }, { sessionId: 'main', subagents: {} }]) {
      assert.equal(parseSubagentsPayload(value), undefined, JSON.stringify(value))
    }
    for (const sessionId of ['', 'x'.repeat(257), 'a\nb', 5, null]) assert.equal(parseSubagentsPayload({ sessionId, subagents: [] }), undefined, String(sessionId))
    assert.deepEqual(parseSubagentsPayload({ sessionId: 'x'.repeat(256), subagents: [] })?.subagents, [])
  })
})
