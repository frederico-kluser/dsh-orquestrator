import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { ConfigClient } from '../../src/client/config-client.ts'
import { DialogHost, type DialogRequest } from '../../src/client/dialogs.ts'
import {
  ABORTED_SEND, PromptGate, attachWhenAvailable, createLastChoiceMemory, createSkillChoiceMemory, isSubagentConversation, patchTargetOf, previewOf, textOf,
  type LastChoiceMemory, type SkillChoiceMemory,
} from '../../src/client/gate.ts'
import type { PromptPartLike, SessionFaceLike, SessionSnapshotLike } from '../../src/client/host-types.ts'
import { OFF_CONFIG, SKILL_NAME, buildConfig, type OrchestratorConfig, type SkillOffer } from '../../src/shared.ts'

const route = { provider: 'openrouter', model: 'google/gemini-3.8-flash' }
const active = buildConfig({ subagentModel: route, workerEffort: 'low' })
const chosen = buildConfig({ subagentModel: route })
/** What a current host says: the skill is registered, so its token will load it. */
const offered: SkillOffer = { name: SKILL_NAME, available: true }

/** The real snapshot also says whether a turn runs; the gate does not read it, and the fake keeps saying so to prove it. */
type FakeSnapshot = SessionSnapshotLike & { readonly running?: boolean }

/** A session class like the real one: `prompt` and the echo seam live on the prototype. */
class FakeSession implements SessionFaceLike {
  readonly sessionId: string
  snapshot: FakeSnapshot = { running: false, subagent: null }
  readonly prompts: { content: readonly PromptPartLike[]; mode: string; requestId: unknown }[] = []
  /** The local echoes the composer registered for this conversation, in the order it registered them. */
  readonly echoes: { readonly requestId: string; retired: boolean }[] = []
  private minted = 0

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  getSnapshot(): SessionSnapshotLike {
    return this.snapshot
  }

  /** DSH's `ISession.beginSubmission`: the echo a composer paints before its prompt, retirable by its owner. */
  beginSubmission(_input: { readonly text: string }): { readonly requestId: string; abandon: () => void } {
    this.minted += 1
    const echo = { requestId: `echo-${this.minted}`, retired: false }
    this.echoes.push(echo)
    return { requestId: echo.requestId, abandon: () => { echo.retired = true } }
  }

  prompt(content: readonly PromptPartLike[], mode: 'queue' | 'steer', _signal?: AbortSignal, requestId?: unknown): Promise<unknown> {
    this.prompts.push({ content, mode, requestId })
    return Promise.resolve({ ok: true, value: { accepted: true } })
  }
}

const originalPrompt = FakeSession.prototype.prompt
const originalBeginSubmission = FakeSession.prototype.beginSubmission

// A test that fails before it detaches must not leave its gate on the shared prototype: every later test would then
// run behind that dead gate and wait for a dialog nobody answers, so one failure would show up as a suite that hangs.
afterEach(() => {
  FakeSession.prototype.prompt = originalPrompt
  FakeSession.prototype.beginSubmission = originalBeginSubmission
})

interface Harness {
  readonly gate: PromptGate
  readonly dialogs: DialogHost
  readonly saved: { sessionId: string; config: OrchestratorConfig | null }[]
  readonly warnings: string[]
  readonly memory: { last: OrchestratorConfig | null }
  /** The skill checkbox's memory: the last answer, and every write in order. */
  readonly skillMemory: { last: boolean | null; readonly writes: boolean[] }
  /** The session of every read of the host state (the gate reads it once per message). */
  readonly loads: string[]
  /** Make the next read of the host wait until the returned function is called. */
  holdNextLoad(): () => void
  stored: OrchestratorConfig | null
  /** What the host says about the skill; null is a host older than the skill, which says nothing. */
  skill: SkillOffer | null
  loadFails: boolean
}

/** @param options - replacements for the two memories, to break them on purpose. */
function harness(options: { readonly skillMemory?: SkillChoiceMemory; readonly memory?: LastChoiceMemory } = {}): Harness {
  const dialogs = new DialogHost()
  const saved: Harness['saved'] = []
  const warnings: string[] = []
  const loads: string[] = []
  const memoryBox = { last: null as OrchestratorConfig | null }
  const skillBox = { last: null as boolean | null, writes: [] as boolean[] }
  const state = { stored: null as OrchestratorConfig | null, skill: offered as SkillOffer | null, loadFails: false, hold: undefined as Promise<void> | undefined }
  // No `load` on purpose: the gate must read the stored choice and the skill offer through the one `loadState` call.
  const client = {
    loadState: async (sessionId: string) => {
      loads.push(sessionId)
      const hold = state.hold
      state.hold = undefined
      if (hold !== undefined) await hold
      if (state.loadFails) throw new Error('404')
      return { config: state.stored, skill: state.skill }
    },
    save: (sessionId: string, config: OrchestratorConfig | null) => { saved.push({ sessionId, config }); return Promise.resolve(config) },
  } as unknown as ConfigClient
  const memory: LastChoiceMemory = options.memory ?? { read: () => memoryBox.last, write: (config) => { memoryBox.last = config } }
  const skillChoice: SkillChoiceMemory = options.skillMemory ?? {
    read: () => skillBox.last,
    write: (on) => { skillBox.last = on; skillBox.writes.push(on) },
  }
  const holdNextLoad = (): (() => void) => {
    let release: () => void = () => {}
    state.hold = new Promise<void>((resolve) => { release = resolve })
    return release
  }
  const gate = new PromptGate({ client, dialogs, memory, skillMemory: skillChoice, warn: message => warnings.push(message) })
  const result = { gate, dialogs, saved, warnings, loads, holdNextLoad, memory: memoryBox, skillMemory: skillBox } as Harness
  Object.defineProperties(result, {
    stored: { get: () => state.stored, set: (value: OrchestratorConfig | null) => { state.stored = value } },
    skill: { get: () => state.skill, set: (value: SkillOffer | null) => { state.skill = value } },
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

/** Freeze a prompt and every part of it, so that any attempt to modify it throws (ES modules are strict). */
const frozen = (parts: PromptPartLike[]): PromptPartLike[] => Object.freeze(parts.map(part => Object.freeze({ ...part }))) as PromptPartLike[]

/** DSH's own skill scanner (`SKILL_GESTURE` in `@deepseek-ai/dsh-tool-skill`): what the host will read in what we send. */
const DSH_SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g
const gesturesIn = (parts: readonly PromptPartLike[] | undefined): string[] => (parts ?? [])
  .flatMap(part => (part.type === 'text' && typeof part.text === 'string' ? [...part.text.matchAll(DSH_SKILL_GESTURE)] : []))
  .map(match => match[2] ?? '')

/** Answer a dialog with a confirm: keep the model choice and say whether the skill stays ticked. */
const confirmAs = (config: OrchestratorConfig, applySkill: boolean) => (request: DialogRequest): void => {
  request.resolve({ kind: 'confirm', config, applySkill })
}
const cancelIt = (request: DialogRequest): void => { request.resolve({ kind: 'cancel' }) }

/** Let every promise continuation that can run, run. */
const settle = (): Promise<void> => new Promise<void>((resolve) => { setImmediate(resolve) })

/** The dialog that is on screen, waiting for it a little (it comes up after the host has been read); a missing one fails the test instead of hanging it. */
async function shown(h: Harness): Promise<DialogRequest> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const request = h.dialogs.current.getSnapshot()
    if (request !== null) return request
    await settle()
  }
  throw new Error('no dialog came up')
}

/** A composer mounted for the session (so a dialog can be shown) with the gate attached to its face. */
function mounted(h: Harness, sessionId = 's'): { session: FakeSession; detach: () => void } {
  const session = new FakeSession(sessionId)
  h.dialogs.registerPresenter(sessionId, Symbol())
  return { session, detach: h.gate.attach(session) }
}

/**
 * Send one message the way the composer does: register the local echo first, then call `prompt` with the identity the
 * echo minted. The echo is what paints the pending bubble before the dialog is even raised.
 */
function send(session: FakeSession, content: readonly PromptPartLike[]): Promise<unknown> {
  const echo = session.beginSubmission({ text: textOf(content) })
  return session.prompt(content, 'queue', undefined, echo.requestId)
}

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
    const literal = { sessionId: 'l', getSnapshot: () => ({ subagent: null }), prompt: () => Promise.resolve() } as SessionFaceLike
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
    const literal = { sessionId: 'l', getSnapshot: () => ({ subagent: null }), prompt: () => Promise.resolve('orig') } as unknown as SessionFaceLike
    const original = literal.prompt
    const off = h.gate.attach(literal)
    assert.notEqual(literal.prompt, original)
    off()
    assert.equal(literal.prompt, original)
  })
})

describe('beforePrompt', () => {
  it('asks before every message the user sends, whatever it looks like', async () => {
    const h = harness()
    const session = new FakeSession('s')
    h.dialogs.registerPresenter('s', Symbol())
    const detach = h.gate.attach(session)
    const asked: string[] = []
    const cases: [string, () => Promise<unknown>][] = [
      ['plain task', () => { session.snapshot = { running: false, subagent: null }; return send(session, text('go')) }],
      ['skill invocation', () => send(session, text('/anchor-animation-agent-skill do the thing'))],
      ['file reference', () => send(session, text('@README.md summarize this'))],
      ['message while a turn runs', () => { session.snapshot = { running: true, subagent: null }; return send(session, text('keep going')) }],
      ['steer', () => { session.snapshot = { running: true, subagent: null }; return session.prompt(text('stop'), 'steer') }],
      ['subagent conversation', () => { session.snapshot = { running: false, subagent: { address: 'x' } }; return send(session, text('next')) }],
    ]
    for (const [label, run] of cases) {
      answerNext(h.dialogs, (request) => {
        asked.push(request.preview)
        // The prompt must wait for the answer, whichever kind of message it is.
        assert.equal(session.prompts.length, asked.length - 1, label)
        request.resolve({ kind: 'confirm', config: OFF_CONFIG, applySkill: false })
      })
      await run()
    }
    assert.deepEqual(asked, ['go', '/anchor-animation-agent-skill do the thing', '@README.md summarize this', 'keep going', 'stop', 'next'])
    assert.equal(session.prompts.length, cases.length) // every confirmed send goes out, after its answer
    detach()
  })

  it('lets only an empty send straight through', async () => {
    const h = harness()
    const session = new FakeSession('s')
    h.dialogs.registerPresenter('s', Symbol())
    const detach = h.gate.attach(session)
    const empty: PromptPartLike[] = []
    await session.prompt(empty, 'queue')
    assert.equal(session.prompts.length, 1)
    assert.equal(session.prompts[0]?.content, empty) // untouched: the very same array
    assert.equal(h.dialogs.current.getSnapshot(), null)
    assert.equal(h.saved.length, 0)
    assert.deepEqual(h.loads, []) // not even the host is asked
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
      request.resolve({ kind: 'confirm', config: active, applySkill: false })
    })
    const original = text('  build   the thing\n please ')
    await session.prompt(original, 'queue', undefined, 'req-1')
    order.push('sent')
    assert.deepEqual(order, ['dialog(gate:build the thing please)', 'sent'])
    assert.equal(session.prompts.length, 1)
    assert.equal(session.prompts[0]?.requestId, 'req-1')
    assert.equal(session.prompts[0]?.content, original) // the skill was not applied: the message is untouched
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
    h.stored = buildConfig({ subagentModel: null, workerEffort: 'high' })
    answerNext(h.dialogs, cancel)
    await session.prompt(text('three'), 'queue')

    assert.deepEqual(initials[0], OFF_CONFIG)
    assert.deepEqual(initials[1], active)
    assert.equal(initials[2]?.workerEffort, 'high')
    assert.equal(h.memory.last, active) // cancelling never overwrites the memory
    detach()
  })

  it('always asks: a stored choice pre-fills the dialog and never silences it', async () => {
    // There is no "do not ask again". One answer may not hide the modal from the
    // next task nor from another conversation (the DSH web client reuses a
    // workspace's blank session for every "new session"), so every new task asks.
    const h = harness()
    const session = new FakeSession('s')
    h.dialogs.registerPresenter('s', Symbol())
    const detach = h.gate.attach(session)
    h.stored = chosen
    const initials: OrchestratorConfig[] = []
    const confirm = (request: DialogRequest): void => { initials.push(request.initial); request.resolve({ kind: 'confirm', config: OFF_CONFIG, applySkill: false }) }

    answerNext(h.dialogs, confirm)
    await session.prompt(text('go'), 'queue')
    answerNext(h.dialogs, confirm)
    await session.prompt(text('more'), 'queue')

    assert.equal(initials.length, 2) // asked twice, never skipped
    assert.deepEqual(initials[0], chosen) // pre-filled with the stored choice
    assert.equal(session.prompts.length, 2)
    detach()
  })

  it('still asks when the host route is unavailable, pre-filled from the last choice', async () => {
    // A dialog whose save fails out loud beats a modal that never appears:
    // the route being down must not silence the question.
    const h = harness()
    const session = new FakeSession('s')
    h.dialogs.registerPresenter('s', Symbol())
    const detach = h.gate.attach(session)
    h.loadFails = true
    h.memory.last = active
    const initials: OrchestratorConfig[] = []
    answerNext(h.dialogs, (request) => { initials.push(request.initial); request.resolve({ kind: 'confirm', config: OFF_CONFIG, applySkill: false }) })
    await session.prompt(text('go'), 'queue')
    assert.equal(session.prompts.length, 1) // asked first, sent after the answer
    assert.deepEqual(initials, [active])
    assert.ok(h.warnings.some(message => /route unavailable/.test(message)))
    detach()
  })

  it('does not wait for a dialog nobody can show, and clears a stale one-task choice', async () => {
    const h = harness()
    const session = new FakeSession('s')
    const detach = h.gate.attach(session) // no presenter registered
    h.stored = active
    const original = text('go')
    await session.prompt(original, 'queue')
    assert.equal(session.prompts.length, 1)
    assert.equal(session.prompts[0]?.content, original) // no dialog, so no skill: the message is untouched
    assert.deepEqual(h.skillMemory.writes, [])
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
    const broken = [{ type: 'text', get text(): string { throw new Error('boom') } }] as unknown as PromptPartLike[]
    await session.prompt(broken, 'queue') // makes beforePrompt throw
    assert.equal(session.prompts.length, 1)
    assert.equal(session.prompts[0]?.content, broken) // the ORIGINAL content goes out
    assert.ok(h.warnings.some(message => /gate failed/.test(message)))
    detach()
  })

  it('returns what to do with the send: the same array when nothing is applied, an abort for a cancel', async () => {
    const h = harness()
    const session = new FakeSession('s')
    h.dialogs.registerPresenter('s', Symbol())
    const original = text('go')
    answerNext(h.dialogs, cancelIt)
    assert.deepEqual(await h.gate.beforePrompt(session, original, 'queue'), { kind: 'abort' })
    answerNext(h.dialogs, confirmAs(active, false))
    assert.deepEqual(await h.gate.beforePrompt(session, original, 'queue'), { kind: 'send', content: original })
    const empty: PromptPartLike[] = []
    assert.deepEqual(await h.gate.beforePrompt(session, empty, 'queue'), { kind: 'send', content: empty })
    answerNext(h.dialogs, confirmAs(active, true))
    const applied = await h.gate.beforePrompt(session, original, 'queue')
    assert.equal(applied.kind, 'send')
    assert.notEqual(applied.kind === 'send' ? applied.content : undefined, original)
    assert.deepEqual(applied.kind === 'send' ? applied.content : undefined, text(`go\n/${SKILL_NAME}`))
    assert.deepEqual(original, text('go')) // and the input is still as it was
  })
})

describe('the skill checkbox', () => {
  it('ticked: the prompt that goes out carries the whole /orchestrate-subagents token, and the input is left alone', async () => {
    const h = harness()
    const { session, detach } = mounted(h)
    const original = frozen(text('build the thing'))
    const requests: DialogRequest[] = []
    answerNext(h.dialogs, (request) => { requests.push(request); request.resolve({ kind: 'confirm', config: active, applySkill: true }) })
    await session.prompt(original, 'queue', undefined, 'req-7')

    assert.equal(session.prompts.length, 1)
    const sent = session.prompts[0]
    assert.deepEqual(sent?.content, [{ type: 'text', text: 'build the thing\n/orchestrate-subagents' }])
    assert.deepEqual(gesturesIn(sent?.content), ['orchestrate-subagents']) // the host's own scanner reads exactly this skill
    assert.equal(sent?.mode, 'queue')
    assert.equal(sent?.requestId, 'req-7') // the rest of the call is forwarded as it came
    assert.deepEqual(original, [{ type: 'text', text: 'build the thing' }]) // the composer's content was not modified
    assert.deepEqual(requests[0]?.skill, offered) // the dialog was told what to show
    assert.deepEqual(h.memory.last, active)
    assert.deepEqual(h.skillMemory.writes, [true])
    detach()
  })

  it('writes the token for every kind of message the gate asks about, and never doubles a token that is already there', async () => {
    const h = harness()
    const { session, detach } = mounted(h)
    const cases: [string, string, string][] = [
      ['plain', 'go', `go\n/${SKILL_NAME}`],
      ['another skill', '/anchor-animation-agent-skill do the thing', `/anchor-animation-agent-skill do the thing\n/${SKILL_NAME}`],
      ['file reference', '@README.md summarize this', `@README.md summarize this\n/${SKILL_NAME}`],
      ['multi-line', 'one\ntwo\n', `one\ntwo\n/${SKILL_NAME}`],
      ['already carries it', `fix it /${SKILL_NAME} now`, `fix it /${SKILL_NAME} now`],
      ['starts with it', `/${SKILL_NAME}`, `/${SKILL_NAME}`],
      ['a longer word is not the token', `/${SKILL_NAME}-v2 go`, `/${SKILL_NAME}-v2 go\n/${SKILL_NAME}`],
    ]
    for (const [label, typed, expected] of cases) {
      answerNext(h.dialogs, confirmAs(chosen, true))
      await session.prompt(text(typed), 'queue')
      const sent = session.prompts.at(-1)?.content
      assert.deepEqual(sent, text(expected), label)
      assert.equal(gesturesIn(sent).filter(name => name === SKILL_NAME).length, 1, label)
    }
    detach()
  })

  it('is never offered in a subagent conversation, whatever the host says: the skill teaches the agent that coordinates', async () => {
    const h = harness()
    const { session, detach } = mounted(h)
    session.snapshot = { running: false, subagent: { address: 'x' } }
    const original = text('keep going')
    const requests: DialogRequest[] = []
    answerNext(h.dialogs, (request) => { requests.push(request); request.resolve({ kind: 'confirm', config: active, applySkill: true }) })
    await session.prompt(original, 'queue')
    assert.equal(requests.length, 1, 'the dialog still asks (the model choice)')
    assert.equal(requests[0]?.skill, null, 'but it has no skill section')
    assert.equal(session.prompts[0]?.content, original, 'and the message is never touched')
    assert.deepEqual(h.skillMemory.writes, [], 'nothing was answered about the skill, so nothing is remembered')
    // The conversation of the main agent right after it is offered again.
    session.snapshot = { running: false, subagent: null }
    answerNext(h.dialogs, (request) => { requests.push(request); request.resolve({ kind: 'confirm', config: active, applySkill: true }) })
    await session.prompt(text('and now'), 'queue')
    assert.deepEqual(requests[1]?.skill, offered)
    assert.deepEqual(session.prompts[1]?.content, text(`and now\n/${SKILL_NAME}`))
    detach()
  })

  it('isSubagentConversation reads the face\'s own snapshot, and a face that cannot say is not one', () => {
    const face = (snapshot: () => SessionSnapshotLike): SessionFaceLike => ({ sessionId: 's', getSnapshot: snapshot, prompt: () => Promise.resolve() })
    assert.equal(isSubagentConversation(face(() => ({ subagent: { address: 'x' } }))), true)
    assert.equal(isSubagentConversation(face(() => ({ subagent: null }))), false)
    assert.equal(isSubagentConversation(face(() => ({ subagent: undefined }))), false)
    assert.equal(isSubagentConversation(face(() => { throw new Error('gone') })), false)
  })

  it('unticked: the message goes out as it is and the answer is remembered', async () => {
    const h = harness()
    const { session, detach } = mounted(h)
    const original = text('build the thing')
    answerNext(h.dialogs, confirmAs(active, false))
    await session.prompt(original, 'queue')
    assert.equal(session.prompts[0]?.content, original) // the very same array: nothing was added
    assert.deepEqual(h.skillMemory.writes, [false])
    assert.equal(h.skillMemory.last, false)
    assert.deepEqual(h.memory.last, active) // the model choice is remembered as always
    detach()
  })

  it('cancelled (button, the ✕, Escape or a mask click): nothing goes out, nothing is remembered, and the send\'s own echo is retired', async () => {
    const h = harness()
    h.skillMemory.last = false // an earlier answer
    const { session, detach } = mounted(h)
    const first = text('one')
    answerNext(h.dialogs, cancelIt)
    const aborted = await send(session, first)
    assert.deepEqual(aborted, ABORTED_SEND, 'the composer is told the send did not happen')
    assert.equal(session.prompts.length, 0, 'the host prompt is never called')
    assert.deepEqual(session.echoes.map(echo => echo.retired), [true], 'the bubble the composer painted for it is retired')

    // The same answer travels whatever control gave it: the four gestures are one `{ kind: 'cancel' }` at the gate.
    for (const gesture of ['the ✕', 'Escape', 'a mask click']) {
      answerNext(h.dialogs, cancelIt)
      assert.deepEqual(await send(session, text(gesture)), ABORTED_SEND, gesture)
    }
    assert.equal(session.prompts.length, 0)
    assert.deepEqual(session.echoes.map(echo => echo.retired), [true, true, true, true])

    // A send the composer itself abandoned while its dialog was up is not sent either.
    const controller = new AbortController()
    const echo = session.beginSubmission({ text: 'two' })
    const sending = session.prompt(text('two'), 'queue', controller.signal, echo.requestId)
    await shown(h)
    controller.abort()
    assert.deepEqual(await sending, ABORTED_SEND)
    assert.equal(session.prompts.length, 0)
    assert.deepEqual(session.echoes.map(echo => echo.retired), [true, true, true, true, true])

    // An empty send is not a send either: it passes straight through, still.
    await session.prompt([], 'queue', undefined, 'empty')
    assert.equal(session.prompts.length, 1)

    assert.deepEqual(h.skillMemory.writes, [])
    assert.equal(h.skillMemory.last, false) // the earlier answer stands
    assert.equal(h.memory.last, null)
    detach()
  })

  it('confirmed: the send goes out carrying the echo\'s own identity, and that echo is left to the host\'s prompt', async () => {
    const h = harness()
    const { session, detach } = mounted(h)
    answerNext(h.dialogs, confirmAs(active, true))
    const sent = await send(session, text('build the thing'))
    assert.deepEqual(sent, { ok: true, value: { accepted: true } }, 'the host\'s own answer reaches the composer untouched')
    assert.deepEqual(session.prompts.map(entry => entry.requestId), ['echo-1'], 'the prompt carries the identity the composer minted')
    assert.deepEqual(session.prompts[0]?.content, text(`build the thing\n/${SKILL_NAME}`))
    assert.deepEqual(session.echoes.map(echo => echo.retired), [false], 'nothing retires an echo behind the host\'s back')
    detach()
  })

  it('is not offered, and the message is never touched, when the host does not say, says it is not registered, or cannot be asked', async () => {
    const cases: [string, (h: Harness) => void][] = [
      ['an older host says nothing about the skill', (h) => { h.skill = null }],
      ['the skill is not registered', (h) => { h.skill = { name: SKILL_NAME, available: false } }],
      ['the host route cannot be read', (h) => { h.loadFails = true }],
    ]
    for (const [label, arrange] of cases) {
      const h = harness()
      arrange(h)
      const { session, detach } = mounted(h)
      const requests: DialogRequest[] = []
      // Even a dialog that insists on the skill must not make the gate invent a token the host never offered.
      answerNext(h.dialogs, (request) => { requests.push(request); request.resolve({ kind: 'confirm', config: active, applySkill: true }) })
      const original = text('build the thing')
      await session.prompt(original, 'queue')

      assert.equal(requests.length, 1, `${label}: it still asks`)
      assert.equal(requests[0]?.skill, null, label)
      assert.equal(session.prompts.length, 1, label)
      assert.equal(session.prompts[0]?.content, original, label)
      assert.deepEqual(gesturesIn(session.prompts[0]?.content), [], label)
      assert.deepEqual(h.skillMemory.writes, [], `${label}: a question that was not shown has no answer to remember`)
      assert.deepEqual(h.memory.last, active, `${label}: the model choice is remembered as always`)
      assert.equal(h.warnings.some(message => /route unavailable/.test(message)), h.loadFails, label)

      // And a cancel in the same situation sends nothing at all.
      answerNext(h.dialogs, (request) => { requests.push(request); request.resolve({ kind: 'cancel' }) })
      const again = text('and again')
      assert.deepEqual(await session.prompt(again, 'queue'), ABORTED_SEND)
      assert.equal(requests[1]?.skill, null, label)
      assert.equal(session.prompts.length, 1, `${label}: the confirmed send is still the only one`)
      detach()
    }
  })

  it('opens ticked on first use, then follows the last answer an interactive box gave', async () => {
    const h = harness()
    const { session, detach } = mounted(h)
    const opened: boolean[] = []
    const ask = async (answer: (request: DialogRequest) => void): Promise<void> => {
      answerNext(h.dialogs, (request) => { opened.push(request.initialSkill); answer(request) })
      await session.prompt(text('go'), 'queue')
    }
    await ask(cancelIt) // first use: ticked
    await ask(confirmAs(active, false)) // unticks it
    await ask(cancelIt) // a cancel changes nothing: still unticked
    await ask(confirmAs(OFF_CONFIG, false)) // a switch-off confirm answers the skill question too: still unticked
    await ask(confirmAs(chosen, true)) // ticks it again
    await ask(cancelIt)
    assert.deepEqual(opened, [true, true, false, false, false, true])
    assert.deepEqual(h.skillMemory.writes, [false, false, true], 'the switch-off confirm wrote its own answer')
    detach()
  })

  it('a confirm with the subagent-model switch off remembers the skill answer too: the box was interactive either way', async () => {
    const h = harness()
    const { session, detach } = mounted(h)
    // The checkbox is not gated by the switch any more, so a switch-off answer is a real answer to the skill question.
    answerNext(h.dialogs, confirmAs(OFF_CONFIG, true))
    await session.prompt(text('go'), 'queue')
    assert.deepEqual(h.memory.last, OFF_CONFIG, 'an off choice is a real answer and persists')
    assert.deepEqual(h.skillMemory.writes, [true], 'the ticked box is remembered')

    answerNext(h.dialogs, confirmAs(OFF_CONFIG, false))
    await session.prompt(text('and then'), 'queue')
    assert.deepEqual(h.memory.last, OFF_CONFIG)
    assert.deepEqual(h.skillMemory.writes, [true, false], 'and so is an unticked one')
    detach()
  })

  it('opens the way an earlier page left it, in any conversation', async () => {
    const h = harness()
    h.skillMemory.last = false
    const a = mounted(h, 'a')
    const b = mounted(h, 'b')
    const opened: [string, boolean][] = []
    for (const { session } of [a, b]) {
      answerNext(h.dialogs, (request) => { opened.push([request.sessionId, request.initialSkill]); request.resolve({ kind: 'cancel' }) })
      await session.prompt(text('go'), 'queue')
    }
    assert.deepEqual(opened, [['a', false], ['b', false]])
    a.detach()
    b.detach()
  })

  it('gives an attachments-only message a text part of its own in front of the attachments, and forwards the rest of the call', async () => {
    const h = harness()
    const { session, detach } = mounted(h)
    const image: PromptPartLike = { type: 'image' }
    const file: PromptPartLike = { type: 'file' }
    answerNext(h.dialogs, confirmAs(chosen, true))
    await session.prompt([image, file], 'steer', undefined, 'req-2')
    const sent = session.prompts[0]
    assert.deepEqual(sent?.content, [{ type: 'text', text: `/${SKILL_NAME}` }, image, file])
    assert.equal(sent?.content[1], image) // the attachments are the original objects, in order
    assert.equal(sent?.content[2], file)
    assert.equal(sent?.mode, 'steer')
    assert.equal(sent?.requestId, 'req-2')
    detach()
  })

  it('keeps attachments and text where they were: only the text part is rewritten', async () => {
    const h = harness()
    const { session, detach } = mounted(h)
    const image: PromptPartLike = { type: 'image' }
    const original = frozen([image, ...text('look at this')])
    answerNext(h.dialogs, confirmAs(chosen, true))
    await session.prompt(original, 'queue')
    assert.deepEqual(session.prompts[0]?.content, [image, { type: 'text', text: `look at this\n/${SKILL_NAME}` }])
    detach()
  })

  it('reads the host once per message: one read supplies the stored choice and the skill offer', async () => {
    const h = harness()
    const { session, detach } = mounted(h)
    answerNext(h.dialogs, cancelIt)
    await session.prompt(text('a'), 'queue')
    answerNext(h.dialogs, confirmAs(active, true))
    await session.prompt(text('b'), 'queue')
    assert.deepEqual(h.loads, ['s', 's'])
    detach()
  })

  it('applies the skill to the message it was asked about and not to the next one', async () => {
    const h = harness()
    const { session, detach } = mounted(h)
    answerNext(h.dialogs, confirmAs(active, true))
    await session.prompt(text('first'), 'queue')
    answerNext(h.dialogs, confirmAs(active, false))
    await session.prompt(text('second'), 'queue')
    assert.deepEqual(session.prompts.map(sent => textOf(sent.content)), [`first\n/${SKILL_NAME}`, 'second'])
    detach()
  })

  it('a skill with another name is written under that name', async () => {
    const h = harness()
    h.skill = { name: 'some-other-skill', available: true }
    const { session, detach } = mounted(h)
    answerNext(h.dialogs, confirmAs(chosen, true))
    await session.prompt(text('go'), 'queue')
    assert.deepEqual(session.prompts[0]?.content, text('go\n/some-other-skill'))
    detach()
  })
})

describe('a token already in the message', () => {
  it('is shown to the dialog as such, and the answer neither doubles the token nor claims the user chose', async () => {
    for (const typed of [`/${SKILL_NAME} do it`, `do it /${SKILL_NAME}`, `do it\n/${SKILL_NAME}\n`, `/${SKILL_NAME}`]) {
      const h = harness()
      const { session, detach } = mounted(h)
      const original = text(typed)
      const requests: DialogRequest[] = []
      // What the real dialog answers for a locked, ticked box.
      answerNext(h.dialogs, (request) => { requests.push(request); request.resolve({ kind: 'confirm', config: active, applySkill: true }) })
      await session.prompt(original, 'queue')
      assert.equal(requests[0]?.skillInMessage, true, typed)
      assert.deepEqual(requests[0]?.skill, offered, typed)
      assert.equal(session.prompts[0]?.content, original, typed) // untouched: the same array, and one token
      assert.deepEqual(gesturesIn(session.prompts[0]?.content), [SKILL_NAME], typed)
      assert.deepEqual(h.skillMemory.writes, [], `${typed}: the user was not asked, so no answer is remembered`)
      assert.deepEqual(h.memory.last, active, `${typed}: the model choice is remembered as always`)
      detach()
    }
  })

  it('wins even over a dialog that answers no: a typed token cannot be taken away, and the no is not remembered', async () => {
    const h = harness()
    const { session, detach } = mounted(h)
    const original = text(`/${SKILL_NAME} do it`)
    answerNext(h.dialogs, confirmAs(chosen, false))
    await session.prompt(original, 'queue')
    assert.equal(session.prompts[0]?.content, original)
    assert.deepEqual(h.skillMemory.writes, [])
    assert.equal(h.skillMemory.last, null)
    detach()
  })

  it('is not claimed for a message without it, for a longer word, for another skill, or when no skill is on offer', async () => {
    const cases: [string, string, (h: Harness) => void][] = [
      ['plain text', 'do it', () => {}],
      ['a longer word', `/${SKILL_NAME}-v2 do it`, () => {}],
      ['another skill', '/anchor-animation-agent-skill do it', () => {}],
      ['typed, but the host does not offer the skill', `/${SKILL_NAME} do it`, (h) => { h.skill = null }],
      ['typed, but the skill is not registered', `/${SKILL_NAME} do it`, (h) => { h.skill = { name: SKILL_NAME, available: false } }],
    ]
    for (const [label, typed, arrange] of cases) {
      const h = harness()
      arrange(h)
      const { session, detach } = mounted(h)
      const requests: DialogRequest[] = []
      answerNext(h.dialogs, (request) => { requests.push(request); request.resolve({ kind: 'cancel' }) })
      await session.prompt(text(typed), 'queue')
      assert.equal(requests[0]?.skillInMessage, false, label)
      detach()
    }
  })

  it('counts a token in any text part, and the attachments do not hide it', async () => {
    const h = harness()
    const { session, detach } = mounted(h)
    const original: PromptPartLike[] = [{ type: 'image' }, ...text('look'), ...text(`and /${SKILL_NAME} please`)]
    const requests: DialogRequest[] = []
    answerNext(h.dialogs, (request) => { requests.push(request); request.resolve({ kind: 'confirm', config: active, applySkill: true }) })
    await session.prompt(original, 'queue')
    assert.equal(requests[0]?.skillInMessage, true)
    assert.equal(session.prompts[0]?.content, original)
    detach()
  })
})

describe('what the dialog opens with, at the moment it opens', () => {
  it('is what the dialog before it left behind: one that waited behind another conversation\'s dialog sees that answer', async () => {
    const h = harness()
    const a = mounted(h, 'a')
    const b = mounted(h, 'b')
    const fromA = a.session.prompt(text('from A'), 'queue')
    const forA = await shown(h)
    assert.equal(forA.initialSkill, true)
    const fromB = b.session.prompt(text('from B'), 'queue')
    await settle() // B's dialog is requested now, behind A's, while A has not answered
    forA.resolve({ kind: 'confirm', config: chosen, applySkill: false })
    await fromA
    const forB = await shown(h)
    assert.equal(forB.sessionId, 'b')
    assert.equal(forB.initialSkill, false) // A said no; B's was requested while the answer was still true
    assert.deepEqual(forB.initial, chosen) // and B has no stored choice of its own, so it opens with the last one confirmed
    forB.resolve({ kind: 'cancel' })
    await fromB
    a.detach()
    b.detach()
  })

  it('keeps a stored choice of the conversation itself over what another conversation answered', async () => {
    const h = harness()
    const a = mounted(h, 'a')
    const b = mounted(h, 'b')
    h.stored = buildConfig({ subagentModel: null, workerEffort: 'high' })
    const fromA = a.session.prompt(text('from A'), 'queue')
    const forA = await shown(h)
    const fromB = b.session.prompt(text('from B'), 'queue')
    await settle()
    forA.resolve({ kind: 'confirm', config: chosen, applySkill: true })
    await fromA
    const forB = await shown(h)
    assert.equal(forB.initial.workerEffort, 'high')
    forB.resolve({ kind: 'cancel' })
    await fromB
    a.detach()
    b.detach()
  })
})

describe('sends in a row', () => {
  it('pass the gate in the order they were made, whatever the host takes to answer each', async () => {
    const h = harness()
    const { session, detach } = mounted(h)
    const releaseFirst = h.holdNextLoad() // the host is slow to answer the FIRST message only
    const first = session.prompt(text('FIRST'), 'queue', undefined, 'r1')
    const second = session.prompt(text('SECOND'), 'queue', undefined, 'r2')
    await settle()
    assert.deepEqual(h.loads, ['s']) // the second has not even asked the host: it waits for the first
    assert.equal(h.dialogs.current.getSnapshot(), null)
    releaseFirst()
    const one = await shown(h)
    assert.equal(one.preview, 'FIRST')
    one.resolve({ kind: 'confirm', config: active, applySkill: false })
    await first
    const two = await shown(h)
    assert.equal(two.preview, 'SECOND')
    two.resolve({ kind: 'confirm', config: active, applySkill: false })
    await second
    assert.deepEqual(session.prompts.map(sent => sent.requestId), ['r1', 'r2'])
    detach()
  })

  it('each dialog opens with what the one before it left behind', async () => {
    const h = harness()
    const { session, detach } = mounted(h)
    const first = session.prompt(text('A'), 'queue')
    const second = session.prompt(text('B'), 'queue')
    const a = await shown(h)
    assert.equal(a.initialSkill, true)
    a.resolve({ kind: 'confirm', config: chosen, applySkill: false })
    await first
    const b = await shown(h)
    assert.equal(b.preview, 'B')
    assert.equal(b.initialSkill, false) // A was answered unticked
    assert.deepEqual(b.initial, chosen)
    b.resolve({ kind: 'confirm', config: active, applySkill: false })
    await second
    assert.deepEqual(session.prompts.map(sent => textOf(sent.content)), [`A`, 'B'])
    detach()
  })

  it('an aborted send stops waiting for its turn, and the sends behind it still do not jump the queue', async () => {
    const h = harness()
    const { session, detach } = mounted(h)
    const controller = new AbortController()
    const first = session.prompt(text('one'), 'queue', undefined, 'r1')
    const second = session.prompt(text('two'), 'queue', controller.signal, 'r2')
    const third = session.prompt(text('three'), 'queue', undefined, 'r3')
    const one = await shown(h)
    controller.abort() // the second is abandoned while it waits behind the first one's dialog
    await second
    assert.deepEqual(session.prompts.map(sent => sent.requestId), ['r2']) // it goes out at once, as it was sent
    assert.equal(h.dialogs.current.getSnapshot(), one) // and the first dialog is still there, answerable
    one.resolve({ kind: 'cancel' })
    await first
    assert.deepEqual(session.prompts.map(sent => sent.requestId), ['r2'], 'the cancel sent nothing')
    const three = await shown(h)
    assert.equal(three.preview, 'three') // the third still waited for the first
    three.resolve({ kind: 'confirm', config: active, applySkill: false })
    await third
    assert.deepEqual(session.prompts.map(sent => sent.requestId), ['r2', 'r3'])
    detach()
  })

  it('an error on the way never wedges the line: the next send is still asked', async () => {
    const h = harness()
    let calls = 0
    const face = {
      sessionId: 's',
      getSnapshot: () => ({ subagent: null }),
      prompt: () => { calls += 1; if (calls === 1) throw new Error('host is down'); return Promise.resolve({ ok: true }) },
    } as SessionFaceLike
    h.dialogs.registerPresenter('s', Symbol())
    const detach = h.gate.attach(face)
    const broken = [{ type: 'text', get text(): string { throw new Error('boom') } }] as unknown as PromptPartLike[]
    await assert.rejects(face.prompt(broken, 'queue'), /host is down/) // the gate fails, then the host call itself throws
    const next = face.prompt(text('after'), 'queue')
    const request = await shown(h)
    assert.equal(request.preview, 'after')
    request.resolve({ kind: 'confirm', config: active, applySkill: false })
    await next
    assert.equal(calls, 2)
    detach()
  })

  it('a host that cannot be read does not wedge it either', async () => {
    const h = harness()
    const { session, detach } = mounted(h)
    h.loadFails = true
    const first = session.prompt(text('one'), 'queue')
    const second = session.prompt(text('two'), 'queue')
    ;(await shown(h)).resolve({ kind: 'confirm', config: active, applySkill: false })
    await first
    ;(await shown(h)).resolve({ kind: 'confirm', config: active, applySkill: false })
    await second
    assert.equal(session.prompts.length, 2)
    detach()
  })

  it('is a line per conversation: another conversation\'s send does not wait behind a slow one', async () => {
    const h = harness()
    const a = mounted(h, 'a')
    const b = mounted(h, 'b')
    const releaseA = h.holdNextLoad()
    const fromA = a.session.prompt(text('from A'), 'queue')
    const fromB = b.session.prompt(text('from B'), 'queue')
    const forB = await shown(h)
    assert.equal(forB.preview, 'from B') // B's read of the host was not held up by A's
    forB.resolve({ kind: 'cancel' })
    await fromB
    releaseA()
    const forA = await shown(h)
    assert.equal(forA.preview, 'from A')
    forA.resolve({ kind: 'cancel' })
    await fromA
    a.detach()
    b.detach()
  })

  it('leaves nothing behind once the sends are through', async () => {
    const h = harness()
    const { session, detach } = mounted(h)
    const sends = [session.prompt(text('one'), 'queue'), session.prompt(text('two'), 'queue')]
    ;(await shown(h)).resolve({ kind: 'cancel' })
    await sends[0]
    ;(await shown(h)).resolve({ kind: 'cancel' })
    await Promise.all(sends)
    await settle()
    assert.equal((h.gate as unknown as { lines: Map<string, unknown> }).lines.size, 0)
    detach()
  })

  it('asks nothing of a send that was already abandoned, and closes the dialog of one abandoned while it is up', async () => {
    const h = harness()
    const { session, detach } = mounted(h)
    const gone = new AbortController()
    gone.abort()
    const original = text('go')
    assert.deepEqual(await h.gate.beforePrompt(session, original, 'queue', gone.signal), { kind: 'send', content: original })
    assert.deepEqual(h.loads, [])
    assert.equal(h.dialogs.current.getSnapshot(), null)

    const controller = new AbortController()
    const echo = session.beginSubmission({ text: 'later' })
    const sending = session.prompt(text('later'), 'queue', controller.signal, echo.requestId)
    await shown(h)
    controller.abort()
    assert.deepEqual(await sending, ABORTED_SEND, 'abandoned while its dialog waited: nothing is sent')
    assert.equal(h.dialogs.current.getSnapshot(), null)
    assert.deepEqual(session.prompts.map(sent => textOf(sent.content)), [], 'the prompt is never called')
    assert.deepEqual(session.echoes.map(entry => entry.retired), [true])
    detach()
  })
})

describe('the skill the host last offered', () => {
  it('is still offered when a later read of the host fails, and still gets its token', async () => {
    const h = harness()
    const { session, detach } = mounted(h)
    answerNext(h.dialogs, confirmAs(active, false))
    await session.prompt(text('one'), 'queue') // a good read: the host names the skill
    h.loadFails = true
    const requests: DialogRequest[] = []
    answerNext(h.dialogs, (request) => { requests.push(request); request.resolve({ kind: 'confirm', config: active, applySkill: true }) })
    await session.prompt(text('two'), 'queue')
    assert.deepEqual(requests[0]?.skill, offered)
    assert.deepEqual(session.prompts[1]?.content, text(`two\n/${SKILL_NAME}`))
    assert.ok(h.warnings.some(message => /route unavailable/.test(message)))
    detach()
  })

  it('is whatever the host said last: a host that stops offering it, or says it is not registered, is believed', async () => {
    for (const later of [null, { name: SKILL_NAME, available: false }] as (SkillOffer | null)[]) {
      const h = harness()
      const { session, detach } = mounted(h)
      answerNext(h.dialogs, confirmAs(active, false))
      await session.prompt(text('one'), 'queue')
      h.skill = later
      answerNext(h.dialogs, confirmAs(active, false))
      await session.prompt(text('two'), 'queue') // a good read that says no
      h.loadFails = true
      const requests: DialogRequest[] = []
      answerNext(h.dialogs, (request) => { requests.push(request); request.resolve({ kind: 'confirm', config: active, applySkill: true }) })
      const original = text('three')
      await session.prompt(original, 'queue') // and then a read that fails
      assert.equal(requests[0]?.skill, null, JSON.stringify(later))
      assert.equal(session.prompts[2]?.content, original, JSON.stringify(later))
      detach()
    }
  })

  it('is shared by the whole page: a conversation whose read fails uses what another one learned', async () => {
    const h = harness()
    const a = mounted(h, 'a')
    const b = mounted(h, 'b')
    answerNext(h.dialogs, cancelIt)
    await a.session.prompt(text('from A'), 'queue')
    h.loadFails = true
    const requests: DialogRequest[] = []
    answerNext(h.dialogs, (request) => { requests.push(request); request.resolve({ kind: 'cancel' }) })
    await b.session.prompt(text('from B'), 'queue')
    assert.deepEqual(requests[0]?.skill, offered)
    a.detach()
    b.detach()
  })

  it('is never invented: a page that has not heard from the host yet offers nothing', async () => {
    const h = harness()
    h.loadFails = true
    const { session, detach } = mounted(h)
    const requests: DialogRequest[] = []
    answerNext(h.dialogs, (request) => { requests.push(request); request.resolve({ kind: 'cancel' }) })
    await session.prompt(text('go'), 'queue')
    assert.equal(requests[0]?.skill, null)
    detach()
  })

  it('is still not offered in a subagent conversation when a read fails', async () => {
    const h = harness()
    const { session, detach } = mounted(h)
    answerNext(h.dialogs, cancelIt)
    await session.prompt(text('one'), 'queue')
    h.loadFails = true
    session.snapshot = { subagent: { address: 'x' } }
    const requests: DialogRequest[] = []
    answerNext(h.dialogs, (request) => { requests.push(request); request.resolve({ kind: 'cancel' }) })
    await session.prompt(text('two'), 'queue')
    assert.equal(requests[0]?.skill, null)
    detach()
  })
})

describe('a remembered choice that cannot be read or written', () => {
  const boom = (): never => { throw new Error('boom') }

  it('does not keep the dialog from coming up: it opens with the defaults', async () => {
    const h = harness({ skillMemory: { read: boom, write: () => {} }, memory: { read: boom, write: () => {} } })
    const { session, detach } = mounted(h)
    const requests: DialogRequest[] = []
    answerNext(h.dialogs, (request) => { requests.push(request); request.resolve({ kind: 'confirm', config: active, applySkill: true }) })
    await session.prompt(text('go'), 'queue')
    assert.equal(requests.length, 1, 'it still asks')
    assert.equal(requests[0]?.initialSkill, true)
    assert.deepEqual(requests[0]?.initial, OFF_CONFIG)
    assert.deepEqual(session.prompts[0]?.content, text(`go\n/${SKILL_NAME}`))
    assert.ok(h.warnings.some(message => /could not read a remembered choice/.test(message)))
    assert.equal(h.warnings.some(message => /gate failed/.test(message)), false)
    detach()
  })

  it('does not send a message the user ticked the skill for without its token', async () => {
    const h = harness({ skillMemory: { read: () => null, write: boom }, memory: { read: () => null, write: boom } })
    const { session, detach } = mounted(h)
    answerNext(h.dialogs, confirmAs(active, true))
    await session.prompt(text('go'), 'queue')
    assert.deepEqual(session.prompts[0]?.content, text(`go\n/${SKILL_NAME}`))
    assert.ok(h.warnings.some(message => /could not remember the choice/.test(message)))
    assert.ok(h.warnings.some(message => /could not remember the skill answer/.test(message)))
    assert.equal(h.warnings.some(message => /gate failed/.test(message)), false)
    detach()
  })

  it('writes each memory on its own: one that breaks does not stop the other', async () => {
    const brokenChoice = harness({ memory: { read: () => null, write: boom } })
    const one = mounted(brokenChoice)
    answerNext(brokenChoice.dialogs, confirmAs(active, false))
    await one.session.prompt(text('go'), 'queue')
    assert.deepEqual(brokenChoice.skillMemory.writes, [false])
    one.detach()

    const brokenSkill = harness({ skillMemory: { read: () => null, write: boom } })
    const two = mounted(brokenSkill)
    answerNext(brokenSkill.dialogs, confirmAs(active, true))
    await two.session.prompt(text('go'), 'queue')
    assert.deepEqual(brokenSkill.memory.last, active)
    two.detach()
  })
})

describe('attachWhenAvailable', () => {
  it('keeps looking until a session face exists, then attaches and stops', async () => {
    const h = harness()
    let face: FakeSession | undefined
    const pending: (() => void)[] = []
    const detach = attachWhenAvailable(
      () => face,
      h.gate,
      () => {},
      (callback) => { pending.push(callback); return callback },
      () => {},
    )
    assert.equal(pending.length, 1) // no face yet: it schedules another look
    pending.shift()?.()
    assert.equal(pending.length, 1) // still nothing: it never gives up
    face = new FakeSession('late')
    pending.shift()?.()
    assert.equal(pending.length, 0) // attached: the polling stops

    h.dialogs.registerPresenter('late', Symbol())
    const asked: string[] = []
    answerNext(h.dialogs, (request) => { asked.push(request.preview); request.resolve({ kind: 'cancel' }) })
    await face.prompt(text('go'), 'queue')
    assert.deepEqual(asked, ['go']) // a late binding still gets the modal

    detach()
    await face.prompt(text('more'), 'queue')
    assert.deepEqual(asked, ['go']) // detached: sends are stock again
  })
})

describe('last-choice memory', () => {
  it('stores the last choice and tolerates missing, stale or broken storage', () => {
    const box = new Map<string, string>()
    const memory = createLastChoiceMemory({ getItem: key => box.get(key) ?? null, setItem: (key, value) => { box.set(key, value) } })
    assert.equal(memory.read(), null)
    memory.write(chosen)
    assert.deepEqual(memory.read(), chosen)

    // An entry written by an older build still pre-fills: its legacy `remember`
    // field is dropped, and the modal asks regardless — nothing can hide it.
    box.set('dsh-orquestrator:last:v1', JSON.stringify({ ...chosen, remember: true }))
    assert.deepEqual(memory.read(), chosen)
    box.set('dsh-orquestrator:last:v1', JSON.stringify({ version: 2 }))
    assert.equal(memory.read(), null)

    assert.equal(createLastChoiceMemory(undefined).read(), null)
    createLastChoiceMemory(undefined).write(active) // must not throw
    const broken = createLastChoiceMemory({ getItem: () => '{oops', setItem: () => { throw new Error('quota') } })
    assert.equal(broken.read(), null)
    broken.write(active)
  })
})

describe('skill-choice memory', () => {
  const KEY = 'dsh-orquestrator:skill:v1'

  it('reads nothing before the first answer, then what was written, as on and off', () => {
    const box = new Map<string, string>()
    const memory = createSkillChoiceMemory({ getItem: key => box.get(key) ?? null, setItem: (key, value) => { box.set(key, value) } })
    assert.equal(memory.read(), null)
    memory.write(true)
    assert.equal(box.get(KEY), 'on')
    assert.equal(memory.read(), true)
    memory.write(false)
    assert.equal(box.get(KEY), 'off')
    assert.equal(memory.read(), false)
    assert.deepEqual([...box.keys()], [KEY]) // one key, and nothing else is written
  })

  it('reads anything but on and off as no answer', () => {
    const box = new Map<string, string>()
    const memory = createSkillChoiceMemory({ getItem: key => box.get(key) ?? null, setItem: (key, value) => { box.set(key, value) } })
    for (const raw of ['', 'true', 'false', 'ON', 'Off', 'yes', '1', '0', ' on', 'off ', 'on\n', '{"on":true}', 'null', 'undefined']) {
      box.set(KEY, raw)
      assert.equal(memory.read(), null, JSON.stringify(raw))
    }
    const absent = createSkillChoiceMemory({ getItem: () => undefined as unknown as null, setItem: () => {} })
    assert.equal(absent.read(), null)
  })

  it('tolerates a missing, throwing or blocked storage and never throws on write', () => {
    assert.equal(createSkillChoiceMemory(undefined).read(), null)
    createSkillChoiceMemory(undefined).write(true) // must not throw
    const broken = createSkillChoiceMemory({
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('quota') },
    })
    assert.equal(broken.read(), null)
    broken.write(false)
    broken.write(true)
  })

  it('lives beside the last-choice memory without touching it', () => {
    const box = new Map<string, string>()
    const storage = { getItem: (key: string) => box.get(key) ?? null, setItem: (key: string, value: string) => { box.set(key, value) } }
    const last = createLastChoiceMemory(storage)
    const skill = createSkillChoiceMemory(storage)
    last.write(active)
    skill.write(false)
    assert.deepEqual(last.read(), active)
    assert.equal(skill.read(), false)
    skill.write(true)
    assert.deepEqual(last.read(), active)
    assert.equal(skill.read(), true)
    assert.equal(box.size, 2)
  })
})
