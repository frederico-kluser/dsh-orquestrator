import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DialogHost, type DialogInput, type DialogRequest, type DialogResult } from '../../src/client/dialogs.ts'
import { OFF_CONFIG, SKILL_NAME, buildConfig, type OrchestratorConfig } from '../../src/shared.ts'

const input = (sessionId = 's1', mode: DialogInput['mode'] = 'gate'): DialogInput => ({
  sessionId, mode, preview: 'task', initial: OFF_CONFIG, skill: null, skillInMessage: false, initialSkill: false, save: () => Promise.resolve(),
})

/** A host with a composer mounted for each of the sessions, so that a dialog for them can be shown. */
function mounted(...sessionIds: string[]): DialogHost {
  const host = new DialogHost()
  for (const sessionId of sessionIds) host.registerPresenter(sessionId, Symbol(sessionId))
  return host
}

const onScreen = (host: DialogHost): DialogRequest | null => host.current.getSnapshot()
const cancel: DialogResult = { kind: 'cancel' }
const confirm = (applySkill: boolean): DialogResult => ({ kind: 'confirm', config: OFF_CONFIG, applySkill })

describe('DialogHost', () => {
  it('shows one dialog at a time and queues the rest in order', async () => {
    const host = mounted('a', 'b')
    const first = host.request(input('a'))
    const second = host.request(input('b'))
    assert.equal(onScreen(host)?.sessionId, 'a')
    onScreen(host)?.resolve(cancel)
    assert.deepEqual(await first, cancel)
    assert.equal(onScreen(host)?.sessionId, 'b')
    onScreen(host)?.resolve(confirm(false))
    assert.deepEqual(await second, confirm(false))
    assert.equal(onScreen(host), null)
  })

  it('resolve is idempotent', async () => {
    const host = mounted('s1')
    const pending = host.request(input())
    const request = onScreen(host) as DialogRequest
    request.resolve(cancel)
    request.resolve(confirm(true))
    assert.deepEqual(await pending, cancel)
  })

  it('hands the dialog the skill on offer, whether the message carries it, and its pre-fill, and hands the answer back as it was given', async () => {
    const host = mounted('s1')
    const offer = { name: SKILL_NAME, available: true }
    const pending = host.request({ ...input(), skill: offer, skillInMessage: true, initialSkill: true })
    const request = onScreen(host) as DialogRequest
    assert.deepEqual(request.skill, offer)
    assert.equal(request.skillInMessage, true)
    assert.equal(request.initialSkill, true)
    assert.deepEqual(request.initial, OFF_CONFIG)
    request.resolve(confirm(true))
    assert.deepEqual(await pending, confirm(true))

    const bare = host.request(input())
    const noSkill = onScreen(host) as DialogRequest
    assert.equal(noSkill.skill, null)
    assert.equal(noSkill.skillInMessage, false)
    assert.equal(noSkill.initialSkill, false)
    noSkill.resolve(confirm(false))
    assert.deepEqual(await bare, confirm(false))
  })

  it('a cancel carries no skill answer, whatever was on offer', async () => {
    const host = mounted('s1')
    const pending = host.request({ ...input(), skill: { name: SKILL_NAME, available: true }, initialSkill: true })
    onScreen(host)?.resolve(cancel)
    assert.deepEqual(await pending, cancel)
  })

  it('a cancel carries no choice at all, from a click or from an abandoned send: only a confirm can be stored', async () => {
    const host = mounted('s1')
    const answers: DialogResult[] = []
    const saves: OrchestratorConfig[] = []
    const observe = (result: DialogResult): void => { answers.push(result) }
    const save = (config: OrchestratorConfig): Promise<void> => { saves.push(config); return Promise.resolve() }
    // A cancel is exactly one field: there is no configuration anywhere in it for a caller to persist.
    assert.deepEqual(Object.keys(cancel), ['kind'])

    const clicked = host.request({ ...input(), onAnswer: observe, save })
    onScreen(host)?.resolve(cancel)
    assert.deepEqual(await clicked, cancel)
    assert.equal(onScreen(host), null)

    const controller = new AbortController()
    const abandoned = host.request({ ...input(), onAnswer: observe, save }, controller.signal)
    controller.abort()
    assert.deepEqual(await abandoned, cancel)

    assert.deepEqual(answers, [cancel, cancel], 'the caller sees the same answer either way')
    assert.deepEqual(saves, [], 'the host itself persists nothing: a confirm is the only thing that can')

    const confirmed = host.request({ ...input(), onAnswer: observe, save })
    onScreen(host)?.resolve(confirm(false))
    assert.deepEqual(await confirmed, confirm(false))
    assert.deepEqual(answers, [cancel, cancel, confirm(false)])
    assert.deepEqual(saves, [], 'and even a confirm is stored by the dialog, not by the host')
  })

  it('resolves an aborted request as a cancel, on screen or still queued', async () => {
    const host = mounted('a', 'b')
    const controller = new AbortController()
    const shown = host.request(input('a'), controller.signal)
    const other = new AbortController()
    const queued = host.request(input('b'), other.signal)
    other.abort()
    assert.deepEqual(await queued, cancel)
    assert.equal(onScreen(host)?.sessionId, 'a')
    controller.abort()
    assert.deepEqual(await shown, cancel)
    assert.equal(onScreen(host), null)
  })

  it('answers an already aborted signal at once without raising a dialog', async () => {
    const host = mounted('s1')
    const controller = new AbortController()
    controller.abort()
    assert.deepEqual(await host.request(input(), controller.signal), cancel)
    assert.equal(onScreen(host), null)
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

  it('lists the sessions that have a composer mounted, in registration order', () => {
    const host = new DialogHost()
    assert.deepEqual(host.presenterSessionIds(), [])
    const offA = host.registerPresenter('a', Symbol())
    const offA2 = host.registerPresenter('a', Symbol())
    const offB = host.registerPresenter('b', Symbol())
    assert.deepEqual(host.presenterSessionIds(), ['a', 'b'])
    offA()
    assert.deepEqual(host.presenterSessionIds(), ['a', 'b']) // a second composer of 'a' is still mounted
    offA2()
    assert.deepEqual(host.presenterSessionIds(), ['b'])
    offB()
    assert.deepEqual(host.presenterSessionIds(), [])
  })

  it('bumps presence on every register and leave so mounted composers re-render', () => {
    const host = new DialogHost()
    const seen: number[] = []
    host.presence.subscribe(() => seen.push(host.presence.getSnapshot()))
    const off = host.registerPresenter('s', Symbol())
    off()
    assert.deepEqual(seen, [1, 2])
  })
})

describe('a dialog nobody can show', () => {
  it('is answered with a cancel at once when its session has no composer, and never raised or queued', async () => {
    const host = mounted('here')
    let answered = 0
    const ghost = host.request({ ...input('ghost'), onAnswer: () => { answered += 1 } })
    assert.equal(onScreen(host), null)
    assert.deepEqual(await ghost, cancel)
    assert.equal(answered, 1)
    // It did not take the page's one modal: the next request, for a session that has a composer, is shown straight away.
    const next = host.request(input('here'))
    assert.equal(onScreen(host)?.sessionId, 'here')
    onScreen(host)?.resolve(cancel)
    await next
  })

  it('does not jam the queue: a configure dialog for a session whose composer left cannot hold the others back', async () => {
    // /orquestrar reads the host, and the composer unmounts while it waits: the request then arrives for a ghost.
    const host = mounted('b')
    host.registerPresenter('gone', Symbol())()
    const configure = host.request(input('gone', 'configure'))
    const send = host.request(input('b'))
    assert.deepEqual(await configure, cancel)
    assert.equal(onScreen(host)?.sessionId, 'b')
    onScreen(host)?.resolve(confirm(false))
    assert.deepEqual(await send, confirm(false))
  })

  it('cancels the dialog on screen when its last composer leaves, and the next one is shown at once', async () => {
    const host = mounted('b')
    const offA = host.registerPresenter('a', Symbol())
    const first = host.request(input('a'))
    const second = host.request(input('b'))
    assert.equal(onScreen(host)?.sessionId, 'a')
    offA()
    assert.deepEqual(await first, cancel)
    assert.equal(onScreen(host)?.sessionId, 'b')
    onScreen(host)?.resolve(cancel)
    await second
  })

  it('cancels every request of that session that is still waiting, not only the one on screen', async () => {
    const host = mounted('a')
    const offB = host.registerPresenter('b', Symbol())
    const a1 = host.request(input('a'))
    const b1 = host.request(input('b'))
    const a2 = host.request(input('a'))
    const b2 = host.request(input('b'))
    assert.equal(onScreen(host)?.sessionId, 'a')
    offB() // B's composer unmounts while both of its requests wait behind A's dialog
    assert.deepEqual(await b1, cancel)
    assert.deepEqual(await b2, cancel)
    assert.equal(onScreen(host)?.sessionId, 'a') // A's dialog is still on screen, untouched
    onScreen(host)?.resolve(cancel)
    assert.deepEqual(await a1, cancel)
    // The next one is A's own second request, not a phantom of B's.
    assert.equal(onScreen(host)?.sessionId, 'a')
    onScreen(host)?.resolve(confirm(true))
    assert.deepEqual(await a2, confirm(true))
    assert.equal(onScreen(host), null)
  })

  it('keeps a session\'s requests while another composer of the same session is still mounted', async () => {
    const host = mounted('a')
    const offFirst = host.registerPresenter('b', Symbol())
    host.registerPresenter('b', Symbol())
    const a = host.request(input('a'))
    const b = host.request(input('b'))
    offFirst()
    assert.equal(onScreen(host)?.sessionId, 'a')
    onScreen(host)?.resolve(cancel)
    await a
    assert.equal(onScreen(host)?.sessionId, 'b') // the second composer of B presents it
    onScreen(host)?.resolve(cancel)
    await b
  })

  it('skips a waiting request whose composer left without the host being told, instead of putting it on screen', async () => {
    // The safety net behind the cases above: whatever way a session loses its composers, a dialog nobody can render
    // is never put on screen. This one is lost by editing the registry behind the host's back.
    const host = mounted('a', 'b', 'c')
    const first = host.request(input('a'))
    const ghost = host.request(input('b'))
    const last = host.request(input('c'))
    ;(host as unknown as { presenters: Map<string, Set<symbol>> }).presenters.delete('b')
    onScreen(host)?.resolve(cancel)
    await first
    assert.deepEqual(await ghost, cancel)
    assert.equal(onScreen(host)?.sessionId, 'c')
    onScreen(host)?.resolve(cancel)
    await last
  })
})

describe('what a dialog opens with', () => {
  it('is read when the dialog goes on screen, so a dialog that waited sees the answer of the one before it', async () => {
    const remembered = { config: OFF_CONFIG, skill: true }
    const reads: string[] = []
    const host = mounted('a', 'b')
    const first = host.request({
      ...input('a'),
      initial: () => { reads.push('first'); return remembered.config },
      initialSkill: () => { reads.push('first'); return remembered.skill },
      onAnswer: (answer) => {
        if (answer.kind === 'confirm') { remembered.config = answer.config; remembered.skill = answer.applySkill }
      },
    })
    const second = host.request({
      ...input('b'),
      initial: () => { reads.push('second'); return remembered.config },
      initialSkill: () => { reads.push('second'); return remembered.skill },
    })
    assert.deepEqual(reads, ['first', 'first']) // the second has not been read: it is not on screen
    assert.equal(onScreen(host)?.initialSkill, true)

    const picked = buildConfig({ subagentModel: { provider: 'p', model: 'm' } })
    onScreen(host)?.resolve({ kind: 'confirm', config: picked, applySkill: false })
    await first
    assert.deepEqual(reads, ['first', 'first', 'second', 'second'])
    assert.equal(onScreen(host)?.sessionId, 'b')
    assert.equal(onScreen(host)?.initialSkill, false) // what the first answered, not what was true when this was requested
    assert.deepEqual(onScreen(host)?.initial, picked)
    onScreen(host)?.resolve(cancel)
    await second
  })

  it('takes plain values as they are', () => {
    const host = mounted('s')
    const picked = buildConfig({ subagentModel: { provider: 'p', model: 'm' } })
    void host.request({ ...input('s'), initial: picked, initialSkill: true })
    assert.equal(onScreen(host)?.initial, picked)
    assert.equal(onScreen(host)?.initialSkill, true)
  })

  it('cancels a request whose pre-fill cannot be read and shows the next one, rather than getting stuck', async () => {
    const host = mounted('a', 'b')
    const first = host.request(input('a'))
    const broken = host.request({ ...input('b'), initial: () => { throw new Error('boom') } })
    const last = host.request(input('a'))
    onScreen(host)?.resolve(cancel)
    await first
    assert.deepEqual(await broken, cancel)
    assert.equal(onScreen(host)?.sessionId, 'a')
    onScreen(host)?.resolve(cancel)
    await last
    assert.equal(onScreen(host), null)
  })
})

describe('the answer callback', () => {
  it('runs once, synchronously, before the next dialog is put on screen and before the promise resolves', async () => {
    const log: string[] = []
    const host = mounted('a', 'b')
    const first = host.request({ ...input('a'), onAnswer: (answer) => { log.push(`answer:${answer.kind}`) } })
    const second = host.request({ ...input('b'), initialSkill: () => { log.push('next on screen'); return false } })
    void first.then(() => { log.push('promise resolved') })
    const request = onScreen(host) as DialogRequest
    request.resolve(confirm(true))
    request.resolve(cancel) // idempotent: the callback is not run again
    log.push('resolve returned')
    await first
    assert.deepEqual(log, ['answer:confirm', 'next on screen', 'resolve returned', 'promise resolved'])
    onScreen(host)?.resolve(cancel)
    await second
  })

  it('is told about every way a dialog ends: an aborted send, a composer that left, a session with no composer', async () => {
    const answers: string[] = []
    const record = (label: string): DialogInput['onAnswer'] => (answer) => { answers.push(`${label}:${answer.kind}`) }
    const host = mounted('a')
    const offB = host.registerPresenter('b', Symbol())
    const controller = new AbortController()
    const onTop = host.request({ ...input('a'), onAnswer: record('aborted') }, controller.signal)
    const waiting = host.request({ ...input('b'), onAnswer: record('left') })
    void host.request({ ...input('nobody'), onAnswer: record('ghost') })
    offB()
    controller.abort()
    await Promise.all([onTop, waiting])
    assert.deepEqual(answers.sort(), ['aborted:cancel', 'ghost:cancel', 'left:cancel'])
  })

  it('may throw without keeping the answer from arriving or the queue from moving on', async () => {
    const host = mounted('a', 'b')
    const first = host.request({ ...input('a'), onAnswer: () => { throw new Error('boom') } })
    const second = host.request(input('b'))
    onScreen(host)?.resolve(confirm(true))
    assert.deepEqual(await first, confirm(true))
    assert.equal(onScreen(host)?.sessionId, 'b')
    onScreen(host)?.resolve(cancel)
    await second
  })
})
