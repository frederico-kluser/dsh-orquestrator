import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'
import { modelFactsOf, resetModelFactsForTests } from '../../src/client/model-facts.ts'
import { TB4_SCORES, TB4_SNAPSHOT, normalizeModelName } from '../../src/bench.generated.ts'

const realFetch: typeof fetch = globalThis.fetch
let calls: { url: string; init: RequestInit | undefined }[] = []

/** Replace the global fetch for one test, recording every call. */
function stub(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): void {
  calls = []
  const fake = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    calls.push({ url, init })
    return handler(url, init)
  }
  globalThis.fetch = fake as typeof fetch
}

/** A JSON response, as the catalog endpoint answers. */
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** The /models fixture: aliases, variants, an unrated model, an ambiguous slug and hostile ids included. */
const CATALOG = {
  data: [
    {
      id: 'z-ai/glm-5.3',
      name: 'GLM 5.3',
      architecture: { input_modalities: ['text', 'image', 'file'], output_modalities: ['text'] },
      benchmarks: { artificial_analysis: { intelligence_index: 44.8, coding_index: 31.2 } },
    },
    {
      id: 'z-ai/glm-5.3-20260101',
      name: 'GLM 5.3 (2026-01-01)',
      architecture: { input_modalities: ['text'] },
      benchmarks: { artificial_analysis: { intelligence_index: 40.1 } },
    },
    {
      id: 'xiaomi/mimo-v2.6-pro',
      name: 'MiMo V2.6 Pro',
      architecture: { input_modalities: ['text', 'image', 'audio', 'video', 'file'], output_modalities: ['text'] },
      benchmarks: { artificial_analysis: { intelligence_index: 51.2 } },
    },
    {
      id: 'deepseek/deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash',
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      benchmarks: { artificial_analysis: { intelligence_index: null } },
    },
    {
      id: 'deepseek/deepseek-v4.1-flash:free',
      name: 'DeepSeek V4.1 Flash (free)',
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      benchmarks: { artificial_analysis: { intelligence_index: 12.3 } },
    },
    {
      id: '~z-ai/glm-latest',
      name: 'GLM Latest',
      alias_target: { slug: 'z-ai/glm-5.3' },
      architecture: { input_modalities: ['text'] },
      benchmarks: {},
    },
    {
      id: 'alpha/shared-slug',
      name: 'Shared One',
      architecture: { input_modalities: ['text'] },
      benchmarks: { artificial_analysis: { intelligence_index: 10 } },
    },
    {
      id: 'beta/shared-slug',
      name: 'Shared Two',
      architecture: { input_modalities: ['text', 'video'] },
      benchmarks: { artificial_analysis: { intelligence_index: 20 } },
    },
    {
      id: 'openai/gpt-6-astra',
      name: 'GPT-6 Astra',
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      benchmarks: { artificial_analysis: { intelligence_index: 52.4 } },
    },
    {
      id: 'acme/astra-preview',
      name: 'GPT-6 Astra',
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      benchmarks: { artificial_analysis: { intelligence_index: 30 } },
    },
    {
      id: 'anthropic/opus-5',
      name: 'Opus 5',
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      benchmarks: { artificial_analysis: { intelligence_index: 55.1 } },
    },
    {
      id: 'acme/opaque', name: 'Opaque', architecture: { input_modalities: [] }, benchmarks: {} },
    { id: 'acme/no-architecture', name: 'Bare', benchmarks: { artificial_analysis: { intelligence_index: 3.8 } } },
    { id: 42, name: 'not a model' },
    { name: 'no id at all' },
  ],
}

beforeEach(() => {
  resetModelFactsForTests()
  calls = []
  globalThis.fetch = realFetch
})

after(() => {
  globalThis.fetch = realFetch
})

describe('model-facts snapshot', () => {
  it('ships Terminal-Bench 4 rows keyed by normalized model names', () => {
    assert.ok(TB4_SNAPSHOT.models >= 3, `expected a real snapshot, got ${String(TB4_SNAPSHOT.models)} models`)
    const keys = Object.keys(TB4_SCORES)
    assert.equal(keys.length, TB4_SNAPSHOT.models)
    for (const key of keys) {
      assert.equal(key, normalizeModelName(key), `${key} is not normalized`)
      const row = TB4_SCORES[key]
      assert.ok(row !== undefined && row.max > 0 && row.max <= 100, `${key} has an implausible max`)
      assert.ok(typeof row.label === 'string' && row.label !== '')
      // Every per-effort number the snapshot keeps is a real accuracy, and none exceeds the model's best.
      for (const [effort, accuracy] of Object.entries(row.efforts)) {
        assert.ok(Number.isFinite(accuracy) && accuracy > 0 && accuracy <= 100, `${key} has an implausible ${effort} accuracy`)
        assert.ok(accuracy <= row.max, `${key} reports ${effort} above its own max`)
      }
    }
    // The score-priority tests below are only meaningful while the board knows GLM.
    assert.ok(TB4_SCORES[normalizeModelName('GLM-5.3')] !== undefined, 'the snapshot lost GLM-5.3')
  })

  it('keeps the per-effort numbers the effort-aware score reads', () => {
    // The board's real rows for GPT-6 Astra (captured 2026-10-08). If these numbers change the snapshot was
    // regenerated: update this guard AND the expectations of the effort tests below.
    assert.deepEqual(TB4_SCORES['gpt6astra']?.efforts, { max: 58.18, xhigh: 57.88, high: 57.88, medium: 54.24, low: 50.61 },
      'the GPT-6 Astra rows moved: the effort tests below assert the numbers of the 2026-10-08 capture')
    // A model measured at several levels is what makes an effort-aware score possible at all.
    assert.ok(Object.keys(TB4_SCORES['gpt6astra']?.efforts ?? {}).length >= 3, 'the snapshot lost its multi-effort model')
    // GLM-5.3 is the single-row control: one level, so every effort resolves to the same number.
    assert.deepEqual(TB4_SCORES['glm53']?.efforts, { max: 41.82 })
  })

  it('normalizes punctuation, case and spacing away', () => {
    assert.equal(normalizeModelName('GLM-5.3'), 'glm53')
    assert.equal(normalizeModelName('glm 5.3'), 'glm53')
    assert.equal(normalizeModelName('glm-5.3'), 'glm53')
    assert.equal(normalizeModelName('MiMo-V2.6-Pro'), 'mimov26pro')
    assert.equal(normalizeModelName('__proto__'), 'proto')
    assert.equal(normalizeModelName('...'), '')
  })
})

describe('modelFactsOf matching', () => {
  it('matches a full catalog id, case-insensitively', async () => {
    stub(() => json(CATALOG))
    assert.deepEqual(await modelFactsOf('z-ai/glm-5.3', 'GLM 5.3'), {
      modalities: { text: true, image: true, audio: false, video: false },
      score: { kind: 'terminal-bench-4', value: `${TB4_SCORES['glm53']?.max.toFixed(1) ?? ''}%` },
    })
    assert.equal(calls[0]?.url, 'https://openrouter.ai/api/v1/models')
    assert.ok(calls[0]?.init?.signal instanceof AbortSignal)
  })

  it('matches a slash-less picker id on its slug part', async () => {
    stub(() => json(CATALOG))
    assert.deepEqual(await modelFactsOf('DeepSeek-V4.1-Flash'), {
      modalities: { text: true, image: false, audio: false, video: false },
      score: null,
    })
  })

  it('never borrows another author\u2019s entry for an id that carries an author', async () => {
    stub(() => json(CATALOG))
    assert.equal(await modelFactsOf('acme/glm-5.3'), null)
    assert.equal(await modelFactsOf('acme/deepseek-v4.1-flash'), null)
  })

  it('resolves an alias entry through alias_target.slug', async () => {
    stub(() => json(CATALOG))
    assert.deepEqual(await modelFactsOf('~z-ai/glm-latest'), {
      // The alias borrows the target's modalities and its Terminal-Bench 4 score, not its own empty ones.
      modalities: { text: true, image: true, audio: false, video: false },
      score: { kind: 'terminal-bench-4', value: `${TB4_SCORES['glm53']?.max.toFixed(1) ?? ''}%` },
    })
  })

  it('resolves an alias id that is not in the catalog to nothing', async () => {
    stub(() => json(CATALOG))
    assert.equal(await modelFactsOf('~acme/gone-latest'), null)
  })

  it('never matches a display name to a catalog entry', async () => {
    stub(() => json(CATALOG))
    // The display name names a real catalog model, but the id does not: nothing is borrowed from it.
    assert.equal(await modelFactsOf('acme/ghost', 'DeepSeek: DeepSeek V4.1 Flash'), null)
    assert.equal(await modelFactsOf('totally/unknown', 'MiMo V2.6 Pro'), null)
    assert.equal(await modelFactsOf('', 'GLM-5.3'), null)
    // A model the catalog does list keeps its own facts, whatever its display name claims.
    assert.deepEqual(await modelFactsOf('acme/opaque', 'DeepSeek: DeepSeek V4.1 Flash'), {
      modalities: { text: false, image: false, audio: false, video: false },
      score: null,
    })
  })

  it('does not strip :variant suffixes', async () => {
    stub(() => json(CATALOG))
    // The base entry is unrated; the :free entry is a different model with its own index.
    assert.deepEqual(await modelFactsOf('deepseek/deepseek-v4.1-flash'), {
      modalities: { text: true, image: false, audio: false, video: false },
      score: null,
    })
    assert.deepEqual(await modelFactsOf('deepseek/deepseek-v4.1-flash:free'), {
      modalities: { text: true, image: true, audio: false, video: false },
      score: { kind: 'intelligence', value: '12.3' },
    })
    assert.deepEqual(await modelFactsOf('deepseek-v4.1-flash:free'), {
      modalities: { text: true, image: true, audio: false, video: false },
      score: { kind: 'intelligence', value: '12.3' },
    })
  })

  it('drops a slug two authors share instead of guessing', async () => {
    stub(() => json(CATALOG))
    assert.equal(await modelFactsOf('shared-slug'), null)
    assert.deepEqual(await modelFactsOf('alpha/shared-slug'), {
      modalities: { text: true, image: false, audio: false, video: false },
      score: { kind: 'intelligence', value: '10.0' },
    })
    assert.deepEqual(await modelFactsOf('beta/shared-slug'), {
      modalities: { text: true, image: false, audio: false, video: true },
      score: { kind: 'intelligence', value: '20.0' },
    })
  })

  it('resolves null for a model the catalog does not list', async () => {
    stub(() => json(CATALOG))
    assert.equal(await modelFactsOf('nobody/nothing'), null)
  })
})

describe('modelFactsOf scores', () => {
  it('prefers Terminal-Bench 4 over the intelligence index', async () => {
    stub(() => json(CATALOG))
    const facts = await modelFactsOf('z-ai/glm-5.3', 'GLM 5.3')
    assert.equal(facts?.score?.kind, 'terminal-bench-4')
    assert.equal(facts?.score?.value, `${TB4_SCORES['glm53']?.max.toFixed(1) ?? ''}%`)
    // One decimal and a percent sign, never the index the catalog also carries (44.8).
    assert.match(facts?.score?.value ?? '', /^\d+\.\d%$/)
  })

  it('matches Terminal-Bench 4 through the display name when the slug does not', async () => {
    stub(() => json(CATALOG))
    const facts = await modelFactsOf('z-ai/glm-5.3-20260101', 'GLM 5.3')
    assert.deepEqual(facts, {
      modalities: { text: true, image: false, audio: false, video: false },
      score: { kind: 'terminal-bench-4', value: `${TB4_SCORES['glm53']?.max.toFixed(1) ?? ''}%` },
    })
  })

  it('falls back to the intelligence index when Terminal-Bench 4 does not know the model', async () => {
    assert.equal(TB4_SCORES[normalizeModelName('MiMo-V2.6-Pro')], undefined, 'the snapshot now knows MiMo: this fallback proves nothing')
    stub(() => json(CATALOG))
    assert.deepEqual(await modelFactsOf('xiaomi/mimo-v2.6-pro'), {
      modalities: { text: true, image: true, audio: true, video: true },
      score: { kind: 'intelligence', value: '51.2' },
    })
  })

  it('carries modalities with no score when neither source rates the model', async () => {
    stub(() => json(CATALOG))
    assert.deepEqual(await modelFactsOf('acme/opaque'), {
      modalities: { text: false, image: false, audio: false, video: false },
      score: null,
    })
  })

  it('formats the intelligence index with one decimal and no unit', async () => {
    stub(() => json(CATALOG))
    const facts = await modelFactsOf('acme/no-architecture')
    assert.deepEqual(facts?.score, { kind: 'intelligence', value: '3.8' })
    assert.deepEqual(facts?.modalities, { text: false, image: false, audio: false, video: false })
  })
})

describe('modelFactsOf effort', () => {
  /** The score value of one (model, effort) query; the effort is omitted entirely when the caller leaves it out. */
  async function value(model: string, displayName: string | undefined, effort?: string | null): Promise<string | null | undefined> {
    stub(() => json(CATALOG))
    return (await modelFactsOf(model, displayName, effort))?.score?.value
  }

  it('resolves a multi-effort Terminal-Bench 4 model at the selected effort', async () => {
    // GPT-6 Astra's real rows: max 58.18, xhigh/high 57.88, medium 54.24, low 50.61.
    assert.equal(await value('openai/gpt-6-astra', 'GPT-6 Astra', 'low'), '50.6%')
    assert.equal(await value('openai/gpt-6-astra', 'GPT-6 Astra', 'medium'), '54.2%')
    assert.equal(await value('openai/gpt-6-astra', 'GPT-6 Astra', 'high'), '57.9%')
    assert.equal(await value('openai/gpt-6-astra', 'GPT-6 Astra', 'xhigh'), '57.9%')
    assert.equal(await value('openai/gpt-6-astra', 'GPT-6 Astra', 'max'), '58.2%')
  })

  it('falls back to the model\u2019s best accuracy for an effort the board never measured', async () => {
    // Astra was not run at these levels: each one reads its max, 58.18. A level the board does know keeps its own row,
    // whatever spelling and padding reaches us.
    const unknown: [string, string][] = [['none', '58.2%'], ['minimal', '58.2%'], ['ultra', '58.2%'], ['reasoning-max', '58.2%'], ['MAX', '58.2%'], ['  low  ', '50.6%']]
    for (const [effort, expected] of unknown) {
      assert.equal(await value('openai/gpt-6-astra', 'GPT-6 Astra', effort), expected, `effort ${JSON.stringify(effort)}`)
    }
    // A level the snapshot has never heard of, including hostile ones, is not a lookup into Object.prototype.
    for (const effort of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      assert.equal(await value('openai/gpt-6-astra', 'GPT-6 Astra', effort), '58.2%', `effort ${effort}`)
    }
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined)
  })

  it('reads a single-row model the same at every effort and at the neutral option', async () => {
    // GLM-5.3 has exactly one row, at `max` (41.82): no level can change its number.
    for (const effort of ['low', 'medium', 'high', 'max', 'xhigh', 'none', '']) {
      assert.equal(await value('z-ai/glm-5.3', 'GLM 5.3', effort), '41.8%', `effort ${JSON.stringify(effort)}`)
    }
    assert.equal(await value('z-ai/glm-5.3', 'GLM 5.3', null), '41.8%')
    assert.equal(await value('z-ai/glm-5.3', 'GLM 5.3', undefined), '41.8%')
    assert.equal(await value('z-ai/glm-5.3', 'GLM 5.3'), '41.8%')
  })

  it('uses the best accuracy across rows as the fallback, not the row labelled max', async () => {
    // Opus 5 is the real gap: xhigh (53.94) beats the row labelled `max` (51.82), so the neutral option shows 53.9.
    assert.deepEqual(TB4_SCORES['opus5']?.efforts, { max: 51.82, xhigh: 53.94, high: 50.3, medium: 44.85, low: 34.85 })
    assert.equal(await value('anthropic/opus-5', 'Opus 5', null), '53.9%')
    assert.equal(await value('anthropic/opus-5', 'Opus 5', ''), '53.9%')
    assert.equal(await value('anthropic/opus-5', 'Opus 5', 'none'), '53.9%')
    assert.equal(await value('anthropic/opus-5', 'Opus 5', 'xhigh'), '53.9%')
    assert.equal(await value('anthropic/opus-5', 'Opus 5', 'max'), '51.8%')
    assert.equal(await value('anthropic/opus-5', 'Opus 5', 'low'), '34.9%')
  })

  it('keeps the intelligence index constant across every effort', async () => {
    // OpenRouter publishes one scalar per model: it cannot move with the effort, and it IS the value at max effort.
    assert.equal(TB4_SCORES[normalizeModelName('MiMo-V2.6-Pro')], undefined, 'the snapshot now knows MiMo: this proof is void')
    for (const effort of [undefined, null, '', 'low', 'medium', 'high', 'max', 'xhigh', 'none', 'constructor']) {
      assert.equal(await value('xiaomi/mimo-v2.6-pro', undefined, effort), '51.2', `effort ${String(effort)}`)
    }
    for (const effort of [undefined, null, '', 'low', 'max']) {
      assert.equal(await value('deepseek/deepseek-v4.1-flash:free', undefined, effort), '12.3', `effort ${String(effort)}`)
    }
  })

  it('never rejects, whatever the effort argument looks like', async () => {
    stub(() => json(CATALOG))
    for (const effort of [undefined, null, '', '   ', 7, {}, ['low'], true, Symbol('low')]) {
      assert.doesNotThrow(() => modelFactsOf('z-ai/glm-5.3', 'GLM 5.3', effort as unknown as string))
      assert.deepEqual(await modelFactsOf('z-ai/glm-5.3', 'GLM 5.3', effort as unknown as string), {
        modalities: { text: true, image: true, audio: false, video: false },
        score: { kind: 'terminal-bench-4', value: '41.8%' },
      })
    }
  })

  it('applies the effort to the Terminal-Bench row the display name supplies', async () => {
    // `acme/astra-preview` is not Astra by slug: the display name is the only thing that finds the leaderboard row,
    // and the selected effort is read from it like any other.
    stub(() => json(CATALOG))
    assert.equal((await modelFactsOf('acme/astra-preview', 'GPT-6 Astra', 'low'))?.score?.value, '50.6%')
    assert.equal((await modelFactsOf('acme/astra-preview', 'GPT-6 Astra', 'max'))?.score?.value, '58.2%')
    // Without the display name the same entry has no Terminal-Bench row: its own index, the same at every effort.
    assert.equal((await modelFactsOf('acme/astra-preview', undefined, 'low'))?.score?.value, '30.0')
    assert.equal((await modelFactsOf('acme/astra-preview', undefined, 'xhigh'))?.score?.value, '30.0')
    // An alias resolves the target's rows, at the effort asked for.
    assert.equal((await modelFactsOf('~z-ai/glm-latest', 'GLM 5.3', 'low'))?.score?.value, '41.8%')
  })
})

describe('modelFactsOf resilience', () => {
  it('resolves null when the catalog call rejects', async () => {
    stub(() => Promise.reject(new Error('offline')))
    assert.equal(await modelFactsOf('z-ai/glm-5.3'), null)
  })

  it('resolves null on an HTTP error', async () => {
    stub(() => json({ error: 'nope' }, 502))
    assert.equal(await modelFactsOf('z-ai/glm-5.3'), null)
  })

  it('resolves null when the body is not JSON', async () => {
    stub(() => new Response('<html>maintenance</html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    assert.equal(await modelFactsOf('z-ai/glm-5.3'), null)
  })

  it('resolves null on a malformed payload instead of crashing', async () => {
    for (const payload of [{}, { data: 'nope' }, { data: null }, 'nope', 7, { data: [null, 3, {}, { id: '' }, { id: '   ' }] }]) {
      resetModelFactsForTests()
      stub(() => json(payload))
      assert.equal(await modelFactsOf('z-ai/glm-5.3'), null, `payload ${JSON.stringify(payload)} should resolve null`)
    }
  })

  it('keeps hostile ids out of Object.prototype', async () => {
    const hostile = JSON.parse(
      '{"data":[{"id":"__proto__","architecture":{"input_modalities":["image"]},"benchmarks":{"artificial_analysis":{"intelligence_index":99}},'
      + '"__proto__":{"polluted":"yes"}},{"id":"constructor","architecture":{"input_modalities":["audio"]},'
      + '"benchmarks":{"artificial_analysis":{"intelligence_index":7}}},{"id":"toString","architecture":{"input_modalities":["video"]}}]}',
    ) as unknown
    stub(() => json(hostile))
    // `constructor` is absent from the catalog: reading it must not reach Object.prototype.constructor.
    resetModelFactsForTests()
    stub(() => json({ data: [{ id: 'harmless/one', architecture: { input_modalities: ['text'] } }] }))
    assert.equal(await modelFactsOf('constructor'), null)
    assert.equal(await modelFactsOf('toString'), null)
    assert.equal(await modelFactsOf('hasOwnProperty'), null)
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined)
    assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false)
    // Present in the catalog under a hostile name, it is just a key in a Map.
    resetModelFactsForTests()
    stub(() => json(hostile))
    assert.deepEqual(await modelFactsOf('constructor'), {
      modalities: { text: false, image: false, audio: true, video: false },
      score: { kind: 'intelligence', value: '7.0' },
    })
    assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false)
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined)
  })

  it('resolves null when the page has no fetch at all', async () => {
    Reflect.deleteProperty(globalThis, 'fetch')
    assert.equal(await modelFactsOf('z-ai/glm-5.3'), null)
  })

  it('gives up on a slow catalog call and resolves null', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    stub((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new DOMException('The operation was aborted.', 'AbortError')) })
    }))
    const pending = modelFactsOf('z-ai/glm-5.3')
    t.mock.timers.tick(8_000)
    assert.equal(await pending, null)
    assert.equal(calls.length, 1)
  })

  it('never rejects, whatever the model argument looks like', async () => {
    stub(() => json(CATALOG))
    for (const model of ['', '   ', '\u0000', '../../etc/passwd', 'a/b/c/d', ':free', '/', 'Z-AI/GLM-5.3 ']) {
      assert.doesNotThrow(() => modelFactsOf(model))
      const facts = await modelFactsOf(model, model)
      assert.ok(facts === null || typeof facts === 'object', `${model} produced ${String(facts)}`)
    }
    // Not a string at all: still null, still no rejection.
    for (const model of [undefined, null, 7, {}, ['z-ai/glm-5.3'], true]) {
      assert.equal(await modelFactsOf(model as unknown as string), null)
      // A non-string display name is ignored, not fatal: the id still resolves on its own slug.
      assert.deepEqual(await modelFactsOf('z-ai/glm-5.3', model as unknown as string), {
        modalities: { text: true, image: true, audio: false, video: false },
        score: { kind: 'terminal-bench-4', value: `${TB4_SCORES['glm53']?.max.toFixed(1) ?? ''}%` },
      })
    }
  })
})

describe('modelFactsOf cache', () => {
  it('fetches the catalog once for several calls and reuses the cached facts', async () => {
    stub(() => json(CATALOG))
    const first = await modelFactsOf('z-ai/glm-5.3')
    const second = await modelFactsOf('xiaomi/mimo-v2.6-pro')
    const again = await modelFactsOf('z-ai/glm-5.3')
    assert.equal(calls.length, 1)
    assert.equal(first, again)
    assert.notEqual(first, second)
  })

  it('coalesces calls issued before the catalog answers', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    stub(async () => {
      await gate
      return json(CATALOG)
    })
    const pending = [modelFactsOf('z-ai/glm-5.3'), modelFactsOf('xiaomi/mimo-v2.6-pro')]
    release?.()
    assert.equal((await Promise.all(pending)).length, 2)
    assert.equal(calls.length, 1)
  })

  it('caches a miss without asking again', async () => {
    stub(() => json(CATALOG))
    assert.equal(await modelFactsOf('nobody/nothing'), null)
    assert.equal(await modelFactsOf('nobody/nothing'), null)
    assert.equal(calls.length, 1)
  })

  it('does not retry a failed catalog call on every call', async () => {
    stub(() => Promise.reject(new Error('offline')))
    assert.equal(await modelFactsOf('z-ai/glm-5.3'), null)
    assert.equal(await modelFactsOf('z-ai/glm-5.3'), null)
    assert.equal(await modelFactsOf('xiaomi/mimo-v2.6-pro'), null)
    assert.equal(calls.length, 1)
  })

  it('keys the cache by (model, effort) while the catalog stays one fetch', async () => {
    stub(() => json(CATALOG))
    const neutral = await modelFactsOf('openai/gpt-6-astra', 'GPT-6 Astra')
    const low = await modelFactsOf('openai/gpt-6-astra', 'GPT-6 Astra', 'low')
    const lowAgain = await modelFactsOf('openai/gpt-6-astra', 'GPT-6 Astra', 'low')
    const high = await modelFactsOf('openai/gpt-6-astra', 'GPT-6 Astra', 'high')
    assert.equal(calls.length, 1)
    assert.equal(neutral?.score?.value, '58.2%')
    assert.equal(low?.score?.value, '50.6%')
    assert.equal(high?.score?.value, '57.9%')
    assert.notEqual(neutral, low)
    assert.notEqual(low, high)
    assert.equal(low, lowAgain)
  })

  it('keys the neutral option, null and an empty effort to the same entry', async () => {
    stub(() => json(CATALOG))
    const missing = await modelFactsOf('openai/gpt-6-astra', 'GPT-6 Astra')
    const empty = await modelFactsOf('openai/gpt-6-astra', 'GPT-6 Astra', '')
    const blank = await modelFactsOf('openai/gpt-6-astra', 'GPT-6 Astra', '   ')
    const nulled = await modelFactsOf('openai/gpt-6-astra', 'GPT-6 Astra', null)
    assert.equal(calls.length, 1)
    assert.equal(missing, empty)
    assert.equal(empty, blank)
    assert.equal(blank, nulled)
    assert.equal(missing?.score?.value, '58.2%')
  })

  it('fetches again after the test hook drops the cache', async () => {
    stub(() => json(CATALOG))
    assert.ok(await modelFactsOf('z-ai/glm-5.3') !== null)
    resetModelFactsForTests()
    assert.ok(await modelFactsOf('z-ai/glm-5.3') !== null)
    assert.equal(calls.length, 2)
  })
})
