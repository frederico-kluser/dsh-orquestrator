import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_CAPS, EFFORT_ORDER, MODEL_PROFILES, capFor, chooseEffort, familyOf, isEffortLevel, lineageOf, lowerEffort, notesFor,
  profileOf, rankOf, sameFamily, sameModel,
} from '../../src/models.ts'

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

describe('familyOf', () => {
  it('reads the vendor from the model id, whatever the provider is called', () => {
    assert.equal(familyOf(ROUTES.azureFlash), 'deepseek')
    assert.equal(familyOf(ROUTES.orFlash), 'deepseek')
    assert.equal(familyOf(ROUTES.azureSonnet), 'anthropic')
    assert.equal(familyOf(ROUTES.orSonnet), 'anthropic')
    assert.equal(familyOf(ROUTES.gemini), 'google')
    assert.equal(familyOf(ROUTES.mimo), 'xiaomi')
    assert.equal(familyOf(ROUTES.glmFlash), 'zai')
    assert.equal(familyOf(ROUTES.kimi), 'moonshot')
    assert.equal(familyOf(route('azure-opencode-claude', 'gpt-6-astra')), 'openai')
    assert.equal(familyOf(route('x', 'o3-mini')), 'openai')
    assert.equal(familyOf(route('x', 'qwen3.6-plus')), 'qwen')
    assert.equal(familyOf(ROUTES.mystery), 'unknown')
  })

  it('does not take a provider name for a lineage', () => {
    // `azure-opencode-claude` is only the name of a route; the model decides.
    assert.equal(familyOf(route('azure-opencode-claude', 'DeepSeek-V4.1-Flash')), 'deepseek')
  })
})

describe('lineageOf and sameModel', () => {
  it('treats every spelling of the V4.1 Flash line as one model', () => {
    const flash = [ROUTES.azureFlash, ROUTES.orFlash, ROUTES.officialFlash, ROUTES.betaFlash]
    for (const a of flash) for (const b of flash) assert.equal(sameModel(a, b), true, `${a.model} vs ${b.model}`)
  })

  it('knows the official API serves deepseek-v4-pro and v4-flash from V4.1 Flash since 2026-09-14', () => {
    assert.equal(sameModel(ROUTES.officialPro, ROUTES.officialFlash), true)
    assert.equal(sameModel(ROUTES.officialOldFlash, ROUTES.officialFlash), true)
    // On OpenRouter the Pro listing is its own endpoint: no alias is claimed there.
    assert.equal(sameModel(ROUTES.orPro, ROUTES.orFlash), false)
  })

  it('matches one Claude model across Azure and OpenRouter spellings', () => {
    assert.equal(sameModel(ROUTES.azureSonnet, ROUTES.orSonnet), true)
    assert.equal(sameModel(ROUTES.azureSonnet, ROUTES.azureHaiku), false)
  })

  it('never merges different models', () => {
    assert.equal(sameModel(ROUTES.glm, ROUTES.glmFlash), false)
    assert.equal(sameModel(ROUTES.mimo, ROUTES.mimoFast), false)
    assert.notEqual(lineageOf(ROUTES.mystery), lineageOf(route('acme', 'acme-ultra-2')))
  })
})

describe('sameFamily', () => {
  it('is true inside a vendor and false across vendors', () => {
    assert.equal(sameFamily(ROUTES.officialPro, ROUTES.azureFlash), true)
    assert.equal(sameFamily(ROUTES.azureSonnet, ROUTES.azureHaiku), true)
    assert.equal(sameFamily(ROUTES.azureFlash, ROUTES.azureSonnet), false)
    assert.equal(sameFamily(ROUTES.glm, ROUTES.mimo), false)
  })

  it('never says two unknown models share a family', () => {
    assert.equal(sameFamily(ROUTES.mystery, route('acme', 'acme-ultra-1')), false)
  })
})

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
    assert.deepEqual(notesFor(ROUTES.officialPro, 'worker'), ['redirected', 'overthinks'])
  })

  it('dates every row and names its sources', () => {
    for (const profile of MODEL_PROFILES) {
      assert.match(profile.verifiedAt, /^\d{4}-\d{2}-\d{2}$/, profile.id)
      assert.ok(profile.sources.length > 0, profile.id)
      for (const cap of Object.values(profile.caps)) assert.ok(isEffortLevel(cap), `${profile.id} cap ${cap}`)
    }
    assert.equal(new Set(MODEL_PROFILES.map(profile => profile.id)).size, MODEL_PROFILES.length)
  })

  it('never advises `max` or `xhigh` for either role (no study supports it)', () => {
    for (const profile of MODEL_PROFILES) {
      for (const cap of Object.values(profile.caps)) assert.ok(rankOf(cap) <= rankOf('high'), `${profile.id} caps at ${cap}`)
    }
  })
})

describe('capFor', () => {
  it('prefers the operator, then the profile, then the generic cap', () => {
    assert.equal(capFor(ROUTES.azureFlash, 'worker'), 'medium')
    assert.equal(capFor(ROUTES.azureFlash, 'reviewer'), 'low')
    assert.equal(capFor(ROUTES.azureFlash, 'reviewer', 'high'), 'high')
    assert.equal(capFor(ROUTES.azureSonnet, 'reviewer'), 'high')
    assert.equal(capFor(ROUTES.mystery, 'worker'), DEFAULT_CAPS.worker)
    assert.equal(capFor(undefined, 'reviewer'), DEFAULT_CAPS.reviewer)
    assert.equal(capFor(ROUTES.azureFlash, 'worker', 'turbo'), 'medium') // a typo in the override is ignored
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

describe('lowerEffort', () => {
  it('steps down the model\'s own ladder and never to off', () => {
    assert.equal(lowerEffort(['off', 'low', 'medium', 'high', 'max'], 'max'), 'high')
    assert.equal(lowerEffort(['off', 'low', 'medium', 'high', 'max'], 'medium'), 'low')
    assert.equal(lowerEffort(['low', 'high', 'max'], 'high'), 'low')
    assert.equal(lowerEffort(['off', 'low', 'medium'], 'low'), undefined)
    assert.equal(lowerEffort(['low', 'high'], undefined), undefined)
    assert.equal(lowerEffort(['low', 'high'], 'turbo'), undefined)
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
