import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ConfigClient, ConfigHttpError, hostBase, type Fetch } from '../../src/client/config-client.ts'
import { SKILL_NAME, buildConfig } from '../../src/shared.ts'
import { legacyParseConfig } from '../legacy-wire.ts'

const route = { provider: 'openrouter', model: 'google/gemini-3.8-flash' }
const config = buildConfig({ subagentModel: route })
const offer = { name: SKILL_NAME, available: true }
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function client(handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>): { client: ConfigClient; calls: { url: URL; init: RequestInit | undefined }[] } {
  const calls: { url: URL; init: RequestInit | undefined }[] = []
  const fetcher: Fetch = async (input, init) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    return handler(url, init)
  }
  return { client: new ConfigClient(fetcher, () => 'http://dsh.test'), calls }
}

describe('ConfigClient', () => {
  it('reads a stored configuration through GET with the session id', async () => {
    const { client: c, calls } = client(() => json({ sessionId: 's 1', config }))
    assert.deepEqual(await c.load('s 1'), config)
    assert.equal(calls[0]?.url.toString(), 'http://dsh.test/dsh-orquestrator/config?sessionId=s+1')
    assert.ok(calls[0]?.init?.signal instanceof AbortSignal)
  })

  it('reads null when nothing is stored', async () => {
    const { client: c } = client(() => json({ sessionId: 's', config: null }))
    assert.equal(await c.load('s'), null)
  })

  it('reads the stored configuration and the skill the host offers in one GET', async () => {
    const { client: c, calls } = client(() => json({ sessionId: 's 1', config, skill: offer }))
    assert.deepEqual(await c.loadState('s 1'), { config, skill: offer })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url.toString(), 'http://dsh.test/dsh-orquestrator/config?sessionId=s+1')
    assert.equal(calls[0]?.init?.method, undefined) // a plain GET
    assert.ok(calls[0]?.init?.signal instanceof AbortSignal)
    assert.deepEqual(await client(() => json({ sessionId: 's', config: null, skill: offer })).client.loadState('s'), { config: null, skill: offer })
  })

  it('passes on a skill the host says is not registered, so that the gate can decide not to offer it', async () => {
    const off = { name: SKILL_NAME, available: false }
    assert.deepEqual(await client(() => json({ sessionId: 's', config, skill: off })).client.loadState('s'), { config, skill: off })
  })

  it('reads no skill when the host does not say: a host older than the skill, or an answer that makes no sense', async () => {
    for (const skill of [undefined, null, SKILL_NAME, true, [], {}, { name: SKILL_NAME }, { available: true }, { name: 'Not Kebab', available: true }, { name: SKILL_NAME, available: 'yes' }]) {
      const { client: c } = client(() => json({ sessionId: 's', config, skill }))
      assert.deepEqual(await c.loadState('s'), { config, skill: null }, String(JSON.stringify(skill)))
    }
  })

  it('load still answers the configuration alone, from one GET, and save is not affected by the skill', async () => {
    const { client: c, calls } = client(() => json({ sessionId: 's', config, skill: offer }))
    assert.deepEqual(await c.load('s'), config)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url.toString(), 'http://dsh.test/dsh-orquestrator/config?sessionId=s')
    assert.deepEqual(await c.save('s', config), config)
    assert.equal(calls.length, 2)
    assert.equal(calls[1]?.init?.method, 'POST')
  })

  it('writes with POST JSON and returns what the host stored', async () => {
    const { client: c, calls } = client((_url, init) => json({ sessionId: 's', config: JSON.parse(String(init?.body)).config }))
    assert.deepEqual(await c.save('s', config), config)
    assert.equal(calls[0]?.init?.method, 'POST')
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { sessionId: 's', config: { ...config, reviewer: { enabled: false, model: null, effort: null } } })
    assert.deepEqual((calls[0]?.init?.headers as Record<string, string>)['content-type'], 'application/json')
    assert.equal(await client(() => json({ sessionId: 's', config: null })).client.save('s', null), null)
  })

  it('posts what a host that has not been restarted since the update still accepts (0.2 to 0.4 refuse a configuration without the reviewer block)', async () => {
    const { client: c, calls } = client((_url, init) => json({ sessionId: 's', config: JSON.parse(String(init?.body)).config }))
    await c.save('s', config)
    await c.save('s', buildConfig({ subagentModel: null, workerEffort: 'low' }))
    await c.save('s', buildConfig({ subagentModel: null }))
    for (const call of calls) {
      const posted = (JSON.parse(String(call.init?.body)) as { config: unknown }).config
      assert.notEqual(legacyParseConfig(posted), undefined, 'the old host would answer 422 "config does not match the expected shape"')
    }
    // Clearing sends null, which every version understands.
    const clearing = client(() => json({ sessionId: 's', config: null }))
    await clearing.client.save('s', null)
    assert.equal((JSON.parse(String(clearing.calls[0]?.init?.body)) as { config: unknown }).config, null)
  })

  it('reads what an old host answers: a reviewer block that is on, with a model, is dropped and the choice kept', async () => {
    const old = { version: 1, subagentModel: route, workerEffort: 'high', reviewer: { enabled: true, model: { provider: 'p', model: 'm' }, effort: 'low' } }
    const { client: c } = client(() => json({ sessionId: 's', config: old }))
    assert.deepEqual(await c.load('s'), { version: 1, subagentModel: route, workerEffort: 'high' })
    assert.deepEqual(await c.save('s', config), { version: 1, subagentModel: route, workerEffort: 'high' })
  })

  it('maps a refusal to a ConfigHttpError carrying status, code and message', async () => {
    const { client: c } = client(() => json({ code: 'invalid-model', message: 'p/ghost: unknown model' }, 422))
    await assert.rejects(c.save('s', config), (error: unknown) => {
      assert.ok(error instanceof ConfigHttpError)
      assert.equal(error.status, 422)
      assert.equal(error.code, 'invalid-model')
      assert.match(error.message, /unknown model/)
      return true
    })
  })

  it('reports an unreachable host as status 0 and a non-JSON answer as its HTTP status', async () => {
    const down = new ConfigClient(() => Promise.reject(new Error('ECONNREFUSED')), () => 'http://x')
    await assert.rejects(down.load('s'), (error: unknown) => error instanceof ConfigHttpError && error.status === 0 && /ECONNREFUSED/.test(error.message))
    const html = client(() => new Response('<html>', { status: 404 })).client
    await assert.rejects(html.load('s'), (error: unknown) => error instanceof ConfigHttpError && error.status === 404)
  })

  it('rejects a host answer whose configuration is malformed', async () => {
    const { client: c } = client(() => json({ sessionId: 's', config: { version: 7 } }))
    await assert.rejects(c.load('s'), /malformed configuration/)
  })

  it('loadState fails exactly like load does: unreachable, refused, not JSON, malformed', async () => {
    const down = new ConfigClient(() => Promise.reject(new Error('ECONNREFUSED')), () => 'http://x')
    await assert.rejects(down.loadState('s'), (error: unknown) => error instanceof ConfigHttpError && error.status === 0 && /ECONNREFUSED/.test(error.message))
    const html = client(() => new Response('<html>', { status: 404 })).client
    await assert.rejects(html.loadState('s'), (error: unknown) => error instanceof ConfigHttpError && error.status === 404)
    const refused = client(() => json({ code: 'bad-request', message: 'sessionId is required' }, 400)).client
    await assert.rejects(refused.loadState(''), (error: unknown) => {
      assert.ok(error instanceof ConfigHttpError)
      assert.equal(error.status, 400)
      assert.equal(error.code, 'bad-request')
      return true
    })
    const malformed = client(() => json({ sessionId: 's', config: { version: 7 }, skill: offer })).client
    await assert.rejects(malformed.loadState('s'), /malformed configuration/)
    const noConfig = client(() => json({ sessionId: 's', skill: offer })).client
    await assert.rejects(noConfig.loadState('s'), (error: unknown) => error instanceof ConfigHttpError)
  })

  it('falls back to a fixed base when the page origin is opaque', () => {
    assert.equal(hostBase(), 'http://dsh.internal') // node has no location
  })
})
