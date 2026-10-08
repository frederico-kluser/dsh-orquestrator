/**
 * The real dialog, rendered. `OrchestratorDialog.tsx` and the client entry are not importable by Node (TSX, the DSH
 * primitives the shell supplies), so this test transpiles `src/` with the `typescript` devDependency into a temp
 * directory, stands a stub in for the primitives module (its `Checkbox` is DSH's own, minus CSS; the contract test pins
 * the real one) and one for `model-facts.ts` (so the capability strip's answers are handed over by the test, one at a
 * time), and renders with react-dom under jsdom. Nothing here is a mock of the code under test: the dialog, the dialog
 * host, the gate, the overlay and `apply()` are the real modules.
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
import type { CatalogState } from '../../src/client/catalog.ts'
import type { DialogInput, DialogResult } from '../../src/client/dialogs.ts'
import type { PromptPartLike } from '../../src/client/host-types.ts'
import type { ModelFacts } from '../../src/client/model-facts.ts'
import type { SkillOffer } from '../../src/shared.ts'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'orq-render-'))

/** The primitives module the shell would supply. The menu renders its rows while it is open, so a test can pick one. */
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
export const Menu = ({ open, anchor, items = [], onSelect }) => h('div', null, anchor, open
  ? h('div', { 'data-menu': '' }, items.filter((item) => item.type === undefined).map((item) => h('button', { key: item.id, type: 'button', 'data-item': item.id, onClick: () => { onSelect(item.id) } }, item.label)))
  : null)
`

/**
 * The `model-facts.ts` contract, with the test's hand on the trigger: every call is recorded and stays pending until
 * the test answers it, which is how the strip's late-answer rule is pinned. The real module (cache, fetch, never
 * rejecting) is the other writer's surface.
 */
const FACTS_STUB = `const state = { asked: [], pending: [] }
globalThis.__orqFacts = state
export function modelFactsOf(model, displayName) {
  state.asked.push({ model, displayName })
  return new Promise((resolve) => { state.pending.push({ model, resolve }) })
}
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
  writeFileSync(join(work, 'client', 'model-facts.js'), FACTS_STUB)
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
/** A model to run subagents on: with it stored, the subagent-model switch opens ON. */
const ROUTE = { provider: 'openrouter', model: 'google/gemini-3.8-flash' }
const ON_CONFIG = buildConfig({ subagentModel: ROUTE })
const STORED_EFFORT = buildConfig({ subagentModel: ROUTE, workerEffort: 'high' })
/** The main agent's model of {@link CATALOG}, and the model of {@link PLAIN_CATALOG}, which has no reasoning levels. */
const MAIN = { provider: 'openrouter', model: 'z-ai/glm-5.3', reasoningEffort: 'medium' }
const PLAIN_ROUTE = { provider: 'openrouter', model: 'plain-chat' }
const LEVEL_NAMES: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', max: 'Max' }
const ladder = (...ids: string[]): { efforts: { id: string; name: string }[]; defaultEffort: string } => ({
  efforts: ids.map(id => ({ id, name: LEVEL_NAMES[id] ?? id })),
  defaultEffort: ids[0] ?? 'low',
})
/** A ready catalog: the main model offers four levels, the picked one three. */
const CATALOG: CatalogState = {
  status: 'ready',
  error: null,
  current: MAIN,
  groups: [{
    id: 'openrouter',
    name: 'OpenRouter',
    models: [
      { id: MAIN.model, name: 'GLM 5.3', reasoning: ladder('low', 'medium', 'high', 'max') },
      { id: ROUTE.model, name: 'Gemini 3.8 Flash', reasoning: ladder('low', 'medium', 'high') },
    ],
  }],
}
/** A ready catalog whose model has no reasoning ladder at all. */
const PLAIN_CATALOG: CatalogState = {
  status: 'ready',
  error: null,
  current: PLAIN_ROUTE,
  groups: [{ id: 'openrouter', name: 'OpenRouter', models: [{ id: PLAIN_ROUTE.model, name: 'Plain Chat' }] }],
}

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
const modelPicker = (el: Element): HTMLButtonElement | null => el.querySelector<HTMLButtonElement>('button.dsh-orq-picker')
const effortSelect = (el: Element): HTMLSelectElement | null => el.querySelector<HTMLSelectElement>('select.dsh-orq-select')
const optionValues = (select: HTMLSelectElement | null): string[] => Array.from(select?.options ?? []).map(option => option.value)
const optionLabels = (select: HTMLSelectElement | null): string[] => Array.from(select?.options ?? []).map(option => option.textContent ?? '')
/** The field a control lives in: what the dialog's section stacks, in order. */
const field = (node: Element | null): Element | null => node?.closest('.dsh-orq-field') ?? null

/** Pick a model in the real ModelPicker through the stub menu (its rows only exist while it is open). */
async function pickModel(el: Element, name: string): Promise<void> {
  await click(modelPicker(el))
  const row = Array.from(el.querySelectorAll('[data-item]')).find(item => item.textContent === name)
  assert.ok(row !== undefined, `no menu row for ${name}`)
  await click(row)
}

/** Choose a level in the native effort select, as a user does: set the value, then fire the change. */
async function chooseEffort(el: Element, value: string): Promise<void> {
  const select = effortSelect(el)
  assert.ok(select !== null, 'the effort select is on screen')
  await act(async () => {
    select.value = value
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    select.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}

interface FactsCall {
  readonly model: string
  readonly displayName?: string | undefined
}
interface FactsState {
  readonly asked: FactsCall[]
  readonly pending: { model: string; resolve: (facts: ModelFacts | null) => void }[]
}
const factsState = (): FactsState => (globalThis as unknown as { __orqFacts: FactsState }).__orqFacts
/** Forget every request of the tests before: each strip test starts from an empty queue. */
const resetFacts = (): void => { factsState().asked.length = 0; factsState().pending.length = 0 }
/** Answer the pending facts request of one model, inside act so that React settles. */
async function answerFacts(model: string, facts: ModelFacts | null): Promise<void> {
  const pending = factsState().pending
  const index = pending.findIndex(entry => entry.model === model)
  assert.ok(index >= 0, `no pending facts request for ${model}`)
  const entry = pending.splice(index, 1)[0]
  await act(async () => {
    entry?.resolve(facts)
    await new Promise<void>((resolve) => { setImmediate(resolve) })
  })
}
const factsOf = (modalities: ModelFacts['modalities'], score: ModelFacts['score']): ModelFacts => ({ modalities, score })

interface Open {
  readonly el: HTMLElement
  readonly answer: Promise<DialogResult>
  readonly saves: unknown[]
  settleSave(failure?: string): Promise<void>
  close(): Promise<void>
}

/** Raise a real dialog through the real DialogHost (a composer is mounted for it) and render the real component. */
async function open(overrides: Partial<DialogInput> = {}, holdSave = false, catalog: CatalogState = LOADING_CATALOG): Promise<Open> {
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
  await act(async () => { root.render(React.createElement(OrchestratorDialog, { request, catalog, reloadCatalog: () => {}, t })) })
  const settleSave = (failure?: string): Promise<void> => act(async () => { const next = held.shift(); if (failure === undefined) next?.resolve(); else next?.reject(new Error(failure)) })
  return { el, answer, saves, settleSave, close: async () => { await act(async () => { root.unmount() }); el.remove() } }
}

describe('the dialog, rendered', { timeout: 30_000 }, () => {
  it('stacks the task, one model section and the skill section: no reasoning-effort section, no Show/Hide button', async () => {
    const o = await open({}, true)
    const stack = o.el.querySelector('.dsh-orq-stack')
    const names = (): string[] => [...(stack?.children ?? [])].map(child => child.className)
    assert.deepEqual(names(), ['dsh-orq-task', 'dsh-orq-section', 'dsh-orq-section dsh-orq-skill'])
    const section = o.el.querySelector('section.dsh-orq-skill')
    assert.ok(section)
    const heading = section.querySelector('h3.dsh-orq-title')
    assert.equal(heading?.textContent, t('skill.title'))
    assert.equal(section.getAttribute('aria-labelledby'), heading?.id)
    assert.equal(section.querySelector('label')?.textContent, t('skill.checkbox'))
    // The 0.8.1 coupling is gone: with the switch off the box is there, enabled and ticked, on the plain hint.
    assert.deepEqual([skillBox(o.el)?.checked, skillBox(o.el)?.disabled], [true, false])
    assert.equal(skillHint(o.el), t('skill.hint', { token: `/${SKILL_NAME}` }))
    // The effort block is not merely closed: it is gone. Two headings (the two sections), no toggle, nothing collapsed.
    assert.equal(o.el.querySelectorAll('h3.dsh-orq-title').length, 2)
    assert.equal(o.el.querySelector('.dsh-orq-link'), null, 'no Show/Hide button')
    assert.equal(o.el.querySelector('[aria-controls]'), null)
    assert.equal(o.el.querySelector('section.dsh-orq-section-quiet'), null)
    assert.ok(effortSelect(o.el) !== null, 'and the effort select is always visible in its place')
    await click(button(o.el, 'primary'))
    await o.settleSave('route down')
    assert.deepEqual(names(), ['dsh-orq-task', 'dsh-orq-section', 'dsh-orq-section dsh-orq-skill', 'dsh-orq-error'])
    await o.close()
  })

  it('opens the box the way the request says, and a confirm answers what the box shows, switch on or off', async () => {
    for (const subagentsOn of [false, true]) {
      for (const initialSkill of [true, false]) {
        for (const clicks of [0, 1, 2, 3]) {
          const o = await open({ initialSkill, initial: subagentsOn ? ON_CONFIG : OFF_CONFIG })
          assert.equal(skillBox(o.el)?.checked, initialSkill, `switch ${String(subagentsOn)}`)
          assert.equal(skillBox(o.el)?.disabled, false)
          for (let i = 0; i < clicks; i += 1) await click(skillBox(o.el))
          const expected = clicks % 2 === 0 ? initialSkill : !initialSkill
          assert.equal(skillBox(o.el)?.checked, expected)
          await click(button(o.el, 'primary'))
          assert.deepEqual(
            await o.answer,
            { kind: 'confirm', config: subagentsOn ? ON_CONFIG : OFF_CONFIG, applySkill: expected },
            `switch ${String(subagentsOn)}, initial ${String(initialSkill)}, ${String(clicks)} clicks`,
          )
          await o.close()
        }
      }
    }
  })

  it('is never gated by the subagent-model switch: it keeps the user\'s state across it and stays toggleable', async () => {
    const o = await open({ initialSkill: true, initial: ON_CONFIG })
    await click(skillBox(o.el)) // the user unticks it
    assert.equal(skillBox(o.el)?.checked, false)
    await click(modelSwitch(o.el)) // off: nothing about the box changes
    assert.deepEqual([skillBox(o.el)?.checked, skillBox(o.el)?.disabled], [false, false], 'still there, still the user\'s state')
    assert.equal(skillHint(o.el), t('skill.hint', { token: `/${SKILL_NAME}` }))
    await click(skillBox(o.el)) // and still toggleable with no subagent model at all
    assert.equal(skillBox(o.el)?.checked, true)
    await click(modelSwitch(o.el)) // on again
    assert.equal(skillBox(o.el)?.checked, true, 'the state survived the switch')
    await click(button(o.el, 'primary'))
    assert.deepEqual(await o.answer, { kind: 'confirm', config: ON_CONFIG, applySkill: true })
    await o.close()
  })

  it('sends the skill token from a fresh, switch-off dialog when the box is ticked, and none when it is unticked', async () => {
    const ticked = await open({ initialSkill: true })
    await click(button(ticked.el, 'primary'))
    assert.deepEqual(await ticked.answer, { kind: 'confirm', config: OFF_CONFIG, applySkill: true }, 'no subagent model, skill applied')
    await ticked.close()
    const unticked = await open({ initialSkill: true })
    await click(unticked.el.querySelector<HTMLInputElement>('.dsh-orq-skill input[type=checkbox]'))
    await click(button(unticked.el, 'primary'))
    assert.deepEqual(await unticked.answer, { kind: 'confirm', config: OFF_CONFIG, applySkill: false })
    await unticked.close()
  })

  it('refuses to confirm with the switch on and no model: a confirmed choice always carries a model (the gate\'s memory rule reads it from the config)', async () => {
    const o = await open({ initialSkill: true })
    await click(modelSwitch(o.el)) // switch on, picker empty
    assert.deepEqual([skillBox(o.el)?.checked, skillBox(o.el)?.disabled], [true, false])
    assert.equal(effortSelect(o.el)?.disabled, true, 'no model, no ladder: the effort select waits too')
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

  it('a token already in the message: ticked and locked whatever the switch says, and the hint says so', async () => {
    for (const initial of [ON_CONFIG, OFF_CONFIG]) {
      const o = await open({ skillInMessage: true, initialSkill: false, initial })
      assert.equal(skillHint(o.el), t('skill.typed', { token: `/${SKILL_NAME}` }), 'reality first: the token applies the skill')
      assert.deepEqual([skillBox(o.el)?.checked, skillBox(o.el)?.disabled], [true, true], 'ticked and locked')
      await click(skillBox(o.el)) // a locked box does not move
      assert.equal(skillBox(o.el)?.checked, true)
      await click(button(o.el, 'primary'))
      assert.deepEqual(await o.answer, { kind: 'confirm', config: initial, applySkill: true }, JSON.stringify(initial))
      await o.close()
    }
    const bare = await open({ skill: null, skillInMessage: true })
    assert.equal(bare.el.querySelector('.dsh-orq-skill'), null, 'nothing to lock when nothing is offered')
    await bare.close()
  })

  it('keeps a stored effort level while the model\'s ladder is unknown, and confirm writes it back', async () => {
    const o = await open({ initial: STORED_EFFORT, initialSkill: true })
    const select = effortSelect(o.el)
    assert.ok(select !== null)
    assert.equal(select.disabled, true, 'the catalog has not answered: there is no ladder to choose from')
    assert.equal(select.value, 'high', 'and the stored level is still the one on screen')
    assert.deepEqual(optionValues(select), ['', 'high'], 'shown as its own row, not dropped')
    await click(button(o.el, 'primary'))
    assert.deepEqual(await o.answer, { kind: 'confirm', config: STORED_EFFORT, applySkill: true }, 'confirm keeps the level instead of resetting it')
    await o.close()
  })

  it('puts the effort select immediately below the model select, and directly under the switch when there is none', async () => {
    const on = await open({ initial: ON_CONFIG, initialSkill: false }, false, CATALOG)
    const modelField = field(modelPicker(on.el))
    assert.ok(modelField !== null, 'the model picker is on screen')
    assert.equal(field(effortSelect(on.el)), modelField.nextElementSibling, 'right after the model select')
    await on.close()

    const off = await open({ initialSkill: false }, false, CATALOG)
    assert.equal(off.el.querySelector('.dsh-orq-picker'), null, 'no model picker with the switch off')
    assert.equal(field(effortSelect(off.el)), off.el.querySelector('.dsh-orq-row')?.nextElementSibling, 'right under the switch')
    await off.close()
  })

  it('offers exactly the effective model\'s ladder plus the neutral row, ordered low to high', async () => {
    // The catalog lists the picked model's levels out of order on purpose: the select orders them by rank.
    const scrambled: CatalogState = {
      ...CATALOG,
      groups: [{ id: 'openrouter', name: 'OpenRouter', models: [{ id: ROUTE.model, name: 'Gemini 3.8 Flash', reasoning: ladder('max', 'low', 'high', 'medium') }] }],
    }
    const on = await open({ initial: ON_CONFIG, initialSkill: false }, false, scrambled)
    assert.equal(effortSelect(on.el)?.disabled, false)
    assert.deepEqual(optionValues(effortSelect(on.el)), ['', 'low', 'medium', 'high', 'max'])
    assert.deepEqual(optionLabels(effortSelect(on.el)), [t('effort.defaultOption'), 'Low', 'Medium', 'High', 'Max'])
    await on.close()

    // With the switch off the ladder is the main agent's: the subagents run on that model.
    const off = await open({ initialSkill: false }, false, CATALOG)
    assert.deepEqual(optionValues(effortSelect(off.el)), ['', 'low', 'medium', 'high', 'max'])
    await off.close()
  })

  it('shows the neutral row alone, disabled, when the effective model has no ladder at all', async () => {
    const o = await open({ initialSkill: false }, false, PLAIN_CATALOG)
    assert.deepEqual([effortSelect(o.el)?.disabled, effortSelect(o.el)?.value], [true, ''])
    assert.deepEqual(optionValues(effortSelect(o.el)), [''])
    await o.close()
  })

  it('AUTO-MAX: a model change selects that model\'s highest level, and opening the dialog does not', async () => {
    const o = await open({ initial: ON_CONFIG, initialSkill: false }, false, CATALOG)
    assert.equal(effortSelect(o.el)?.value, '', 'a stored neutral choice is not auto-maxed at open')
    await pickModel(o.el, 'GLM 5.3')
    assert.equal(effortSelect(o.el)?.value, 'max', 'the newly picked model\'s highest level')
    await pickModel(o.el, 'Gemini 3.8 Flash')
    assert.equal(effortSelect(o.el)?.value, 'high', 'and the other model\'s own ceiling')
    await click(button(o.el, 'primary'))
    assert.deepEqual(await o.answer, { kind: 'confirm', config: STORED_EFFORT, applySkill: false }, 'the auto-maxed level is what goes out')
    await o.close()

    const kept = await open({ initial: STORED_EFFORT, initialSkill: false }, false, CATALOG)
    assert.equal(effortSelect(kept.el)?.value, 'high', 'a stored level is kept at open, not auto-maxed')
    await pickModel(kept.el, 'GLM 5.3')
    assert.equal(effortSelect(kept.el)?.value, 'max', 'until the user changes the model')
    await kept.close()
  })

  it('writes an effort-only choice with the switch off, and null for the neutral row', async () => {
    const o = await open({ initialSkill: false }, false, CATALOG)
    assert.equal(effortSelect(o.el)?.value, '')
    await chooseEffort(o.el, 'high')
    await click(button(o.el, 'primary'))
    assert.deepEqual(
      await o.answer,
      { kind: 'confirm', config: buildConfig({ subagentModel: null, workerEffort: 'high' }), applySkill: false },
      'a touched effort with no subagent model is an effort-only choice',
    )
    await o.close()

    const back = await open({ initial: buildConfig({ subagentModel: null, workerEffort: 'high' }), initialSkill: false }, false, CATALOG)
    assert.equal(effortSelect(back.el)?.value, 'high', 'the stored effort-only choice is on screen')
    await chooseEffort(back.el, '')
    await click(button(back.el, 'primary'))
    assert.deepEqual(await back.answer, { kind: 'confirm', config: OFF_CONFIG, applySkill: false }, 'and the neutral row is null on the wire')
    await back.close()
  })

  it('the capability strip marks the modalities the model understands and shows the score of its kind', async () => {
    resetFacts()
    const o = await open({ initial: ON_CONFIG, initialSkill: false }, false, CATALOG)
    await until('the facts request', () => factsState().pending.some(entry => entry.model === ROUTE.model))
    assert.deepEqual(factsState().asked.at(-1), { model: ROUTE.model, displayName: 'Gemini 3.8 Flash' }, 'the picked model, by id and display name')
    assert.equal(o.el.querySelector('.dsh-orq-facts'), null, 'nothing is drawn while the answer is in flight')
    await answerFacts(ROUTE.model, factsOf({ text: true, image: true, audio: false, video: false }, { kind: 'terminal-bench-4', value: '41.8%' }))
    const icons = [...o.el.querySelectorAll('.dsh-orq-fact')]
    assert.equal(icons.length, 4)
    assert.deepEqual(icons.map(icon => icon.getAttribute('data-orq-on')), ['false', 'true', 'true', 'false'], 'audio, photo, text, video')
    assert.deepEqual(
      icons.map(icon => icon.getAttribute('aria-label')),
      [t('facts.audio.off'), t('facts.photo'), t('facts.text'), t('facts.video.off')],
      'each glyph says what it means when read out loud',
    )
    assert.equal(icons[1]?.querySelector('svg')?.getAttribute('aria-hidden'), 'true', 'the glyph itself is decorative')
    assert.equal(o.el.querySelector('.dsh-orq-facts-score')?.textContent, t('facts.tb4', { value: '41.8%' }))
    await o.close()
  })

  it('the capability strip follows the main model with the switch off, and shows nothing at all for an unknown model', async () => {
    resetFacts()
    const unknown = await open({ initial: ON_CONFIG, initialSkill: false }, false, CATALOG)
    await until('the facts request', () => factsState().pending.some(entry => entry.model === ROUTE.model))
    await answerFacts(ROUTE.model, null)
    assert.equal(unknown.el.querySelector('.dsh-orq-facts'), null, 'an unknown model shows no strip, and nothing is broken')
    assert.equal(unknown.el.querySelector('.dsh-orq-facts-score'), null)
    await unknown.close()

    resetFacts()
    const off = await open({ initialSkill: false }, false, CATALOG)
    await until('the facts request for the main model', () => factsState().pending.some(entry => entry.model === MAIN.model))
    await answerFacts(MAIN.model, factsOf({ text: true, image: false, audio: false, video: false }, { kind: 'intelligence', value: '44.8' }))
    assert.deepEqual([...off.el.querySelectorAll('.dsh-orq-fact')].map(icon => icon.getAttribute('data-orq-on')), ['false', 'false', 'true', 'false'])
    assert.equal(off.el.querySelector('.dsh-orq-facts-score')?.textContent, t('facts.intelligence', { value: '44.8' }))
    await off.close()
  })

  it('a late answer for a model the user has left never lands on the strip', async () => {
    resetFacts()
    const o = await open({ initial: STORED_EFFORT, initialSkill: false }, false, CATALOG)
    await until('the request for the picked model', () => factsState().pending.some(entry => entry.model === ROUTE.model))
    await pickModel(o.el, 'GLM 5.3')
    await until('the request for the new model', () => factsState().pending.some(entry => entry.model === MAIN.model))
    assert.equal(o.el.querySelector('.dsh-orq-facts'), null, 'the old strip went with the old model')
    await answerFacts(MAIN.model, factsOf({ text: true, image: false, audio: false, video: false }, { kind: 'terminal-bench-4', value: '41.8%' }))
    assert.equal(o.el.querySelector('.dsh-orq-facts-score')?.textContent, t('facts.tb4', { value: '41.8%' }))
    await answerFacts(ROUTE.model, factsOf({ text: true, image: true, audio: true, video: true }, { kind: 'intelligence', value: '44.8' }))
    assert.equal(o.el.querySelector('.dsh-orq-facts-score')?.textContent, t('facts.tb4', { value: '41.8%' }), 'the stale answer was dropped')
    assert.deepEqual([...o.el.querySelectorAll('.dsh-orq-fact')].map(icon => icon.getAttribute('data-orq-on')), ['false', 'false', 'true', 'false'])
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
    assert.deepEqual([skillBox(chat.el)?.checked, skillBox(chat.el)?.disabled], [true, true], 'a typed token ticks and locks the box')
    assert.equal(chat.el.querySelector('.dsh-orq-skill-hint')?.textContent, t('skill.typed', { token: `/${SKILL_NAME}` }))
    await click(button(chat.el, 'primary'))
    await sent
    assert.deepEqual(chat.face.sent, [[{ type: 'text', text: `/${SKILL_NAME} fix it` }]])
    assert.equal(app.storage.has(KEY), false, 'the user was not asked, so nothing is remembered')
    await chat.leave()
  })

  it('writes the skill preference on a switch-off confirm: the box is a real question either way', async () => {
    const app = await boot()
    const chat = await app.conversation('s')
    const sent = chat.send('plain task')
    await until('the dialog', () => skillBox(chat.el) !== null)
    assert.deepEqual([skillBox(chat.el)?.checked, skillBox(chat.el)?.disabled], [true, false], 'ticked and interactive with no subagent model')
    assert.equal(chat.el.querySelector('.dsh-orq-skill-hint')?.textContent, t('skill.hint', { token: `/${SKILL_NAME}` }))
    await click(skillBox(chat.el)) // untick
    await click(button(chat.el, 'primary'))
    await sent
    assert.equal(app.storage.get(KEY), 'off', 'the answer reached the storage with the switch off')
    assert.equal((JSON.parse(app.storage.get(LAST) ?? 'null') as { subagentModel: unknown }).subagentModel, null, 'the off model choice is remembered as always')
    assert.deepEqual(chat.face.sent, [[{ type: 'text', text: 'plain task' }]])

    const again = chat.send('another task')
    await until('the second dialog', () => skillBox(chat.el) !== null)
    assert.equal(skillBox(chat.el)?.checked, false, 'opens the way it was left')
    await click(skillBox(chat.el)) // tick it back
    await click(button(chat.el, 'primary'))
    await again
    assert.equal(app.storage.get(KEY), 'on')
    assert.deepEqual(chat.face.sent[1], [{ type: 'text', text: `another task\n/${SKILL_NAME}` }], 'the token goes out although the subagents stay on the main model')
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
    await click(skillBox(b.el)) // untick: this test is about the jam, not the skill
    await click(button(b.el, 'primary'))
    await sent
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
