import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ConfigClient } from '../../src/client/config-client.ts'
import { DialogHost, type DialogRequest } from '../../src/client/dialogs.ts'
import { PromptGate, createLastChoiceMemory, patchTargetOf, previewOf, textOf, type LastChoiceMemory } from '../../src/client/gate.ts'
import type { PromptPartLike, SessionFaceLike, SessionSnapshotLike } from '../../src/client/host-types.ts'
import { OFF_CONFIG, buildConfig, type OrchestratorConfig } from '../../src/shared.ts'

const route = { provider: 'openrouter', model: 'google/gemini-3.8-flash' }
const active = buildConfig({ subagentModel: route, reviewerEnabled: true, reviewerModel: null, remember: false })
const remembered = buildConfig({ subagentModel: route, reviewerEnabled: false, reviewerModel: null, remember: true })

/** A session class like the real one: `prompt` lives on the prototype. */
class FakeSession implements SessionFaceLike {
  readonly sessionId: string
  snapshot: SessionSnapshotLike = { running: false, subagent: null }
  readonly prompts: { content: readonly PromptPartLike[]; mode: string; requestId: unknown }[] = []

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  getSnapshot(): SessionSnapshotLike {
    return this.snapshot
  }

  prompt(content: readonly PromptPartLike[], mode: 'queue' | 'steer', _signal?: AbortSignal, requestId?: unknown): Promise<unknown> {
    this.prompts.push({ content, mode, requestId })
    return Promise.resolve({ ok: true, value: { accepted: true } })
  }
}

interface Harness {
  readonly gate: PromptGate
  readonly dialogs: DialogHost
  readonly saved: { sessionId: string; config: OrchestratorConfig | null }[]
  readonly warnings: string[]
  readonly memory: { last: OrchestratorConfig | null }
  stored: OrchestratorConfig | null
  loadFails: boolean
}

function harness(): Harness {
  const dialogs = new DialogHost()
  const saved: Harness['saved'] = []
  const warnings: string[] = []
  const memoryBox = { last: null as OrchestratorConfig | null }
  const state = { stored: null as OrchestratorConfig | null, loadFails: false }
  const client = {
    load: () => (state.loadFails ? Promise.reject(new Error('404')) : Promise.resolve(state.stored)),
    save: (sessionId: string, config: OrchestratorConfig | null) => { saved.push({ sessionId, config }); return Promise.resolve(config) },
  } as unknown as ConfigClient
  const memory: LastChoiceMemory = { read: () => memoryBox.last, write: (config) => { memoryBox.last = config } }
  const gate = new PromptGate({ client, dialogs, memory, warn: message => warnings.push(message) })
  const result = { gate, dialogs, saved, warnings, memory: memoryBox } as Harness
  Object.defineProperties(result, {
    stored: { get: () => state.stored, set: (value: OrchestratorConfig | null) => { state.stored = value } },
    loadFails: { get: () => state.loadFails, set: (value: boolean) => { state.loadFails = value } },
  })
  return result
}

/** Answer the next dialog like a user would. */
function answerNext(host: DialogHost, answer: (request: DialogRequest) => void): void {
  const off = host.current.subscribe(() => {
    const request = host.current.getSnapshot()
    if (request === null) return
    off()
    queueMicrotask(() => { answer(request) })
  })
}

const text = (value: string): PromptPartLike[] => [{ type: 'text', text: value }]

describe('helpers', () => {
  it('joins text parts and previews on one bounded line', () => {
    assert.equal(textOf([...text('a'), { type: 'image' }, ...text('b')]), 'a\nb')
    assert.equal(previewOf('  many\n\n  spaces   here '), 'many spaces here')
    const long = previewOf('x'.repeat(500))
    assert.equal(long.length, 240)
    assert.ok(long.endsWith('\u2026'))
  })

  it('picks the prototype for class instances and the face itself otherwise', () => {
    const session = new FakeSession('s')
    assert.equal(patchTargetOf(session), FakeSession.prototype)
    const literal = { sessionId: 'l', getSnapshot: () => ({ running: false, subagent: null }), prompt: () => Promise.resolve() } as SessionFaceLike
    assert.equal(patchTargetOf(literal), literal) // never Object.prototype
    const shadowed = new FakeSession('own')
    ;(shadowed as { prompt: unknown }).prompt = () => Promise.resolve()
    assert.equal(patchTargetOf(shadowed), shadowed)
  })
})

describe('attach', () => {
  it('wraps the prototype once for many sessions and restores it exactly', () => {
    const h = harness()
    const original = FakeSession.prototype.prompt
    const a = new FakeSession('a')
    const b = new FakeSession('b')
    const offA = h.gate.attach(a)
    const offB = h.gate.attach(b)
    assert.notEqual(FakeSession.prototype.prompt, original)
    offA()
    assert.notEqual(FakeSession.prototype.prompt, original) // b still attached
    offB()
    offB() // idempotent
    assert.equal(FakeSession.prototype.prompt, original)
  })

  it('restores an instance-level patch and removes it when it was inherited', () => {
    const h = harness()
    const literal = { sessionId: 'l', getSnapshot: () => ({ running: false, subagent: null }), prompt: () => Promise.resolve('orig') } as unknown as SessionFaceLike
    const original = literal.prompt
    const off = h.gate.attach(literal)
    assert.notEqual(literal.prompt, original)
    off()
    assert.equal(literal.prompt, original)
  })
})

describe('beforePrompt', () => {
  it('sends straight through for anything that is not a new task', async () => {
    const h = harness()
    const session = new FakeSession('s')
    const detach = h.gate.attach(session)
    const cases: [string, () => Promise<unknown>][] = [
      ['running', () => { session.snapshot = { running: true, subagent: null }; return session.prompt(text('go'), 'queue') }],
      ['steer', () => { session.snapshot = { running: false, subagent: null }; return session.prompt(text('go'), 'steer') }],
      ['subagent conversation', () => { session.snapshot = { running: false, subagent: { address: 'x' } }; return session.prompt(text('go'), 'queue') }],
      ['slash line', () => { session.snapshot = { running: false, subagent: null }; return session.prompt(text('/goal x'), 'queue') }],
      ['empty', () => session.prompt([], 'queue')],
    ]
    for (const [label, run] of cases) {
      const before = session.prompts.length
      await run()
      assert.equal(session.prompts.length, before + 1, label)
    }
    assert.equal(h.dialogs.current.getSnapshot(), null)
    assert.equal(h.saved.length, 0)
    detach()
  })

  it('asks on a new task, waits for the answer, then sends', async () => {
    const h = harness()
    const session = new FakeSession('s')
    h.dialogs.registerPresenter('s', Symbol())
    const detach = h.gate.attach(session)
    const order: string[] = []
    answerNext(h.dialogs, (request) => {
      order.push(`dialog(${request.mode}:${request.preview})`)
      assert.equal(session.prompts.length, 0) // the prompt must not have gone out yet
      request.resolve({ kind: 'confirm', config: active })
    })
    await session.prompt(text('  build   the thing\n please '), 'queue', undefined, 'req-1')
    order.push('sent')
    assert.deepEqual(order, ['dialog(gate:build the thing please)', 'sent'])
    assert.equal(session.prompts.length, 1)
    assert.equal(session.prompts[0]?.requestId, 'req-1')
    assert.deepEqual(h.memory.last, active)
    detach()
  })

  it('opens the dialog pre-filled from the stored choice, else the last confirmed one, else off', async () => {
    const h = harness()
    const session = new FakeSession('s')
    h.dialogs.registerPresenter('s', Symbol())
    const detach = h.gate.attach(session)
    const initials: OrchestratorConfig[] = []
    const cancel = (request: DialogRequest): void => { initials.push(request.initial); request.resolve({ kind: 'cancel' }) }

    answerNext(h.dialogs, cancel)
    await session.prompt(text('one'), 'queue')
    h.memory.last = active
    answerNext(h.dialogs, cancel)
    await session.prompt(text('two'), 'queue')
    h.stored = buildConfig({ subagentModel: null, reviewerEnabled: true, reviewerModel: null, remember: false })
    answerNext(h.dialogs, cancel)
    await session.prompt(text('three'), 'queue')

    assert.deepEqual(initials[0], OFF_CONFIG)
    assert.deepEqual(initials[1], active)
    assert.equal(initials[2]?.reviewer.enabled, true)
    assert.equal(h.memory.last, active) // cancelling never overwrites the memory
    detach()
  })

  it('does not ask again when "do not ask again" is on for an active choice', async () => {
    const h = harness()
    const session = new FakeSession('s')
    h.dialogs.registerPresenter('s', Symbol())
    const detach = h.gate.attach(session)
    h.stored = remembered
    await session.prompt(text('go'), 'queue')
    assert.equal(h.dialogs.current.getSnapshot(), null)
    assert.equal(session.prompts.length, 1)
    detach()
  })

  it('still asks in a conversation with no turn yet, whatever is remembered', async () => {
    // The DSH web client reuses a workspace's blank session for every "new
    // session" (`ui-workspace` `connectWorkspace`), so a choice remembered on a
    // blank session is not this conversation's answer: honoring it would silence
    // the modal for the whole workspace instead of one chat.
    const h = harness()
    const session = new FakeSession('s')
    session.snapshot = { running: false, subagent: null, blank: true }
    h.dialogs.registerPresenter('s', Symbol())
    const detach = h.gate.attach(session)
    h.stored = remembered
    const initials: OrchestratorConfig[] = []
    answerNext(h.dialogs, (request) => {
      initials.push(request.initial)
      request.resolve({ kind: 'cancel' })
    })
    await session.prompt(text('go'), 'queue')
    assert.deepEqual(initials.length, 1)
    assert.equal(initials[0]?.remember, true) // pre-filled: one click re-affirms it
    assert.equal(session.prompts.length, 1)

    // Once the conversation has been used, the remembered choice applies again.
    session.snapshot = { running: false, subagent: null, blank: false }
    await session.prompt(text('more'), 'queue')
    assert.equal(initials.length, 1)
    assert.equal(session.prompts.length, 2)
    detach()
  })

  it('fails open when the host route is unavailable', async () => {
    const h = harness()
    const session = new FakeSession('s')
    h.dialogs.registerPresenter('s', Symbol())
    const detach = h.gate.attach(session)
    h.loadFails = true
    await session.prompt(text('go'), 'queue')
    assert.equal(session.prompts.length, 1)
    assert.equal(h.dialogs.current.getSnapshot(), null)
    assert.ok(h.warnings.some(message => /route unavailable/.test(message)))
    detach()
  })

  it('does not wait for a dialog nobody can show, and clears a stale one-task choice', async () => {
    const h = harness()
    const session = new FakeSession('s')
    const detach = h.gate.attach(session) // no presenter registered
    h.stored = active
    await session.prompt(text('go'), 'queue')
    assert.equal(session.prompts.length, 1)
    assert.deepEqual(h.saved, [{ sessionId: 's', config: null }])
    h.stored = null
    await session.prompt(text('again'), 'queue')
    assert.equal(h.saved.length, 1) // nothing stale to clear
    detach()
  })

  it('an aborted send closes the dialog and still lets the (aborted) prompt through', async () => {
    const h = harness()
    const session = new FakeSession('s')
    h.dialogs.registerPresenter('s', Symbol())
    const detach = h.gate.attach(session)
    const controller = new AbortController()
    queueMicrotask(() => { controller.abort() })
    await session.prompt(text('go'), 'queue', controller.signal)
    assert.equal(session.prompts.length, 1)
    assert.equal(h.dialogs.current.getSnapshot(), null)
    detach()
  })

  it('fails open when the gate itself throws', async () => {
    const h = harness()
    const session = new FakeSession('s')
    h.dialogs.registerPresenter('s', Symbol())
    const detach = h.gate.attach(session)
    session.snapshot = null as unknown as SessionSnapshotLike // makes beforePrompt throw
    await session.prompt(text('go'), 'queue')
    assert.equal(session.prompts.length, 1)
    assert.ok(h.warnings.some(message => /gate failed/.test(message)))
    detach()
  })
})

describe('last-choice memory', () => {
  it('stores without the per-conversation flag and tolerates missing or broken storage', () => {
    const box = new Map<string, string>()
    const memory = createLastChoiceMemory({ getItem: key => box.get(key) ?? null, setItem: (key, value) => { box.set(key, value) } })
    assert.equal(memory.read(), null)
    memory.write(remembered)
    assert.equal(memory.read()?.remember, false)
    assert.equal(memory.read()?.subagentModel?.model, route.model)

    // The same flag is stripped on read: the key is shared by every conversation
    // and workspace in the browser, so a stale entry can never pre-check it.
    box.set('dsh-orquestrator:last:v1', JSON.stringify({ ...remembered, remember: true }))
    assert.equal(memory.read()?.remember, false)
    assert.equal(memory.read()?.reviewer.enabled, remembered.reviewer.enabled)
    box.set('dsh-orquestrator:last:v1', JSON.stringify({ version: 2, remember: true }))
    assert.equal(memory.read(), null)

    assert.equal(createLastChoiceMemory(undefined).read(), null)
    createLastChoiceMemory(undefined).write(active) // must not throw
    const broken = createLastChoiceMemory({ getItem: () => '{oops', setItem: () => { throw new Error('quota') } })
    assert.equal(broken.read(), null)
    broken.write(active)
  })
})
