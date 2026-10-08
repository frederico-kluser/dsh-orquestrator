import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Fetch } from '../../src/client/config-client.ts'
import { SubagentsClient } from '../../src/client/subagents-client.ts'

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const record = {
  id: 'child-1', parentId: 'main', backend: 'spawn', route: { provider: 'openrouter', model: 'google/gemini-3.8-flash', reasoningEffort: 'high' },
  state: 'done', stopReason: 'completed', startedAt: 1_700_000_000_000, endedAt: 1_700_000_005_000,
}

interface Call { readonly url: URL; readonly init: RequestInit | undefined }

function client(handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>, timeoutMs?: number): { client: SubagentsClient; calls: Call[] } {
  const calls: Call[] = []
  const fetcher: Fetch = async (input, init) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    return handler(url, init)
  }
  return { client: new SubagentsClient(fetcher, () => 'http://dsh.test', timeoutMs), calls }
}

/** Count the timers the client sets and clears (the global functions it calls are swapped for counting ones). */
function countTimers(): { live(): number; started(): number; restore(): void } {
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const active = new Set<unknown>()
  let started = 0
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const handle = realSet(...args)
    active.add(handle)
    started += 1
    return handle
  }) as typeof setTimeout
  globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
    active.delete(handle)
    realClear(handle)
  }) as typeof clearTimeout
  return {
    // A timer that fired and was not cleared is the leak this counts.
    live: () => active.size,
    started: () => started,
    restore() {
      globalThis.setTimeout = realSet
      globalThis.clearTimeout = realClear
    },
  }
}

/** A fetcher that never answers on its own and rejects like fetch does when its signal aborts. */
const hanging = (url: URL, init: RequestInit | undefined): Promise<Response> => new Promise((_resolve, reject) => {
  void url
  init?.signal?.addEventListener('abort', () => { reject(init.signal?.reason ?? new Error('aborted')) }, { once: true })
})

describe('SubagentsClient', () => {
  it('reads the ledger through GET with the session id in the query', async () => {
    const { client: c, calls } = client(() => json({ sessionId: 's 1', subagents: [] }))
    await c.list('s 1')
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url.toString(), 'http://dsh.test/dsh-orquestrator/subagents?sessionId=s+1')
    assert.ok(calls[0]?.init?.signal instanceof AbortSignal)
    assert.equal((calls[0]?.init?.headers as Record<string, string>)['accept'], 'application/json')
    assert.equal(calls[0]?.init?.method, undefined, 'a plain GET')
    assert.equal(calls[0]?.init?.cache, 'no-store', 'the ledger changes under the poll: no cached answer')
  })

  it('escapes a session id that would break the query', async () => {
    const { client: c, calls } = client(() => json({ sessionId: 'a&b=c', subagents: [] }))
    await c.list('a&b=c')
    assert.equal(calls[0]?.url.searchParams.get('sessionId'), 'a&b=c')
    assert.equal([...calls[0]?.url.searchParams.keys() ?? []].length, 1)
  })

  it('parses the answer with the shared parser', async () => {
    const { client: c } = client(() => json({ sessionId: 'main', subagents: [record] }))
    assert.deepEqual(await c.list('main'), { sessionId: 'main', subagents: [record] })
  })

  it('drops a malformed record and keeps the others', async () => {
    const { client: c } = client(() => json({ sessionId: 'main', subagents: [record, { id: 'broken' }, { ...record, id: 'child-2', state: 'running', stopReason: null, endedAt: null }] }))
    const payload = await c.list('main')
    assert.deepEqual(payload?.subagents.map(entry => entry.id), ['child-1', 'child-2'])
  })

  it('answers an empty ledger as an empty list, not as undefined', async () => {
    const { client: c } = client(() => json({ sessionId: 'main', subagents: [] }))
    assert.deepEqual(await c.list('main'), { sessionId: 'main', subagents: [] })
  })

  it('resolves undefined on a network error', async () => {
    const down = new SubagentsClient(() => Promise.reject(new Error('ECONNREFUSED')), () => 'http://dsh.test')
    assert.equal(await down.list('main'), undefined)
  })

  it('resolves undefined when the fetch function itself throws', async () => {
    const broken = new SubagentsClient(() => { throw new Error('boom') }, () => 'http://dsh.test')
    assert.equal(await broken.list('main'), undefined)
  })

  it('resolves undefined when the host base cannot be resolved', async () => {
    const broken = new SubagentsClient(() => Promise.resolve(json({})), () => { throw new Error('no base') })
    assert.equal(await broken.list('main'), undefined)
    const notAUrl = new SubagentsClient(() => Promise.resolve(json({})), () => 'not a url')
    assert.equal(await notAUrl.list('main'), undefined)
  })

  it('resolves undefined on a status that is not OK, 404 from a host that predates the route included', async () => {
    for (const status of [404, 401, 403, 422, 500, 503]) {
      const { client: c } = client(() => json({ code: 'internal', message: 'no' }, status))
      assert.equal(await c.list('main'), undefined, String(status))
    }
    const html = client(() => new Response('<html>not found</html>', { status: 404 })).client
    assert.equal(await html.list('main'), undefined)
    // An OK-looking body behind a failing status is still a failure.
    assert.equal(await client(() => json({ sessionId: 'main', subagents: [record] }, 500)).client.list('main'), undefined)
  })

  it('resolves undefined for an answer that is not JSON', async () => {
    assert.equal(await client(() => new Response('<html>hello</html>', { status: 200 })).client.list('main'), undefined)
    assert.equal(await client(() => new Response('', { status: 200 })).client.list('main'), undefined)
    assert.equal(await client(() => new Response('{"sessionId":', { status: 200 })).client.list('main'), undefined)
  })

  it('resolves undefined for a malformed body', async () => {
    for (const body of [null, 'text', 7, [], {}, { sessionId: 'main' }, { subagents: [] }, { sessionId: 'main', subagents: 'nope' }, { sessionId: '', subagents: [] }, { sessionId: 5, subagents: [] }]) {
      const { client: c } = client(() => json(body))
      assert.equal(await c.list('main'), undefined, JSON.stringify(body))
    }
  })

  it('resolves undefined when reading the body fails', async () => {
    const failing = { ok: true, status: 200, json: () => Promise.reject(new Error('stream reset')) } as unknown as Response
    assert.equal(await client(() => failing).client.list('main'), undefined)
  })

  it('does not call the host at all for a signal that is already aborted', async () => {
    const { client: c, calls } = client(() => json({ sessionId: 'main', subagents: [] }))
    const controller = new AbortController()
    controller.abort()
    assert.equal(await c.list('main', controller.signal), undefined)
    assert.equal(calls.length, 0)
  })

  it('aborts the request when the caller aborts while it is in flight, and resolves undefined', async () => {
    const { client: c, calls } = client(hanging)
    const controller = new AbortController()
    const pending = c.list('main', controller.signal)
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    const signal = calls[0]?.init?.signal
    assert.ok(signal instanceof AbortSignal)
    assert.equal(signal.aborted, false)
    controller.abort(new Error('menu closed'))
    assert.equal(await pending, undefined)
    assert.equal(signal.aborted, true)
  })

  it('gives up after its own deadline when the host does not answer', async () => {
    const { client: c, calls } = client(hanging, 25)
    assert.equal(await c.list('main'), undefined)
    assert.equal(calls[0]?.init?.signal?.aborted, true)
  })

  it('has a deadline of its own even when the caller passes a signal that never fires', async () => {
    const { client: c } = client(hanging, 25)
    const never = new AbortController()
    assert.equal(await c.list('main', never.signal), undefined)
  })

  it('does not leave a timer behind, whatever the request ends in (the deadline is released)', async () => {
    const timers = countTimers()
    try {
      const ok = client(() => json({ sessionId: 'main', subagents: [] })).client
      await ok.list('main')
      assert.equal(timers.live(), 0, 'after an answer')
      await client(() => json({}, 500)).client.list('main')
      assert.equal(timers.live(), 0, 'after a refusal')
      await client(() => { throw new Error('boom') }).client.list('main')
      assert.equal(timers.live(), 0, 'after a failure')
      const controller = new AbortController()
      const pending = client(hanging).client.list('main', controller.signal)
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(timers.live(), 1, 'while the request is in flight')
      controller.abort()
      await pending
      assert.equal(timers.live(), 0, 'after the caller aborted')
      await client(hanging, 20).client.list('main')
      assert.equal(timers.live(), 0, 'after the deadline passed')
      assert.ok(timers.started() >= 5, 'the deadline timer was really used')
    } finally {
      timers.restore()
    }
  })

  it('does not leave an abort listener behind on the caller\'s signal', async () => {
    const never = new AbortController()
    let added = 0
    let removed = 0
    const add = never.signal.addEventListener.bind(never.signal)
    const remove = never.signal.removeEventListener.bind(never.signal)
    never.signal.addEventListener = ((...args: Parameters<typeof add>) => { added += 1; return add(...args) }) as typeof add
    never.signal.removeEventListener = ((...args: Parameters<typeof remove>) => { removed += 1; return remove(...args) }) as typeof remove
    await client(() => json({ sessionId: 'main', subagents: [] })).client.list('main', never.signal)
    assert.equal(added, 1)
    assert.equal(removed, 1)
  })

  it('settles at the deadline even when the fetch ignores its signal and never answers', async () => {
    const forever = new Promise<Response>(() => undefined)
    const c = new SubagentsClient(() => forever, () => 'http://dsh.test', 20)
    const raced = await Promise.race([c.list('main'), new Promise(resolve => setTimeout(() => resolve('STILL PENDING'), 500))])
    assert.equal(raced, undefined)
  })

  it('settles when the caller aborts a fetch that ignores its signal', async () => {
    const forever = new Promise<Response>(() => undefined)
    const c = new SubagentsClient(() => forever, () => 'http://dsh.test', 60_000)
    const controller = new AbortController()
    const pending = c.list('main', controller.signal)
    setTimeout(() => { controller.abort() }, 10)
    const raced = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('STILL PENDING'), 500))])
    assert.equal(raced, undefined)
  })

  it('settles when the body never arrives either (response.json hangs)', async () => {
    const stuck = { ok: true, status: 200, json: () => new Promise(() => undefined) } as unknown as Response
    const c = new SubagentsClient(() => Promise.resolve(stuck), () => 'http://dsh.test', 20)
    const raced = await Promise.race([c.list('main'), new Promise(resolve => setTimeout(() => resolve('STILL PENDING'), 500))])
    assert.equal(raced, undefined)
  })

  it('does not report an unhandled rejection from a request that fails after the deadline passed', async () => {
    const late = (): Promise<Response> => new Promise((_resolve, reject) => { setTimeout(() => { reject(new Error('too late')) }, 40) })
    const c = new SubagentsClient(late, () => 'http://dsh.test', 10)
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      assert.equal(await c.list('main'), undefined)
      await new Promise<void>(resolve => setTimeout(resolve, 80))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    assert.deepEqual(unhandled, [])
  })

  it('hands the host\'s clock on, so the caller can age a record by the clock its times are in', async () => {
    const { client: c } = client(() => json({ sessionId: 'main', subagents: [record], now: 1_700_000_009_000 }))
    const payload = await c.list('main')
    assert.equal(payload?.now, 1_700_000_009_000)
    // A host that does not say what time it is leaves it out; a nonsense clock is dropped, not trusted.
    assert.equal((await client(() => json({ sessionId: 'main', subagents: [] })).client.list('main'))?.now, undefined)
    for (const now of ['soon', -5, Number.NaN, null, {}]) {
      const answer = await client(() => json({ sessionId: 'main', subagents: [], now })).client.list('main')
      assert.deepEqual(answer, { sessionId: 'main', subagents: [] }, JSON.stringify(now))
    }
  })

  it('remembers a 404 for the life of the client and does not ask again (a host older than the route)', async () => {
    const { client: c, calls } = client(() => new Response('<html>not found</html>', { status: 404 }))
    assert.equal(c.missing, false)
    assert.equal(await c.list('main'), undefined)
    assert.equal(c.missing, true)
    assert.equal(calls.length, 1)
    for (let index = 0; index < 5; index += 1) assert.equal(await c.list('other'), undefined)
    assert.equal(calls.length, 1, 'no further request')
  })

  it('does not take any other failure for a missing route: it asks again next time', async () => {
    for (const status of [400, 401, 403, 405, 422, 500, 502, 503]) {
      const { client: c, calls } = client(() => json({ code: 'internal', message: 'no' }, status))
      assert.equal(await c.list('main'), undefined, String(status))
      assert.equal(c.missing, false, String(status))
      await c.list('main')
      assert.equal(calls.length, 2, String(status))
    }
    // A network error, a timeout and a body that is not JSON are not a missing route either.
    const down = new SubagentsClient(() => Promise.reject(new Error('ECONNREFUSED')), () => 'http://dsh.test')
    await down.list('main')
    assert.equal(down.missing, false)
    const slow = client(hanging, 15).client
    await slow.list('main')
    assert.equal(slow.missing, false)
    const html = client(() => new Response('<html>', { status: 200 })).client
    await html.list('main')
    assert.equal(html.missing, false)
  })

  it('asks again after a good answer that follows failures, and a missing route stays missing even for an aborted call', async () => {
    let answer: Response | undefined
    const { client: c, calls } = client(() => answer ?? new Response('x', { status: 503 }))
    assert.equal(await c.list('main'), undefined)
    answer = json({ sessionId: 'main', subagents: [record] })
    assert.equal((await c.list('main'))?.subagents.length, 1)
    assert.equal(calls.length, 2)
    const gone = client(() => new Response('', { status: 404 })).client
    await gone.list('main')
    const controller = new AbortController()
    controller.abort()
    assert.equal(await gone.list('main', controller.signal), undefined)
    assert.equal(gone.missing, true)
  })

  it('never rejects, whatever the host does', async () => {
    const hostile: Fetch[] = [
      () => Promise.reject(undefined),
      () => Promise.reject(new DOMException('aborted', 'AbortError')),
      () => Promise.resolve(undefined as unknown as Response),
      () => Promise.resolve(null as unknown as Response),
      () => Promise.resolve({ ok: true } as unknown as Response),
    ]
    for (const fetcher of hostile) {
      const c = new SubagentsClient(fetcher, () => 'http://dsh.test')
      assert.equal(await c.list('main'), undefined)
    }
  })
})
