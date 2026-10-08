import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { registerRoutes } from '../../src/routes.ts'
import {
  CONFIG_ROUTE, MAX_SUBAGENTS_PER_RESPONSE, SKILL_NAME, SUBAGENTS_ROUTE, buildConfig, parseSubagentsPayload,
  type ModelRoute, type SkillOffer,
} from '../../src/shared.ts'
import { legacyParseConfig } from '../legacy-wire.ts'
import { ConfigStore } from '../../src/store.ts'
import { SubagentLedger } from '../../src/subagents.ts'
import type { ConnectionLike, LlmLike, WebServerLike } from '../../src/host-services.ts'

const route = { provider: 'openrouter', model: 'google/gemini-3.8-flash' }
const valid = buildConfig({ subagentModel: route, workerEffort: 'high' })

type Handler = Parameters<WebServerLike['register']>[0]['handler']

let server: Server
let base: string
let fence: 401 | 403 | undefined
let llm: LlmLike | undefined
/** What the host's skill closure answers; undefined is "no skill", which keeps every config answer as it always was. */
let offer: SkillOffer | undefined
/** The conversations the skill closure was asked about, in order. */
const skillAsked: string[] = []
/** The ledger's clock: set it before seeding a child to give it a start time. */
let clock = 0
/** The host's clock the subagents answer carries (epoch milliseconds). */
const HOST_NOW = 1_800_000_000_123
const llmCalls: unknown[] = []
const store = new ConfigStore({ maxSessions: 100 })
const ledger = new SubagentLedger({ now: () => clock })

before(async () => {
  const handlers = new Map<string, Handler>()
  const webServer: WebServerLike = {
    register(registration) {
      assert.equal(registration.kind, 'exact')
      handlers.set(registration.path, registration.handler)
      return () => undefined
    },
  }
  const connection: ConnectionLike = { requestRejection: () => fence }
  registerRoutes(webServer, {
    store,
    connection,
    ledger,
    now: () => HOST_NOW,
    skill: (sessionId) => { skillAsked.push(sessionId); return offer },
    get llm() { return llm },
    timeoutSignal: () => new AbortController().signal,
  })
  assert.deepEqual([...handlers.keys()], [CONFIG_ROUTE, SUBAGENTS_ROUTE])
  server = createServer((req, res) => {
    const handler = handlers.get(new URL(String(req.url), 'http://localhost').pathname)
    if (handler === undefined) {
      res.statusCode = 404
      res.end()
      return
    }
    void handler(req, res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})
after(() => { server.close() })

const post = (body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }): Promise<Response> =>
  fetch(`${base}${CONFIG_ROUTE}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })

describe('config route', () => {
  it('answers the trust fence rejection with its status and no body, touching nothing', async () => {
    fence = 403
    const response = await post({ sessionId: 's-fence', config: valid })
    assert.equal(response.status, 403)
    assert.equal(await response.text(), '')
    assert.equal(store.get('s-fence'), undefined)
    fence = 401
    assert.equal((await fetch(`${base}${CONFIG_ROUTE}?sessionId=x`)).status, 401)
    fence = undefined
  })

  it('reads null for an unknown session and the stored value afterwards', async () => {
    const empty = await fetch(`${base}${CONFIG_ROUTE}?sessionId=s-read`)
    assert.equal(empty.status, 200)
    assert.deepEqual(await empty.json(), { sessionId: 's-read', config: null })
    assert.equal((await post({ sessionId: 's-read', config: valid })).status, 200)
    const filled = await fetch(`${base}${CONFIG_ROUTE}?sessionId=s-read`)
    assert.deepEqual(await filled.json(), { sessionId: 's-read', config: { ...valid, reviewer: { enabled: false, model: null, effort: null } } }, 'the stored choice plus the disabled legacy block old browsers insist on')
    assert.equal(filled.headers.get('cache-control'), 'no-store')
  })

  it('requires a sessionId on GET', async () => {
    const response = await fetch(`${base}${CONFIG_ROUTE}`)
    assert.equal(response.status, 400)
    assert.equal(((await response.json()) as { code: string }).code, 'bad-request')
  })

  it('clears a session when config is null', async () => {
    await post({ sessionId: 's-clear', config: valid })
    const response = await post({ sessionId: 's-clear', config: null })
    assert.deepEqual(await response.json(), { sessionId: 's-clear', config: null })
    assert.equal(store.get('s-clear'), undefined)
  })

  it('rejects wrong content types, bad JSON, missing fields and malformed configs', async () => {
    assert.equal((await post('x', { 'content-type': 'text/plain' })).status, 415)
    assert.equal((await post('{nope')).status, 400)
    assert.equal((await post({ config: valid })).status, 400)
    assert.equal((await post({ sessionId: 's' })).status, 400)
    assert.equal((await post({ sessionId: 's'.repeat(300), config: valid })).status, 400)
    const bad = await post({ sessionId: 's-bad', config: { version: 1, subagentModel: { provider: 'p' } } })
    assert.equal(bad.status, 422)
    assert.equal(((await bad.json()) as { code: string }).code, 'invalid-config')
    assert.equal(store.get('s-bad'), undefined)
  })

  it('accepts what a stale tab running the 0.4.0 dialog posts (a reviewer block) and stores only the model and the effort', async () => {
    const stale = { version: 1, subagentModel: route, workerEffort: 'low', reviewer: { enabled: true, model: { provider: 'p', model: 'm' }, effort: 'high' } }
    const response = await post({ sessionId: 's-stale', config: stale })
    assert.equal(response.status, 200)
    assert.deepEqual(store.get('s-stale'), { version: 1, subagentModel: route, workerEffort: 'low' })
  })

  it('answers in the shape every version accepts, so a tab opened before a restart (0.2 to 0.4) can still read and save', async () => {
    const saved = await post({ sessionId: 's-wire', config: valid })
    assert.equal(saved.status, 200)
    const postAnswer = (await saved.json()) as { config: unknown }
    assert.deepEqual(postAnswer.config, { ...valid, reviewer: { enabled: false, model: null, effort: null } })
    assert.notEqual(legacyParseConfig(postAnswer.config), undefined, 'the old browser would throw "the host answered a malformed configuration"')
    const read = (await (await fetch(`${base}${CONFIG_ROUTE}?sessionId=s-wire`)).json()) as { config: unknown }
    assert.notEqual(legacyParseConfig(read.config), undefined)
    assert.deepEqual(store.get('s-wire'), valid, 'what is stored never carries the block')
    const cleared = (await (await post({ sessionId: 's-wire', config: null })).json()) as { config: unknown }
    assert.equal(cleared.config, null)
  })

  it('accepts what a new browser posts to a host of any age and what an old browser posts to this one', async () => {
    // The new browser's POST body (with the legacy block) and the old browser's (the block switched on) both parse here.
    const fromNew = await post({ sessionId: 's-new', config: { ...valid, reviewer: { enabled: false, model: null, effort: null } } })
    assert.equal(fromNew.status, 200)
    const fromOld = await post({ sessionId: 's-old', config: { ...valid, reviewer: { enabled: true, model: { provider: 'p', model: 'm' }, effort: null } } })
    assert.equal(fromOld.status, 200)
    assert.deepEqual(store.get('s-new'), valid)
    assert.deepEqual(store.get('s-old'), valid)
  })

  it('rejects an oversized body with 413 and stays usable', async () => {
    const response = await post(`{"sessionId":"s","config":null,"pad":"${'x'.repeat(70 * 1024)}"}`)
    assert.equal(response.status, 413)
    assert.equal((await fetch(`${base}${CONFIG_ROUTE}?sessionId=alive`)).status, 200)
  })

  it('answers 405 with the allowed methods', async () => {
    const response = await fetch(`${base}${CONFIG_ROUTE}`, { method: 'PUT' })
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'GET, POST')
  })

  it('validates the named route against the live LLM runtime before storing', async () => {
    llm = {
      resolveCallConfig: (config) => {
        llmCalls.push(config)
        return config.model === 'ghost' ? Promise.reject(new Error('unknown model')) : Promise.resolve({})
      },
    }
    const named = buildConfig({ subagentModel: { provider: 'p', model: 'other', reasoningEffort: 'high' } })
    assert.equal((await post({ sessionId: 's-llm', config: named })).status, 200)
    assert.deepEqual(llmCalls, [{ provider: 'p', model: 'other', reasoningEffort: 'high' }])

    const ghost = buildConfig({ subagentModel: { provider: 'p', model: 'ghost' } })
    const refused = await post({ sessionId: 's-ghost', config: ghost })
    assert.equal(refused.status, 422)
    const payload = (await refused.json()) as { code: string; message: string }
    assert.equal(payload.code, 'invalid-model')
    assert.match(payload.message, /p\/ghost: unknown model/)
    assert.equal(store.get('s-ghost'), undefined)
    llm = undefined
  })
})

describe('config route skill offer', () => {
  const available: SkillOffer = { name: SKILL_NAME, available: true }
  const legacyBlock = { enabled: false, model: null, effort: null }

  /** Run a test body with the host's skill closure answering `value`, whatever happens. */
  async function offering(value: SkillOffer | undefined, body: () => Promise<void>): Promise<void> {
    offer = value
    try {
      await body()
    } finally {
      offer = undefined
    }
  }

  it('adds the skill the host offers to the GET answer, the POST answer and the clear answer', async () => {
    await offering(available, async () => {
      const read = await fetch(`${base}${CONFIG_ROUTE}?sessionId=s-skill`)
      assert.deepEqual(await read.json(), { sessionId: 's-skill', config: null, skill: available })
      const saved = await post({ sessionId: 's-skill', config: valid })
      assert.equal(saved.status, 200)
      assert.deepEqual(await saved.json(), { sessionId: 's-skill', config: { ...valid, reviewer: legacyBlock }, skill: available })
      const filled = await fetch(`${base}${CONFIG_ROUTE}?sessionId=s-skill`)
      assert.deepEqual(await filled.json(), { sessionId: 's-skill', config: { ...valid, reviewer: legacyBlock }, skill: available })
      const cleared = await post({ sessionId: 's-skill', config: null })
      assert.equal(cleared.status, 200)
      assert.deepEqual(await cleared.json(), { sessionId: 's-skill', config: null, skill: available })
    })
  })

  it('says so when the skill is not available', async () => {
    const unavailable: SkillOffer = { name: SKILL_NAME, available: false }
    await offering(unavailable, async () => {
      const read = await fetch(`${base}${CONFIG_ROUTE}?sessionId=s-skill-off`)
      assert.deepEqual(await read.json(), { sessionId: 's-skill-off', config: null, skill: unavailable })
    })
  })

  it('asks the host for the offer on every answer, so a change shows at once', async () => {
    const asked = async (): Promise<unknown> => ((await (await fetch(`${base}${CONFIG_ROUTE}?sessionId=s-skill-live`)).json()) as { skill?: unknown }).skill
    await offering(available, async () => {
      assert.deepEqual(await asked(), available)
      offer = { name: SKILL_NAME, available: false }
      assert.deepEqual(await asked(), { name: SKILL_NAME, available: false })
      offer = undefined
      assert.equal(await asked(), undefined)
    })
  })

  it('asks the host about the conversation each answer is for, and only for the answers that carry the offer', async () => {
    skillAsked.length = 0
    await offering(available, async () => {
      await fetch(`${base}${CONFIG_ROUTE}?sessionId=conv-get`)
      await post({ sessionId: 'conv-post', config: valid })
      await post({ sessionId: 'conv-clear', config: null })
      await fetch(`${base}${CONFIG_ROUTE}`) // a 400: no conversation, no offer
      await post({ sessionId: 'conv-bad', config: { version: 1, subagentModel: { provider: 'p' } } }) // a 422
    })
    assert.deepEqual(skillAsked, ['conv-get', 'conv-post', 'conv-clear'])
  })

  it('leaves every answer exactly as a host without the skill wrote it when there is no offer', async () => {
    await offering(undefined, async () => {
      assert.equal(await (await fetch(`${base}${CONFIG_ROUTE}?sessionId=s-plain`)).text(), JSON.stringify({ sessionId: 's-plain', config: null }))
      assert.equal(
        await (await post({ sessionId: 's-plain', config: valid })).text(),
        JSON.stringify({ sessionId: 's-plain', config: { ...valid, reviewer: legacyBlock } }),
      )
      assert.equal(await (await post({ sessionId: 's-plain', config: null })).text(), JSON.stringify({ sessionId: 's-plain', config: null }))
    })
  })

  it('keeps the skill out of every answer that is not a success', async () => {
    await offering(available, async () => {
      const missing = await fetch(`${base}${CONFIG_ROUTE}`)
      assert.deepEqual(await missing.json(), { code: 'bad-request', message: 'sessionId query parameter is required' })
      const malformed = await post({ sessionId: 's-skill-bad', config: { version: 1, subagentModel: { provider: 'p' } } })
      assert.equal(malformed.status, 422)
      assert.deepEqual(await malformed.json(), { code: 'invalid-config', message: 'config does not match the expected shape' })
      fence = 403
      try {
        const refused = await fetch(`${base}${CONFIG_ROUTE}?sessionId=s-skill-fence`)
        assert.equal(refused.status, 403)
        assert.equal(await refused.text(), '')
      } finally {
        fence = undefined
      }
    })
  })
})

describe('subagents route', () => {
  const url = (sessionId?: string): string => `${base}${SUBAGENTS_ROUTE}${sessionId === undefined ? '' : `?sessionId=${encodeURIComponent(sessionId)}`}`
  const routeA: ModelRoute = { provider: 'azure-opencode', model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'medium' }
  const routeB: ModelRoute = { provider: 'openrouter-extra', model: 'xiaomi/mimo-v2.6-pro' }

  /** Put a child in the ledger as the tracker would: started at `startedAt`, and ended at `end.at` when `end` is given. */
  function seed(id: string, parentId: string | null, startedAt: number, route: ModelRoute | null = null, end?: { readonly stopReason: string; readonly at: number }): void {
    clock = startedAt
    ledger.start({ id, parentId, backend: 'spawn', route })
    if (end === undefined) return
    clock = end.at
    ledger.finish(id, { stopReason: end.stopReason })
  }

  it('answers the trust fence rejection with its status and no body, before the method and the session id are looked at', async () => {
    seed('fence-child', 'sub-fence', 1)
    try {
      for (const status of [401, 403] as const) {
        fence = status
        for (const [label, request] of [
          ['a good request', fetch(url('sub-fence'))],
          ['no session id', fetch(url())],
          ['a method that is not allowed', fetch(url('sub-fence'), { method: 'PUT' })],
          ['a method that is not allowed and no session id', fetch(url(), { method: 'DELETE' })],
        ] as const) {
          const response = await request
          assert.equal(response.status, status, label)
          assert.equal(await response.text(), '', label)
          assert.equal(response.headers.get('allow'), null, label)
          assert.equal(response.headers.get('content-type'), null, label)
        }
      }
    } finally {
      fence = undefined
    }
    assert.equal((await fetch(url('sub-fence'))).status, 200, 'the route answers again once the fence lets the request through')
  })

  it('answers 405 with the allowed method and no body for anything but GET', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
      const response = await fetch(url('sub-method'), { method, ...method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{"sessionId":"sub-method"}' } : {} })
      assert.equal(response.status, 405, method)
      assert.equal(response.headers.get('allow'), 'GET', method)
      assert.equal(await response.text(), '', method)
    }
  })

  it('takes a session id of 256 characters and refuses one of 257', async () => {
    const accepted = await fetch(url('s'.repeat(256)))
    assert.equal(accepted.status, 200)
    assert.deepEqual(await accepted.json(), { sessionId: 's'.repeat(256), subagents: [], now: HOST_NOW })
    const refused = await fetch(url('s'.repeat(257)))
    assert.equal(refused.status, 400)
    assert.deepEqual(await refused.json(), { code: 'bad-request', message: 'sessionId query parameter is required' })
    // The configuration route draws the same line.
    assert.equal((await fetch(`${base}${CONFIG_ROUTE}?sessionId=${'s'.repeat(256)}`)).status, 200)
    assert.equal((await fetch(`${base}${CONFIG_ROUTE}?sessionId=${'s'.repeat(257)}`)).status, 400)
  })

  it('requires a usable sessionId', async () => {
    for (const [label, address] of [
      ['absent', url()],
      ['empty', `${base}${SUBAGENTS_ROUTE}?sessionId=`],
      ['too long', url('s'.repeat(300))],
    ] as const) {
      const response = await fetch(address)
      assert.equal(response.status, 400, label)
      assert.deepEqual(await response.json(), { code: 'bad-request', message: 'sessionId query parameter is required' }, label)
    }
  })

  it('lists the subagents under the session, direct and deeper, oldest first, as a payload the browser parses', async () => {
    seed('sub-late', 'sub-root', 30, routeB)
    seed('sub-early', 'sub-root', 10, routeA, { stopReason: 'completed', at: 12 })
    seed('sub-grand', 'sub-early', 20, null, { stopReason: 'aborted', at: 25 })
    seed('sub-deep', 'sub-grand', 40, routeB, { stopReason: 'max-tokens', at: 41 })
    const response = await fetch(url('sub-root'))
    assert.equal(response.status, 200)
    const body: unknown = await response.json()
    assert.deepEqual(body, {
      now: HOST_NOW,
      sessionId: 'sub-root',
      subagents: [
        { id: 'sub-early', parentId: 'sub-root', backend: 'spawn', route: routeA, state: 'done', stopReason: 'completed', startedAt: 10, endedAt: 12 },
        { id: 'sub-grand', parentId: 'sub-early', backend: 'spawn', route: null, state: 'stopped', stopReason: 'aborted', startedAt: 20, endedAt: 25 },
        { id: 'sub-late', parentId: 'sub-root', backend: 'spawn', route: routeB, state: 'running', stopReason: null, startedAt: 30, endedAt: null },
        { id: 'sub-deep', parentId: 'sub-grand', backend: 'spawn', route: routeB, state: 'failed', stopReason: 'max-tokens', startedAt: 40, endedAt: 41 },
      ],
    })
    assert.deepEqual(parseSubagentsPayload(body)?.subagents.map(record => record.id), ['sub-early', 'sub-grand', 'sub-late', 'sub-deep'])
    assert.equal(parseSubagentsPayload(body)?.now, HOST_NOW, 'the browser reads the host clock too')
  })

  it('sends JSON that nothing may cache', async () => {
    seed('cache-child', 'sub-cache', 1)
    const response = await fetch(url('sub-cache'))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
  })

  it('lists descendants only: not the session itself, not another session\'s subagents', async () => {
    seed('only-root', 'only-top', 5)
    seed('only-child', 'only-root', 6)
    seed('only-elsewhere', 'only-other', 7)
    const ids = async (sessionId: string): Promise<string[]> => ((await (await fetch(url(sessionId))).json()) as { subagents: { id: string }[] }).subagents.map(record => record.id)
    assert.deepEqual(await ids('only-root'), ['only-child'])
    assert.deepEqual(await ids('only-top'), ['only-root', 'only-child'])
    assert.deepEqual(await ids('only-other'), ['only-elsewhere'])
    const unknown = await fetch(url('only-nobody'))
    assert.equal(unknown.status, 200)
    assert.deepEqual(await unknown.json(), { sessionId: 'only-nobody', subagents: [], now: HOST_NOW })
  })

  it('carries at most the newest MAX_SUBAGENTS_PER_RESPONSE records, oldest first', async () => {
    const spare = 3
    for (let index = 0; index < MAX_SUBAGENTS_PER_RESPONSE + spare; index += 1) seed(`cap-${String(index).padStart(4, '0')}`, 'cap-root', 1000 + index)
    const { subagents } = (await (await fetch(url('cap-root'))).json()) as { subagents: { id: string }[] }
    assert.equal(subagents.length, MAX_SUBAGENTS_PER_RESPONSE)
    assert.equal(subagents[0]?.id, `cap-${String(spare).padStart(4, '0')}`)
    assert.equal(subagents.at(-1)?.id, `cap-${String(MAX_SUBAGENTS_PER_RESPONSE + spare - 1).padStart(4, '0')}`)
  })
})

describe('registerRoutes registrations', () => {
  const connection: ConnectionLike = { requestRejection: () => undefined }
  const common = { store: new ConfigStore({ maxSessions: 1 }), connection }

  /** A web-server double that records what is registered and removed, and can refuse one path. */
  function recorder(options: { readonly refuse?: string; readonly failRemoval?: string } = {}): {
    webServer: WebServerLike; registered: string[]; kinds: string[]; removed: string[]; handlers: Map<string, Handler>
  } {
    const registered: string[] = []
    const kinds: string[] = []
    const removed: string[] = []
    const handlers = new Map<string, Handler>()
    const webServer: WebServerLike = {
      register(registration) {
        if (registration.path === options.refuse) throw new Error(`cannot register ${registration.path}`)
        registered.push(registration.path)
        kinds.push(registration.kind)
        handlers.set(registration.path, registration.handler)
        return () => {
          removed.push(registration.path)
          if (registration.path === options.failRemoval) throw new Error(`cannot remove ${registration.path}`)
        }
      },
    }
    return { webServer, registered, kinds, removed, handlers }
  }

  it('stamps the subagents answer with the real clock when it is not given one', async () => {
    const web = recorder()
    registerRoutes(web.webServer, { ...common, ledger: new SubagentLedger() })
    const handler = web.handlers.get(SUBAGENTS_ROUTE)
    assert.ok(handler)
    const sent: string[] = []
    const res = { statusCode: 0, setHeader: () => undefined, end: (body?: string) => { sent.push(body ?? '') } }
    const before = Date.now()
    await handler({ method: 'GET', url: `${SUBAGENTS_ROUTE}?sessionId=s`, headers: {} } as never, res as never)
    const after = Date.now()
    const body = JSON.parse(sent[0] ?? '{}') as { now?: number }
    assert.equal(typeof body.now, 'number')
    assert.ok((body.now ?? 0) >= before && (body.now ?? 0) <= after, 'it is Date.now() at the moment of the answer')
    assert.equal(res.statusCode, 200)
  })

  it('registers only the config route when there is no ledger', () => {
    const web = recorder()
    const dispose = registerRoutes(web.webServer, common)
    assert.deepEqual(web.registered, [CONFIG_ROUTE])
    dispose()
    assert.deepEqual(web.removed, [CONFIG_ROUTE])
  })

  it('registers the subagents route as well when there is a ledger, both exact, and one disposer removes both', () => {
    const web = recorder()
    const dispose = registerRoutes(web.webServer, { ...common, ledger: new SubagentLedger() })
    assert.deepEqual(web.registered, [CONFIG_ROUTE, SUBAGENTS_ROUTE])
    assert.deepEqual(web.kinds, ['exact', 'exact'])
    assert.deepEqual(web.removed, [])
    dispose()
    assert.deepEqual([...web.removed].sort(), [CONFIG_ROUTE, SUBAGENTS_ROUTE].sort())
    assert.equal(web.removed.length, 2)
  })

  it('removes the config route again and rethrows when the subagents route cannot be registered', () => {
    const web = recorder({ refuse: SUBAGENTS_ROUTE })
    assert.throws(() => registerRoutes(web.webServer, { ...common, ledger: new SubagentLedger() }), new RegExp(`cannot register ${SUBAGENTS_ROUTE}`))
    assert.deepEqual(web.registered, [CONFIG_ROUTE])
    assert.deepEqual(web.removed, [CONFIG_ROUTE])
  })

  it('reports the registration error, not a removal error, when undoing the first registration also fails', () => {
    const web = recorder({ refuse: SUBAGENTS_ROUTE, failRemoval: CONFIG_ROUTE })
    assert.throws(() => registerRoutes(web.webServer, { ...common, ledger: new SubagentLedger() }), new RegExp(`cannot register ${SUBAGENTS_ROUTE}`))
    assert.deepEqual(web.removed, [CONFIG_ROUTE])
  })

  it('does not try the subagents route when the config route cannot be registered', () => {
    const web = recorder({ refuse: CONFIG_ROUTE })
    assert.throws(() => registerRoutes(web.webServer, { ...common, ledger: new SubagentLedger() }), new RegExp(`cannot register ${CONFIG_ROUTE}`))
    assert.deepEqual(web.registered, [])
    assert.deepEqual(web.removed, [])
  })

  it('still removes the config route when removing the subagents route fails', () => {
    const web = recorder({ failRemoval: SUBAGENTS_ROUTE })
    const dispose = registerRoutes(web.webServer, { ...common, ledger: new SubagentLedger() })
    assert.throws(dispose, new RegExp(`cannot remove ${SUBAGENTS_ROUTE}`))
    assert.deepEqual([...web.removed].sort(), [CONFIG_ROUTE, SUBAGENTS_ROUTE].sort())
  })
})
