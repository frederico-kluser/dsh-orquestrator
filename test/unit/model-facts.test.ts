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
    { id: 'acme/opaque', name: 'Opaque', architecture: { input_modalities: [] }, benchmarks: {} },
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
      assert.ok(row !== undefined && row.accuracy > 0 && row.accuracy <= 100, `${key} has an implausible accuracy`)
      assert.ok(typeof row.label === 'string' && row.label !== '')
    }
    // The score-priority tests below are only meaningful while the board knows GLM.
    assert.ok(TB4_SCORES[normalizeModelName('GLM-5.3')] !== undefined, 'the snapshot lost GLM-5.3')
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
      score: { kind: 'terminal-bench-4', value: `${TB4_SCORES['glm53']?.accuracy.toFixed(1) ?? ''}%` },
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
      score: { kind: 'terminal-bench-4', value: `${TB4_SCORES['glm53']?.accuracy.toFixed(1) ?? ''}%` },
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
    assert.equal(facts?.score?.value, `${TB4_SCORES['glm53']?.accuracy.toFixed(1) ?? ''}%`)
    // One decimal and a percent sign, never the index the catalog also carries (44.8).
    assert.match(facts?.score?.value ?? '', /^\d+\.\d%$/)
  })

  it('matches Terminal-Bench 4 through the display name when the slug does not', async () => {
    stub(() => json(CATALOG))
    const facts = await modelFactsOf('z-ai/glm-5.3-20260101', 'GLM 5.3')
    assert.deepEqual(facts, {
      modalities: { text: true, image: false, audio: false, video: false },
      score: { kind: 'terminal-bench-4', value: `${TB4_SCORES['glm53']?.accuracy.toFixed(1) ?? ''}%` },
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
        score: { kind: 'terminal-bench-4', value: `${TB4_SCORES['glm53']?.accuracy.toFixed(1) ?? ''}%` },
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

  it('fetches again after the test hook drops the cache', async () => {
    stub(() => json(CATALOG))
    assert.ok(await modelFactsOf('z-ai/glm-5.3') !== null)
    resetModelFactsForTests()
    assert.ok(await modelFactsOf('z-ai/glm-5.3') !== null)
    assert.equal(calls.length, 2)
  })
})
