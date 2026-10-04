import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_CAP, EFFORT_ORDER, MODEL_PROFILES, capFor, chooseEffort, isEffortLevel, notesFor, profileOf, rankOf } from '../../src/models.ts'

const route = (provider: string, model: string) => ({ provider, model })

// The routes of a real DSH settings.yaml, so the matchers are tested against the spellings that exist.
const ROUTES = {
  azureFlash: route('azure-opencode', 'DeepSeek-V4.1-Flash'),
  orFlash: route('openrouter-extra', 'deepseek/deepseek-v4.1-flash'),
  officialFlash: route('deepseek-official', 'deepseek-flash'),
  officialPro: route('deepseek-official', 'deepseek-v4-pro'),
  officialOldFlash: route('deepseek-official', 'deepseek-v4-flash'),
  betaFlash: route('deepseek-beta', 'deepseek-v4.1-flash-expires-on-0910'),
  orPro: route('openrouter', 'deepseek/deepseek-v4-pro'),
  azureSonnet: route('azure-opencode-claude', 'claude-sonnet-5-5'),
  orSonnet: route('openrouter', 'anthropic/claude-sonnet-5.5'),
  azureHaiku: route('azure-opencode-claude', 'claude-haiku-4-5'),
  gemini: route('openrouter', 'google/gemini-3.8-flash'),
  mimo: route('openrouter-extra', 'xiaomi/mimo-v2.6-pro'),
  mimoFast: route('openrouter', 'xiaomi/mimo-v2.6-pro-ultraspeed'),
  glm: route('openrouter', 'z-ai/glm-5.3'),
  glmFlash: route('openrouter', 'z-ai/glm-5.3-flash'),
  kimi: route('openrouter', 'moonshotai/kimi-k3'),
  mystery: route('acme', 'acme-ultra-1'),
}

describe('profiles', () => {
  it('matches the most specific row first', () => {
    assert.equal(profileOf(ROUTES.officialPro)?.id, 'deepseek-v4-pro-official')
    assert.equal(profileOf(ROUTES.azureFlash)?.id, 'deepseek-flash')
    assert.equal(profileOf(ROUTES.mimoFast)?.id, 'mimo-ultraspeed')
    assert.equal(profileOf(ROUTES.mimo)?.id, 'mimo')
    assert.equal(profileOf(ROUTES.glmFlash)?.id, 'glm-flash')
    assert.equal(profileOf(ROUTES.glm)?.id, 'glm')
    assert.equal(profileOf(ROUTES.azureSonnet)?.id, 'claude-large')
    assert.equal(profileOf(ROUTES.azureHaiku)?.id, 'claude-haiku')
    assert.equal(profileOf(ROUTES.gemini)?.id, 'gemini-flash')
    assert.equal(profileOf(ROUTES.kimi), undefined)
    assert.equal(profileOf(ROUTES.mystery), undefined)
  })

  it('applies the V4-Pro redirect advice only on the official route', () => {
    assert.equal(profileOf(ROUTES.orPro), undefined)
    assert.deepEqual(notesFor(ROUTES.officialPro), ['redirected', 'overthinks'])
  })

  it('dates every row and names its sources', () => {
    for (const profile of MODEL_PROFILES) {
      assert.match(profile.verifiedAt, /^\d{4}-\d{2}-\d{2}$/, profile.id)
      assert.ok(profile.sources.length > 0, profile.id)
      if (profile.cap !== undefined) assert.ok(isEffortLevel(profile.cap), `${profile.id} cap ${profile.cap}`)
    }
    assert.equal(new Set(MODEL_PROFILES.map(profile => profile.id)).size, MODEL_PROFILES.length)
  })

  it('never advises `max` or `xhigh` for a subagent (no study supports it)', () => {
    for (const profile of MODEL_PROFILES) {
      if (profile.cap !== undefined) assert.ok(rankOf(profile.cap) <= rankOf('high'), `${profile.id} caps at ${profile.cap}`)
    }
  })
})

describe('capFor', () => {
  it('prefers the operator, then the profile, then the generic cap', () => {
    assert.equal(capFor(ROUTES.azureFlash), 'medium')
    assert.equal(capFor(ROUTES.azureFlash, 'high'), 'high')
    assert.equal(capFor(ROUTES.mimo), 'low')
    assert.equal(capFor(ROUTES.azureSonnet), 'high')
    assert.equal(capFor(ROUTES.mystery), DEFAULT_CAP)
    assert.equal(capFor(undefined), DEFAULT_CAP)
    assert.equal(capFor(ROUTES.azureFlash, 'turbo'), 'medium') // a typo in the override is ignored
  })
})

describe('chooseEffort', () => {
  const full = ['off', 'low', 'medium', 'high', 'xhigh', 'max']

  it('keeps the level the route would use when it is within the ceiling', () => {
    assert.deepEqual(chooseEffort({ ladder: full, current: 'low', explicit: undefined, cap: 'medium' }), { effort: undefined, reason: 'within-cap' })
    assert.deepEqual(chooseEffort({ ladder: full, current: 'medium', explicit: undefined, cap: 'medium' }), { effort: undefined, reason: 'within-cap' })
  })

  it('lowers a route that defaults to max (the deployments this plugin targets)', () => {
    assert.deepEqual(chooseEffort({ ladder: full, current: 'max', explicit: undefined, cap: 'medium' }), { effort: 'medium', reason: 'capped' })
    assert.deepEqual(chooseEffort({ ladder: full, current: 'max', explicit: undefined, cap: 'high' }), { effort: 'high', reason: 'capped' })
  })

  it('sets the ceiling when the route default is unknown', () => {
    assert.deepEqual(chooseEffort({ ladder: full, current: undefined, explicit: undefined, cap: 'medium' }), { effort: 'medium', reason: 'capped' })
  })

  it('takes the highest rung not above the ceiling when the ladder skips rungs (GLM offers low, high, max)', () => {
    assert.deepEqual(chooseEffort({ ladder: ['low', 'high', 'max'], current: 'max', explicit: undefined, cap: 'medium' }), { effort: 'low', reason: 'capped' })
    assert.deepEqual(chooseEffort({ ladder: ['low', 'high', 'max'], current: 'max', explicit: undefined, cap: 'high' }), { effort: 'high', reason: 'capped' })
  })

  it('never picks off on its own, and falls back to the lowest thinking level when everything is above the ceiling', () => {
    assert.deepEqual(chooseEffort({ ladder: ['off', 'high', 'max'], current: 'max', explicit: undefined, cap: 'low' }), { effort: 'high', reason: 'capped' })
    assert.deepEqual(chooseEffort({ ladder: ['off'], current: 'off', explicit: undefined, cap: 'low' }), { effort: undefined, reason: 'within-cap' })
    assert.deepEqual(chooseEffort({ ladder: ['off'], current: 'max', explicit: undefined, cap: 'low' }), { effort: undefined, reason: 'no-reasoning' })
  })

  it('lets an explicit level win, even above the ceiling, when the model offers it', () => {
    assert.deepEqual(chooseEffort({ ladder: full, current: 'max', explicit: 'xhigh', cap: 'medium' }), { effort: 'xhigh', reason: 'explicit' })
    assert.deepEqual(chooseEffort({ ladder: full, current: 'max', explicit: 'off', cap: 'medium' }), { effort: 'off', reason: 'explicit' })
  })

  it('drops an explicit level the model does not offer and falls back to the policy', () => {
    assert.deepEqual(chooseEffort({ ladder: ['low', 'high', 'max'], current: 'max', explicit: 'medium', cap: 'medium' }), { effort: 'low', reason: 'capped', dropped: 'medium' })
  })

  it('sends nothing to a model without reasoning levels', () => {
    assert.deepEqual(chooseEffort({ ladder: [], current: undefined, explicit: undefined, cap: 'medium' }), { effort: undefined, reason: 'no-reasoning' })
    assert.deepEqual(chooseEffort({ ladder: [], current: undefined, explicit: 'high', cap: 'medium' }), { effort: undefined, reason: 'no-reasoning', dropped: 'high' })
  })

  it('passes an explicit level through when the ladder is unknown, and decides nothing otherwise', () => {
    assert.deepEqual(chooseEffort({ ladder: undefined, current: 'max', explicit: 'high', cap: 'medium' }), { effort: 'high', reason: 'explicit' })
    assert.deepEqual(chooseEffort({ ladder: undefined, current: 'max', explicit: undefined, cap: 'medium' }), { effort: undefined, reason: 'no-ladder' })
  })

  it('ignores ladder ids DSH does not define', () => {
    assert.deepEqual(chooseEffort({ ladder: ['turbo', 'low', 'high'], current: 'high', explicit: undefined, cap: 'medium' }), { effort: 'low', reason: 'capped' })
  })
})

describe('levels', () => {
  it('ranks the canonical order and rejects anything else', () => {
    assert.deepEqual([...EFFORT_ORDER].map(rankOf), [0, 1, 2, 3, 4, 5, 6])
    assert.equal(rankOf('turbo'), -1)
    assert.equal(isEffortLevel('xhigh'), true)
    assert.equal(isEffortLevel('XHIGH'), false)
    assert.equal(isEffortLevel(3), false)
  })
})
