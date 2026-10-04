import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { registerRoutes } from '../../src/routes.ts'
import { CONFIG_ROUTE, buildConfig } from '../../src/shared.ts'
import { legacyParseConfig } from '../legacy-wire.ts'
import { ConfigStore } from '../../src/store.ts'
import type { ConnectionLike, LlmLike, WebServerLike } from '../../src/host-services.ts'

const route = { provider: 'openrouter', model: 'google/gemini-3.8-flash' }
const valid = buildConfig({ subagentModel: route, workerEffort: 'high' })

let server: Server
let base: string
let fence: 401 | 403 | undefined
let llm: LlmLike | undefined
const llmCalls: unknown[] = []
const store = new ConfigStore({ maxSessions: 100 })

before(async () => {
  let handler: Parameters<WebServerLike['register']>[0]['handler'] | undefined
  const webServer: WebServerLike = {
    register(registration) {
      assert.equal(registration.kind, 'exact')
      assert.equal(registration.path, CONFIG_ROUTE)
      handler = registration.handler
      return () => undefined
    },
  }
  const connection: ConnectionLike = { requestRejection: () => fence }
  registerRoutes(webServer, {
    store,
    connection,
    get llm() { return llm },
    timeoutSignal: () => new AbortController().signal,
  })
  server = createServer((req, res) => { void handler?.(req, res) })
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
