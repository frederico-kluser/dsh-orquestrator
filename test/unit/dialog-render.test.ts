/**
 * The real dialog, rendered. `OrchestratorDialog.tsx` and the client entry are not importable by Node (TSX, the DSH
 * primitives the shell supplies), so this test transpiles `src/` with the `typescript` devDependency into a temp
 * directory, stands a stub in for the primitives module (its `Checkbox` is DSH's own, minus CSS; the contract test pins
 * the real one), and renders with react-dom under jsdom. Nothing here is a mock of the code under test: the dialog, the
 * dialog host, the gate, the overlay and `apply()` are the real modules.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { after, describe, it, mock } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import ts from 'typescript'
import type { DialogInput, DialogResult } from '../../src/client/dialogs.ts'
import type { PromptPartLike } from '../../src/client/host-types.ts'
import type { SkillOffer } from '../../src/shared.ts'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'orq-render-'))

/** The primitives module the shell would supply. */
const PRIMITIVES = `import React from 'react'
const h = React.createElement
const icon = (name) => () => h('svg', { 'data-icon': name })
export const IconAgentPresetOutline16 = icon('agent')
export const IconSkillOutline16 = icon('skill')
export const IconChevronDownOutline14 = icon('chevron')
export const IconLoadingOutline16 = icon('loading')
export const Button = ({ children, variant, icon: _icon, ...rest }) => h('button', { type: 'button', 'data-variant': variant, ...rest }, children)
export const Switch = ({ checked, onChange, label, disabled }) => h('input', { type: 'checkbox', role: 'switch', 'aria-label': label, checked, disabled, onChange: (event) => { onChange(event.target.checked) } })
export const Checkbox = ({ checked, onChange, label, disabled = false, title, className }) =>
  h('label', { className, title }, h('input', { type: 'checkbox', checked, disabled, onChange: (event) => { onChange(event.target.checked) } }), h('span', null, label))
export const Modal = ({ open, onClose, title, description, closeLabel, className, footer, children }) => open
  ? h('div', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title, className }, h('button', { 'aria-label': closeLabel, 'data-close': '', onClick: onClose }), h('p', null, description), children, h('footer', null, footer))
  : null
export const Menu = ({ anchor }) => h('div', null, anchor)
`

/** Transpile every module of `src/` the way the build reads it (JSX automatic runtime, `.ts` specifiers rewritten). */
function transpileSources(): void {
  const src = join(repo, 'src')
  const stub = join(work, 'primitives.js')
  writeFileSync(stub, PRIMITIVES)
  writeFileSync(join(work, 'package.json'), '{"type":"module"}')
  symlinkSync(join(repo, 'node_modules'), join(work, 'node_modules'), 'dir')
  for (const file of readdirSync(src, { recursive: true, encoding: 'utf8' })) {
    if (!/\.tsx?$/.test(file) || file.endsWith('.d.ts')) continue
    const out = join(work, file.replace(/\.tsx?$/, '.js'))
    const toStub = relative(dirname(out), stub).split(sep).join('/')
    const js = ts.transpileModule(readFileSync(join(src, file), 'utf8'), {
      fileName: join(src, file),
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, rewriteRelativeImportExtensions: true },
    }).outputText.replace(/(['"])@deepseek-ai\/dsh-client-ui-primitives\1/g, JSON.stringify(toStub.startsWith('.') ? toStub : `./${toStub}`))
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, js)
  }
}
transpileSources()

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://dsh.test/' })
const dsh = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { value: key === 'window' ? dom.window : dsh[key], configurable: true, writable: true })
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true })
const realFetch = globalThis.fetch
// A cancel leaves the dialog's 1.5 s "wait for the host" timer behind; with the clock mocked no real timer holds the process open.
mock.timers.enable({ apis: ['setTimeout'] })

const load = async <T>(file: string): Promise<T> => (await import(pathToFileURL(join(work, file)).href)) as T
const { createRoot } = await import('react-dom/client')
const { OrchestratorDialog } = await load<typeof import('../../src/client/OrchestratorDialog.tsx')>('client/OrchestratorDialog.js')
const { DialogHost } = await load<typeof import('../../src/client/dialogs.ts')>('client/dialogs.js')
const { LOADING_CATALOG } = await load<typeof import('../../src/client/catalog.ts')>('client/catalog.js')
const { en } = await load<typeof import('../../src/client/locales.ts')>('client/locales.js')
const { OFF_CONFIG, SKILL_NAME, buildConfig } = await load<typeof import('../../src/shared.ts')>('shared.js')
const entry = await load<typeof import('../../src/client/index.ts')>('client/index.js')

after(() => {
  mock.timers.reset()
  Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true })
  dom.window.close()
  unlinkSync(join(work, 'node_modules'))
  rmSync(work, { recursive: true, force: true })
})

const t = (key: keyof typeof en, params: Record<string, unknown> = {}): string =>
  Object.entries(params).reduce((text: string, [name, value]) => text.replaceAll(`{${name}}`, String(value)), en[key])
const offer: SkillOffer = { name: SKILL_NAME, available: true }
const KEY = 'dsh-orquestrator:skill:v1'
const LAST = 'dsh-orquestrator:last:v1'
/** A model to run subagents on: with it stored, the subagent-model switch opens ON and the skill box is interactive. */
const ROUTE = { provider: 'openrouter', model: 'google/gemini-3.8-flash' }
const ON_CONFIG = buildConfig({ subagentModel: ROUTE })
const STORED_EFFORT = buildConfig({ subagentModel: ROUTE, workerEffort: 'high' })

/** Wait, inside act so that React settles, until something is on the page; running out of turns fails the test instead of hanging it. */
async function until(what: string, ready: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !ready(); turn += 1) await act(async () => { await new Promise<void>((resolve) => { setImmediate(resolve) }) })
  assert.ok(ready(), `timed out waiting for ${what}`)
}
const click = (node: Element | null | undefined): Promise<void> => act(async () => { (node as HTMLElement).click() })
const button = (el: Element, variant: 'primary' | 'outline'): Element | null => el.querySelector(`footer button[data-variant=${variant}]`)
const skillBox = (el: Element): HTMLInputElement | null => el.querySelector<HTMLInputElement>('.dsh-orq-skill input[type=checkbox]')
const modelSwitch = (el: Element): HTMLInputElement | null => el.querySelector<HTMLInputElement>('input[role=switch]')
const skillHint = (el: Element): string | null => el.querySelector('.dsh-orq-skill-hint')?.textContent ?? null

interface Open {
  readonly el: HTMLElement
  readonly answer: Promise<DialogResult>
  readonly saves: unknown[]
  settleSave(failure?: string): Promise<void>
  close(): Promise<void>
}

/** Raise a real dialog through the real DialogHost (a composer is mounted for it) and render the real component. */
async function open(overrides: Partial<DialogInput> = {}, holdSave = false): Promise<Open> {
  const host = new DialogHost()
  host.registerPresenter('s', Symbol('composer'))
  const saves: unknown[] = []
  const held: { resolve: () => void; reject: (error: Error) => void }[] = [] // the saves still waiting for the host, oldest first
  const answer = host.request({
    sessionId: 's', mode: 'gate', preview: 'build the thing', initial: OFF_CONFIG, skill: offer, skillInMessage: false, initialSkill: true,
    save: async (config) => {
      saves.push(config)
      if (holdSave) await new Promise<void>((resolve, reject) => { held.push({ resolve, reject: (error) => { reject(error) } }) })
    },
    ...overrides,
  })
  const request = host.current.getSnapshot()
  assert.ok(request !== null, 'the dialog is on screen')
  const el = document.body.appendChild(document.createElement('div'))
  const root = createRoot(el)
  await act(async () => { root.render(React.createElement(OrchestratorDialog, { request, catalog: LOADING_CATALOG, reloadCatalog: () => {}, t })) })
  const settleSave = (failure?: string): Promise<void> => act(async () => { const next = held.shift(); if (failure === undefined) next?.resolve(); else next?.reject(new Error(failure)) })
  return { el, answer, saves, settleSave, close: async () => { await act(async () => { root.unmount() }); el.remove() } }
}

describe('the dialog, rendered', { timeout: 30_000 }, () => {
  it('shows the skill as its last section: a title, a checkbox, and the hint that fits the switch; the error line comes after', async () => {
    const o = await open({}, true)
    const section = o.el.querySelector('section.dsh-orq-skill')
    assert.ok(section)
    const heading = section.querySelector('h3.dsh-orq-title')
    assert.equal(heading?.textContent, t('skill.title'))
    assert.equal(section.getAttribute('aria-labelledby'), heading?.id)
    assert.equal(section.querySelector('label')?.textContent, t('skill.checkbox'))
    assert.equal(skillHint(o.el), t('skill.needsModel'), 'the switch is off on a fresh dialog: the box waits for it')
    const stack = o.el.querySelector('.dsh-orq-stack')
    const names = (): string[] => [...(stack?.children ?? [])].map(child => child.className)
    assert.deepEqual(names(), ['dsh-orq-task', 'dsh-orq-section', 'dsh-orq-section dsh-orq-skill'])
    await click(button(o.el, 'primary'))
    await o.settleSave('route down')
    assert.deepEqual(names(), ['dsh-orq-task', 'dsh-orq-section', 'dsh-orq-section dsh-orq-skill', 'dsh-orq-error'])
    await o.close()
  })

  it('opens the box the way the request says (switch on), and a confirm answers what the box shows', async () => {
    for (const initialSkill of [true, false]) {
      for (const clicks of [0, 1, 2, 3]) {
        const o = await open({ initialSkill, initial: ON_CONFIG })
        assert.equal(skillBox(o.el)?.checked, initialSkill, `initialSkill ${String(initialSkill)}`)
        assert.equal(skillBox(o.el)?.disabled, false)
        for (let i = 0; i < clicks; i += 1) await click(skillBox(o.el))
        const expected = clicks % 2 === 0 ? initialSkill : !initialSkill
        assert.equal(skillBox(o.el)?.checked, expected)
        await click(button(o.el, 'primary'))
        assert.deepEqual(await o.answer, { kind: 'confirm', config: ON_CONFIG, applySkill: expected }, `${String(initialSkill)} after ${String(clicks)} clicks`)
        await o.close()
      }
    }
  })

  it('the box follows the subagent-model switch: off and locked without it, whatever the memory says', async () => {
    const o = await open({ initialSkill: true })
    assert.deepEqual([skillBox(o.el)?.checked, skillBox(o.el)?.disabled], [false, true], 'unchecked and disabled with the switch off')
    assert.equal(skillHint(o.el), t('skill.needsModel'))
    await click(skillBox(o.el))
    assert.equal(skillBox(o.el)?.checked, false, 'a disabled box does not move')
    await click(modelSwitch(o.el)) // the switch on: the box shows the state the memory holds
    assert.deepEqual([skillBox(o.el)?.checked, skillBox(o.el)?.disabled], [true, false])
    assert.equal(skillHint(o.el), t('skill.hint', { token: `/${SKILL_NAME}` }))
    await click(modelSwitch(o.el)) // and off again: the shown state is gated again
    assert.deepEqual([skillBox(o.el)?.checked, skillBox(o.el)?.disabled], [false, true])
    await o.close()
  })

  it('a switch off-and-on round trip keeps the box state the user left, and the confirm answers the effective box', async () => {
    const o = await open({ initialSkill: true, initial: ON_CONFIG })
    await click(skillBox(o.el)) // the user unticks it
    await click(modelSwitch(o.el)) // off
    assert.deepEqual([skillBox(o.el)?.checked, skillBox(o.el)?.disabled], [false, true])
    await click(modelSwitch(o.el)) // on again
    assert.equal(skillBox(o.el)?.checked, false, 'the user\'s untick is restored, not the ticked default')
    await click(button(o.el, 'primary'))
    assert.deepEqual(await o.answer, { kind: 'confirm', config: ON_CONFIG, applySkill: false })
    await o.close()
    const ticked = await open({ initialSkill: true, initial: ON_CONFIG })
    await click(button(ticked.el, 'primary'))
    assert.deepEqual(await ticked.answer, { kind: 'confirm', config: ON_CONFIG, applySkill: true }, 'applySkill true only when the effective box is ticked')
    await ticked.close()
    const gated = await open({ initialSkill: false })
    await click(modelSwitch(gated.el)) // switch on, but no model picked yet: the box shows the remembered off state
    assert.equal(skillBox(gated.el)?.checked, false)
    await click(skillBox(gated.el)) // the box is interactive: the user ticks it
    await click(modelSwitch(gated.el)) // switch off: the tick is remembered but not shown
    assert.equal(skillBox(gated.el)?.checked, false)
    await click(modelSwitch(gated.el))
    assert.equal(skillBox(gated.el)?.checked, true, 'restored')
    await gated.close()
  })

  it('refuses to confirm with the switch on and no model: a confirmed choice always carries a model (the gate\'s memory rule reads it from the config)', async () => {
    const o = await open({ initialSkill: true })
    await click(modelSwitch(o.el)) // switch on, picker empty
    assert.deepEqual([skillBox(o.el)?.checked, skillBox(o.el)?.disabled], [true, false])
    const primary = button(o.el, 'primary') as HTMLButtonElement | null
    assert.equal(primary?.disabled, true, 'the confirm button waits for a model')
    let settled = false
    void o.answer.then(() => { settled = true })
    await click(primary)
    await act(async () => { await new Promise<void>((resolve) => { setImmediate(resolve) }) })
    assert.equal(settled, false, 'no confirm came out of it')
    await click(button(o.el, 'outline'))
    assert.deepEqual(await o.answer, { kind: 'cancel' }, 'only the cancel settles')
    await o.close()
  })

  it('answers a plain cancel, whatever the box says, from the Cancel button and from the close button', async () => {
    for (const control of ['cancel', 'close']) {
      const o = await open()
      await click(control === 'cancel' ? button(o.el, 'outline') : o.el.querySelector('[data-close]'))
      assert.deepEqual(await o.answer, { kind: 'cancel' }, control)
      assert.deepEqual(o.saves, [null], `${control} clears the stored choice`)
      await o.close()
    }
  })

  it('shows no skill without an offer, and none in configure mode even if one is passed; either confirms with applySkill false', async () => {
    for (const overrides of [{ skill: null }, { mode: 'configure' as const, preview: '' }]) {
      const o = await open({ initialSkill: true, ...overrides })
      assert.equal(o.el.querySelector('.dsh-orq-skill'), null)
      assert.equal(o.el.querySelector('input[type=checkbox]:not([role=switch])'), null)
      assert.ok(!(o.el.textContent ?? '').includes(t('skill.title')))
      await click(button(o.el, 'primary'))
      assert.deepEqual(await o.answer, { kind: 'confirm', config: OFF_CONFIG, applySkill: false })
      await o.close()
    }
  })

  it('locks the box while the choice is saved, and unlocks it with the user\'s state when the save fails', async () => {
    const o = await open({ initial: ON_CONFIG }, true)
    await click(skillBox(o.el)) // untick
    assert.equal(skillBox(o.el)?.disabled, false)
    await click(button(o.el, 'primary'))
    assert.equal(skillBox(o.el)?.disabled, true, 'locked while saving')
    await o.settleSave('route down')
    assert.equal(skillBox(o.el)?.disabled, false)
    assert.equal(skillBox(o.el)?.checked, false, 'the user\'s state is kept')
    assert.match(o.el.querySelector('.dsh-orq-error')?.textContent ?? '', /route down/)
    await click(skillBox(o.el)) // tick it again, and retry: the retry must carry what the box shows NOW, not what it showed at the first try
    await click(button(o.el, 'primary'))
    await o.settleSave()
    assert.deepEqual(await o.answer, { kind: 'confirm', config: ON_CONFIG, applySkill: true })
    await o.close()
  })

  it('a token already in the message: the hint says so whatever the switch is, and only the switch decides the box', async () => {
    for (const initial of [ON_CONFIG, OFF_CONFIG]) {
      const locked = initial === ON_CONFIG
      const o = await open({ skillInMessage: true, initialSkill: false, initial })
      assert.equal(skillHint(o.el), t('skill.typed', { token: `/${SKILL_NAME}` }), 'reality first: the token applies the skill')
      assert.deepEqual([skillBox(o.el)?.checked, skillBox(o.el)?.disabled], [locked, true], locked ? 'ticked and locked' : 'unchecked and gated by the switch')
      await click(skillBox(o.el)) // a locked box does not move
      assert.equal(skillBox(o.el)?.checked, locked)
      await click(button(o.el, 'primary'))
      assert.deepEqual(await o.answer, { kind: 'confirm', config: initial, applySkill: locked }, locked ? 'a token with the switch on' : 'a token with the switch off')
      await o.close()
    }
    const bare = await open({ skill: null, skillInMessage: true })
    assert.equal(bare.el.querySelector('.dsh-orq-skill'), null, 'nothing to lock when nothing is offered')
    await bare.close()
  })

  it('keeps a stored effort level while the model\'s ladder is unknown, and confirm writes it back', async () => {
    const o = await open({ initial: STORED_EFFORT, initialSkill: true })
    assert.ok(o.el.querySelector('section.dsh-orq-section-quiet'), 'the effort block is there with the stored model')
    assert.equal(o.el.querySelector('section.dsh-orq-section-quiet .dsh-orq-hint')?.textContent, t('effort.summary.custom'), 'a stored level stays chosen (the catalog has not answered yet)')
    await click(button(o.el, 'primary'))
    assert.deepEqual(await o.answer, { kind: 'confirm', config: STORED_EFFORT, applySkill: true }, 'confirm keeps the level instead of resetting it to recommended')
    await o.close()
  })
})

/** The client entry, run for real against a fake DSH client and a fake host route. */
async function boot(skill: SkillOffer | null = offer) {
  const storage = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) } }, configurable: true, writable: true })
  let holdGet: Promise<void> | undefined
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (input: string | URL | Request, init?: RequestInit) => {
      const posted = init?.method === 'POST' ? JSON.parse(String(init.body)) as { sessionId: string; config: unknown } : undefined
      const held = holdGet
      if (posted === undefined && held !== undefined) { holdGet = undefined; await held }
      const sessionId = posted?.sessionId ?? new URL(String(input)).searchParams.get('sessionId')
      return new Response(JSON.stringify({ sessionId, config: posted?.config ?? null, skill }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const bindings = new Map<string, { session: unknown }>()
  const slots: { spec: { name: string; inject: (id: string) => { host: unknown } }; component: unknown }[] = []
  const commands: { name: string; ui: { run: (session: { sessionId: string }) => void } }[] = []
  const language = { active: 'en', locales: [{ id: 'en' }] } // a store snapshot must be the same object every time
  const locale = { register: () => () => {}, bind: () => t, getSnapshot: () => language, subscribe: () => () => {} }
  const services: Record<string, unknown> = {
    sessions: { binding: (id: string) => bindings.get(id) },
    slots: { inject: (_name: string, factory: () => unknown) => factory(), register: (spec: never, component: unknown) => { slots.push({ spec, component }); return () => {} } },
    locale,
    commandUi: { register: (command: never) => { commands.push(command); return () => {} } },
  }
  const ctx = { get: (name: string) => services[name], inject: (_deps: string[], run: (scope: unknown) => void) => { run(ctx) }, effect: (run: () => unknown, name: string) => (/marks/.test(name) ? undefined : run()) }
  entry.apply(ctx as never)
  const overlay = slots.find(slot => slot.spec.name === 'conversation.input.overlay')
  assert.ok(overlay)
  const { dialogs } = (overlay.spec.inject('any') as unknown as { host: { dialogs: InstanceType<typeof DialogHost> } }).host
  /** A conversation: a session face whose `prompt` the gate wraps, and the composer overlay mounted for it. */
  async function conversation(sessionId: string) {
    class Face {
      readonly sessionId = sessionId
      readonly sent: PromptPartLike[][] = []
      getSnapshot(): { subagent: null } { return { subagent: null } }
      prompt(content: readonly PromptPartLike[]): Promise<unknown> { this.sent.push([...content]); return Promise.resolve({ ok: true }) }
    }
    const face = new Face()
    bindings.set(sessionId, { session: face })
    const el = document.body.appendChild(document.createElement('div'))
    const root = createRoot(el)
    await act(async () => { root.render(React.createElement(overlay?.component as never, { sessionId, host: overlay?.spec.inject(sessionId).host })) })
    return { el, face, send: (text: string) => face.prompt([{ type: 'text', text }]), leave: () => act(async () => { root.unmount() }) }
  }
  return { storage, commands, dialogs, conversation, holdNextRead: () => { let release = (): void => {}; holdGet = new Promise<void>((resolve) => { release = resolve }); return release } }
}

describe('the client entry, wired', { timeout: 30_000 }, () => {
  it('remembers the skill answer in the page\'s storage and opens the next dialog the way it was left', async () => {
    const app = await boot()
    const chat = await app.conversation('s')
    app.storage.set(LAST, JSON.stringify(ON_CONFIG)) // this conversation already runs subagents on their own model
    const sent = chat.send('one')
    await until('the first dialog', () => skillBox(chat.el) !== null)
    assert.equal(skillBox(chat.el)?.checked, true, 'ticked on first use')
    await click(skillBox(chat.el)) // untick
    await click(button(chat.el, 'primary'))
    assert.deepEqual(await sent, { ok: true })
    assert.equal(app.storage.get(KEY), 'off', 'the answer reached localStorage')
    assert.deepEqual(chat.face.sent, [[{ type: 'text', text: 'one' }]])

    const again = chat.send('two')
    await until('the second dialog', () => skillBox(chat.el) !== null)
    assert.equal(skillBox(chat.el)?.checked, false, 'opens the way it was left')
    await click(skillBox(chat.el)) // tick
    await click(button(chat.el, 'primary'))
    await again
    assert.equal(app.storage.get(KEY), 'on')
    assert.deepEqual(chat.face.sent[1], [{ type: 'text', text: `two\n/${SKILL_NAME}` }])
    await chat.leave()
  })

  it('a message that already carries the token says so and goes out with that one token, box or not', async () => {
    const app = await boot()
    const chat = await app.conversation('s')
    const sent = chat.send(`/${SKILL_NAME} fix it`)
    await until('the dialog', () => skillBox(chat.el) !== null)
    assert.deepEqual([skillBox(chat.el)?.checked, skillBox(chat.el)?.disabled], [false, true], 'a fresh dialog has the switch off: the box is gated, the typed token stands')
    assert.equal(chat.el.querySelector('.dsh-orq-skill-hint')?.textContent, t('skill.typed', { token: `/${SKILL_NAME}` }))
    await click(button(chat.el, 'primary'))
    await sent
    assert.deepEqual(chat.face.sent, [[{ type: 'text', text: `/${SKILL_NAME} fix it` }]])
    assert.equal(app.storage.has(KEY), false, 'the user was not asked, so nothing is remembered')
    await chat.leave()
  })

  it('with the subagent-model switch off there is no skill answer to remember, and the model answer still persists', async () => {
    const app = await boot()
    const chat = await app.conversation('s')
    app.storage.set(KEY, 'on') // the preference an earlier, interactive dialog left
    const sent = chat.send('plain task')
    await until('the dialog', () => skillBox(chat.el) !== null)
    assert.deepEqual([skillBox(chat.el)?.checked, skillBox(chat.el)?.disabled], [false, true])
    assert.equal(chat.el.querySelector('.dsh-orq-skill-hint')?.textContent, t('skill.needsModel'))
    await click(button(chat.el, 'primary'))
    await sent
    assert.equal(app.storage.get(KEY), 'on', 'no skill answer was given: the preference is untouched')
    assert.equal((JSON.parse(app.storage.get(LAST) ?? 'null') as { subagentModel: unknown }).subagentModel, null, 'the off model choice is remembered as always')
    assert.deepEqual(chat.face.sent, [[{ type: 'text', text: 'plain task' }]])
    await chat.leave()
  })

  it('/orquestrar opens the dialog without a skill, and the answer sends nothing', async () => {
    const app = await boot()
    const chat = await app.conversation('s')
    app.commands.find(command => command.name === 'orquestrar')?.ui.run({ sessionId: 's' })
    await until('the configure dialog', () => chat.el.querySelector('[role=dialog]') !== null)
    // What the entry raised, not only what the dialog chose to draw: the dialog would hide a skill offered here anyway.
    const raised = app.dialogs.current.getSnapshot()
    assert.deepEqual([raised?.mode, raised?.skill, raised?.skillInMessage, raised?.initialSkill], ['configure', null, false, false])
    assert.equal(chat.el.querySelector('.dsh-orq-skill'), null)
    assert.ok(!(chat.el.textContent ?? '').includes(t('skill.title')))
    await click(button(chat.el, 'primary'))
    await until('the dialog to close', () => chat.el.querySelector('[role=dialog]') === null)
    assert.deepEqual(chat.face.sent, [])
    assert.equal(app.storage.has(KEY), false, 'a configure dialog never answers the skill question')
    await chat.leave()
  })

  it('a composer that leaves while /orquestrar reads the host does not jam every later send', async () => {
    const app = await boot()
    const a = await app.conversation('a')
    const b = await app.conversation('b')
    const release = app.holdNextRead() // the host is slow to answer the read /orquestrar makes first
    app.commands.find(command => command.name === 'orquestrar')?.ui.run({ sessionId: 'a' })
    await a.leave() // the user navigates away while it waits
    release()
    const sent = b.send('from B')
    await until('B\'s dialog, not a phantom of the left conversation', () => skillBox(b.el) !== null)
    await click(button(b.el, 'primary'))
    await sent
    // A fresh dialog has the subagent-model switch off, so no skill token: this test is about the jam, not the skill.
    assert.deepEqual(b.face.sent, [[{ type: 'text', text: 'from B' }]])
    await b.leave()
  })

  it('a host that does not offer the skill shows no checkbox and sends the message as it is', async () => {
    const app = await boot(null)
    const chat = await app.conversation('s')
    const sent = chat.send('plain')
    await until('the dialog', () => chat.el.querySelector('[role=dialog]') !== null)
    assert.equal(skillBox(chat.el), null)
    await click(button(chat.el, 'primary'))
    await sent
    assert.deepEqual(chat.face.sent, [[{ type: 'text', text: 'plain' }]])
    assert.equal(app.storage.has(KEY), false)
    await chat.leave()
  })
})
