import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DialogHost, type DialogInput, type DialogRequest } from '../../src/client/dialogs.ts'
import { OFF_CONFIG } from '../../src/shared.ts'

const input = (sessionId = 's1', mode: DialogInput['mode'] = 'gate'): DialogInput => ({
  sessionId, mode, preview: 'task', initial: OFF_CONFIG, save: () => Promise.resolve(),
})

describe('DialogHost', () => {
  it('shows one dialog at a time and queues the rest in order', async () => {
    const host = new DialogHost()
    const first = host.request(input('a'))
    const second = host.request(input('b'))
    assert.equal(host.current.getSnapshot()?.sessionId, 'a')
    host.current.getSnapshot()?.resolve({ kind: 'cancel' })
    assert.deepEqual(await first, { kind: 'cancel' })
    assert.equal(host.current.getSnapshot()?.sessionId, 'b')
    host.current.getSnapshot()?.resolve({ kind: 'confirm', config: OFF_CONFIG })
    assert.deepEqual(await second, { kind: 'confirm', config: OFF_CONFIG })
    assert.equal(host.current.getSnapshot(), null)
  })

  it('resolve is idempotent', async () => {
    const host = new DialogHost()
    const pending = host.request(input())
    const request = host.current.getSnapshot() as DialogRequest
    request.resolve({ kind: 'cancel' })
    request.resolve({ kind: 'confirm', config: OFF_CONFIG })
    assert.deepEqual(await pending, { kind: 'cancel' })
  })

  it('resolves an aborted request as a cancel, on screen or still queued', async () => {
    const host = new DialogHost()
    const controller = new AbortController()
    const onScreen = host.request(input('a'), controller.signal)
    const other = new AbortController()
    const queued = host.request(input('b'), other.signal)
    other.abort()
    assert.deepEqual(await queued, { kind: 'cancel' })
    assert.equal(host.current.getSnapshot()?.sessionId, 'a')
    controller.abort()
    assert.deepEqual(await onScreen, { kind: 'cancel' })
    assert.equal(host.current.getSnapshot(), null)
  })

  it('answers an already aborted signal at once without raising a dialog', async () => {
    const host = new DialogHost()
    const controller = new AbortController()
    controller.abort()
    assert.deepEqual(await host.request(input(), controller.signal), { kind: 'cancel' })
    assert.equal(host.current.getSnapshot(), null)
  })

  it('tracks presenters: the first mount presents, later ones stay silent, and a departure hands over', () => {
    const host = new DialogHost()
    const one = Symbol('one')
    const two = Symbol('two')
    assert.equal(host.hasPresenter('s'), false)
    const offOne = host.registerPresenter('s', one)
    const offTwo = host.registerPresenter('s', two)
    assert.equal(host.hasPresenter('s'), true)
    assert.equal(host.isPresenter('s', one), true)
    assert.equal(host.isPresenter('s', two), false)
    offOne()
    assert.equal(host.isPresenter('s', two), true)
    offTwo()
    assert.equal(host.hasPresenter('s'), false)
  })

  it('bumps presence on every register and leave so mounted composers re-render', () => {
    const host = new DialogHost()
    const seen: number[] = []
    host.presence.subscribe(() => seen.push(host.presence.getSnapshot()))
    const off = host.registerPresenter('s', Symbol())
    off()
    assert.deepEqual(seen, [1, 2])
  })

  it('cancels the on-screen dialog when its last presenter leaves', async () => {
    const host = new DialogHost()
    const off = host.registerPresenter('s', Symbol())
    const pending = host.request(input('s'))
    off()
    assert.deepEqual(await pending, { kind: 'cancel' })
  })
})
