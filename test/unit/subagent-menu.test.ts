import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { createRequire } from 'node:module'
import v8 from 'node:v8'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'
import type { CatalogState } from '../../src/client/catalog.ts'
import type {
  CatalogGroupLike, LocaleLike, SessionListStateLike, SessionSummaryLike, SubagentCatalogEntryLike, SubagentCatalogLike,
} from '../../src/client/host-types.ts'
import { en, pt } from '../../src/client/locales.ts'
import { CSS } from '../../src/client/styles.ts'
import { installSubagentMarks, type MarksTimers, type SubagentMarksDeps } from '../../src/client/subagent-menu.ts'
import { SubagentsClient } from '../../src/client/subagents-client.ts'
import type { SubagentRecord, SubagentsPayload } from '../../src/shared.ts'

const SVG_NS = 'http://www.w3.org/2000/svg'
const NOW = 1_800_000_000_000

/** Let every pending microtask (observer deliveries, coalesced scans, promise continuations) run. */
const flush = (): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, 0))

// ---------------------------------------------------------------------------------------------------------------
// The native menu, as DSH 0.1.6 renders it (SubagentHeaderLineage.tsx): roles, aria attributes and structure only.
// ---------------------------------------------------------------------------------------------------------------

/** One row of the menu. */
interface Row {
  readonly id: string
  /** The entry's label; the id stands in when absent, as in DSH. */
  readonly label?: string
  readonly activity?: 'running' | 'inactive'
  readonly kind?: 'child' | 'diagnostic'
  /** The session title the session list holds: DSH puts it after the label in the row's aria-label. */
  readonly title?: string
  /** DSH marks the row of the conversation the page shows with aria-current (a switcher menu only). */
  readonly current?: boolean
  /** The row is expanded and its own catalog holds these rows. */
  readonly children?: readonly Row[]
  /** The row is expanded but its catalog has not arrived: DSH renders this many disabled placeholders. */
  readonly loading?: number
}

type DotState = 'ongoing' | 'done' | 'error' | 'idle' | 'warning'

/** Build an element. */
function el(doc: Document, tag: string, attributes: Readonly<Record<string, string>> = {}, ...children: Node[]): HTMLElement {
  const element = doc.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value)
  element.append(...children)
  return element
}

/** The StateDot: an animated svg while ongoing, a styled span otherwise (both aria-hidden, both with an inline size). */
function makeDot(doc: Document, state: DotState): Element {
  if (state === 'ongoing') {
    const svg = doc.createElementNS(SVG_NS, 'svg')
    for (const [name, value] of Object.entries({ class: 'matrix', 'data-state': 'ongoing', width: '10', height: '10', viewBox: '0 0 10 10', 'aria-hidden': 'true' })) svg.setAttribute(name, value)
    for (const x of [0, 4, 8]) {
      const cell = doc.createElementNS(SVG_NS, 'rect')
      cell.setAttribute('x', String(x))
      cell.setAttribute('y', '0')
      cell.setAttribute('width', '2')
      cell.setAttribute('height', '2')
      svg.append(cell)
    }
    return svg
  }
  return el(doc, 'span', { class: 'dot', 'data-state': state, 'aria-hidden': 'true', style: 'width: 10px; height: 10px;' })
}

/** The text block: label and summary. */
function makeContent(doc: Document, label: string, summary?: string): HTMLElement {
  const content = el(doc, 'span', { class: 'content' }, el(doc, 'span', { class: 'label' }, doc.createTextNode(label)))
  if (summary !== undefined) content.append(el(doc, 'span', { class: 'summary' }, doc.createTextNode(summary)))
  return content
}

/** A chevron: an svg WITHOUT data-state, like DSH's icons. */
function makeChevron(doc: Document): Element {
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('aria-hidden', 'true')
  return svg
}

/** One `.node` of the menu: the row and, when it is expanded, its group. */
function makeNode(doc: Document, row: Row, level: number, reserve: boolean): HTMLElement {
  const node = el(doc, 'div', { class: 'node' })
  if (row.kind === 'diagnostic') {
    const reason = 'corrupted session record'
    const item = el(doc, 'div', { role: 'treeitem', 'aria-disabled': 'true', 'aria-level': String(level), 'aria-label': `${row.id} ${reason}`, class: 'row disabled', title: reason })
    if (reserve) item.append(el(doc, 'span', { class: 'disclosureSpace' }))
    item.append(makeDot(doc, 'error'), makeContent(doc, row.id, reason))
    node.append(item)
    return node
  }
  const label = row.label ?? row.id
  const activity = row.activity ?? 'inactive'
  // `[label, [title, mode, activity].join(' · '), metrics]` joined by spaces, as DSH's CatalogRows builds it.
  const summary = `${row.title === undefined ? '' : `${row.title} · `}continuable · ${activity === 'running' ? 'running' : 'not running'}`
  const expanded = row.children !== undefined || row.loading !== undefined
  const item = el(doc, 'div', { role: 'treeitem', tabindex: '0', 'aria-level': String(level), 'aria-label': `${label} ${summary} 12K tok 1m 05s`, class: 'row' })
  if (row.current === true) item.setAttribute('aria-current', 'true')
  if (expanded) item.setAttribute('aria-expanded', 'true')
  if (expanded) item.append(el(doc, 'button', { type: 'button', tabindex: '-1', class: 'disclosure disclosureOpen', 'aria-label': `Collapse ${label} descendants` }, makeChevron(doc)))
  else if (reserve) item.append(el(doc, 'span', { class: 'disclosureSpace' }))
  item.append(el(
    doc,
    'div',
    { class: 'clickarea' },
    makeDot(doc, activity === 'running' ? 'ongoing' : 'done'),
    makeContent(doc, label, summary),
    el(doc, 'span', { class: 'metrics' }, el(doc, 'span', { class: 'metricToken' }, doc.createTextNode('12K tok')), el(doc, 'span', { class: 'metricDuration', title: 'Total active duration: 1m 05s' }, doc.createTextNode('1m 05s'))),
    el(doc, 'button', { type: 'button', class: 'sidebarButton', 'aria-label': `Open ${label} in sidebar`, title: `Open ${label} in sidebar` }, makeChevron(doc)),
  ))
  node.append(item)
  if (row.children !== undefined) {
    const group = el(doc, 'div', { role: 'group', class: 'children' })
    const reserveInner = row.children.some(child => child.children !== undefined || child.loading !== undefined)
    for (const child of row.children) group.append(makeNode(doc, child, level + 1, reserveInner))
    node.append(group)
  } else if (row.loading !== undefined) {
    const group = el(doc, 'div', { role: 'group', class: 'children', 'aria-busy': 'true' })
    for (let index = 0; index < row.loading; index += 1) {
      group.append(el(doc, 'div', { class: 'node' }, el(
        doc,
        'div',
        { role: 'treeitem', 'aria-disabled': 'true', 'aria-level': String(level + 1), 'aria-label': 'Loading subagents', class: 'row disabled loadingRow' },
        el(doc, 'span', { class: 'disclosureSpace' }),
        makeDot(doc, 'ongoing'),
        makeContent(doc, 'Loading subagents…'),
      )))
    }
    node.append(group)
  }
  return node
}

/** The portaled menu: a `role="tree"` with one node per row. */
function makeMenu(doc: Document, rows: readonly Row[], title = 'Subagent sessions'): HTMLElement {
  const menu = el(doc, 'div', { class: 'menu', role: 'tree', 'aria-label': title })
  const reserve = rows.some(row => row.children !== undefined || row.loading !== undefined)
  for (const row of rows) menu.append(makeNode(doc, row, 1, reserve))
  return menu
}

/** The catalog entry DSH keeps for a row. */
function entryOf(row: Row): SubagentCatalogEntryLike {
  if (row.kind === 'diagnostic') return { kind: 'diagnostic', id: row.id, reason: 'corrupt' }
  return {
    kind: 'child',
    id: row.id,
    activity: row.activity ?? 'inactive',
    hasChildren: row.children !== undefined || row.loading !== undefined,
    mode: 'continuable',
    ...row.label === undefined ? {} : { label: row.label },
  }
}

/** The catalogs DSH's session list holds for a menu rooted at `rootId`. */
function catalogsOf(rootId: string, rows: readonly Row[]): Record<string, SubagentCatalogLike> {
  const catalogs: Record<string, SubagentCatalogLike> = { [rootId]: { entries: rows.map(entryOf), state: 'ready' } }
  for (const row of rows) {
    if (row.children !== undefined) Object.assign(catalogs, catalogsOf(row.id, row.children))
  }
  return catalogs
}

// ---------------------------------------------------------------------------------------------------------------
// The doubles.
// ---------------------------------------------------------------------------------------------------------------

/** Timers that never fire on their own: the test drives them. */
class FakeTimers implements MarksTimers {
  private next = 1
  private readonly timers = new Map<number, { fn: () => void; ms: number }>()
  /** Every call to setInterval, ever. */
  started = 0

  setInterval(fn: () => void, ms: number): unknown {
    const handle = this.next
    this.next += 1
    this.started += 1
    this.timers.set(handle, { fn, ms })
    return handle
  }

  clearInterval(handle: unknown): void {
    this.timers.delete(handle as number)
  }

  /** Fire every live timer (or those with this period) once. */
  fire(ms?: number): void {
    for (const [handle, timer] of [...this.timers]) {
      if (this.timers.has(handle) && (ms === undefined || timer.ms === ms)) timer.fn()
    }
  }

  get count(): number {
    return this.timers.size
  }

  periods(): number[] {
    return [...this.timers.values()].map(timer => timer.ms).sort((a, b) => a - b)
  }
}

/** The client session list store. */
class FakeStore {
  state: SessionListStateLike
  reads = 0
  throwOnRead = false
  throwOnSubscribe = false
  private readonly listeners = new Set<() => void>()

  constructor(state: SessionListStateLike) {
    this.state = state
  }

  readonly list = {
    getSnapshot: (): SessionListStateLike => {
      this.reads += 1
      if (this.throwOnRead) throw new Error('store exploded')
      return this.state
    },
    subscribe: (listener: () => void): (() => void) => {
      if (this.throwOnSubscribe) throw new Error('no subscriptions today')
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }

  set(state: SessionListStateLike): void {
    this.state = state
    for (const listener of [...this.listeners]) listener()
  }

  get listenerCount(): number {
    return this.listeners.size
  }
}

/** The locale runtime: DSH's own menu title and this plugin's dictionary, in the active language. */
class FakeLocale implements LocaleLike {
  active = 'en'
  nativeTitle: string | 'throw' | 'key' = 'Subagent sessions'
  private readonly listeners = new Set<() => void>()

  addLanguage(): () => void {
    return () => undefined
  }

  register(): () => void {
    return () => undefined
  }

  bind(ns: string): (key: string, params?: Record<string, unknown>) => string {
    if (ns === 'subagent') {
      return (key) => {
        if (this.nativeTitle === 'throw') throw new Error('the locale is not ready')
        // Like the real runtime, a lookup that finds nothing answers with the key itself.
        return key === 'tree.aria' && this.nativeTitle !== 'key' ? this.nativeTitle : key
      }
    }
    return (key, params) => {
      const dictionary: Readonly<Record<string, string>> = this.active === 'pt' ? pt : en
      const template = dictionary[key] ?? key
      return params === undefined ? template : template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
    }
  }

  getSnapshot(): { readonly active: string; readonly locales: readonly { readonly id: string }[] } {
    return { active: this.active, locales: [{ id: 'en' }, { id: 'pt' }] }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  switchTo(id: string): void {
    this.active = id
    for (const listener of [...this.listeners]) listener()
  }

  get listenerCount(): number {
    return this.listeners.size
  }
}

/** The host ledger carrier. */
class FakeLedger {
  records: SubagentRecord[] = []
  /** The host's clock the answers carry (epoch ms); a host that does not say leaves it out. */
  hostNow: number | undefined = NOW
  mode: 'ok' | 'throw' | 'reject' | 'undefined' | 'pending' = 'ok'
  readonly calls: { readonly sessionId: string; readonly signal: AbortSignal | undefined }[] = []
  private readonly waiting: (() => void)[] = []

  list(sessionId: string, signal?: AbortSignal): Promise<SubagentsPayload | undefined> {
    this.calls.push({ sessionId, signal })
    switch (this.mode) {
      case 'throw': throw new Error('the ledger exploded')
      case 'reject': return Promise.reject(new Error('the ledger rejected'))
      case 'undefined': return Promise.resolve(undefined)
      case 'pending': return new Promise((resolve) => { this.waiting.push(() => { resolve(this.answer(sessionId)) }) })
      case 'ok': return Promise.resolve(this.answer(sessionId))
    }
  }

  private answer(sessionId: string): SubagentsPayload {
    return { sessionId, subagents: [...this.records], ...this.hostNow === undefined ? {} : { now: this.hostNow } }
  }

  /** Answer every request that is waiting. */
  release(): void {
    for (const answer of this.waiting.splice(0)) answer()
  }
}

/** The model catalog. */
const GROUPS: readonly CatalogGroupLike[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    models: [
      {
        id: 'google/gemini-3.8-flash',
        name: 'Gemini 3.8 Flash',
        reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' },
      },
      { id: 'moonshotai/kimi-k3', name: 'Kimi K3' },
    ],
  },
  {
    id: 'azure',
    name: 'Azure',
    models: [{ id: 'DeepSeek-V4.1-Flash', name: 'DeepSeek V4.1 Flash', reasoning: { efforts: [{ id: 'medium', name: 'Medium' }], defaultEffort: 'medium' } }],
  },
]
const READY: CatalogState = { status: 'ready', groups: GROUPS, current: null, error: null }

/** The `loadCatalog` double. */
class FakeCatalog {
  mode: 'ready' | 'error' | 'pending' | 'throw' | 'reject' = 'ready'
  readonly calls: string[] = []
  private readonly waiting: ((state: CatalogState) => void)[] = []

  readonly load = (sessionId: string): Promise<CatalogState> => {
    this.calls.push(sessionId)
    switch (this.mode) {
      case 'throw': throw new Error('the catalog exploded')
      case 'reject': return Promise.reject(new Error('the catalog rejected'))
      case 'error': return Promise.resolve({ status: 'error', groups: [], current: null, error: 'no catalog' })
      case 'pending': return new Promise((resolve) => { this.waiting.push(resolve) })
      case 'ready': return Promise.resolve(READY)
    }
  }

  release(): void {
    for (const answer of this.waiting.splice(0)) answer(READY)
  }
}

/** A ledger record. */
const record = (id: string, state: SubagentRecord['state'], patch: Partial<SubagentRecord> = {}): SubagentRecord => ({
  id,
  parentId: 'main',
  backend: 'spawn',
  route: null,
  state,
  stopReason: state === 'running' ? null : state === 'stopped' ? 'aborted' : 'completed',
  startedAt: NOW - 120_000,
  endedAt: state === 'running' ? null : NOW - 60_000,
  ...patch,
})

const GEMINI = { provider: 'openrouter', model: 'google/gemini-3.8-flash' }
const KIMI = { provider: 'openrouter', model: 'moonshotai/kimi-k3' }

/** The menu the tests share: every state, a nested group (with a diagnostic row), and a group whose catalog has not arrived. */
const ROWS: readonly Row[] = [
  { id: 'c-run', label: 'Scout', activity: 'running' },
  {
    id: 'c-done',
    label: 'Builder',
    children: [
      { id: 'n-ok', label: 'Deep one' },
      { id: 'n-bad', kind: 'diagnostic' },
      { id: 'n-fail', label: 'Deep two' },
    ],
  },
  { id: 'c-fail', label: 'Reviewer' },
  { id: 'c-wait', label: 'Loader', loading: 2 },
  { id: 'c-stop', label: 'Planner' },
  { id: 'c-unk', label: 'Tester' },
]

/** What the ledger knows about those rows. */
const LEDGER: readonly SubagentRecord[] = [
  record('c-run', 'running', { startedAt: NOW - 1_000, route: { ...GEMINI, reasoningEffort: 'high' } }),
  record('c-done', 'done', { route: { ...GEMINI, reasoningEffort: 'low' } }),
  record('n-ok', 'done', { route: KIMI }),
  record('n-fail', 'failed', { stopReason: 'error', route: { ...GEMINI, reasoningEffort: 'high' } }),
  record('c-fail', 'failed', { stopReason: 'max-tokens', route: KIMI }),
  record('c-stop', 'stopped', { route: { provider: 'openrouter', model: 'acme/mystery' } }),
]

/** The session list: the conversation, and what DSH remembers of the one child that has no ledger record. */
function listState(rows: readonly Row[], rootId = 'main', extra: Readonly<Record<string, SessionSummaryLike>> = {}): SessionListStateLike {
  const lastUsed: SessionSummaryLike = {
    id: 'c-unk', parentId: rootId, origin: 'subagent', running: false,
    projectionValues: { modelSelection: { lastUsed: { provider: 'azure', model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'medium' } } },
  }
  const byId: Record<string, SessionSummaryLike> = { [rootId]: { id: rootId, running: true }, 'c-unk': lastUsed }
  // A row with a title has a summary with that title, which is where DSH reads it from.
  const addTitles = (list: readonly Row[], parentId: string): void => {
    for (const row of list) {
      if (row.title !== undefined) byId[row.id] = { ...byId[row.id], id: row.id, parentId, origin: 'subagent', running: false, title: row.title }
      if (row.children !== undefined) addTitles(row.children, row.id)
    }
  }
  addTitles(rows, rootId)
  return { byId: { ...byId, ...extra }, subagentsByParent: catalogsOf(rootId, rows) }
}

/** Everything one test needs. */
class Harness {
  readonly dom = new JSDOM('<!doctype html><html><body></body></html>')
  readonly doc: Document = this.dom.window.document
  readonly timers = new FakeTimers()
  readonly store = new FakeStore(listState(ROWS))
  readonly locale = new FakeLocale()
  readonly ledger = new FakeLedger()
  readonly catalog = new FakeCatalog()
  readonly clock = { now: NOW }
  readonly warnings: { message: string; error: unknown }[] = []
  /** Uncaught exceptions jsdom saw in observer callbacks. */
  readonly errors: unknown[] = []
  visible: string[] = ['main']
  private readonly stops: (() => void)[] = []

  constructor() {
    this.ledger.records = [...LEDGER]
    this.dom.window.addEventListener('error', (event) => { this.errors.push(event.error ?? event.message) })
  }

  /** Render the native menu and put it on the body (nothing is flushed). */
  open(rows: readonly Row[] = ROWS, title?: string): HTMLElement {
    const menu = makeMenu(this.doc, rows, title)
    this.doc.body.append(menu)
    return menu
  }

  /** Install the controller. */
  install(patch: Partial<SubagentMarksDeps> = {}): () => void {
    const stop = installSubagentMarks({
      document: this.doc,
      sessions: { binding: () => undefined, list: this.store.list },
      locale: this.locale,
      client: { list: (sessionId, signal) => this.ledger.list(sessionId, signal) },
      visibleSessionIds: () => this.visible,
      loadCatalog: this.catalog.load,
      warn: (message, error) => { this.warnings.push({ message, error }) },
      timers: this.timers,
      now: () => this.clock.now,
      ...patch,
    })
    this.stops.push(stop)
    return stop
  }

  /** Change one entry's activity in the store (and nothing else). */
  setActivity(id: string, activity: 'running' | 'inactive'): void {
    const swap = (catalog: SubagentCatalogLike): SubagentCatalogLike => ({
      ...catalog,
      entries: catalog.entries.map(entry => (entry.kind === 'child' && entry.id === id ? { ...entry, activity } : entry)),
    })
    this.store.set({
      ...this.store.state,
      subagentsByParent: Object.fromEntries(Object.entries(this.store.state.subagentsByParent).map(([parent, catalog]) => [parent, swap(catalog)])),
    })
  }

  /** What React does when a dot changes state: drop the old node and insert a new one before the text block. */
  replaceDot(row: Element, state: DotState): Element {
    const old = dotOf(row)
    const parent = old.parentElement
    assert.ok(parent, 'the dot has a parent')
    const content = old.nextElementSibling
    parent.removeChild(old)
    const next = makeDot(this.doc, state)
    parent.insertBefore(next, content)
    return next
  }

  finish(): void {
    for (const stop of this.stops) stop()
    this.dom.window.close()
  }
}

const harnesses: Harness[] = []
function harness(): Harness {
  const created = new Harness()
  harnesses.push(created)
  return created
}
afterEach(() => {
  for (const created of harnesses.splice(0)) created.finish()
})

/** The row whose label starts with a text. */
function rowOf(menu: ParentNode, label: string): Element {
  const found = [...menu.querySelectorAll('[role="treeitem"]')].find(item => item.getAttribute('aria-label')?.startsWith(label) === true)
  assert.ok(found, `no row labelled ${label}`)
  return found
}
const dotOf = (row: Element): Element => {
  const found = row.querySelector('[data-state]')
  assert.ok(found, 'the row has a dot')
  return found
}
const iconOf = (row: Element): Element | null => row.querySelector('.dsh-orq-sub-icon')
const tagOf = (row: Element): Element | null => row.querySelector('.dsh-orq-sub-tag')
const ours = (root: ParentNode): Element[] => [...root.querySelectorAll('.dsh-orq-sub-icon, .dsh-orq-sub-model, .dsh-orq-sub-tag, [data-orq-row]')]
const stateOf = (row: Element): string | null | undefined => iconOf(row)?.getAttribute('data-orq-state')

/** What one row shows: icon state, status text, model label and its tooltip. */
function shown(row: Element): { state: string | null | undefined; text: string | null | undefined; model: string | null | undefined; title: string | null | undefined } {
  const icon = iconOf(row)
  const tag = tagOf(row)
  return {
    state: icon?.getAttribute('data-orq-state'),
    text: icon?.getAttribute('aria-label'),
    model: tag?.textContent,
    title: tag?.getAttribute('title'),
  }
}

describe('subagent menu marks: finding the menu', () => {
  it('ignores everything on the body that is not the subagent menu', async () => {
    const h = harness()
    const stop = h.install()
    const other = h.open(ROWS, 'File tree')
    const loose = el(h.doc, 'div', {}, el(h.doc, 'div', { role: 'treeitem', 'aria-level': '1', 'aria-label': 'Scout' }, el(h.doc, 'span', { 'data-state': 'done' }), el(h.doc, 'span')))
    const dialog = el(h.doc, 'div', { role: 'dialog', 'aria-label': 'Subagent sessions' })
    h.doc.body.append(loose, dialog)
    await flush()
    assert.equal(h.timers.started, 0)
    assert.equal(h.ledger.calls.length, 0)
    assert.equal(h.store.reads, 0)
    assert.equal(h.catalog.calls.length, 0)
    assert.equal(ours(h.doc).length, 0)
    assert.equal(other.hasAttribute('data-orq-row'), false)
    stop()
  })

  it('decorates a menu that is already open when the controller starts', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    // The first scan is immediate: no waiting for a mutation or a timer. It draws what needs no ledger (the model DSH
    // saw a child use) and leaves DSH's own dots alone until the ledger has answered.
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 0)
    assert.equal(menu.querySelectorAll('[data-orq-row]').length, 0)
    assert.equal(shown(rowOf(menu, 'Tester')).model, 'DeepSeek-V4.1-Flash · medium', 'raw ids until the model catalog answers')
    await flush()
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
    const area = rowOf(menu, 'Builder').querySelector('.clickarea')
    assert.deepEqual([...area?.children ?? []].map(child => child.className || child.tagName), ['dsh-orq-sub-icon', 'dot', 'content', 'metrics', 'sidebarButton'])
    assert.equal(rowOf(menu, 'Builder').getAttribute('data-orq-row'), '')
  })

  it('decorates a menu that opens later, and only the subagent menu among the body children', async () => {
    const h = harness()
    h.install()
    await flush()
    assert.equal(h.timers.count, 0, 'nothing is polled while no menu is open')
    h.open(ROWS, 'File tree')
    const menu = h.open()
    await flush()
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
    assert.equal(h.doc.querySelectorAll('.dsh-orq-sub-icon').length, 8, 'the other tree is untouched')
    assert.deepEqual(h.timers.periods(), [2_000])
  })

  it('compares the menu title with the one the active language gives DSH', async () => {
    const h = harness()
    h.locale.nativeTitle = 'Sessões de subagentes'
    h.install()
    const wrong = h.open(ROWS, 'Subagent sessions')
    const right = h.open(ROWS, 'Sessões de subagentes')
    await flush()
    assert.equal(ours(wrong).length, 0)
    assert.equal(right.querySelectorAll('.dsh-orq-sub-icon').length, 8)
  })

  it('falls back to the structure of the rows when the title cannot be looked up (the lookup throws)', async () => {
    const h = harness()
    h.locale.nativeTitle = 'throw'
    h.install()
    const menu = h.open(ROWS, 'whatever the language says')
    const notAMenu = el(h.doc, 'div', { role: 'tree', 'aria-label': 'Files' }, el(h.doc, 'div', { role: 'treeitem', 'aria-level': '1', 'aria-label': 'Scout' }, el(h.doc, 'span', {}, h.doc.createTextNode('no dot here'))))
    h.doc.body.append(notAMenu)
    await flush()
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
    assert.equal(ours(notAMenu).length, 0)
  })

  it('falls back to the structure of the rows when the lookup answers with the key itself', async () => {
    const h = harness()
    h.locale.nativeTitle = 'key'
    h.install()
    const menu = h.open(ROWS, 'Subagent sessions')
    await flush()
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
  })

  it('does nothing at all without a session list (a DSH line that moved it)', async () => {
    const h = harness()
    const menu = h.open()
    h.install({ sessions: { binding: () => undefined } })
    h.open()
    await flush()
    assert.equal(ours(menu).length, 0)
    assert.equal(h.timers.started, 0)
    assert.equal(h.ledger.calls.length, 0)
    assert.equal(h.warnings.length, 0)
  })

  it('stays out of the way in a document without a window', () => {
    const h = harness()
    const detached = h.dom.window.document.implementation.createHTMLDocument('detached')
    assert.equal(detached.defaultView, null)
    const stop = h.install({ document: detached })
    assert.doesNotThrow(stop)
    assert.equal(h.warnings.length, 1)
    assert.equal(h.timers.started, 0)
  })
})

describe('subagent menu marks: what a row shows', () => {
  it('shows the right icon, status text and model label on every kind of row', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    await flush()
    assert.deepEqual(shown(rowOf(menu, 'Scout')), {
      state: 'running', text: 'Running', model: 'Gemini 3.8 Flash · High', title: 'This subagent runs on Gemini 3.8 Flash, reasoning effort High',
    })
    assert.deepEqual(shown(rowOf(menu, 'Builder')), {
      state: 'done', text: 'Done', model: 'Gemini 3.8 Flash · Low', title: 'This subagent runs on Gemini 3.8 Flash, reasoning effort Low',
    })
    assert.deepEqual(shown(rowOf(menu, 'Reviewer')), {
      state: 'failed', text: 'Failed: token limit reached', model: 'Kimi K3', title: 'This subagent runs on Kimi K3',
    })
    assert.deepEqual(shown(rowOf(menu, 'Planner')), {
      state: 'stopped', text: 'Stopped', model: 'acme/mystery', title: 'This subagent runs on acme/mystery',
    })
    assert.deepEqual(shown(rowOf(menu, 'Tester')), {
      state: 'unknown', text: 'Outcome not recorded', model: 'DeepSeek V4.1 Flash · Medium', title: 'This subagent runs on DeepSeek V4.1 Flash, reasoning effort Medium',
    })
  })

  it('writes the icon as an accessible image and as a tooltip, with an svg that is aria-hidden', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    await flush()
    const icon = iconOf(rowOf(menu, 'Reviewer'))
    assert.ok(icon)
    assert.equal(icon.tagName, 'SPAN')
    assert.equal(icon.getAttribute('role'), 'img')
    assert.equal(icon.getAttribute('aria-label'), 'Failed: token limit reached')
    assert.equal(icon.getAttribute('title'), 'Failed: token limit reached')
    const svg = icon.firstElementChild
    assert.ok(svg)
    assert.equal(svg.namespaceURI, SVG_NS)
    assert.equal(svg.getAttribute('aria-hidden'), 'true')
    assert.equal(svg.getAttribute('width'), '14')
    assert.equal(svg.getAttribute('height'), '14')
    assert.equal(icon.children.length, 1)
  })

  it('draws a different glyph for every state', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    await flush()
    const glyphs = ['Scout', 'Builder', 'Reviewer', 'Planner', 'Tester'].map(label => iconOf(rowOf(menu, label))?.innerHTML)
    assert.equal(new Set(glyphs).size, 5)
    for (const markup of glyphs) assert.ok(markup !== undefined && markup.startsWith('<svg'))
  })

  it('shows a failure without a recorded reason as a plain failure', async () => {
    const h = harness()
    h.ledger.records = [record('c-fail', 'failed', { stopReason: null, route: KIMI })]
    const menu = h.open()
    h.install()
    await flush()
    assert.equal(shown(rowOf(menu, 'Reviewer')).text, 'Failed')
  })

  it('shows a model label without a separator when the route carries no effort', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    await flush()
    const tag = tagOf(rowOf(menu, 'Reviewer'))
    assert.equal(tag?.textContent, 'Kimi K3')
    assert.equal(tag?.textContent?.includes('·'), false)
  })

  it('marks nested rows from their own catalogs and leaves diagnostics and loading placeholders alone', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    await flush()
    assert.deepEqual(shown(rowOf(menu, 'Deep one')), { state: 'done', text: 'Done', model: 'Kimi K3', title: 'This subagent runs on Kimi K3' })
    assert.equal(shown(rowOf(menu, 'Deep two')).state, 'failed')
    assert.equal(shown(rowOf(menu, 'Deep two')).text, 'Failed: error')
    assert.equal(shown(rowOf(menu, 'Deep two')).model, 'Gemini 3.8 Flash · High')
    // The row that owns a group nobody has loaded is marked; the placeholders inside it are not.
    assert.equal(stateOf(rowOf(menu, 'Loader')), 'unknown')
    assert.equal(tagOf(rowOf(menu, 'Loader')), null)
    for (const untouched of [rowOf(menu, 'n-bad'), ...menu.querySelectorAll('[aria-label="Loading subagents"]')]) {
      assert.equal(ours(untouched).length, 0)
      assert.equal(untouched.hasAttribute('data-orq-row'), false)
      assert.equal(untouched.getAttribute('aria-disabled'), 'true')
    }
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-model').length, 7)
  })

  it('does not touch the native dot: it stays in place, byte for byte, and gets no inline style', async () => {
    const h = harness()
    const menu = h.open()
    const rows = [...menu.querySelectorAll('[role="treeitem"]')]
    const before = rows.map(row => ({ node: row.querySelector('[data-state]'), html: row.querySelector('[data-state]')?.outerHTML, style: row.querySelector('[data-state]')?.getAttribute('style') }))
    h.install()
    await flush()
    rows.forEach((row, index) => {
      const dot = row.querySelector('[data-state]')
      assert.equal(dot, before[index]?.node, 'the same node')
      assert.equal(dot?.outerHTML, before[index]?.html, 'the same markup')
      assert.equal(dot?.getAttribute('style'), before[index]?.style, 'no inline style added')
    })
    const done = dotOf(rowOf(menu, 'Builder'))
    assert.equal(done.getAttribute('style'), 'width: 10px; height: 10px;')
    // Our icon is the dot's previous sibling and the text block is still its next one.
    assert.ok(done.previousElementSibling?.classList.contains('dsh-orq-sub-icon'))
    assert.ok(done.nextElementSibling?.classList.contains('content'))
  })

  it('leaves the rest of the row exactly as DSH rendered it', async () => {
    const h = harness()
    const menu = h.open()
    const strip = (root: Element): string => {
      const copy = root.cloneNode(true) as Element
      for (const element of ours(copy)) {
        if (element.hasAttribute('data-orq-row')) element.removeAttribute('data-orq-row')
        else element.remove()
      }
      for (const element of copy.querySelectorAll('[aria-describedby]')) element.removeAttribute('aria-describedby')
      return copy.outerHTML
    }
    const before = menu.outerHTML
    h.install()
    await flush()
    assert.notEqual(menu.outerHTML, before)
    assert.equal(strip(menu), before, 'removing what we added gives back DSH\'s markup')
  })

  it('puts the icon before the dot and the model label last in the text block', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    await flush()
    const row = rowOf(menu, 'Builder')
    const area = row.querySelector('.clickarea')
    assert.ok(area)
    assert.deepEqual([...area.children].map(child => child.className || child.tagName), ['dsh-orq-sub-icon', 'dot', 'content', 'metrics', 'sidebarButton'])
    const content = row.querySelector('.content')
    assert.deepEqual([...content?.children ?? []].map(child => child.className), ['label', 'summary', 'dsh-orq-sub-model'])
    assert.equal(row.getAttribute('data-orq-row'), '')
    assert.equal(row.querySelector('.dsh-orq-sub-model')?.children.length, 1)
  })

  it('works for an ongoing (svg) dot as well as a span dot', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    await flush()
    const dot = dotOf(rowOf(menu, 'Scout'))
    assert.equal(dot.tagName.toLowerCase(), 'svg')
    assert.ok(dot.previousElementSibling?.classList.contains('dsh-orq-sub-icon'))
  })

  it('writes variable text with textContent, never as markup', async () => {
    const h = harness()
    h.ledger.records = [record('c-fail', 'failed', { stopReason: '<img src=x onerror=alert(1)>', route: { provider: 'p', model: '<b>bold</b>' } })]
    const menu = h.open()
    h.install()
    await flush()
    const row = rowOf(menu, 'Reviewer')
    assert.equal(row.querySelectorAll('img, b').length, 0)
    assert.equal(tagOf(row)?.textContent, '<b>bold</b>')
    assert.equal(iconOf(row)?.getAttribute('aria-label'), 'Failed: <img src=x onerror=alert(1)>')
  })
})

describe('subagent menu marks: the ledger, the clock and the language', () => {
  it('asks the ledger of the menu\'s root as soon as it is known', async () => {
    const h = harness()
    h.open()
    h.install()
    assert.equal(h.ledger.calls.length, 1)
    assert.equal(h.ledger.calls[0]?.sessionId, 'main')
    assert.ok(h.ledger.calls[0]?.signal instanceof AbortSignal)
    await flush()
    assert.equal(h.ledger.calls.length, 1)
  })

  it('draws nothing status-related on the first opening until the ledger answers: DSH\'s own dots stay, and no frame says "outcome not recorded"', async () => {
    const h = harness()
    h.ledger.mode = 'pending'
    h.catalog.mode = 'pending'
    const menu = h.open()
    h.install()
    await flush()
    // No icon, and DSH's dot is not hidden: the row is exactly what DSH drew, plus the model DSH saw the child use.
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 0)
    assert.equal(menu.querySelectorAll('[data-orq-row]').length, 0)
    const dot = dotOf(rowOf(menu, 'Builder'))
    assert.equal(dot.previousElementSibling, null)
    assert.equal(shown(rowOf(menu, 'Tester')).model, 'DeepSeek-V4.1-Flash · medium')
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-model').length, 1, 'only the child with a route the session list knows')
    h.ledger.mode = 'ok'
    h.ledger.release()
    await flush()
    assert.equal(stateOf(rowOf(menu, 'Builder')), 'done')
    assert.equal(stateOf(rowOf(menu, 'Scout')), 'running')
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
  })

  it('takes a status mark off a row that now belongs to a root whose ledger is not known yet (DSH\'s own dot shows again)', async () => {
    const h = harness()
    const rows: Row[] = [{ id: 'a1', label: 'Scout', activity: 'running' }, { id: 'a2', label: 'Builder' }]
    h.store.state = listState(rows, 'A')
    h.visible = ['A']
    h.ledger.records = [record('a1', 'running', { startedAt: NOW - 1_000 }), record('a2', 'done')]
    const menu = h.open(rows)
    h.install()
    await flush()
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 2)
    // The same rows now fit another conversation's catalog, whose ledger has not answered.
    h.ledger.mode = 'pending'
    h.visible = ['B']
    h.store.set(listState([{ id: 'b1', label: 'Scout', activity: 'running' }, { id: 'b2', label: 'Builder' }], 'B'))
    await flush()
    assert.deepEqual(h.ledger.calls.map(call => call.sessionId), ['A', 'B'])
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 0)
    assert.equal(menu.querySelectorAll('[data-orq-row]').length, 0)
    assert.equal(dotOf(rowOf(menu, 'Builder')).previousElementSibling, null, 'DSH\'s dot is first in the click area again')
    h.ledger.mode = 'ok'
    h.ledger.records = [record('b1', 'failed', { stopReason: 'error' }), record('b2', 'done')]
    h.ledger.release()
    await flush()
    assert.equal(stateOf(rowOf(menu, 'Scout')), 'failed')
  })

  it('stops waiting for a ledger that is slow: after about a second and a half the poll draws status from the catalog alone', async () => {
    const h = harness()
    h.ledger.mode = 'pending'
    const menu = h.open()
    h.install()
    await flush()
    h.clock.now = NOW + 1_499
    h.timers.fire(2_000)
    await flush()
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 0)
    h.clock.now = NOW + 1_500
    h.timers.fire(2_000)
    await flush()
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
    assert.equal(stateOf(rowOf(menu, 'Scout')), 'running')
    assert.equal(stateOf(rowOf(menu, 'Builder')), 'unknown', 'a finished child with no record: "outcome not recorded"')
    // The ledger answers after all: the marks are corrected in place.
    h.ledger.mode = 'ok'
    h.ledger.release()
    await flush()
    assert.equal(stateOf(rowOf(menu, 'Builder')), 'done')
  })

  it('draws status at once when the ledger fails: a failed answer is an answer', async () => {
    for (const mode of ['undefined', 'reject', 'throw'] as const) {
      const h = harness()
      h.ledger.mode = mode
      const menu = h.open()
      h.install()
      await flush()
      assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8, mode)
      assert.equal(stateOf(rowOf(menu, 'Builder')), 'unknown', mode)
    }
  })

  it('keeps the marks the catalog can give when the host has no ledger (a 404 answers undefined)', async () => {
    const h = harness()
    h.ledger.mode = 'undefined'
    const menu = h.open()
    h.install()
    await flush()
    assert.equal(stateOf(rowOf(menu, 'Scout')), 'running')
    assert.equal(stateOf(rowOf(menu, 'Builder')), 'unknown')
    assert.equal(shown(rowOf(menu, 'Tester')).model, 'DeepSeek V4.1 Flash · Medium', 'the route DSH saw the child use still shows')
    assert.equal(h.warnings.length, 0, 'a missing route is not a failure')
  })

  it('stops believing a running record once it is 5 s old by the host\'s clock and the catalog says the child is not live', async () => {
    const h = harness()
    h.ledger.records = [record('c-fail', 'running', { startedAt: NOW - 1_000, route: KIMI })]
    const menu = h.open()
    h.install()
    await flush()
    assert.equal(stateOf(rowOf(menu, 'Reviewer')), 'running', 'young: the end event may just be late')
    // The host keeps its own time, and every answer says so.
    h.clock.now = NOW + 3_999
    h.ledger.hostNow = NOW + 3_999
    h.timers.fire(2_000)
    await flush()
    assert.equal(stateOf(rowOf(menu, 'Reviewer')), 'running', 'one millisecond short of 5 s')
    h.clock.now = NOW + 4_000
    h.ledger.hostNow = NOW + 4_000
    h.timers.fire(2_000)
    await flush()
    assert.equal(stateOf(rowOf(menu, 'Reviewer')), 'unknown', 'a spinner can never spin forever')
    assert.equal(iconOf(rowOf(menu, 'Reviewer'))?.getAttribute('aria-label'), 'Outcome not recorded')
  })

  it('ages a record by the host\'s clock, not by a browser clock that is hours off (a tunnelled or skewed browser)', async () => {
    for (const skew of [3_600_000, -3_600_000]) {
      const h = harness()
      h.ledger.records = [record('c-fail', 'running', { startedAt: NOW - 1_000, route: KIMI })]
      h.clock.now = NOW + skew
      const menu = h.open()
      h.install()
      await flush()
      assert.equal(stateOf(rowOf(menu, 'Reviewer')), 'running', `browser clock ${String(skew)} ms off`)
    }
  })

  it('carries the host\'s reading forward by the time that passes on this page, while no new answer comes', async () => {
    const h = harness()
    h.ledger.records = [record('c-fail', 'running', { startedAt: NOW - 1_000, route: KIMI })]
    const menu = h.open()
    h.install()
    await flush()
    // The next answers fail: the last one stands, and its age grows with this page's own clock.
    h.ledger.mode = 'undefined'
    h.clock.now = NOW + 3_999
    h.timers.fire(2_000)
    await flush()
    assert.equal(stateOf(rowOf(menu, 'Reviewer')), 'running')
    h.clock.now = NOW + 4_000
    h.timers.fire(2_000)
    await flush()
    assert.equal(stateOf(rowOf(menu, 'Reviewer')), 'unknown')
  })

  it('does not let a page clock that steps backwards bring a stale record back to life', async () => {
    const h = harness()
    h.ledger.records = [record('c-fail', 'running', { startedAt: NOW - 20_000, route: KIMI })]
    const menu = h.open()
    h.install()
    await flush()
    assert.equal(stateOf(rowOf(menu, 'Reviewer')), 'unknown')
    // No new answer re-baselines it, and the page clock jumps an hour back: no time passed since the host spoke.
    h.ledger.mode = 'undefined'
    h.clock.now = NOW - 3_600_000
    h.timers.fire(2_000)
    await flush()
    assert.equal(stateOf(rowOf(menu, 'Reviewer')), 'unknown', 'a spinner cannot be revived by the clock')
  })

  it('falls back to the browser clock for a host that does not say what time it is', async () => {
    const h = harness()
    h.ledger.hostNow = undefined
    h.ledger.records = [record('c-fail', 'running', { startedAt: NOW - 1_000, route: KIMI })]
    const menu = h.open()
    h.install()
    await flush()
    assert.equal(stateOf(rowOf(menu, 'Reviewer')), 'running')
    h.clock.now = NOW + 4_000
    h.timers.fire(2_000)
    await flush()
    assert.equal(stateOf(rowOf(menu, 'Reviewer')), 'unknown', 'by the browser clock the record is 5 s old')
  })

  it('lets a finished ledger record win while the catalog still says the child is live', async () => {
    const h = harness()
    h.ledger.records = [record('c-run', 'done', { route: GEMINI })]
    const menu = h.open()
    h.install()
    await flush()
    assert.equal(stateOf(rowOf(menu, 'Scout')), 'done')
  })

  it('shows raw ids until the model catalog answers, then display names', async () => {
    const h = harness()
    h.catalog.mode = 'pending'
    const menu = h.open()
    h.install()
    await flush()
    assert.equal(shown(rowOf(menu, 'Scout')).model, 'google/gemini-3.8-flash · high')
    assert.equal(shown(rowOf(menu, 'Reviewer')).model, 'moonshotai/kimi-k3')
    assert.equal(shown(rowOf(menu, 'Scout')).title, 'This subagent runs on google/gemini-3.8-flash, reasoning effort high')
    h.catalog.release()
    await flush()
    assert.equal(shown(rowOf(menu, 'Scout')).model, 'Gemini 3.8 Flash · High')
    assert.equal(shown(rowOf(menu, 'Reviewer')).model, 'Kimi K3')
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-model').length, 7, 'the label was rewritten in place')
  })

  it('asks the model catalog once per opening, for the first visible conversation, and reuses it for a minute', async () => {
    const h = harness()
    h.visible = ['main', 'elsewhere']
    h.install()
    const first = h.open()
    await flush()
    assert.deepEqual(h.catalog.calls, ['main'])
    first.remove()
    await flush()
    // A minute has not passed: the names are reused, so the new menu paints with them at once.
    h.clock.now = NOW + 59_000
    const second = h.open()
    await flush()
    assert.equal(shown(rowOf(second, 'Scout')).model, 'Gemini 3.8 Flash · High')
    assert.deepEqual(h.catalog.calls, ['main'])
    second.remove()
    await flush()
    h.clock.now = NOW + 61_000
    h.open()
    await flush()
    assert.deepEqual(h.catalog.calls, ['main', 'main'])
  })

  it('falls back to the menu\'s root when no conversation is visible', async () => {
    const h = harness()
    h.visible = []
    h.open()
    h.install()
    await flush()
    assert.deepEqual(h.catalog.calls, ['main'])
  })

  it('does not cache a catalog that failed to load: the next opening asks again', async () => {
    const h = harness()
    h.catalog.mode = 'error'
    h.install()
    const first = h.open()
    await flush()
    assert.equal(shown(rowOf(first, 'Scout')).model, 'google/gemini-3.8-flash · high', 'raw ids stay')
    first.remove()
    await flush()
    h.catalog.mode = 'ready'
    const second = h.open()
    await flush()
    assert.equal(h.catalog.calls.length, 2)
    assert.equal(shown(rowOf(second, 'Scout')).model, 'Gemini 3.8 Flash · High')
  })

  it('does not let a model catalog request that never answers block the next opening for ever', async () => {
    const h = harness()
    h.catalog.mode = 'pending'
    h.install()
    const first = h.open()
    await flush()
    assert.equal(h.catalog.calls.length, 1)
    first.remove()
    await flush()
    h.clock.now = NOW + 10_000
    const second = h.open()
    await flush()
    assert.equal(h.catalog.calls.length, 1, 'the first request may still answer')
    second.remove()
    await flush()
    h.clock.now = NOW + 31_000
    h.catalog.mode = 'ready'
    const third = h.open()
    await flush()
    assert.equal(h.catalog.calls.length, 2)
    assert.equal(shown(rowOf(third, 'Scout')).model, 'Gemini 3.8 Flash · High')
  })

  it('asks the model catalog once for two menus that open together', async () => {
    const h = harness()
    h.catalog.mode = 'pending'
    h.install()
    h.open()
    h.open()
    await flush()
    assert.equal(h.catalog.calls.length, 1)
    h.catalog.release()
    await flush()
    assert.equal(h.catalog.calls.length, 1)
  })

  it('rewrites the texts when the language changes', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    await flush()
    assert.equal(shown(rowOf(menu, 'Builder')).text, 'Done')
    h.locale.switchTo('pt')
    await flush()
    assert.deepEqual(shown(rowOf(menu, 'Builder')), {
      state: 'done', text: 'Concluído', model: 'Gemini 3.8 Flash · Low', title: 'Este subagente roda em Gemini 3.8 Flash, esforço de raciocínio Low',
    })
    assert.equal(shown(rowOf(menu, 'Reviewer')).text, 'Falhou: limite de tokens atingido')
    assert.equal(shown(rowOf(menu, 'Reviewer')).state, 'failed', 'the glyph is not redrawn for a text change')
  })

  it('finds the root through the parent of a visible subagent conversation (the switcher menu)', async () => {
    const h = harness()
    // The page shows a subagent's own conversation: its menu lists the siblings, rooted at the parent.
    h.visible = ['c-done']
    h.store.state = {
      ...h.store.state,
      byId: { ...h.store.state.byId, 'c-done': { id: 'c-done', parentId: 'main', origin: 'subagent', running: false } },
    }
    h.open()
    h.install()
    await flush()
    assert.equal(h.ledger.calls[0]?.sessionId, 'main')
  })

  it('finds the root among the catalog owners when nothing visible points at it', async () => {
    const h = harness()
    h.visible = []
    const menu = h.open()
    h.install()
    await flush()
    assert.equal(h.ledger.calls[0]?.sessionId, 'main')
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
  })

  it('does not decorate a menu whose rows do not match any catalog (and fetches nothing)', async () => {
    const h = harness()
    h.store.state = { ...h.store.state, subagentsByParent: catalogsOf('main', [{ id: 'other', label: 'Somebody else' }]) }
    const menu = h.open()
    h.install()
    await flush()
    assert.equal(ours(menu).length, 0)
    assert.equal(h.ledger.calls.length, 0)
    assert.deepEqual(h.timers.periods(), [2_000], 'it keeps looking while the menu is open')
  })
})

describe('subagent menu marks: staying up to date', () => {
  it('updates a row in place when the catalog flips its activity and the ledger says it failed', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    await flush()
    const row = rowOf(menu, 'Scout')
    const icon = iconOf(row)
    const model = row.querySelector('.dsh-orq-sub-model')
    assert.equal(icon?.getAttribute('data-orq-state'), 'running')

    // The child ends: DSH's catalog says it is no longer live and React swaps the dot; the ledger records the failure.
    h.ledger.records = h.ledger.records.map(entry => (entry.id === 'c-run' ? record('c-run', 'failed', { stopReason: 'error', route: { ...GEMINI, reasoningEffort: 'high' } }) : entry))
    h.replaceDot(row, 'done')
    h.setActivity('c-run', 'inactive')
    await flush()
    // The ledger is read again soon, not at once; until then the young `running` record keeps the spinner honest.
    assert.deepEqual(h.timers.periods(), [250, 2_000])
    assert.equal(stateOf(row), 'running')
    h.timers.fire(250)
    await flush()

    assert.equal(iconOf(row), icon, 'the same icon node, updated in place')
    assert.equal(row.querySelector('.dsh-orq-sub-model'), model, 'the same model host')
    assert.equal(stateOf(row), 'failed')
    assert.equal(iconOf(row)?.getAttribute('aria-label'), 'Failed: error')
    assert.equal(row.querySelectorAll('.dsh-orq-sub-icon').length, 1)
    assert.equal(row.querySelectorAll('.dsh-orq-sub-model').length, 1)
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
    assert.deepEqual(h.timers.periods(), [2_000], 'the one-shot is gone once it fired')
  })

  it('does not ask the ledger again for a store change that flips no status', async () => {
    const h = harness()
    h.open()
    h.install()
    await flush()
    const asked = h.ledger.calls.length
    h.store.set({ ...h.store.state, byId: { ...h.store.state.byId, extra: { id: 'extra', running: false } } })
    await flush()
    assert.equal(h.ledger.calls.length, asked)
    assert.deepEqual(h.timers.periods(), [2_000])
  })

  it('asks the ledger once for a burst of flips', async () => {
    const h = harness()
    h.open()
    h.install()
    await flush()
    const asked = h.ledger.calls.length
    h.setActivity('c-run', 'inactive')
    h.setActivity('c-stop', 'running')
    h.setActivity('c-unk', 'running')
    await flush()
    assert.deepEqual(h.timers.periods(), [250, 2_000])
    h.timers.fire(250)
    await flush()
    assert.equal(h.ledger.calls.length, asked + 1)
  })

  it('re-reads the ledger on every poll and re-scans', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    await flush()
    assert.equal(stateOf(rowOf(menu, 'Planner')), 'stopped')
    h.ledger.records = h.ledger.records.map(entry => (entry.id === 'c-stop' ? record('c-stop', 'done', { stopReason: 'completed', route: GEMINI }) : entry))
    h.timers.fire(2_000)
    await flush()
    assert.equal(h.ledger.calls.length, 2)
    assert.equal(stateOf(rowOf(menu, 'Planner')), 'done')
    assert.equal(shown(rowOf(menu, 'Planner')).model, 'Gemini 3.8 Flash')
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
  })

  it('removes the model label when the route is no longer known', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    await flush()
    assert.ok(tagOf(rowOf(menu, 'Reviewer')))
    h.ledger.records = h.ledger.records.map(entry => (entry.id === 'c-fail' ? { ...entry, route: null } : entry))
    h.timers.fire(2_000)
    await flush()
    assert.equal(rowOf(menu, 'Reviewer').querySelector('.dsh-orq-sub-model'), null)
    assert.equal(stateOf(rowOf(menu, 'Reviewer')), 'failed')
  })

  it('reads the ledger one request at a time, and again once after a flip that came during a request', async () => {
    const h = harness()
    h.ledger.mode = 'pending'
    h.open()
    h.install()
    await flush()
    assert.equal(h.ledger.calls.length, 1)
    // Polls that find the request still pending do not queue more of them.
    h.timers.fire(2_000)
    h.timers.fire(2_000)
    await flush()
    assert.equal(h.ledger.calls.length, 1)
    // A flip is news, though: it wants one more read after this one.
    h.setActivity('c-run', 'inactive')
    await flush()
    h.timers.fire(250)
    await flush()
    assert.equal(h.ledger.calls.length, 1)
    h.ledger.mode = 'ok'
    h.ledger.release()
    await flush()
    assert.equal(h.ledger.calls.length, 2, 'one trailing read, not three')
    await flush()
    assert.equal(h.ledger.calls.length, 2)
  })

  it('does nothing to the DOM on a second scan: nothing is added, moved or rewritten', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    await flush()
    const seen: MutationRecord[] = []
    const watcher = new h.dom.window.MutationObserver((records) => { seen.push(...records) })
    watcher.observe(menu, { childList: true, subtree: true, attributes: true, characterData: true })
    const before = menu.outerHTML
    h.timers.fire(2_000)
    await flush()
    h.store.set({ ...h.store.state })
    await flush()
    h.locale.switchTo('en')
    await flush()
    assert.equal(seen.length, 0, 'no mutation at all')
    assert.equal(menu.outerHTML, before)
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-model').length, 7)
    watcher.disconnect()
  })

  it('does not re-scan because of its own insertions', async () => {
    const h = harness()
    // The ledger answers (with nothing) at once and the model catalog never does: the scans are the first, synchronous
    // one and the one the answer asks for, which draws every icon.
    h.ledger.mode = 'undefined'
    h.catalog.mode = 'pending'
    const menu = h.open()
    h.install()
    assert.equal(h.store.reads, 1)
    await flush()
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
    assert.equal(h.store.reads, 2)
    await flush()
    await flush()
    assert.equal(h.store.reads, 2, 'its own icons, labels and attributes did not wake it up')
    // A change that is not its own does.
    menu.append(el(h.doc, 'div', { class: 'notice' }))
    await flush()
    assert.equal(h.store.reads, 3)
  })

  it('coalesces a burst of mutations into one scan', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    await flush()
    const reads = h.store.reads
    for (let index = 0; index < 20; index += 1) menu.append(el(h.doc, 'div', { class: 'notice' }))
    h.store.set({ ...h.store.state })
    h.locale.switchTo('en')
    await flush()
    assert.equal(h.store.reads - reads, 1)
  })

  it('marks rows that React adds later (a branch that gets expanded)', async () => {
    const h = harness()
    const rows: Row[] = [{ id: 'c-a', label: 'Alpha' }, { id: 'c-b', label: 'Beta' }]
    h.store.state = listState(rows)
    const menu = h.open(rows)
    h.install()
    await flush()
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 2)
    // Beta is expanded: its catalog arrives in the store and React renders the group under it.
    const expanded: Row[] = [{ id: 'c-a', label: 'Alpha' }, { id: 'c-b', label: 'Beta', children: [{ id: 'c-b1', label: 'Beta one' }] }]
    h.store.state = listState(expanded)
    const fresh = makeMenu(h.doc, expanded)
    const group = fresh.querySelector('[role="group"]')
    assert.ok(group)
    menu.querySelectorAll('.node')[1]?.append(group)
    await flush()
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 3)
    assert.equal(stateOf(rowOf(menu, 'Beta one')), 'unknown')
  })

  it('takes its marks off a row that stops matching its entry, and leaves the others alone', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    await flush()
    const row = rowOf(menu, 'Tester')
    assert.ok(iconOf(row))
    // The row is now somebody else's: its label no longer starts with the entry's label.
    row.setAttribute('aria-label', 'Somebody else continuable')
    row.querySelector('.content')?.append(el(h.doc, 'span'))
    await flush()
    assert.equal(ours(row).length, 0)
    assert.equal(row.hasAttribute('data-orq-row'), false)
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 0, 'the first-level labels no longer fit any catalog, so no row is resolved')
  })

  it('finds a new root when the conversation changes, and asks that ledger at once', async () => {
    const h = harness()
    const other: Row[] = [{ id: 'x-1', label: 'Alpha' }, { id: 'x-2', label: 'Beta' }]
    const menu = h.open(other)
    h.store.state = {
      byId: { second: { id: 'second', running: false } },
      subagentsByParent: catalogsOf('second', other),
    }
    h.visible = ['second']
    h.install()
    assert.equal(h.ledger.calls[0]?.sessionId, 'second')
    await flush()
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 2)
    // The same menu element now belongs to another conversation's catalog.
    const third: Row[] = [{ id: 'y-1', label: 'Alpha' }, { id: 'y-2', label: 'Beta' }]
    h.store.set({ byId: { third: { id: 'third', running: false } }, subagentsByParent: catalogsOf('third', third) })
    await flush()
    assert.equal(h.ledger.calls.at(-1)?.sessionId, 'third')
  })

  it('survives a React-style re-render that replaces the dot node', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    await flush()
    const row = rowOf(menu, 'Builder')
    const icon = iconOf(row)
    const fresh = h.replaceDot(row, 'idle')
    await flush()
    assert.equal(row.querySelectorAll('.dsh-orq-sub-icon').length, 1)
    assert.equal(iconOf(row), icon)
    assert.equal(fresh.previousElementSibling, icon, 'the icon is still the dot\'s previous sibling')
    assert.equal(stateOf(row), 'done')
    // The next scan is still quiet.
    h.timers.fire(2_000)
    await flush()
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
  })

  it('puts the icon back before the dot when something inserted the new dot ahead of it', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    await flush()
    const row = rowOf(menu, 'Builder')
    const area = row.querySelector('.clickarea')
    assert.ok(area)
    const icon = iconOf(row)
    assert.ok(icon)
    // A different renderer: the old dot goes, the new one lands at the start of the row, ahead of our icon.
    dotOf(row).remove()
    area.prepend(makeDot(h.doc, 'warning'))
    await flush()
    assert.equal(row.querySelectorAll('.dsh-orq-sub-icon').length, 1)
    assert.equal(iconOf(row), icon)
    assert.equal(dotOf(row).previousElementSibling, icon)
    assert.equal(dotOf(row).nextElementSibling?.className, 'content')
    assert.equal(row.querySelectorAll('.dsh-orq-sub-model').length, 1)
  })

  it('marks a row again after React re-creates it (a new node without our attribute)', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    await flush()
    const old = rowOf(menu, 'Reviewer')
    const node = old.parentElement
    assert.ok(node)
    node.replaceChildren(makeNode(h.doc, { id: 'c-fail', label: 'Reviewer' }, 1, true).firstElementChild as Element)
    await flush()
    const fresh = rowOf(menu, 'Reviewer')
    assert.notEqual(fresh, old)
    assert.equal(fresh.querySelectorAll('.dsh-orq-sub-icon').length, 1)
    assert.equal(stateOf(fresh), 'failed')
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
  })

  it('survives React replacing the text block or the whole click area of a row', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    await flush()
    const row = rowOf(menu, 'Builder')
    const content = row.querySelector('.content')
    assert.ok(content)
    content.replaceWith(makeContent(h.doc, 'Builder', 'continuable · not running'))
    await flush()
    assert.equal(row.querySelectorAll('.dsh-orq-sub-model').length, 1)
    assert.equal(row.querySelectorAll('.dsh-orq-sub-icon').length, 1)
    const area = row.querySelector('.clickarea')
    assert.ok(area)
    area.replaceWith(el(h.doc, 'div', { class: 'clickarea' }, makeDot(h.doc, 'done'), makeContent(h.doc, 'Builder', 'continuable · not running')))
    await flush()
    assert.equal(row.querySelectorAll('.dsh-orq-sub-icon').length, 1)
    assert.equal(row.querySelectorAll('.dsh-orq-sub-model').length, 1)
    assert.equal(stateOf(row), 'done')
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
  })

  it('removes a stray duplicate of its own elements instead of keeping two', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    await flush()
    const row = rowOf(menu, 'Builder')
    const icon = iconOf(row)
    assert.ok(icon)
    icon.after(icon.cloneNode(true))
    row.querySelector('.content')?.append(row.querySelector('.dsh-orq-sub-model')?.cloneNode(true) as Node)
    assert.equal(row.querySelectorAll('.dsh-orq-sub-icon').length, 2)
    h.timers.fire(2_000)
    await flush()
    assert.equal(row.querySelectorAll('.dsh-orq-sub-icon').length, 1)
    assert.equal(row.querySelectorAll('.dsh-orq-sub-model').length, 1)
  })

  it('skips a row that does not have the structure DSH 0.1.6 renders, and leaves it as DSH drew it', async () => {
    const h = harness()
    const menu = h.open()
    // A future DSH renders Scout without a status dot, and Builder with a dot nothing follows.
    const scout = rowOf(menu, 'Scout')
    dotOf(scout).remove()
    const builder = rowOf(menu, 'Builder')
    const content = builder.querySelector('.content')
    const area = builder.querySelector('.clickarea')
    assert.ok(content && area)
    area.replaceChildren(dotOf(builder))
    h.install()
    await flush()
    assert.equal(ours(scout).length, 0)
    assert.equal(ours(builder).length, 0)
    assert.equal(scout.hasAttribute('data-orq-row'), false)
    assert.equal(builder.hasAttribute('data-orq-row'), false)
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 6, 'the other rows are still marked')
    assert.equal(h.warnings.length, 0)
  })

  it('does not take any other `data-state` element for the status dot', async () => {
    const h = harness()
    const menu = h.open()
    const row = rowOf(menu, 'Builder')
    // A disclosure that carries a data-state of its own (a menu primitive might): it is no StateDot.
    const toggle = row.querySelector('.disclosure')
    assert.ok(toggle)
    toggle.setAttribute('data-state', 'open')
    h.install()
    await flush()
    assert.equal(toggle.nextElementSibling?.className, 'clickarea')
    assert.equal(ours(toggle).length, 0)
    assert.equal(stateOf(row), 'done')
    assert.equal(dotOf(row).getAttribute('data-state'), 'open', 'the disclosure is still the first data-state element')
    assert.ok(row.querySelector('.clickarea .dsh-orq-sub-icon'))
  })
})

describe('subagent menu marks: leaving', () => {
  it('stops its timers, subscriptions and requests when the menu leaves the DOM', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    await flush()
    assert.deepEqual(h.timers.periods(), [2_000])
    assert.equal(h.store.listenerCount, 1)
    assert.equal(h.locale.listenerCount, 1)
    h.setActivity('c-run', 'inactive')
    await flush()
    assert.deepEqual(h.timers.periods(), [250, 2_000])
    menu.remove()
    await flush()
    assert.equal(h.timers.count, 0, 'the poll and the pending one-shot are gone')
    assert.equal(h.store.listenerCount, 0)
    assert.equal(h.locale.listenerCount, 0)
    // Nothing reacts to what happens to the old menu or to the store any more.
    const reads = h.store.reads
    const calls = h.ledger.calls.length
    menu.append(el(h.doc, 'div'))
    h.setActivity('c-run', 'running')
    h.locale.switchTo('pt')
    await flush()
    assert.equal(h.store.reads, reads)
    assert.equal(h.ledger.calls.length, calls)
    assert.equal(h.warnings.length, 0)
    assert.equal(h.errors.length, 0)
  })

  it('stops when the menu is detached without the body observer reporting it (the poll checks isConnected)', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    await flush()
    menu.remove()
    // Even if the body observer's report were lost, the next poll finds the menu gone.
    h.timers.fire(2_000)
    await flush()
    assert.equal(h.timers.count, 0)
    assert.equal(h.store.listenerCount, 0)
  })

  it('keeps the other menu going when one closes', async () => {
    const h = harness()
    h.install()
    const first = h.open()
    const second = h.open()
    await flush()
    assert.equal(h.timers.count, 2)
    assert.equal(h.store.listenerCount, 2)
    first.remove()
    await flush()
    assert.equal(h.timers.count, 1)
    assert.equal(h.store.listenerCount, 1)
    h.setActivity('c-run', 'inactive')
    await flush()
    assert.equal(stateOf(rowOf(second, 'Scout')), 'running', 'a young running record')
    assert.ok(iconOf(rowOf(second, 'Scout')))
  })

  it('paints a reopened menu with what it knew, then refreshes it', async () => {
    const h = harness()
    h.install()
    const first = h.open()
    await flush()
    first.remove()
    await flush()
    h.ledger.mode = 'pending'
    const second = h.open()
    await flush()
    // The ledger has not answered yet, but the last answer is kept: no flash of "outcome not recorded".
    assert.equal(h.ledger.calls.length, 2)
    assert.equal(stateOf(rowOf(second, 'Builder')), 'done')
    assert.equal(stateOf(rowOf(second, 'Reviewer')), 'failed')
    h.ledger.mode = 'ok'
    h.ledger.release()
    await flush()
    assert.equal(stateOf(rowOf(second, 'Builder')), 'done')
  })

  it('removes every element and attribute it added when disposed, and nothing else', async () => {
    const h = harness()
    const menu = h.open()
    const before = h.doc.body.innerHTML
    const stop = h.install()
    await flush()
    assert.notEqual(h.doc.body.innerHTML, before)
    assert.ok(ours(menu).length > 0)
    stop()
    assert.equal(ours(h.doc).length, 0)
    assert.equal(h.doc.querySelectorAll('[data-orq-row], [data-orq-state]').length, 0)
    assert.equal(h.doc.body.innerHTML, before, 'the page is byte for byte what DSH rendered')
    assert.equal(h.timers.count, 0)
    assert.equal(h.store.listenerCount, 0)
    assert.equal(h.locale.listenerCount, 0)
  })

  it('stops reacting once disposed: later menus and later mutations are ignored', async () => {
    const h = harness()
    const stop = h.install()
    stop()
    const menu = h.open()
    h.store.set({ ...h.store.state })
    await flush()
    assert.equal(ours(menu).length, 0)
    assert.equal(h.timers.started, 0)
    assert.equal(h.ledger.calls.length, 0)
    assert.equal(h.store.reads, 0)
  })

  it('aborts a request that is in flight when disposed, and ignores its answer', async () => {
    const h = harness()
    h.ledger.mode = 'pending'
    const menu = h.open()
    const stop = h.install()
    await flush()
    const signal = h.ledger.calls[0]?.signal
    assert.ok(signal)
    assert.equal(signal.aborted, false)
    stop()
    assert.equal(signal.aborted, true)
    h.ledger.release()
    await flush()
    assert.equal(ours(menu).length, 0)
    assert.equal(h.warnings.length, 0)
    assert.equal(h.errors.length, 0)
  })

  it('does not report as a failure the rejection an aborted request ends in', async () => {
    const h = harness()
    const menu = h.open()
    const stop = h.install({
      client: {
        list: (_sessionId, signal) => new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) }, { once: true })
        }),
      },
    })
    await flush()
    stop()
    await flush()
    assert.equal(h.warnings.length, 0, 'giving up on a request is not a failure of the request')
    assert.equal(h.errors.length, 0)
    assert.equal(ours(menu).length, 0)
  })

  it('takes the model label and its description off a row that never got its icon, when disposed during the first opening', async () => {
    const h = harness()
    h.ledger.mode = 'pending'
    const menu = h.open()
    const before = h.doc.body.innerHTML
    const stop = h.install()
    await flush()
    const tester = rowOf(menu, 'Tester')
    assert.ok(tagOf(tester), 'the model label is drawn before the ledger answers')
    assert.ok(tester.hasAttribute('aria-describedby'))
    assert.equal(tester.hasAttribute('data-orq-row'), false, 'and the row is not marked, so only its description tells it is ours')
    stop()
    assert.equal(tester.hasAttribute('aria-describedby'), false)
    assert.equal(h.doc.body.innerHTML, before)
  })

  it('ignores the answer of the model catalog that arrives after it was disposed', async () => {
    const h = harness()
    h.catalog.mode = 'pending'
    const menu = h.open()
    const stop = h.install()
    await flush()
    stop()
    h.catalog.release()
    await flush()
    assert.equal(ours(menu).length, 0)
    assert.equal(h.errors.length, 0)
  })

  it('can be disposed twice', async () => {
    const h = harness()
    h.open()
    const stop = h.install()
    await flush()
    stop()
    assert.doesNotThrow(stop)
  })

  it('can be started again after it was disposed (a plugin reload) and decorates the open menu afresh', async () => {
    const h = harness()
    const menu = h.open()
    const first = h.install()
    await flush()
    first()
    assert.equal(ours(menu).length, 0)
    h.install()
    await flush()
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
  })
})

describe('subagent menu marks: failing open', () => {
  it('never throws when the ledger carrier throws, and warns once however often it fails', async () => {
    const h = harness()
    h.ledger.mode = 'throw'
    const menu = h.open()
    assert.doesNotThrow(() => h.install())
    await flush()
    for (let index = 0; index < 4; index += 1) {
      h.timers.fire(2_000)
      await flush()
    }
    assert.equal(h.warnings.length, 1)
    assert.match(h.warnings[0]?.message ?? '', /ledger/)
    assert.match(String((h.warnings[0]?.error as Error).message), /exploded/)
    assert.equal(h.errors.length, 0)
    // What the catalog alone can say is still drawn.
    assert.equal(stateOf(rowOf(menu, 'Scout')), 'running')
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
  })

  it('never throws when the ledger carrier rejects, and recovers when it works again', async () => {
    const h = harness()
    h.ledger.mode = 'reject'
    const menu = h.open()
    h.install()
    await flush()
    h.timers.fire(2_000)
    await flush()
    assert.equal(h.warnings.length, 1)
    h.ledger.mode = 'ok'
    h.timers.fire(2_000)
    await flush()
    assert.equal(stateOf(rowOf(menu, 'Builder')), 'done')
    assert.equal(h.warnings.length, 1)
    assert.equal(h.errors.length, 0)
  })

  it('never throws when the session list throws, warns once, and leaves the menu as DSH drew it', async () => {
    const h = harness()
    h.store.throwOnRead = true
    const menu = h.open()
    const before = menu.outerHTML
    assert.doesNotThrow(() => h.install())
    await flush()
    for (let index = 0; index < 3; index += 1) {
      menu.append(el(h.doc, 'div'))
      h.timers.fire(2_000)
      await flush()
    }
    assert.equal(h.warnings.length, 1)
    assert.equal(h.errors.length, 0)
    assert.equal(ours(menu).length, 0)
    assert.equal(menu.querySelectorAll('div:not([class])').length, 3)
    assert.equal(menu.outerHTML.replace(/<div><\/div>/g, ''), before)
    // The store recovers: the marks appear on the next poll.
    h.store.throwOnRead = false
    h.timers.fire(2_000)
    await flush()
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
  })

  it('keeps the marks it drew when the session list starts to throw later', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    await flush()
    h.store.throwOnRead = true
    h.timers.fire(2_000)
    await flush()
    h.store.set(h.store.state)
    await flush()
    assert.equal(h.warnings.length, 1)
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
    assert.equal(h.errors.length, 0)
  })

  it('works without a subscription when the store or the locale refuse one', async () => {
    const h = harness()
    h.store.throwOnSubscribe = true
    const menu = h.open()
    h.install()
    await flush()
    assert.equal(h.warnings.length, 1)
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8, 'the poll still keeps it current')
    assert.deepEqual(h.timers.periods(), [2_000])
    menu.remove()
    await flush()
    assert.equal(h.timers.count, 0)
  })

  it('never throws when the model catalog throws or rejects, and keeps raw ids', async () => {
    for (const mode of ['throw', 'reject'] as const) {
      const h = harness()
      h.catalog.mode = mode
      const menu = h.open()
      assert.doesNotThrow(() => h.install())
      await flush()
      assert.equal(h.warnings.length, 1, mode)
      assert.equal(shown(rowOf(menu, 'Scout')).model, 'google/gemini-3.8-flash · high')
      assert.equal(h.errors.length, 0)
    }
  })

  it('still finds the root through the catalog owners when the list of visible conversations throws', async () => {
    const h = harness()
    const menu = h.open()
    h.install({ visibleSessionIds: () => { throw new Error('no composers') } })
    await flush()
    assert.equal(h.warnings.length, 1)
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
    assert.deepEqual(h.catalog.calls, ['main'])
  })

  it('survives a diagnostics sink that throws', async () => {
    const h = harness()
    h.ledger.mode = 'throw'
    const menu = h.open()
    assert.doesNotThrow(() => h.install({ warn: () => { throw new Error('the sink is broken') } }))
    await flush()
    h.timers.fire(2_000)
    await flush()
    assert.equal(h.errors.length, 0)
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
  })

  it('survives a locale that throws while it translates', async () => {
    const h = harness()
    const menu = h.open()
    const broken: LocaleLike = {
      ...h.locale,
      addLanguage: () => () => undefined,
      register: () => () => undefined,
      getSnapshot: () => h.locale.getSnapshot(),
      subscribe: (listener) => h.locale.subscribe(listener),
      bind: (ns) => (ns === 'subagent' ? h.locale.bind(ns) : () => { throw new Error('no dictionary') }),
    }
    assert.doesNotThrow(() => h.install({ locale: broken }))
    await flush()
    assert.equal(h.warnings.length, 1)
    assert.equal(h.errors.length, 0)
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 0, 'a row is not marked with text that could not be written')
    assert.equal(menu.querySelectorAll('[data-orq-row]').length, 0)
  })

  it('survives timers that throw: it gives the menu back as DSH drew it', async () => {
    const h = harness()
    const menu = h.open()
    const before = h.doc.body.innerHTML
    const hostile: MarksTimers = { setInterval: () => { throw new Error('no timers') }, clearInterval: () => { throw new Error('no timers') } }
    assert.doesNotThrow(() => h.install({ timers: hostile }))
    await flush()
    assert.equal(h.warnings.length, 1)
    assert.match(String((h.warnings[0]?.error as Error).message), /no timers/)
    // A menu that cannot be kept up to date is not decorated at all.
    assert.equal(ours(menu).length, 0)
    assert.equal(h.doc.body.innerHTML, before)
    assert.equal(h.store.listenerCount, 0)
    assert.doesNotThrow(() => menu.remove())
    await flush()
    assert.equal(h.errors.length, 0)
  })

  it('does not use class names of DSH to find anything: hashed classes work the same', async () => {
    const h = harness()
    const menu = h.open()
    // CSS modules hash every class in production.
    for (const element of menu.querySelectorAll('[class]')) element.setAttribute('class', `_${Math.random().toString(36).slice(2, 8)}`)
    h.install()
    await flush()
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-model').length, 7)
    assert.equal(stateOf(rowOf(menu, 'Reviewer')), 'failed')
  })
})

/** Two session list states merged (several conversations on one page). */
function mergeStates(...states: SessionListStateLike[]): SessionListStateLike {
  return {
    byId: Object.assign({}, ...states.map(state => state.byId)) as SessionListStateLike['byId'],
    subagentsByParent: Object.assign({}, ...states.map(state => state.subagentsByParent)) as SessionListStateLike['subagentsByParent'],
  }
}

/** Make the document's observers drop the removals they would report, like a report that got lost. */
function blindToRemovals(window: JSDOM['window']): void {
  const Real = window.MutationObserver
  class Blind extends Real {
    constructor(callback: MutationCallback) {
      super((records, observer) => {
        const seen = records.map(record => ({ type: record.type, target: record.target, addedNodes: record.addedNodes, removedNodes: [] as Node[] }))
        callback(seen as unknown as MutationRecord[], observer)
      })
    }
  }
  window.MutationObserver = Blind as unknown as typeof Real
}

describe('subagent menu marks: telling which conversation a menu belongs to', () => {
  it('walks every ancestor of a visible subagent: the menu of an ancestor two levels up is rooted at that ancestor', async () => {
    const h = harness()
    const twin: Row[] = [{ id: 'twin-child', label: 'Fix the bug' }]
    const rootRows: Row[] = [{ id: 'C', label: 'Fix the bug' }]
    h.store.state = {
      byId: {
        Root: { id: 'Root', running: false },
        C: { id: 'C', parentId: 'Root', origin: 'subagent', running: false },
        G: { id: 'G', parentId: 'C', origin: 'subagent', running: false },
      },
      // The twin's catalog was loaded first, so it comes first in the table.
      subagentsByParent: { ...catalogsOf('twinOwner', twin), ...catalogsOf('Root', rootRows) },
    }
    h.visible = ['G']
    const menu = h.open(rootRows)
    h.install()
    await flush()
    assert.deepEqual(h.ledger.calls.map(call => call.sessionId), ['Root'])
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 1)
  })

  it('stops the walk where DSH\'s does: at a session that is not a subagent, and it survives a cycle', async () => {
    const h = harness()
    const rootRows: Row[] = [{ id: 'C', label: 'Fix the bug' }]
    const above: Row[] = [{ id: 'Root', label: 'Fix the bug' }]
    h.store.state = {
      byId: {
        Top: { id: 'Top', running: false },
        // Root is a conversation of its own (no origin): its parent is not an ancestor on this page.
        Root: { id: 'Root', parentId: 'Top', running: false },
        C: { id: 'C', parentId: 'Root', origin: 'subagent', running: false },
        loopA: { id: 'loopA', parentId: 'loopB', origin: 'subagent', running: false },
        loopB: { id: 'loopB', parentId: 'loopA', origin: 'subagent', running: false },
      },
      subagentsByParent: { ...catalogsOf('Top', above), ...catalogsOf('Root', rootRows) },
    }
    h.visible = ['C', 'loopA']
    const menu = h.open(rootRows)
    assert.doesNotThrow(() => h.install())
    await flush()
    assert.deepEqual(h.ledger.calls.map(call => call.sessionId), ['Root'], 'Top is no ancestor: both fit, but only Root is in the first tier')
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 1)
    assert.equal(h.warnings.length, 0)
  })

  it('finds the root through the parent of a visible subagent conversation even when a look-alike catalog comes first', async () => {
    const h = harness()
    // The page shows a subagent's own conversation: its menu lists the siblings, rooted at the parent.
    h.visible = ['c-done']
    const twin: Row[] = ROWS.map(row => ({ id: `twin-${row.id}`, ...row.label === undefined ? {} : { label: row.label } }))
    h.store.state = {
      byId: { ...h.store.state.byId, 'c-done': { id: 'c-done', parentId: 'main', origin: 'subagent', running: false } },
      // The twin has the same labels in the same order, and comes first in the table.
      subagentsByParent: { ...catalogsOf('twin', twin), ...h.store.state.subagentsByParent },
    }
    const menu = h.open()
    h.install()
    await flush()
    assert.deepEqual(h.ledger.calls.map(call => call.sessionId), ['main'])
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
  })

  it('resolves nothing when two conversations on the page have look-alike subagents (two panes): the rows stay as DSH drew them', async () => {
    const h = harness()
    const rowsA: Row[] = [{ id: 'a-child', label: 'Explore codebase' }]
    const rowsB: Row[] = [{ id: 'b-child', label: 'Explore codebase' }]
    h.store.state = mergeStates(
      { byId: { A: { id: 'A', running: false }, B: { id: 'B', running: false } }, subagentsByParent: {} },
      { byId: {}, subagentsByParent: { ...catalogsOf('A', rowsA), ...catalogsOf('B', rowsB) } },
    )
    h.visible = ['A', 'B']
    const menu = h.open(rowsB)
    const before = menu.outerHTML
    h.install()
    await flush()
    h.timers.fire(2_000)
    await flush()
    assert.equal(menu.outerHTML, before)
    assert.equal(h.ledger.calls.length, 0, 'it asks no ledger for a conversation it cannot tell')
    assert.equal(h.warnings.length, 0)
  })

  it('tells those two panes apart by the session title, and marks only the menu\'s own subagents', async () => {
    const h = harness()
    const rowsA: Row[] = [{ id: 'a-child', label: 'Explore codebase', title: 'Find the router' }]
    const rowsB: Row[] = [{ id: 'b-child', label: 'Explore codebase', title: 'Find the store' }]
    h.store.state = mergeStates(listState(rowsA, 'A'), listState(rowsB, 'B'))
    h.visible = ['A', 'B']
    h.ledger.records = [record('a-child', 'failed', { stopReason: 'error', route: KIMI }), record('b-child', 'done', { route: GEMINI })]
    const menuOfB = h.open(rowsB)
    h.install()
    await flush()
    assert.deepEqual(h.ledger.calls.map(call => call.sessionId), ['B'])
    const row = rowOf(menuOfB, 'Explore codebase')
    assert.equal(stateOf(row), 'done', 'the state of B\'s child, not A\'s')
    assert.equal(shown(row).model, 'Gemini 3.8 Flash')
  })

  it('does not let a catalog whose label merely starts the way another label does capture its menu', async () => {
    const h = harness()
    const rowsA: Row[] = [{ id: 'a1', label: 'Review', title: 'Check the login flow' }]
    const rowsB: Row[] = [{ id: 'b1', label: 'Review the auth module', title: 'Plan the release' }]
    h.store.state = mergeStates(listState(rowsA, 'A'), listState(rowsB, 'B'))
    h.visible = ['A', 'B']
    h.ledger.records = [record('b1', 'done', { route: GEMINI })]
    const menuOfB = h.open(rowsB)
    h.install()
    await flush()
    assert.deepEqual(h.ledger.calls.map(call => call.sessionId), ['B'])
    assert.equal(stateOf(rowOf(menuOfB, 'Review the auth module')), 'done')
  })

  it('does not mark a row whose label is another one\'s plus a few letters', async () => {
    const h = harness()
    const rows: Row[] = [{ id: 'c1', label: 'Review' }]
    h.store.state = listState(rows)
    // DSH renders `Reviewer`, the store says `Review`: not the same row.
    const menu = h.open([{ id: 'c1', label: 'Reviewer' }])
    h.install()
    await flush()
    assert.equal(ours(menu).length, 0)
    assert.equal(h.ledger.calls.length, 0)
  })

  it('never marks the row of an entry with an empty label', async () => {
    const h = harness()
    const rows: Row[] = [{ id: 'c1', label: '' }]
    h.store.state = listState(rows)
    const menu = h.open(rows)
    h.install()
    await flush()
    assert.equal(ours(menu).length, 0)
    assert.equal(h.ledger.calls.length, 0)
  })

  it('lets the child\'s own catalog and its parent\'s share a tier: a look-alike chain is settled by aria-current, or not at all', async () => {
    const h = harness()
    // The page is C, whose parent P lists it. C's own catalog (a child G) has the same label as C.
    const pRows: Row[] = [{ id: 'C', label: 'Fix the bug', current: true }]
    const cRows: Row[] = [{ id: 'G', label: 'Fix the bug' }]
    h.store.state = {
      byId: { P: { id: 'P', running: false }, C: { id: 'C', parentId: 'P', origin: 'subagent', running: false } },
      subagentsByParent: { ...catalogsOf('C', cRows), ...catalogsOf('P', pRows) },
    }
    h.visible = ['C']
    // The switcher menu of C: DSH marks C's row aria-current, and G is no session on the page.
    const menu = h.open(pRows)
    h.install()
    await flush()
    assert.deepEqual(h.ledger.calls.map(call => call.sessionId), ['P'], 'the child\'s own catalog did not outrank its parent')
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 1)
  })

  it('without that marker the look-alike chain is left alone', async () => {
    const h = harness()
    const pRows: Row[] = [{ id: 'C', label: 'Fix the bug' }]
    const cRows: Row[] = [{ id: 'G', label: 'Fix the bug' }]
    h.store.state = {
      byId: { P: { id: 'P', running: false }, C: { id: 'C', parentId: 'P', origin: 'subagent', running: false } },
      subagentsByParent: { ...catalogsOf('C', cRows), ...catalogsOf('P', pRows) },
    }
    h.visible = ['C']
    const menu = h.open(pRows)
    h.install()
    await flush()
    assert.equal(ours(menu).length, 0)
    assert.equal(h.ledger.calls.length, 0)
  })

  it('with no conversation visible, two look-alike catalogs resolve nothing, and a single fit among them is marked', async () => {
    const h = harness()
    const twin: Row[] = [{ id: 'old-child', label: 'Summarize results' }]
    const real: Row[] = [{ id: 'new-child', label: 'Summarize results' }]
    h.visible = []
    h.store.state = {
      byId: { realParent: { id: 'realParent', running: false }, oldParent: { id: 'oldParent', running: false } },
      subagentsByParent: { ...catalogsOf('oldParent', twin), ...catalogsOf('realParent', real) },
    }
    const menu = h.open(real)
    h.install()
    await flush()
    assert.equal(ours(menu).length, 0)
    assert.equal(h.ledger.calls.length, 0)
    // The twin goes away (its catalog is dropped): the menu has one fit, and is marked at the next poll.
    h.store.set({ byId: h.store.state.byId, subagentsByParent: catalogsOf('realParent', real) })
    await flush()
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 1)
    assert.deepEqual(h.ledger.calls.map(call => call.sessionId), ['realParent'])
  })

  it('takes its marks off a menu that turns ambiguous (a look-alike catalog appears in the store)', async () => {
    const h = harness()
    const rows: Row[] = [{ id: 'a1', label: 'Scout' }, { id: 'a2', label: 'Builder' }]
    h.store.state = listState(rows, 'A')
    h.visible = ['A']
    const menu = h.open(rows)
    h.install()
    await flush()
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 2)
    h.visible = ['A', 'B']
    h.store.set({ byId: { ...h.store.state.byId, B: { id: 'B', running: false } }, subagentsByParent: { ...h.store.state.subagentsByParent, ...catalogsOf('B', [{ id: 'b1', label: 'Scout' }, { id: 'b2', label: 'Builder' }]) } })
    await flush()
    assert.equal(ours(menu).length, 0)
    assert.equal([...menu.querySelectorAll('[aria-describedby]')].length, 0)
  })
})

describe('subagent menu marks: a row that is not what DSH 0.1.6 renders', () => {
  it('does not put the model label in an element that does not hold the row\'s label (something sits between the dot and the text)', async () => {
    const h = harness()
    const menu = h.open()
    for (const area of menu.querySelectorAll('.clickarea')) area.firstElementChild?.after(el(h.doc, 'span', { class: 'avatar' }))
    const before = menu.outerHTML
    h.install()
    await flush()
    assert.equal(ours(menu).length, 0)
    assert.equal(menu.outerHTML, before, 'every row stays exactly as DSH drew it')
    assert.equal(h.warnings.length, 0)
  })

  it('skips a row whose dot comes after the text block (the next element is not the label)', async () => {
    const h = harness()
    const menu = h.open()
    for (const area of menu.querySelectorAll('.clickarea')) area.append(area.firstElementChild as Element)
    h.install()
    await flush()
    assert.equal(ours(menu).length, 0)
  })

  it('still marks a row whose text block holds more than the label (the summary, the model label of an earlier pass)', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    await flush()
    const row = rowOf(menu, 'Builder')
    const content = row.querySelector('.content')
    assert.ok(content)
    assert.ok((content.textContent ?? '').startsWith('Builder'))
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
  })

  it('takes the marks off a row whose structure changed under it', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    await flush()
    const row = rowOf(menu, 'Builder')
    assert.ok(iconOf(row))
    // The text block is now something else (a rearranged DSH): the label is not in it any more.
    const content = row.querySelector('.content')
    assert.ok(content)
    content.replaceChildren(h.doc.createTextNode('something else entirely'))
    await flush()
    assert.equal(ours(row).length, 0)
    assert.equal(row.hasAttribute('data-orq-row'), false)
    assert.equal(row.hasAttribute('aria-describedby'), false)
  })
})

describe('subagent menu marks: what a screen reader hears', () => {
  it('points each marked row\'s aria-describedby at its icon and its model label', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    await flush()
    const row = rowOf(menu, 'Reviewer')
    const icon = iconOf(row)
    const tag = tagOf(row)
    assert.ok(icon && tag)
    assert.match(icon.id, /^dsh-orq-sub-/)
    assert.match(tag.id, /^dsh-orq-sub-/)
    assert.deepEqual((row.getAttribute('aria-describedby') ?? '').split(' '), [icon.id, tag.id])
    // What the references add up to: the state and the model.
    const heard = (row.getAttribute('aria-describedby') ?? '').split(' ').map(id => h.doc.getElementById(id)).map(node => node?.getAttribute('aria-label') ?? node?.textContent).join(' ')
    assert.equal(heard, 'Failed: token limit reached Kimi K3')
    // Every id is unique on the page, and the icon keeps its role and tooltip.
    const ids = [...menu.querySelectorAll('.dsh-orq-sub-icon, .dsh-orq-sub-tag')].map(node => node.id)
    assert.equal(new Set(ids).size, ids.length)
    assert.equal(icon.getAttribute('role'), 'img')
    assert.equal(icon.getAttribute('title'), 'Failed: token limit reached')
  })

  it('describes a row without a model by its icon alone, and updates the description when the model goes', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    await flush()
    const loader = rowOf(menu, 'Loader')
    assert.equal(loader.getAttribute('aria-describedby'), iconOf(loader)?.id)
    const reviewer = rowOf(menu, 'Reviewer')
    assert.equal((reviewer.getAttribute('aria-describedby') ?? '').split(' ').length, 2)
    h.ledger.records = h.ledger.records.map(entry => (entry.id === 'c-fail' ? { ...entry, route: null } : entry))
    h.timers.fire(2_000)
    await flush()
    assert.equal(reviewer.getAttribute('aria-describedby'), iconOf(reviewer)?.id)
  })

  it('describes a row by its model label alone until the icon may be drawn', async () => {
    const h = harness()
    h.ledger.mode = 'pending'
    const menu = h.open()
    h.install()
    await flush()
    const tester = rowOf(menu, 'Tester')
    assert.equal(tester.getAttribute('aria-describedby'), tagOf(tester)?.id)
    assert.equal(rowOf(menu, 'Builder').hasAttribute('aria-describedby'), false)
  })

  it('keeps an id that was already there, and hands the row back exactly as it was when disposed', async () => {
    const h = harness()
    const menu = h.open()
    const row = rowOf(menu, 'Reviewer')
    row.setAttribute('aria-describedby', 'hint-from-dsh')
    const before = h.doc.body.innerHTML
    const stop = h.install()
    await flush()
    const tokens = (row.getAttribute('aria-describedby') ?? '').split(' ')
    assert.equal(tokens.length, 3)
    assert.equal(tokens[0], 'hint-from-dsh')
    stop()
    assert.equal(row.getAttribute('aria-describedby'), 'hint-from-dsh')
    assert.equal(h.doc.body.innerHTML, before)
  })

  it('is not overwritten by a re-render that sets the row\'s own attributes', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    await flush()
    const row = rowOf(menu, 'Builder')
    const described = row.getAttribute('aria-describedby')
    assert.ok(described)
    // What React does on a state change: new aria-label, new class, aria-current: none of it is aria-describedby.
    row.setAttribute('aria-label', `${row.getAttribute('aria-label') ?? ''}!`)
    row.setAttribute('aria-current', 'true')
    row.setAttribute('class', 'row other')
    await flush()
    assert.equal(row.getAttribute('aria-describedby'), described)
  })
})

describe('subagent menu marks: the model label and the stop reason', () => {
  it('shows the model DSH saw the child use before the one the ledger recorded at its start', async () => {
    const h = harness()
    // The ledger recorded Gemini when the child started; DSH's own session list says its latest request went to Kimi.
    h.ledger.records = [record('c-done', 'done', { route: { ...GEMINI, reasoningEffort: 'low' } }), record('c-fail', 'failed', { stopReason: 'error', route: { ...GEMINI, reasoningEffort: 'high' } })]
    h.store.state = {
      ...h.store.state,
      byId: { ...h.store.state.byId, 'c-done': { id: 'c-done', running: false, projectionValues: { modelSelection: { lastUsed: KIMI } } } },
    }
    const menu = h.open()
    h.install()
    await flush()
    assert.equal(shown(rowOf(menu, 'Builder')).model, 'Kimi K3')
    // A child that has made no request yet has nothing in the session list: the ledger's route stands in.
    assert.equal(shown(rowOf(menu, 'Reviewer')).model, 'Gemini 3.8 Flash · High')
  })

  it('spells out the stop reasons it knows and prints any other as the host sent it', async () => {
    for (const [reason, text] of [
      ['error', 'Failed: error'],
      ['max-tokens', 'Failed: token limit reached'],
      ['refusal', 'Failed: declined the task'],
      ['content-filter', 'Failed: content-filter'],
      ['constructor', 'Failed: constructor'],
      ['__proto__', 'Failed: __proto__'],
      ['toString', 'Failed: toString'],
    ] as const) {
      const h = harness()
      h.ledger.records = [record('c-fail', 'failed', { stopReason: reason, route: KIMI })]
      const menu = h.open()
      h.install()
      await flush()
      assert.equal(shown(rowOf(menu, 'Reviewer')).text, text, reason)
    }
  })

  it('spells the reasons out in the active language too', async () => {
    const h = harness()
    h.ledger.records = [record('c-fail', 'failed', { stopReason: 'refusal', route: KIMI })]
    const menu = h.open()
    h.install()
    await flush()
    h.locale.switchTo('pt')
    await flush()
    assert.equal(shown(rowOf(menu, 'Reviewer')).text, 'Falhou: recusou a tarefa')
  })
})

describe('subagent menu marks: a host that predates the ledger route', () => {
  it('asks once, remembers the 404, and shows what DSH itself knows: the model, a spinner for a live child, a neutral mark for a finished one', async () => {
    const h = harness()
    let fetches = 0
    const client = new SubagentsClient(() => { fetches += 1; return Promise.resolve(new Response('not found', { status: 404 })) }, () => 'http://dsh.test')
    const menu = h.open()
    h.install({ client })
    await flush()
    assert.equal(fetches, 1)
    for (let index = 0; index < 6; index += 1) {
      h.timers.fire(2_000)
      await flush()
    }
    assert.equal(fetches, 1, 'the poll no longer asks')
    assert.equal(client.missing, true)
    assert.equal(stateOf(rowOf(menu, 'Scout')), 'running')
    for (const label of ['Builder', 'Reviewer', 'Planner', 'Tester']) assert.equal(stateOf(rowOf(menu, label)), 'unknown', label)
    assert.equal(iconOf(rowOf(menu, 'Builder'))?.getAttribute('aria-label'), 'Outcome not recorded')
    assert.equal(shown(rowOf(menu, 'Tester')).model, 'DeepSeek V4.1 Flash · Medium', 'the route DSH saw the child use')
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-model').length, 1, 'no ledger, so no route for a child DSH has not seen request')
    assert.equal(h.warnings.length, 0, 'an old host is not a failure')
  })

  it('does not take any other failure for an old host: it keeps asking', async () => {
    const h = harness()
    let fetches = 0
    const client = new SubagentsClient(() => { fetches += 1; return Promise.resolve(new Response('', { status: 503 })) }, () => 'http://dsh.test')
    h.open()
    h.install({ client })
    await flush()
    h.timers.fire(2_000)
    await flush()
    h.timers.fire(2_000)
    await flush()
    assert.equal(fetches, 3)
    assert.equal(client.missing, false)
  })
})

describe('subagent menu marks: a ledger that never answers', () => {
  it('gives up on a request that never settles, aborts it, counts it as a failed answer and asks again on the next poll', async () => {
    const h = harness()
    const signals: AbortSignal[] = []
    const menu = h.open()
    h.install({ client: { list: (_id, signal) => { if (signal !== undefined) signals.push(signal); return new Promise(() => undefined) } } })
    await flush()
    assert.equal(signals.length, 1)
    assert.deepEqual(h.timers.periods(), [2_000, 8_000])
    for (let index = 0; index < 5; index += 1) {
      h.timers.fire(2_000)
      await flush()
    }
    assert.equal(signals.length, 1, 'a poll that finds the request pending asks nothing')
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 0, 'still waiting for the first answer')
    h.timers.fire(8_000)
    await flush()
    assert.equal(signals[0]?.aborted, true)
    assert.equal(h.warnings.length, 1)
    assert.match(h.warnings[0]?.message ?? '', /did not answer/)
    // The marks stop waiting: status from the catalog alone.
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
    assert.equal(stateOf(rowOf(menu, 'Scout')), 'running')
    // The root is not wedged: the next poll asks again.
    h.timers.fire(2_000)
    await flush()
    assert.equal(signals.length, 2)
    assert.equal(signals[1]?.aborted, false)
    assert.deepEqual(h.timers.periods(), [2_000, 8_000])
  })

  it('ignores the late answer of a request it gave up on, and uses the next one', async () => {
    const h = harness()
    const waiting: ((payload: SubagentsPayload) => void)[] = []
    const menu = h.open()
    h.install({ client: { list: () => new Promise<SubagentsPayload>((resolve) => { waiting.push(resolve) }) } })
    await flush()
    h.timers.fire(8_000)
    await flush()
    h.timers.fire(2_000)
    await flush()
    assert.equal(waiting.length, 2)
    waiting[0]?.({ sessionId: 'main', subagents: [record('c-done', 'failed', { stopReason: 'error' })], now: NOW })
    await flush()
    assert.equal(stateOf(rowOf(menu, 'Builder')), 'unknown', 'the first request was given up on: its answer is stale')
    waiting[1]?.({ sessionId: 'main', subagents: [record('c-done', 'done')], now: NOW })
    await flush()
    assert.equal(stateOf(rowOf(menu, 'Builder')), 'done')
    assert.deepEqual(h.timers.periods(), [2_000], 'the watchdog is gone once the request settled')
  })

  it('stops the watchdog with the controller', async () => {
    const h = harness()
    h.open()
    const stop = h.install({ client: { list: () => new Promise<SubagentsPayload>(() => undefined) } })
    await flush()
    assert.deepEqual(h.timers.periods(), [2_000, 8_000])
    stop()
    assert.equal(h.timers.count, 0)
  })

  it('does not wedge on the real client when the fetch ignores its signal and never answers', async () => {
    const h = harness()
    const calls: string[] = []
    const client = new SubagentsClient((input) => { calls.push(String(input)); return new Promise<Response>(() => undefined) }, () => 'http://dsh.test', 20)
    const menu = h.open()
    h.install({ client })
    await flush()
    await new Promise<void>(resolve => setTimeout(resolve, 80))
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8, 'the carrier\'s deadline settled the request')
    h.timers.fire(2_000)
    await new Promise<void>(resolve => setTimeout(resolve, 80))
    assert.equal(calls.length, 2, 'and the root was asked again')
  })
})

describe('subagent menu marks: one controller per document', () => {
  it('lets a newer controller retire the older one, so two never decorate and sweep the same rows against each other', async () => {
    const h = harness()
    const menu = h.open()
    const first = h.install()
    await flush()
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
    const second = h.install()
    // The older one is gone with its subscriptions, and the newer holds its own.
    assert.equal(h.store.listenerCount, 1)
    assert.equal(h.locale.listenerCount, 1)
    await flush()
    // ... and with its poll: only the newer controller's poll is left once its first ledger request settled.
    assert.equal(h.timers.count, 1)
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
    // A plugin reload calls the older disposer again: the newer controller is not touched.
    first()
    await flush()
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
    assert.equal(h.timers.count, 1)
    assert.equal(h.store.listenerCount, 1)
    h.timers.fire(2_000)
    await flush()
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
    second()
    assert.equal(ours(menu).length, 0)
    assert.equal(h.timers.count, 0)
    // And a fresh start after the last one was disposed works.
    h.install()
    await flush()
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
  })

  it('leaves two documents alone: each has its own controller', async () => {
    const one = harness()
    const two = harness()
    const menuOne = one.open()
    const menuTwo = two.open()
    one.install()
    two.install()
    await flush()
    assert.equal(menuOne.querySelectorAll('.dsh-orq-sub-icon').length, 8)
    assert.equal(menuTwo.querySelectorAll('.dsh-orq-sub-icon').length, 8)
  })

  it('does not leave a mark of its own on the document object that outlives it', async () => {
    const h = harness()
    const stop = h.install()
    stop()
    assert.deepEqual(Object.getOwnPropertySymbols(h.doc), [])
  })
})

describe('subagent menu marks: disposed from inside one of its own callbacks', () => {
  it('leaves nothing behind however deep in a scan the dispose happens', async () => {
    for (const where of ['getSnapshot', 'visible', 'bind', 'translate', 'titles'] as const) {
      const h = harness()
      const menu = h.open()
      let stop: () => void = () => undefined
      const realBind = (ns: string): ((key: string, params?: Record<string, unknown>) => string) => {
        const translate = h.locale.bind(ns)
        return ns === 'orquestrator' ? (key, params) => { translations += 1; return translate(key, params) } : translate
      }
      const base = { addLanguage: h.locale.addLanguage.bind(h.locale), register: h.locale.register.bind(h.locale), getSnapshot: h.locale.getSnapshot.bind(h.locale), subscribe: h.locale.subscribe.bind(h.locale) }
      let armed = false
      let disposedAt = -1
      let translations = 0
      const patch: { -readonly [K in keyof SubagentMarksDeps]?: SubagentMarksDeps[K] } = {}
      if (where === 'getSnapshot') {
        const real = h.store.list.getSnapshot
        h.store.list.getSnapshot = () => { if (armed) stop(); return real() }
      } else if (where === 'visible') {
        patch.visibleSessionIds = () => { if (armed) stop(); return ['main'] }
      } else if (where === 'bind') {
        patch.locale = { ...base, bind: (ns) => { if (armed && ns === 'orquestrator') stop(); return realBind(ns) } }
      } else if (where === 'translate') {
        patch.locale = { ...base, bind: (ns) => (ns === 'orquestrator' ? (key, params) => { if (armed) stop(); return realBind(ns)(key, params) } : realBind(ns)) }
      } else {
        h.store.state = { ...h.store.state, byId: { ...h.store.state.byId, 'c-run': { id: 'c-run', running: true, get title(): string { if (armed) stop(); return 'x' } } } }
      }
      const install = h.install
      stop = install.call(h, { locale: { ...base, bind: realBind }, ...patch })
      const disposer = stop
      stop = () => { disposedAt = translations; disposer() }
      await flush()
      armed = true
      h.timers.fire(2_000)
      await flush()
      await flush()
      if (where !== 'translate') assert.equal(translations, disposedAt, `${where}: no translation is asked for once the controller is retired`)
      assert.equal(ours(menu).length, 0, where)
      assert.equal(menu.querySelectorAll('[data-orq-row], [aria-describedby]').length, 0, where)
      assert.equal(h.timers.count, 0, where)
      assert.equal(h.store.listenerCount, 0, where)
      assert.equal(h.errors.length, 0, where)
      assert.equal(h.warnings.length, 0, where)
    }
  })
})

describe('subagent menu marks: the empty-tree fallback', () => {
  it('does not take a foreign tree without rows for the menu when the title cannot be looked up', async () => {
    const h = harness()
    h.locale.nativeTitle = 'key'
    h.install()
    h.doc.body.append(el(h.doc, 'div', { role: 'tree', 'aria-label': 'Some other plugin tree' }))
    await flush()
    assert.equal(h.timers.started, 0)
    assert.equal(h.store.listenerCount, 0)
    assert.equal(h.store.reads, 0)
    assert.equal(h.catalog.calls.length, 0)
  })

  it('still takes a tree whose rows all carry a status dot', async () => {
    const h = harness()
    h.locale.nativeTitle = 'throw'
    h.install()
    const menu = h.open()
    await flush()
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 8)
  })
})

describe('subagent menu marks: what it keeps and lets go of', () => {
  it('keeps at most 16 ledgers: the oldest root is forgotten, the newest remembered', async () => {
    const h = harness()
    h.install()
    const roots = Array.from({ length: 17 }, (_, index) => `root-${String(index)}`)
    const rowsOf = (root: string): Row[] => [{ id: `${root}-a`, label: `Alpha ${root}` }, { id: `${root}-b`, label: `Beta ${root}` }]
    for (const root of roots) {
      h.store.state = { byId: { [root]: { id: root, running: false } }, subagentsByParent: catalogsOf(root, rowsOf(root)) }
      h.visible = [root]
      h.ledger.records = [record(`${root}-a`, 'done'), record(`${root}-b`, 'failed', { stopReason: 'error' })]
      const menu = h.open(rowsOf(root))
      await flush()
      menu.remove()
      await flush()
    }
    // Reopen the first root while the ledger holds its answer back: it was forgotten, so nothing is drawn yet.
    h.ledger.mode = 'pending'
    h.catalog.mode = 'pending'
    h.store.state = { byId: { 'root-0': { id: 'root-0', running: false } }, subagentsByParent: catalogsOf('root-0', rowsOf('root-0')) }
    h.visible = ['root-0']
    const old = h.open(rowsOf('root-0'))
    await flush()
    assert.equal(old.querySelectorAll('.dsh-orq-sub-icon').length, 0)
    // The newest root is remembered: it paints at once from what it knew.
    h.store.set({ byId: { 'root-16': { id: 'root-16', running: false } }, subagentsByParent: catalogsOf('root-16', rowsOf('root-16')) })
    h.visible = ['root-16']
    const recent = h.open(rowsOf('root-16'))
    await flush()
    assert.equal(recent.querySelectorAll('.dsh-orq-sub-icon').length, 2)
    assert.equal(stateOf(rowOf(recent, 'Alpha root-16')), 'done')
  })

  it('lets go of what the ledger told it when disposed (the closure the disposer keeps does not hold the records)', async () => {
    v8.setFlagsFromString('--expose-gc')
    const collect = vm.runInNewContext('gc') as () => void
    const h = harness()
    let seen: WeakRef<SubagentRecord> | undefined
    h.open()
    const stop = h.install({
      client: {
        list: (sessionId) => {
          const fresh = record('c-done', 'done', { route: GEMINI })
          seen ??= new WeakRef(fresh)
          return Promise.resolve({ sessionId, subagents: [fresh], now: NOW })
        },
      },
    })
    await flush()
    assert.ok(seen?.deref(), 'the controller holds the record while it is running')
    stop()
    // `stop` is still referenced here, and so is everything it closes over, unless the controller let go.
    for (let attempt = 0; attempt < 20 && seen?.deref() !== undefined; attempt += 1) {
      await flush()
      collect()
    }
    assert.equal(seen?.deref(), undefined)
    assert.equal(typeof stop, 'function')
  })

  it('puts a row back as DSH drew it when the DOM refuses part of the mark', async () => {
    const h = harness()
    const menu = h.open()
    const row = rowOf(menu, 'Builder')
    const content = row.querySelector('.content')
    assert.ok(content)
    // The icon and the row attribute go in first; the model label is where it fails.
    content.append = (): void => { throw new Error('the DOM refused') }
    h.install()
    await flush()
    assert.equal(ours(row).length, 0)
    assert.equal(row.hasAttribute('data-orq-row'), false)
    assert.equal(row.hasAttribute('aria-describedby'), false)
    assert.equal(dotOf(row).previousElementSibling, null, 'DSH\'s dot is the first thing in the click area again')
    assert.equal(h.warnings.length, 1)
    assert.match(String((h.warnings[0]?.error as Error).message), /refused/)
    // The other rows are marked.
    assert.equal(menu.querySelectorAll('.dsh-orq-sub-icon').length, 7)
  })

  it('stops a poll that finds its menu gone without the body observer having reported it', async () => {
    const h = harness()
    blindToRemovals(h.dom.window)
    const menu = h.open()
    h.install()
    await flush()
    const calls = h.ledger.calls.length
    menu.remove()
    await flush()
    assert.equal(h.timers.count, 1, 'the report of the removal was lost')
    h.timers.fire(2_000)
    // The poll notices at once, before it reads the ledger or schedules anything.
    assert.equal(h.timers.count, 0)
    assert.equal(h.store.listenerCount, 0)
    assert.equal(h.ledger.calls.length, calls)
  })

  it('stops a scan that finds its menu gone without the body observer having reported it', async () => {
    const h = harness()
    blindToRemovals(h.dom.window)
    const menu = h.open()
    h.install()
    await flush()
    menu.remove()
    await flush()
    assert.equal(h.timers.count, 1)
    h.setActivity('c-stop', 'running')
    await flush()
    assert.equal(h.timers.count, 0)
    assert.equal(h.store.listenerCount, 0)
    assert.equal(h.locale.listenerCount, 0)
  })
})

describe('subagent menu marks: real React reconciliation', () => {
  /** An entry of the replica's catalogs. */
  interface ReplicaEntry { id: string; label: string; activity: 'running' | 'inactive'; hasChildren: boolean }
  /** Everything the replica renders from. */
  interface Replica {
    entries: ReplicaEntry[]
    nested: Record<string, ReplicaEntry[]>
    expanded: string[]
    titles: Record<string, string>
    tokens: Record<string, number>
    current: string | undefined
  }

  it('keeps one icon per row, in place, through every shape of re-render DSH produces, with nothing torn out and no React complaint', async () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { pretendToBeVisual: true })
    const doc = dom.window.document
    // React DOM looks for these globals when it loads; they are put back below.
    const names = ['window', 'document', 'HTMLElement', 'Node', 'Element', 'SVGElement', 'navigator'] as const
    const saved = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
    const replacements: Record<(typeof names)[number], unknown> = {
      window: dom.window, document: doc, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Element: dom.window.Element, SVGElement: dom.window.SVGElement, navigator: dom.window.navigator,
    }
    for (const name of names) Object.defineProperty(globalThis, name, { value: replacements[name], configurable: true, writable: true })
    const complaints: unknown[] = []
    const realError = console.error
    console.error = (...args: unknown[]): void => { complaints.push(args) }
    const h = harness()
    let stop: () => void = () => undefined
    let root: { render(node: unknown): void } | undefined
    try {
      const require = createRequire(import.meta.url)
      const React = require('react') as typeof import('react')
      const ReactDOM = require('react-dom') as typeof import('react-dom')
      const { createRoot } = require('react-dom/client') as typeof import('react-dom/client')
      const e = React.createElement as (type: unknown, props?: unknown, ...children: unknown[]) => import('react').ReactElement

      // DSH's StateDot, as its primitive renders it.
      const StateDot = ({ state }: { state: 'ongoing' | 'done' }): import('react').ReactElement => (
        state === 'ongoing'
          ? e('svg', { className: 'matrix', 'data-state': 'ongoing', width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': 'true' }, [0, 4, 8].map(x => e('rect', { key: x, x, y: 0, width: 2, height: 2 })))
          : e('span', { className: 'dot', 'data-state': state, style: { width: 10, height: 10 }, 'aria-hidden': 'true' })
      )

      // DSH's CatalogRows: same element tree, same conditionals, same keys.
      const Rows = ({ list, parent, state, level }: { list: Record<string, ReplicaEntry[]>; parent: string; state: Replica; level: number }): import('react').ReactElement | null => {
        const entries = list[parent]
        if (entries === undefined) return null
        const reserve = entries.some(entry => entry.hasChildren)
        return e(React.Fragment, null, entries.map((entry) => {
          const title = state.titles[entry.id]
          const tokens = state.tokens[entry.id] === undefined ? undefined : `${String(state.tokens[entry.id])} tok`
          const secondary = [title, 'continuable', entry.activity === 'running' ? 'running' : 'not running'].filter(part => part !== undefined).join(' · ')
          const metrics = [tokens, '2s'].filter(part => part !== undefined).join(' · ')
          const isCurrent = entry.id === state.current
          const isExpanded = state.expanded.includes(entry.id)
          const leaf = !entry.hasChildren
          return e('div', { key: entry.id, className: 'node' },
            e('div', {
              role: 'treeitem', tabIndex: 0, 'aria-level': level, 'aria-current': isCurrent || undefined,
              'aria-label': [entry.label, secondary, metrics].filter(part => part !== '').join(' '),
              ...leaf ? {} : { 'aria-expanded': isExpanded }, className: 'row',
            },
            leaf ? (reserve && e('span', { className: 'disclosureSpace' })) : e('button', { type: 'button', tabIndex: -1, className: 'disclosure' }, e('svg', { width: 14, height: 14 })),
            e('div', { className: 'clickarea' },
              e(StateDot, { state: entry.activity === 'running' ? 'ongoing' : 'done' }),
              e('span', { className: 'content' }, e('span', { className: 'label' }, entry.label), e('span', { className: 'summary' }, secondary)),
              metrics !== '' && e('span', { className: 'metrics' }, tokens !== undefined && e('span', { className: 'metricToken' }, tokens), e('span', { className: 'metricDuration' }, '2s')),
              !isCurrent && e('button', { type: 'button', className: 'sidebarButton' }, e('svg', { width: 14, height: 14 })),
            )),
            isExpanded && !leaf && e('div', { role: 'group', className: 'children' }, e(Rows, { list, parent: entry.id, state, level: level + 1 })),
          )
        }))
      }

      const listeners = new Set<() => void>()
      let state: Replica = {
        entries: [
          { id: 'a', label: 'Alpha', activity: 'running', hasChildren: false },
          { id: 'b', label: 'Beta', activity: 'inactive', hasChildren: true },
          { id: 'c', label: 'Gamma', activity: 'inactive', hasChildren: false },
        ],
        nested: { b: [{ id: 'b1', label: 'Beta one', activity: 'inactive', hasChildren: false }, { id: 'b2', label: 'Beta two', activity: 'running', hasChildren: false }] },
        expanded: [],
        titles: { a: 'Alpha task' },
        tokens: { c: 1200 },
        current: undefined,
      }
      const lists = (): Record<string, ReplicaEntry[]> => ({ main: state.entries, ...state.nested })
      const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
      const update = (next: Replica): void => {
        state = next
        ReactDOM.flushSync(() => { for (const listener of [...listeners]) listener() })
      }
      const change = (patch: Partial<Replica>): void => { update({ ...state, ...patch }) }
      const Menu = (): import('react').ReactElement => {
        const snapshot = React.useSyncExternalStore(subscribe, () => state)
        return ReactDOM.createPortal(
          e('div', { className: 'menu', role: 'tree', 'aria-label': 'Subagent sessions' }, e(Rows, { list: lists(), parent: 'main', state: snapshot, level: 1 })),
          doc.body,
        ) as unknown as import('react').ReactElement
      }

      h.ledger.records = [
        record('a', 'running', { startedAt: NOW - 1_000, route: GEMINI }), record('b', 'done', { route: KIMI }),
        record('c', 'failed', { stopReason: 'error', route: GEMINI }), record('b1', 'done'), record('b2', 'running', { startedAt: NOW - 1_000 }),
      ]
      // The session list the controller reads, derived from the replica's state.
      const snapshot = (): SessionListStateLike => ({
        byId: Object.fromEntries(Object.entries(state.titles).map(([id, title]) => [id, { id, running: false, title }])),
        subagentsByParent: Object.fromEntries(Object.entries(lists()).map(([parent, entries]) => [parent, { state: 'ready', entries: entries.map(entry => ({ kind: 'child', mode: 'continuable', ...entry })) }])) as SessionListStateLike['subagentsByParent'],
      })
      stop = h.install({
        document: doc,
        sessions: { binding: () => undefined, list: { getSnapshot: snapshot, subscribe } },
        warn: (message, error) => { h.warnings.push({ message, error }) },
      })
      root = createRoot(doc.getElementById('app') as HTMLElement)
      ReactDOM.flushSync(() => { root?.render(e(Menu)) })
      await flush()

      const menu = (): Element => {
        const found = doc.querySelector('[role="tree"]')
        assert.ok(found, 'the menu is open')
        return found
      }
      const rows = (): Element[] => [...menu().querySelectorAll('[role="treeitem"]')]
      const checkRows = (when: string): void => {
        for (const row of rows()) {
          assert.equal(row.querySelectorAll('.dsh-orq-sub-icon').length, 1, `${when}: one icon on ${row.getAttribute('aria-label') ?? ''}`)
          assert.ok(dotOf(row).previousElementSibling?.classList.contains('dsh-orq-sub-icon'), `${when}: the icon is right before the dot`)
          assert.ok(row.querySelectorAll('.dsh-orq-sub-model').length <= 1, `${when}: at most one model label`)
          assert.ok(row.hasAttribute('data-orq-row'), `${when}: marked`)
          const described = (row.getAttribute('aria-describedby') ?? '').split(' ').filter(id => id !== '')
          assert.ok(described.length >= 1 && described.every(id => row.querySelector(`[id="${id}"]`) !== null), `${when}: described by its own elements`)
        }
      }
      assert.equal(rows().length, 3)
      checkRows('first paint')

      // No icon may ever be torn out by the controller's own scan while the store changes.
      const tornOut: string[] = []
      const watcher = new dom.window.MutationObserver((records) => {
        for (const mutation of records) for (const node of mutation.removedNodes) if ((node as Element).classList?.contains('dsh-orq-sub-icon')) tornOut.push('icon removed')
      })
      watcher.observe(menu(), { childList: true, subtree: true })
      const iconOfA = iconOf(rows()[0] as Element)

      // The dot swaps between the animated svg and the span as the child starts and stops.
      for (let index = 0; index < 8; index += 1) {
        change({ entries: state.entries.map(entry => (entry.id === 'a' ? { ...entry, activity: index % 2 === 0 ? 'inactive' : 'running' } : entry)) })
        await flush()
        checkRows(`dot swap ${String(index)}`)
      }
      assert.equal(iconOf(rows()[0] as Element), iconOfA, 'the same icon node survived every swap')

      // Metrics appear and disappear after the text block.
      for (let index = 0; index < 4; index += 1) {
        change({ tokens: index % 2 === 0 ? { c: 1200, a: 99 } : { c: 1200 } })
        await flush()
        checkRows(`metrics ${String(index)}`)
      }

      // The row of the conversation the page shows loses its sidebar button and gains aria-current.
      for (const current of ['a', undefined, 'c']) {
        change({ current })
        await flush()
        checkRows(`current ${String(current)}`)
      }

      // A keyed insert at the top, a reversal (keyed moves), and a removal.
      change({ entries: [{ id: 'z', label: 'Zeta', activity: 'inactive', hasChildren: false }, ...state.entries] })
      await flush()
      checkRows('insert')
      assert.equal(rows().length, 4)
      change({ entries: [...state.entries].reverse() })
      await flush()
      checkRows('reverse')
      change({ entries: state.entries.filter(entry => entry.id !== 'a') })
      await flush()
      checkRows('remove')
      assert.equal(rows().length, 3)

      // A branch is expanded and collapsed.
      change({ expanded: ['b'] })
      await flush()
      assert.equal(rows().length, 5)
      checkRows('expand')
      assert.equal(stateOf(rowOf(menu(), 'Beta two')), 'running')
      change({ expanded: [] })
      await flush()
      assert.equal(rows().length, 3)
      checkRows('collapse')

      // A label is renamed: React rewrites the text and the aria-label of the row, and the mark follows.
      change({ entries: state.entries.map(entry => (entry.id === 'c' ? { ...entry, label: 'Renamed' } : entry)) })
      await flush()
      checkRows('rename')
      assert.equal(stateOf(rowOf(menu(), 'Renamed')), 'failed')
      h.timers.fire(2_000)
      await flush()
      checkRows('poll')

      assert.deepEqual(tornOut, [])
      watcher.disconnect()
      // Closing the menu takes the controller's timers and subscriptions with it.
      ReactDOM.flushSync(() => { root?.render(null) })
      await flush()
      assert.equal(doc.querySelector('[role="tree"]'), null)
      assert.equal(h.timers.count, 0)
      assert.deepEqual(complaints, [])
      assert.deepEqual(h.warnings, [])
      assert.deepEqual(h.errors, [])
    } finally {
      stop()
      console.error = realError
      for (const [name, descriptor] of saved) {
        if (descriptor === undefined) Reflect.deleteProperty(globalThis, name)
        else Object.defineProperty(globalThis, name, descriptor)
      }
    }
  })
})

describe('subagent menu marks: the stylesheet', () => {
  /** The stylesheet in a document of its own, with the rules parsed by jsdom. */
  function sheetRules(): CSSRule[] {
    const dom = new JSDOM(`<!doctype html><html><head><style>${CSS}</style></head><body></body></html>`)
    harnesses.push({ finish: () => { dom.window.close() } } as unknown as Harness)
    const sheet = dom.window.document.styleSheets[0]
    assert.ok(sheet)
    return [...sheet.cssRules]
  }

  it('hides the native dot of a marked row, and only that dot', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    await flush()
    const hide = sheetRules().find(rule => rule instanceof h.dom.window.CSSStyleRule === false && 'selectorText' in rule && String((rule as CSSStyleRule).selectorText).includes('data-orq-row')) as CSSStyleRule | undefined
    assert.ok(hide, 'a rule keyed on data-orq-row')
    assert.equal(hide.style.display, 'none')
    const selector = hide.selectorText
    const matching = [...menu.querySelectorAll('[data-state]')].filter(dot => dot.matches(selector))
    // Every marked row's dot is hidden (8 rows), no other element is: not the chevrons, not the placeholders' and the diagnostic's dots.
    assert.equal(matching.length, 8)
    for (const dot of matching) assert.ok(dot.previousElementSibling?.classList.contains('dsh-orq-sub-icon'))
    for (const item of menu.querySelectorAll('[aria-disabled="true"]')) assert.equal(item.querySelector('[data-state]')?.matches(selector), false)
    assert.equal(menu.querySelector('.disclosure')?.matches(selector), false)
  })

  it('does not hide a dot when our icon is missing, even if the row kept its attribute (fail-open)', async () => {
    const h = harness()
    const menu = h.open()
    h.install()
    await flush()
    const hide = sheetRules().find(rule => 'selectorText' in rule && String((rule as CSSStyleRule).selectorText).includes('data-orq-row')) as CSSStyleRule
    const row = rowOf(menu, 'Builder')
    assert.equal(dotOf(row).matches(hide.selectorText), true)
    iconOf(row)?.remove()
    assert.equal(dotOf(row).matches(hide.selectorText), false)
  })

  it('has the hooks the controller writes: the four states, the spin, the reduced-motion override and the label', () => {
    const rules = sheetRules()
    const selectors = rules.flatMap(rule => ('selectorText' in rule ? [String((rule as CSSStyleRule).selectorText)] : []))
    for (const state of ['running', 'done', 'failed', 'stopped']) assert.ok(selectors.includes(`.dsh-orq-sub-icon[data-orq-state='${state}']`), state)
    assert.ok(selectors.includes('.dsh-orq-sub-icon'))
    assert.ok(selectors.includes('.dsh-orq-sub-model'))
    assert.ok(selectors.includes('.dsh-orq-sub-tag'))
    assert.match(CSS, /\.dsh-orq-sub-icon\[data-orq-state='running'\] svg \{[^}]*animation: dsh-orq-spin/)
    assert.match(CSS, /@keyframes dsh-orq-spin/)
    assert.match(CSS, /@media \(prefers-reduced-motion: reduce\) \{ \.dsh-orq-sub-icon\[data-orq-state='running'\] svg \{ animation: none; \} \}/)
    assert.match(CSS, /\.dsh-orq-sub-tag \{[^}]*text-overflow: ellipsis/)
    // The tag is a block (an inline-flex box would clip without an ellipsis) and may shrink inside the narrow menu.
    assert.match(CSS, /\.dsh-orq-sub-tag \{[^}]*display: block/)
    assert.match(CSS, /\.dsh-orq-sub-tag \{[^}]*min-width: 0/)
    // Keeps to the DSH tokens: the marks bring no colors of their own.
    const marks = CSS.split('\n').filter(line => line.startsWith('.dsh-orq-sub-') || line.startsWith('[role=\'treeitem\'][data-orq-row]')).join('\n')
    assert.doesNotMatch(marks, /#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i)
  })
})
