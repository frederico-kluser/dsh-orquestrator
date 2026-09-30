import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ConfigClient, ConfigHttpError, hostBase, type Fetch } from '../../src/client/config-client.ts'
import { buildConfig } from '../../src/shared.ts'

const route = { provider: 'openrouter', model: 'google/gemini-3.8-flash' }
const config = buildConfig({ subagentModel: route, reviewerEnabled: true, reviewerModel: null, remember: false })
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

  it('writes with POST JSON and returns what the host stored', async () => {
    const { client: c, calls } = client((_url, init) => json({ sessionId: 's', config: JSON.parse(String(init?.body)).config }))
    assert.deepEqual(await c.save('s', config), config)
    assert.equal(calls[0]?.init?.method, 'POST')
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { sessionId: 's', config })
    assert.deepEqual((calls[0]?.init?.headers as Record<string, string>)['content-type'], 'application/json')
    assert.equal(await client(() => json({ sessionId: 's', config: null })).client.save('s', null), null)
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

  it('falls back to a fixed base when the page origin is opaque', () => {
    assert.equal(hostBase(), 'http://dsh.internal') // node has no location
  })
})
