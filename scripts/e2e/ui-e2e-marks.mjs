#!/usr/bin/env node
/**
 * Browser end-to-end checks of the marks on DSH's subagent dropdown (plugin 0.8.0) against a REAL DSH web server running
 * on an isolated DSH_HOME (never the operator's own). Companion of `ui-e2e.mjs` and `ui-e2e-skill.mjs`, same style: a
 * `check()` helper, one `<phase>.report.json`, screenshots.
 *
 *   DSH_URL=<authenticated dsh web URL> ORQ_SESSIONS_DIR=<sessions dir> [OUT_DIR=<dir>] [CHROME_PATH=<chrome>] \
 *     [STEPS=row,ledger,clock,notfound,errors,model,firstopen,workflow,native,cleanup,failopen,readme] PHASE=marks node ui-e2e-marks.mjs
 *   PHASE=marks scripts/e2e/with-server.sh node scripts/e2e/ui-e2e-marks.mjs    starts that isolated server (and DSH_URL) for you
 *
 * What the marks are: the dropdown in the task header (a `role="tree"` menu appended to `document.body`, "Subagent sessions")
 * lists a conversation's subagents. The plugin decorates each child row from outside: `span.dsh-orq-sub-icon[data-orq-state]` in
 * front of DSH's own status dot (the dot is hidden by CSS once the row carries the icon) and `span.dsh-orq-sub-model >
 * span.dsh-orq-sub-tag` ("<model>" or "<model> · <effort>") at the end of the row's text block. The data: the host ledger
 * `GET /dsh-orquestrator/subagents?sessionId=<root>` ({ sessionId, subagents: [...], now }), merged with DSH's own session store.
 *
 * PHASE:
 *   marks  (default) no model run: it opens the root sessions this home really holds with subagent children (`discoverSessions`
 *          reads the session logs: on a fresh home they are the live children an earlier phase created, on the Acer home they
 *          were OLD sessions whose children predate the ledger) and drives the ledger with `page.route`. `STEPS` picks the
 *          groups (default: all but `live`):
 *     row        M1  the narrowest session: one row per child, one icon `unknown` ("Outcome not recorded", the ledger mocked to
 *                    answer with no record), DSH's dot in the DOM but `display: none`, the row's own text unchanged, the model
 *                    tag against the child's real route in its log; dark and light screenshots
 *     ledger     M2  every state through a simulated ledger (running / done / failed with max-tokens, error, refusal, an unknown reason /
 *                    stopped): the icon, its tooltip, the animation, four distinct colors, an in-place update (same nodes, no
 *                    duplicates); a failing answer after a good one keeps what was known
 *     clock      M2  the 5 s window of a `running` record is measured on the HOST's clock (answers an hour ahead and an hour behind the
 *                    browser's), carried forward by the time elapsed in the page since the answer
 *     notfound   M2/M8 HTTP 404 from the route: remembered for the life of the page (no further request across 6 s open and three
 *                    reopenings); the rows still render (neutral mark, the model tag DSH knows)
 *     errors     M2  HTTP 500 (asked again at the next poll), a malformed body, a non-JSON body, a network abort: each leaves the rows
 *                    usable with the neutral mark (a fresh page each: a failed answer after a good one keeps the good one)
 *     model      M3  the model label: DSH's own `lastUsed` wins over the ledger's route; the ledger's route fills in for a child that has
 *                    none; display names from the composer's catalog; an unknown id shows raw; no route, no tag; a long id is cut by an
 *                    ellipsis inside the 336 px menu
 *     firstopen  M3  a reloaded page whose ledger answer is held for 3 s: DSH's own dots stay and the model label is drawn at once; the
 *                    status icons arrive with the answer (or at the 1.5 s mark, seen at the next poll); `aria-describedby` names two
 *                    ids of ours and the browser's accessibility tree gives the row the state text as its description
 *     workflow   M4  "Use the workflow tool exactly" (2 children) and a parent with 8: every row marked, order and labels kept,
 *                    count of icons = count of rows, no duplicates after 6 s, the mutation count of the open menu small and stable
 *     native     M5  the stock behavior is intact: a click on a row opens the child, the arrow button opens it in the sidebar, the arrow
 *                    keys, Home, End and Escape move focus as before, the row's `aria-label` is untouched; the switcher on the child's page
 *     cleanup    M6  closing the menu leaves nothing of ours in `document`; 15 quick open/close cycles: no leftovers, no console errors, a
 *                    bounded number of requests, none after the last close
 *     failopen   M7  every `/dsh-orquestrator/` request aborted: the menu opens, DSH's rows render and can be clicked, no page error
 *     readme     M11 README screenshots (1280x860, dark and light) with a running, a done and a failed row, each with its model tag
 *   live   M9  one short REAL run: a new session, DeepSeek V4.1 Flash as the subagent model, three background subagents that `sleep 20`;
 *          while they run the rows show the spinner and the model tag, afterwards the check; the ledger read back from the page is
 *          compared with the children in the session logs; a second page whose route answers 404 shows a spinner for a live child
 *   (every step) M10  no uncaught page errors and no failed `/dsh-orquestrator/` responses beyond the ones provoked on purpose
 *
 * Models: only the main agent of the isolated home (GLM 5.3) and, for the subagent picker, DeepSeek V4.1 Flash. The `marks` phase runs
 * no model at all. The session logs (`<ORQ_SESSIONS_DIR>/<workspace>/<session-id>/session.v3.jsonl.zstd`, read with `zstd -dc`) are the
 * evidence of the children's real routes, so `zstd` must be on PATH.
 *
 * Writes <OUT_DIR>/<phase>.report.json (checks, observations, the tooltips and colors seen) and screenshots `marks-*.png` and
 * `readme-subagent-list-{dark,light}.png`. The token in DSH_URL is a per-process credential: it is never written out (every message is
 * scrubbed).
 */
import { chromium } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const url = process.env.DSH_URL
const phase = process.env.PHASE ?? 'marks'
const out = resolve(process.env.OUT_DIR ?? join(repo, '.validation-tmp', 'out-marks'))
const DEFAULT_STEPS = {
  marks: 'row,ledger,clock,notfound,errors,model,firstopen,workflow,native,cleanup,failopen,readme',
  live: 'live',
}
if (!(phase in DEFAULT_STEPS)) {
  console.error(`unknown phase: ${phase} (marks | live)`)
  process.exit(2)
}
const steps = new Set((process.env.STEPS ?? DEFAULT_STEPS[phase]).split(',').map((item) => item.trim()).filter(Boolean))
const sessionsDir = process.env.ORQ_SESSIONS_DIR ?? (process.env.DSH_HOME === undefined ? undefined : join(process.env.DSH_HOME, 'sessions'))
if (url === undefined) throw new Error('DSH_URL is required')
if (sessionsDir === undefined) throw new Error('ORQ_SESSIONS_DIR (or DSH_HOME) is required: the checks read the DSH session logs')
mkdirSync(out, { recursive: true })

/** Strip anything that could carry the per-process token out of a message. */
const scrub = (value) => String(value)
  .split(url).join('<dsh-url>')
  .replace(/token=[A-Za-z0-9_-]+/g, 'token=<x>')
  .replace(/https?:\/\/127\.0\.0\.1:\d+/g, 'http://127.0.0.1:<port>')

// A crash must not print the URL (Playwright puts it in some messages).
for (const event of ['unhandledRejection', 'uncaughtException']) {
  process.on(event, (error) => {
    console.error(`${event}: ${scrub(error?.stack ?? error)}`)
    process.exit(1)
  })
}

const checks = []
const notes = []
const skipped = []
const text = (detail) => scrub(detail === undefined ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail))
const check = (name, ok, detail = '') => {
  const shown = text(detail)
  checks.push({ name, ok: Boolean(ok), detail: shown.slice(0, 900) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${shown === '' ? '' : `  [${shown.slice(0, 260)}]`}`)
}
/** A measurement that is reported, never counted as a failure (what the page shows, where there is nothing to compare it with). */
const note = (name, detail = '') => {
  const shown = text(detail)
  notes.push({ name, detail: shown.slice(0, 900) })
  console.log(`NOTE  ${name}${shown === '' ? '' : `  [${shown.slice(0, 260)}]`}`)
}
/** A check this environment cannot run (it needs something the DSH home does not have). */
const skip = (name, reason) => {
  skipped.push({ name, reason })
  console.log(`SKIP  ${name}  [${reason}]`)
}

const sleep = (ms) => new Promise((done) => { setTimeout(done, ms) })
/** Poll `fn` until it returns something truthy; `{ ok, value, ms }`. */
async function until(fn, { timeout = 7_000, every = 120 } = {}) {
  const started = Date.now()
  let value
  while (Date.now() - started < timeout) {
    value = await fn()
    if (value) return { ok: true, value, ms: Date.now() - started }
    await sleep(every)
  }
  return { ok: false, value, ms: Date.now() - started }
}

const chromePath = process.env.CHROME_PATH
const browser = await chromium.launch(chromePath === undefined ? { channel: 'chrome', headless: true } : { executablePath: chromePath, headless: true, args: ['--no-sandbox'] })

// ------------------------------------------------------------------------------------------------ constants
const TREE = 'body > [role="tree"]'
const TRIGGER = '[aria-haspopup="tree"]'
const LEDGER_PATH = '/dsh-orquestrator/subagents'
const LEDGER_GLOB = '**/dsh-orquestrator/subagents*'
const COMPOSER = /Describe what you want to build|Message or run a task/
const DIALOG = 'Orchestrate subagents'
const SKILL_LABEL = 'Apply the orchestration skill to this task'
const WORKER = { name: /DeepSeek V4\.1 Flash \(Azure\)/, id: 'DeepSeek-V4.1-Flash' }
const SEND = 'Send with these options'
const AZURE = { provider: 'azure-opencode', model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'medium' }
const GLM = { provider: 'openrouter', model: 'z-ai/glm-5.3', reasoningEffort: 'high' }
const TEXT = {
  unknown: 'Outcome not recorded', running: 'Running', done: 'Done', stopped: 'Stopped',
  maxTokens: 'Failed: token limit reached', error: 'Failed: error', refusal: 'Failed: declined the task', weird: 'Failed: weird',
}
/**
 * The sessions the steps open: the sidebar's rows by title and the number the header says. `discoverSessions()` points them
 * at the sessions this home really holds (see there); these values are the fallback titles and the shape each step needs.
 */
let ONE = { title: 'Use the subagent tool exactly', count: 1 }
let TWO_NO_ROUTE = { title: 'Use the subagent tool exactly', count: 2, noRoute: true }
let WORKFLOW = { title: 'Use the workflow tool exactly', count: 2 }
let WORKFLOW8 = { title: 'Use the workflow tool exactly', count: 8 }

// ------------------------------------------------------------------------------------------------ the DSH session logs
function logFile(sessionId) {
  if (sessionId === undefined) return undefined
  for (const directory of readdirSync(sessionsDir)) {
    const file = join(sessionsDir, directory, sessionId, 'session.v3.jsonl.zstd')
    if (existsSync(file)) return file
  }
  return undefined
}

/** Every event of a session log decoded so far (a log being written yields its complete lines). */
function readEventsAt(file) {
  let raw = ''
  try {
    raw = execFileSync('zstd', ['-dc', file], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8')
  } catch (error) {
    raw = error.stdout?.toString('utf8') ?? ''
  }
  return raw.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
}

/** Every event of a session log decoded so far, by session id. */
function readEvents(sessionId) {
  const file = logFile(sessionId)
  return file === undefined ? [] : readEventsAt(file)
}

const cache = new Map()
/**
 * The subagents of a session as its log tells them, in the order DSH lists them: id, label (null = DSH shows the id), title, the route
 * of the child's latest model request (`request/header`) and how its last turn ended.
 */
function familyOf(rootId) {
  const events = readEvents(rootId)
  const seen = new Set()
  const kids = []
  for (const event of events) {
    if (event.type !== 'subagent/catalog' || seen.has(event.data.childId)) continue
    seen.add(event.data.childId)
    kids.push({ id: event.data.childId, label: event.data.label ?? null, mode: event.data.mode ?? null })
  }
  for (const kid of kids) {
    const log = readEvents(kid.id)
    const config = log.filter((event) => event.type === 'request/header').at(-1)?.data?.header?.config
    kid.route = config === undefined ? null : { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort ?? null }
    kid.title = log.find((event) => event.type === 'session/title')?.data?.title ?? null
    kid.end = log.filter((event) => event.type === 'turn/end').at(-1)?.data?.reason?.kind ?? null
    kid.spawned = log.find((event) => event.type === 'session')?.createdAt ?? null
  }
  cache.set(rootId, kids)
  return kids
}
const routeText = (route) => (route === null ? 'none' : `${route.provider}/${route.model}${route.reasoningEffort ? ` (${route.reasoningEffort})` : ''}`)
const norm = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '')

/**
 * Every root session of this home that has subagent children, read from the logs, fewest children first:
 * `{ rootId, title, count, family, withRoute }`. The Acer home this script was written against held OLD sessions with
 * fixed titles; a fresh home holds whatever the earlier phases of this battery created (here: the live children), so the
 * specs are derived at run time instead of being written down.
 */
function inventory() {
  const found = []
  for (const workspace of readdirSync(sessionsDir)) {
    let entries = []
    try {
      entries = readdirSync(join(sessionsDir, workspace))
    } catch {
      continue
    }
    for (const id of entries) {
      if (!id.startsWith('session-')) continue
      const file = join(sessionsDir, workspace, id, 'session.v3.jsonl.zstd')
      if (!existsSync(file)) continue
      const events = readEventsAt(file)
      if (events[0]?.origin === 'subagent') continue
      // Every title the session ever carried, most recent first: DSH renames it (source `user`) and a generated title can
      // win the sidebar over it, so the row is looked up by whichever candidate the sidebar happens to show.
      const titles = [...new Set(events.filter((event) => event.type === 'session/title' && typeof event.data?.title === 'string').map((event) => event.data.title))].reverse()
      const family = familyOf(id)
      if (titles.length === 0 || family.length === 0) continue
      found.push({ rootId: id, title: titles[0], titles, count: family.length, family, withRoute: family.filter((kid) => kid.route !== null).length })
    }
  }
  return found.sort((left, right) => left.count - right.count)
}

/**
 * Point the specs at what the home holds: the narrowest root for the single-row checks (whatever its width), a two-child
 * root for the checks that move between two rows, a wider one for the many-children checks. A shape the home does not have
 * keeps the title written down below, so its step fails with a clear message or skips.
 */
function discoverSessions() {
  const found = inventory()
  const first = found[0]
  if (first !== undefined) ONE = { title: first.title, titles: first.titles, count: first.count }
  const pair = found.find((root) => root.count === 2)
  if (pair !== undefined) WORKFLOW = { title: pair.title, titles: pair.titles, count: pair.count }
  const noRoute = found.find((root) => root.count === 2 && root.withRoute < 2)
  if (noRoute !== undefined) TWO_NO_ROUTE = { title: noRoute.title, titles: noRoute.titles, count: noRoute.count, noRoute: true }
  const wide = found.find((root) => root.count >= 3)
  if (wide !== undefined) WORKFLOW8 = { title: wide.title, titles: wide.titles, count: wide.count }
  note('what this home holds (root sessions with subagent children, from the logs)', found.map((root) => ({ titles: root.titles.map((title) => title.slice(0, 40)), children: root.count, withRoute: root.withRoute })))
}

// ------------------------------------------------------------------------------------------------ pages and trackers
/** Everything one page reports: errors, failed responses, the plugin's own traffic (paths only, never the URL). */
const trackers = []
function track(label, page) {
  const tracker = { label, uncaught: [], consoleErrors: [], failed: [], ledger: [], configIds: [], expecting: false }
  page.on('pageerror', (error) => tracker.uncaught.push(scrub(error).slice(0, 300)))
  page.on('console', (message) => {
    if (message.type() === 'error') tracker.consoleErrors.push({ text: scrub(message.text()).slice(0, 200), expected: tracker.expecting })
  })
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname
    if (response.status() >= 400) tracker.failed.push({ status: response.status(), path, expected: tracker.expecting })
  })
  page.on('request', (request) => {
    const target = new URL(request.url())
    if (target.pathname === LEDGER_PATH) tracker.ledger.push({ at: Date.now(), sessionId: target.searchParams.get('sessionId') })
    if (target.pathname === '/dsh-orquestrator/config' && request.method() === 'GET') {
      const id = target.searchParams.get('sessionId')
      if (id !== null) tracker.configIds.push({ at: Date.now(), id })
    }
  })
  trackers.push(tracker)
  return tracker
}

/** A page of its own (own context): `{ label, context, page, t, ledger, scheme }`. */
async function newPage(label, { scheme = 'dark', viewport = { width: 1280, height: 860 }, scale = 1 } = {}) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: scale })
  const page = await context.newPage()
  return { label, scheme, context, page, t: track(label, page), ledger: undefined }
}

async function open(s) {
  await s.page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await s.page.getByRole('tree', { name: 'Sessions' }).waitFor({ state: 'visible', timeout: 30_000 })
  await sleep(1_000)
}

const shot = async (s, name, options = {}) => { await s.page.screenshot({ path: join(out, `marks-${name}.png`), ...options }) }

// ------------------------------------------------------------------------------------------------ the sidebar: finding an old session
async function expandSidebar(s) {
  const sidebar = s.page.getByRole('tree', { name: 'Sessions' })
  for (let index = 0; index < 20; index += 1) {
    const collapsed = sidebar.locator('[role=treeitem][aria-expanded=false]').first()
    if (await collapsed.count() === 0) break
    await collapsed.click()
    await sleep(200)
  }
  for (let index = 0; index < 20; index += 1) {
    const more = sidebar.getByRole('button', { name: /Show \d+ more sessions/ }).first()
    if (await more.count() === 0) break
    await more.click()
    await sleep(200)
  }
}

/** The number in the header's trigger label ("1 subagent", "2 subagents", "3 subagents running"), or undefined. */
async function triggerCount(s) {
  const label = await s.page.locator(TRIGGER).first().getAttribute('aria-label', { timeout: 1_500 }).catch(() => null)
  const match = /^(\d+) subagents?/.exec(label ?? '')
  return match === null ? undefined : Number(match[1])
}

/**
 * Open the old session of the sidebar whose title is `spec.title` and whose header counts `spec.count` subagents (the home holds many
 * sessions with the same title). `known` (an earlier result) goes straight to the same row. Returns `{ rootId, nth, family }`.
 */
async function openSession(s, spec, known) {
  await expandSidebar(s)
  const rowsFor = (title) => s.page.getByRole('tree', { name: 'Sessions' }).getByRole('treeitem').filter({ hasText: title })
  let rows = rowsFor(spec.title)
  // The sidebar may show another title the session carried (a generated one over a rename), and a long title may be cut
  // in the row: try every candidate, then its opening words.
  for (const title of (spec.titles ?? []).slice(1)) {
    if (await rows.count() > 0) break
    rows = rowsFor(title)
  }
  if (await rows.count() === 0 && spec.title.length > 30) rows = rowsFor(spec.title.slice(0, 30))
  const total = await rows.count()
  const order = known === undefined ? Array.from({ length: total }, (_, index) => index) : [known.nth]
  for (const nth of order) {
    const before = s.t.configIds.length
    await rows.nth(nth).click()
    await until(() => s.t.configIds.length > before, { timeout: 5_000, every: 100 })
    await sleep(700)
    const count = await triggerCount(s)
    if (count !== spec.count) continue
    const rootId = s.t.configIds.at(-1)?.id
    if (rootId === undefined) continue
    const family = familyOf(rootId)
    if (family.length !== spec.count && spec.count <= 2) continue
    if (spec.noRoute === true && family.some((kid) => kid.route !== null)) continue
    return { rootId, nth, family }
  }
  throw new Error(`no session titled "${spec.title}" with ${String(spec.count)} subagent(s) in the sidebar (${String(total)} rows with that title)`)
}

// ------------------------------------------------------------------------------------------------ the ledger, simulated with page.route
/** An epoch-ms record of the host ledger for `id`; `over` wins. */
const record = (rootId, id, over = {}, hostNow = Date.now()) => ({
  id, parentId: rootId, backend: 'spawn', route: AZURE, state: 'done', stopReason: 'completed', startedAt: hostNow - 9_000, endedAt: hostNow - 2_000, ...over,
})

/**
 * One record per child of a session, all in the same state. DSH's menu lists the children in an order of its own (the
 * live children of this home come out reversed against the session log's catalog), so a state driven for a single child
 * lands on a row the check is not looking at; recording every child makes the row under test show it whatever the order.
 */
const recordsFor = (session, over, hostNow) => session.family.map((kid) => record(session.rootId, kid.id, over, hostNow))

/** The behaviors the route can have. Each is `async (ctx) => answer`; `ctx` = { sessionId }. */
const L = {
  /** 200 with `build(hostNow)` as the records and the host's clock (`skew` ms away from this machine's) in `now`. */
  json: (build, { skew = 0, delay = 0, withNow = true } = {}) => async (ctx) => {
    const hostNow = Date.now() + skew
    const body = { sessionId: ctx.sessionId, subagents: build(hostNow, ctx.sessionId) }
    if (withNow) body.now = hostNow
    return { status: 200, body: JSON.stringify(body), contentType: 'application/json', delay }
  },
  status: (status, body = '{"error":"x"}') => async () => ({ status, body, contentType: 'application/json' }),
  plain: (body) => async () => ({ status: 200, body, contentType: 'text/plain' }),
  abort: () => async () => ({ abort: true }),
  pass: () => async () => ({ pass: true }),
}

/** Route every ledger request of the page through `s.ledger` (the behavior can be swapped at any time). */
async function routeLedger(s, initial = L.pass()) {
  s.ledger = initial
  await s.page.route(LEDGER_GLOB, async (route) => {
    const request = route.request()
    const sessionId = new URL(request.url()).searchParams.get('sessionId')
    let answer
    try {
      answer = await s.ledger({ sessionId })
    } catch (error) {
      answer = { abort: true, why: String(error) }
    }
    if (answer.pass === true) return route.continue()
    if (answer.abort === true) return route.abort('failed')
    if (answer.delay > 0) await sleep(answer.delay)
    return route.fulfill({ status: answer.status, contentType: answer.contentType, body: answer.body })
  })
}

// ------------------------------------------------------------------------------------------------ reading the menu
/** Runs in the page: everything the checks need to know about the open menu, as plain JSON. */
function inspectInPage() {
  const tree = document.querySelector('body > [role="tree"]')
  if (tree === null) return null
  const box = (element) => {
    if (element === null || element === undefined) return null
    const r = element.getBoundingClientRect()
    return { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10, right: Math.round(r.right * 10) / 10, bottom: Math.round(r.bottom * 10) / 10 }
  }
  const css = (element, property) => (element === null || element === undefined ? null : getComputedStyle(element)[property])
  const ours = (element) => /dsh-orq-sub-/.test(element.getAttribute('class') ?? '')
  const rows = Array.from(tree.querySelectorAll('[role="treeitem"]')).map((row) => {
    const icons = Array.from(row.querySelectorAll('.dsh-orq-sub-icon'))
    const hosts = Array.from(row.querySelectorAll('.dsh-orq-sub-model'))
    const tags = Array.from(row.querySelectorAll('.dsh-orq-sub-tag'))
    const dots = Array.from(row.querySelectorAll('[data-state]'))
    const dot = dots[0] ?? null
    const clickarea = dot === null ? null : dot.parentElement
    let content = dot === null ? null : dot.nextElementSibling
    while (content !== null && ours(content)) content = content.nextElementSibling
    const labelElement = content === null ? null : content.children[0] ?? null
    const summaryElement = content === null ? null : content.children[1] ?? null
    let after = content === null ? null : content.nextElementSibling
    const metrics = after !== null && after.tagName !== 'BUTTON' ? after : null
    const button = clickarea === null ? null : clickarea.querySelector('button')
    const icon = icons[0] ?? null
    const tag = tags[0] ?? null
    const svg = icon === null ? null : icon.querySelector('svg')
    const describedBy = (row.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
    return {
      ariaLabel: row.getAttribute('aria-label'),
      level: Number(row.getAttribute('aria-level')),
      current: row.getAttribute('aria-current'),
      expanded: row.getAttribute('aria-expanded'),
      hasExpander: row.querySelector('button[aria-label*="descendants"]') !== null,
      rowMarked: row.hasAttribute('data-orq-row'),
      describedBy,
      describedTargets: describedBy.map((id) => {
        const target = document.getElementById(id)
        return target === null ? null : { tag: target.tagName, cls: target.getAttribute('class'), ours: target.className.toString().includes('dsh-orq-sub-') }
      }),
      icons: icons.length,
      iconState: icon === null ? null : icon.getAttribute('data-orq-state'),
      iconTitle: icon === null ? null : icon.getAttribute('title'),
      iconAria: icon === null ? null : icon.getAttribute('aria-label'),
      iconRole: icon === null ? null : icon.getAttribute('role'),
      iconId: icon === null ? null : icon.id,
      iconColor: css(icon, 'color'),
      svgAnimation: css(svg, 'animationName'),
      svgMotion: css(svg, 'animationDuration'),
      iconBox: box(icon),
      dots: dots.length,
      dotDisplay: css(dot, 'display'),
      dotBox: box(dot),
      hosts: hosts.length,
      tags: tags.length,
      tagText: tag === null ? null : tag.textContent,
      tagTitle: tag === null ? null : tag.getAttribute('title'),
      tagId: tag === null ? null : tag.id,
      tagBox: box(tag),
      tagOverflow: tag === null ? null : { scrollWidth: tag.scrollWidth, clientWidth: tag.clientWidth, textOverflow: css(tag, 'textOverflow') },
      labelText: labelElement === null ? null : labelElement.textContent,
      labelChildren: labelElement === null ? null : labelElement.children.length,
      labelBox: box(labelElement),
      summaryText: summaryElement === null ? null : summaryElement.textContent,
      summaryChildren: summaryElement === null ? null : summaryElement.children.length,
      contentChildren: content === null ? null : content.children.length,
      metricsBox: box(metrics),
      buttonBox: box(button),
      rowBox: box(row),
      sameRow: window.__probe !== undefined && window.__probe.row === row,
      sameIcon: window.__probe !== undefined && icon !== null && window.__probe.icon === icon,
    }
  })
  return { label: tree.getAttribute('aria-label'), box: box(tree), rows, menus: document.querySelectorAll('body > [role="tree"]').length }
}

const snap = (s) => s.page.evaluate(inspectInPage)
/** Remember the first row and icon nodes, to tell later whether an update happened in place. */
const probe = (s) => s.page.evaluate(() => {
  const row = document.querySelector('body > [role="tree"] [role="treeitem"]')
  window.__probe = { row, icon: row === null ? null : row.querySelector('.dsh-orq-sub-icon') }
})

/** Everything of ours that is still in the document. */
const leftovers = (s) => s.page.evaluate(() => ({
  icons: document.querySelectorAll('.dsh-orq-sub-icon').length,
  hosts: document.querySelectorAll('.dsh-orq-sub-model').length,
  tags: document.querySelectorAll('.dsh-orq-sub-tag').length,
  rows: document.querySelectorAll('[data-orq-row]').length,
  describedBy: document.querySelectorAll('[aria-describedby*="dsh-orq-sub-"]').length,
  ids: document.querySelectorAll('[id^="dsh-orq-sub-"]').length,
  trees: document.querySelectorAll('body > [role="tree"]').length,
}))

const noLeftovers = (value) => Object.entries(value).every(([key, count]) => key === 'trees' || count === 0)

/** Pointer on the trigger: the menu opens after DSH's 150 ms hover delay. */
async function openMenu(s, { settle = true } = {}) {
  await s.page.mouse.move(8, 8)
  await sleep(150)
  await s.page.locator(TRIGGER).first().hover()
  await s.page.locator(TREE).waitFor({ state: 'attached', timeout: 6_000 })
  if (settle) await sleep(250)
}

/** Pointer away: the menu closes after DSH's 120 ms hover delay. */
async function closeMenu(s) {
  await s.page.mouse.move(8, 8)
  await s.page.locator(TREE).waitFor({ state: 'detached', timeout: 6_000 })
}

/** Wait until the open menu satisfies `predicate(menu)`; `{ ok, value, ms }` with the last snapshot. */
const waitMenu = (s, predicate, options) => until(async () => {
  const menu = await snap(s)
  return menu !== null && predicate(menu) ? menu : false
}, options).then(async (result) => (result.ok ? result : { ...result, value: await snap(s) }))

const allIcons = (state) => (menu) => menu.rows.length > 0 && menu.rows.every((row) => row.icons === 1 && row.iconState === state)
const noDuplicates = (menu) => menu.rows.every((row) => row.icons <= 1 && row.hosts <= 1 && row.tags <= 1 && row.hosts === row.tags)

/** The accessibility tree's `treeitem` nodes: name and computed description (what `aria-describedby` adds). */
async function accessibleItems(s) {
  const cdp = await s.context.newCDPSession(s.page)
  try {
    await cdp.send('Accessibility.enable')
    const { nodes } = await cdp.send('Accessibility.getFullAXTree')
    return nodes.filter((node) => node.role?.value === 'treeitem' && !node.ignored).map((node) => ({ name: node.name?.value ?? '', description: node.description?.value ?? '' }))
  } finally {
    await cdp.detach().catch(() => undefined)
  }
}

// ------------------------------------------------------------------------------------------------ structure of a step
async function section(name, task) {
  console.log(`\n--- ${name}`)
  try {
    await task()
  } catch (error) {
    check(`${name}: the step ran to its end without an exception`, false, scrub(error?.stack ?? error).split('\n').slice(0, 3).join(' | '))
  }
}

/** A short unique summary of what a row shows, for the notes. */
const brief = (row) => `${row.iconState ?? 'no-icon'}${row.tagText === null ? '' : ` | ${row.tagText}`}`

// ================================================================================================ M1: the row
let one // { rootId, nth, family } of the one-child session, once found

async function stepRow() {
  const dark = await newPage('M1-dark', { scheme: 'dark', scale: 2 })
  await open(dark)
  one = await openSession(dark, ONE)
  const kid = one.family[0]
  const width = one.family.length
  note('M1 the session and its child (from the log)', { rows: one.family.length, label: kid?.label, title: kid?.title, route: routeText(kid?.route ?? null), ended: kid?.end })
  // The row's marks are checked against a ledger that knows NOTHING about the child (the "old child" case): an answer with
  // no record is what leaves the neutral mark, whatever this home's children have in the real ledger.
  await routeLedger(dark, L.json(() => []))
  await openMenu(dark)
  const menu = (await waitMenu(dark, (m) => m.rows.length === width && m.rows.every((row) => row.icons === 1), { timeout: 8_000 })).value
  const row = menu.rows[0]
  check('M1 the menu is DSH\'s own: labelled "Subagent sessions", one menu on the body', menu.label === 'Subagent sessions' && menu.menus === 1, menu.label)
  check(`M1 the menu lists the session's ${String(width)} child row(s)`, menu.rows.length === width && width >= 1, menu.rows.length)
  check('M1 the row carries data-orq-row', row.rowMarked === true)
  check('M1 ONE .dsh-orq-sub-icon, data-orq-state="unknown" (no ledger record: the child predates the ledger)', row.icons === 1 && row.iconState === 'unknown', `${String(row.icons)} / ${row.iconState}`)
  check('M1 the icon\'s title and aria-label read "Outcome not recorded"', row.iconTitle === TEXT.unknown && row.iconAria === TEXT.unknown, `${row.iconTitle} / ${row.iconAria}`)
  check('M1 the icon is role="img"', row.iconRole === 'img', row.iconRole)
  check('M1 DSH\'s own dot is still in the DOM but not visible (computed display: none)', row.dots >= 1 && row.dotDisplay === 'none', `${String(row.dots)} dot(s), display ${row.dotDisplay}`)
  const label = kid?.label ?? kid?.id
  check('M1 the row\'s label is what DSH renders (the creation label) and is a plain text node', row.labelText === label && row.labelChildren === 0, `${row.labelText} (${String(row.labelChildren)} element children)`)
  check('M1 the summary line is untouched (no element added inside it) and the row\'s aria-label is "label summary metrics"', row.summaryChildren === 0 && row.ariaLabel.startsWith(`${row.labelText} ${row.summaryText}`), `${row.summaryText} || ${row.ariaLabel}`)
  check('M1 the row\'s aria-label has none of our text', !/Outcome|Running|Done|Failed|Stopped|DeepSeek|GLM/.test(row.ariaLabel), row.ariaLabel)
  check('M1 the text block holds exactly DSH\'s two lines and our model host', row.contentChildren === 2 + row.hosts, row.contentChildren)
  note('M1 the model tag the page shows', { tag: row.tagText, title: row.tagTitle })
  const real = kid?.route
  const shown = row.tagText ?? ''
  const matches = real !== null && real !== undefined && norm(shown).includes(norm(real.model)) && (real.reasoningEffort === null || norm(shown).endsWith(norm(real.reasoningEffort)))
  check('M1 the tag shows the child\'s real route (its request/header: DSH\'s own lastUsed), by display name and effort', matches, `${shown}  vs  ${routeText(real ?? null)}`)
  check('M1 the tag\'s tooltip reads "This subagent runs on ..."', /^This subagent runs on .+/.test(row.tagTitle ?? ''), row.tagTitle)
  check('M1 the tag is inside the 336 px menu (no overflow) and clear of the token and duration column', menu.box.w <= 336.5 && row.tagBox !== null && row.tagBox.right <= menu.box.right + 0.5 && (row.metricsBox === null || row.tagBox.right <= row.metricsBox.x + 0.5), JSON.stringify({ menu: menu.box.w, tag: row.tagBox, metrics: row.metricsBox }))
  const iconMid = row.iconBox.y + row.iconBox.h / 2
  const labelMid = row.labelBox.y + row.labelBox.h / 2
  check('M1 the icon sits on the label\'s first line (centres within 2 px)', Math.abs(iconMid - labelMid) <= 2, `${String(iconMid)} vs ${String(labelMid)}`)
  check('M1 the icon\'s box, with its margins, takes the room of DSH\'s dot (label starts at the same x as with the dot)', row.iconBox.x + row.iconBox.w <= row.labelBox.x, JSON.stringify({ icon: row.iconBox, label: row.labelBox }))
  check('M1 the icon colour resolves', Boolean(row.iconColor) && row.iconColor !== 'rgba(0, 0, 0, 0)', row.iconColor)
  await shot(dark, 'M1-dark')
  await dark.page.locator(TREE).screenshot({ path: join(out, 'marks-M1-dark-menu.png') })
  note('M1 colours (dark): unknown', row.iconColor)
  await dark.context.close()

  const light = await newPage('M1-light', { scheme: 'light', scale: 2 })
  await open(light)
  await openSession(light, ONE, one)
  await routeLedger(light, L.json(() => []))
  await openMenu(light)
  const lightMenu = (await waitMenu(light, (m) => m.rows.length === width && m.rows.every((row) => row.icons === 1), { timeout: 8_000 })).value
  check('M1 light theme: the same marks (one icon unknown, the tag, the dot hidden)', lightMenu.rows[0].icons === 1 && lightMenu.rows[0].iconState === 'unknown' && lightMenu.rows[0].tagText === row.tagText && lightMenu.rows[0].dotDisplay === 'none')
  check('M1 light theme: the icon colour resolves and differs from the dark one or the theme gave the same grey', Boolean(lightMenu.rows[0].iconColor), `${lightMenu.rows[0].iconColor} (dark ${row.iconColor})`)
  await shot(light, 'M1-light')
  await light.page.locator(TREE).screenshot({ path: join(out, 'marks-M1-light-menu.png') })
  await light.context.close()
}

// ================================================================================================ M2: every state through a simulated ledger
const STATES = [
  { name: 'running', record: (hostNow) => ({ state: 'running', stopReason: null, startedAt: hostNow - 1_000, endedAt: null }), state: 'running', text: TEXT.running },
  { name: 'done', record: (hostNow) => ({ state: 'done', stopReason: 'completed', startedAt: hostNow - 9_000, endedAt: hostNow - 2_000 }), state: 'done', text: TEXT.done },
  { name: 'failed / max-tokens', record: (hostNow) => ({ state: 'failed', stopReason: 'max-tokens', startedAt: hostNow - 9_000, endedAt: hostNow - 2_000 }), state: 'failed', text: TEXT.maxTokens },
  { name: 'failed / error', record: (hostNow) => ({ state: 'failed', stopReason: 'error', startedAt: hostNow - 9_000, endedAt: hostNow - 2_000 }), state: 'failed', text: TEXT.error },
  { name: 'failed / refusal', record: (hostNow) => ({ state: 'failed', stopReason: 'refusal', startedAt: hostNow - 9_000, endedAt: hostNow - 2_000 }), state: 'failed', text: TEXT.refusal },
  { name: 'failed / an unknown reason ("weird")', record: (hostNow) => ({ state: 'failed', stopReason: 'weird', startedAt: hostNow - 9_000, endedAt: hostNow - 2_000 }), state: 'failed', text: TEXT.weird },
  { name: 'failed / no reason', record: (hostNow) => ({ state: 'failed', stopReason: null, startedAt: hostNow - 9_000, endedAt: hostNow - 2_000 }), state: 'failed', text: 'Failed' },
  { name: 'stopped / aborted', record: (hostNow) => ({ state: 'stopped', stopReason: 'aborted', startedAt: hostNow - 9_000, endedAt: hostNow - 2_000 }), state: 'stopped', text: TEXT.stopped },
]

async function stepLedger() {
  const s = await newPage('M2-ledger', { scheme: 'dark', scale: 2 })
  await open(s)
  one ??= await openSession(s, ONE)
  one = { ...one, ...(await openSession(s, ONE, one)) }
  const kid = one.family[0]
  // A ledger that knows nothing first: the rows are drawn with the neutral mark, and THOSE nodes are what every state
  // below must update in place (the probe has to be taken before the first state, or the snapshot the check compares
  // against was taken before the probe existed).
  await routeLedger(s, L.json(() => []))
  await openMenu(s)
  await waitMenu(s, allIcons('unknown'), { timeout: 7_000 })
  await probe(s)
  const colors = {}
  const seen = []
  for (const item of STATES) {
    s.ledger = L.json((hostNow) => recordsFor(one, item.record(hostNow), hostNow))
    const result = await waitMenu(s, (m) => m.rows.length >= 1 && m.rows[0].iconState === item.state && m.rows[0].iconTitle === item.text, { timeout: 7_000 })
    const row = result.value?.rows[0]
    check(`M2 ${item.name}: data-orq-state="${item.state}", tooltip and aria-label "${item.text}" within 7 s of the answer`, result.ok && row.iconAria === item.text, `${row?.iconState} | ${row?.iconTitle} | ${row?.iconAria} (${String(result.ms)} ms)`)
    if (!result.ok) continue
    check(`M2 ${item.name}: ${item.state === 'running' ? 'the svg animates (animation-name is not none)' : 'no spin (animation-name is none)'}`, item.state === 'running' ? row.svgAnimation !== 'none' && row.svgAnimation !== '' : row.svgAnimation === 'none', `${row.svgAnimation} ${row.svgMotion}`)
    check(`M2 ${item.name}: still ONE icon and at most one model host and tag in the row (no duplicates)`, noDuplicates(result.value) && row.icons === 1 && row.hosts === 1, `${String(row.icons)} icon(s), ${String(row.hosts)} host(s), ${String(row.tags)} tag(s)`)
    check(`M2 ${item.name}: the update happened in place (same row node, same icon node)`, row.sameRow === true && row.sameIcon === true, `row ${String(row.sameRow)}, icon ${String(row.sameIcon)}`)
    check(`M2 ${item.name}: DSH's dot stays hidden`, row.dotDisplay === 'none', row.dotDisplay)
    const key = item.state
    if (colors[key] === undefined) colors[key] = row.iconColor
    seen.push({ case: item.name, state: row.iconState, text: row.iconTitle, color: row.iconColor, animation: row.svgAnimation })
    if (item.name === 'running') await shot(s, 'M2-running')
    if (item.name === 'failed / max-tokens') await shot(s, 'M2-failed')
  }
  note('M2 what each state showed', seen)
  const values = ['running', 'done', 'failed', 'stopped'].map((key) => colors[key])
  check('M2 the colours of running / done / failed / stopped resolve to four different non-empty computed colours', values.every(Boolean) && new Set(values).size === 4, JSON.stringify(colors))

  // A failed answer after a good one keeps what was known (the last good ledger stays, it is not wiped).
  const lastGood = STATES.at(-1)
  for (const [name, behavior] of [['HTTP 500', L.status(500)], ['a network abort', L.abort()], ['a body that is not JSON', L.plain('this is not json')], ['a malformed payload', L.plain('{"sessionId":7,"subagents":"x"}')]]) {
    s.t.expecting = true
    s.ledger = behavior
    await sleep(4_600)
    const menu = await snap(s)
    check(`M2 ${name} after a good answer: the rows keep the last known state and tooltip (the page is not wiped)`, menu !== null && menu.rows[0].iconState === lastGood.state && menu.rows[0].iconTitle === lastGood.text, menu === null ? 'menu gone' : `${menu.rows[0].iconState} | ${menu.rows[0].iconTitle}`)
  }
  s.t.expecting = false
  // The record disappears from an answer that is fine: no record means unknown (never an invented "done").
  s.ledger = L.json(() => [])
  const gone = await waitMenu(s, allIcons('unknown'), { timeout: 7_000 })
  check('M2 an answer without the child\'s record: back to "Outcome not recorded"', gone.ok && gone.value.rows[0].iconTitle === TEXT.unknown, gone.value?.rows[0]?.iconTitle)
  // Another child\'s record, and one whose id is nobody\'s, are ignored.
  s.ledger = L.json((hostNow) => [record(one.rootId, 'not-a-child-of-this-menu', { state: 'failed', stopReason: 'error' }, hostNow)])
  await sleep(2_600)
  const stranger = await snap(s)
  check('M2 a record for an id that is not in the menu changes nothing', stranger.rows[0].iconState === 'unknown')

  // Reduced motion: the spinner stops, the glyph stays.
  s.ledger = L.json((hostNow) => recordsFor(one, STATES[0].record(hostNow), hostNow))
  await waitMenu(s, allIcons('running'), { timeout: 7_000 })
  await s.page.emulateMedia({ reducedMotion: 'reduce' })
  await sleep(400)
  const reduced = (await snap(s)).rows[0]
  check('M2 prefers-reduced-motion: the running icon does not spin', reduced.iconState === 'running' && reduced.svgAnimation === 'none', reduced.svgAnimation)
  await s.page.emulateMedia({ reducedMotion: 'no-preference' })
  await s.context.close()
}

// ================================================================================================ M2: the host's clock
async function stepClock() {
  const s = await newPage('M2-clock', { scheme: 'dark' })
  await open(s)
  one ??= await openSession(s, ONE)
  one = { ...one, ...(await openSession(s, ONE, one)) }
  const kid = one.family[0]
  await routeLedger(s, L.json(() => []))
  await openMenu(s)
  await waitMenu(s, allIcons('unknown'), { timeout: 7_000 })
  const HOUR = 3_600_000
  for (const [name, skew] of [['an hour AHEAD of the browser clock', HOUR], ['an hour BEHIND the browser clock', -HOUR]]) {
    // Each answer is built fresh: the record is `age` old on the HOST's clock at the moment of the answer.
    const answer = (age) => L.json((hostNow) => recordsFor(one, { state: 'running', stopReason: null, startedAt: hostNow - age, endedAt: null }, hostNow), { skew })
    s.ledger = answer(60_000)
    const stale = await waitMenu(s, (m) => m.rows[0]?.iconState === 'unknown', { timeout: 7_000 })
    check(`M2 clock, host ${name}: a record "running" 60 s old (host clock), the catalog says not live: the neutral mark`, stale.ok && stale.value.rows[0].iconTitle === TEXT.unknown, `${stale.value?.rows[0]?.iconState} | ${stale.value?.rows[0]?.iconTitle}`)
    s.ledger = answer(1_000)
    const fresh = await waitMenu(s, (m) => m.rows[0]?.iconState === 'running', { timeout: 7_000 })
    check(`M2 clock, host ${name}: a record "running" 1 s old (host clock): "Running", whatever the browser clock says`, fresh.ok && fresh.value.rows[0].iconTitle === TEXT.running, `${fresh.value?.rows[0]?.iconState} | ${fresh.value?.rows[0]?.iconTitle}`)
    // One good answer, then the route fails: the host's `now` is carried forward by the page's own elapsed time, so the record ages out.
    let answered = 0
    let lastAnswerAt = 0
    s.ledger = async (ctx) => {
      if (answered === 0) {
        answered += 1
        lastAnswerAt = Date.now()
        return L.json((hostNow) => recordsFor(one, { state: 'running', stopReason: null, startedAt: hostNow - 1_000, endedAt: null }, hostNow), { skew })(ctx)
      }
      return L.status(500)(ctx)
    }
    s.t.expecting = true
    const up = await waitMenu(s, (m) => m.rows[0]?.iconState === 'running', { timeout: 6_000 })
    const aged = await waitMenu(s, (m) => m.rows[0]?.iconState === 'unknown', { timeout: 14_000, every: 200 })
    const elapsed = Date.now() - lastAnswerAt
    s.t.expecting = false
    check(`M2 clock, host ${name}: with one answer and no later one, "running" turns neutral when the record is 5 s old by the host's clock plus the time elapsed in the page (browser clock ignored)`, up.ok && aged.ok && elapsed >= 3_500 && elapsed <= 10_000, `running seen: ${String(up.ok)}; neutral after ${String(elapsed)} ms`)
  }
  await s.context.close()
}

// ================================================================================================ M2/M8: a host older than the feature (404)
async function stepNotFound() {
  const s = await newPage('M2-404', { scheme: 'dark' })
  s.t.expecting = true
  await routeLedger(s, L.status(404, '{"error":"not found"}'))
  await open(s)
  one ??= await openSession(s, ONE)
  one = { ...one, ...(await openSession(s, ONE, one)) }
  const before = s.t.ledger.length
  await openMenu(s)
  const first = await waitMenu(s, allIcons('unknown'), { timeout: 7_000 })
  check('M8 HTTP 404 from the route: the rows render at once with the neutral mark "Outcome not recorded"', first.ok && first.value.rows[0].iconTitle === TEXT.unknown, first.value?.rows[0] && brief(first.value.rows[0]))
  check('M8 ... and still show the model DSH knows for the child (its lastUsed)', first.ok && first.value.rows[0].tagText !== null, first.value?.rows[0]?.tagText)
  check('M8 ... DSH\'s dot is hidden and the row is marked', first.ok && first.value.rows[0].dotDisplay === 'none' && first.value.rows[0].rowMarked)
  await sleep(6_000)
  const afterWait = s.t.ledger.length - before
  check('M2 a 404 is remembered: after the first 404 the menu stays open 6 s and the page asks the route NO more times', afterWait === 1, `${String(afterWait)} request(s) in total (the first one included)`)
  for (let round = 1; round <= 3; round += 1) {
    await closeMenu(s)
    await openMenu(s)
    const again = await waitMenu(s, allIcons('unknown'), { timeout: 6_000 })
    check(`M2 reopening #${String(round)} after the 404: the rows are marked again (neutral) with no new request`, again.ok && s.t.ledger.length - before === 1, `${String(s.t.ledger.length - before)} request(s)`)
    await sleep(1_200)
  }
  note('M8 what the rows show against a host with no ledger route', first.value?.rows.map(brief))
  await shot(s, 'M8-404')
  // The route comes back (a host update) but the page was loaded before it: only a reload picks it up.
  s.ledger = L.json((hostNow) => recordsFor(one, { state: 'done' }, hostNow))
  s.t.expecting = false
  await sleep(4_500)
  const stuck = await snap(s)
  check('M2 a remembered 404 stays remembered even when the route works again (until the page reloads)', stuck.rows[0].iconState === 'unknown' && s.t.ledger.length - before === 1, `${stuck.rows[0].iconState}, ${String(s.t.ledger.length - before)} request(s)`)
  await s.page.reload({ waitUntil: 'networkidle' })
  await sleep(1_000)
  await openSession(s, ONE, one)
  await openMenu(s)
  const reloaded = await waitMenu(s, (m) => m.rows.length >= 1 && m.rows[0].iconState === 'done', { timeout: 8_000 })
  check('M2 after a reload the page asks again and shows the record', reloaded.ok, reloaded.value?.rows[0] && brief(reloaded.value.rows[0]))
  await s.context.close()
}

// ================================================================================================ M2: the other ways the answer can fail
async function stepErrors() {
  const modes = [
    ['HTTP 500', L.status(500), true],
    ['a malformed payload (JSON of the wrong shape)', L.plain('{"sessionId":7,"subagents":"x"}'), false],
    ['a body that is not JSON', L.plain('<html>nope</html>'), false],
    ['a network abort', L.abort(), true],
  ]
  for (const [name, behavior, asksAgain] of modes) {
    const s = await newPage(`M2-${name}`, { scheme: 'dark' })
    s.t.expecting = true
    await routeLedger(s, behavior)
    await open(s)
    one ??= await openSession(s, ONE)
    one = { ...one, ...(await openSession(s, ONE, one)) }
    const before = s.t.ledger.length
    await openMenu(s)
    const marked = await waitMenu(s, allIcons('unknown'), { timeout: 7_000 })
    check(`M2 ${name} from the first request: the rows are usable and carry the neutral mark "Outcome not recorded"`, marked.ok && marked.value.rows[0].iconTitle === TEXT.unknown && marked.value.rows[0].icons === 1, marked.value?.rows[0] && brief(marked.value.rows[0]))
    check(`M2 ${name}: the model tag DSH knows is there`, marked.ok && marked.value.rows[0].tagText !== null, marked.value?.rows[0]?.tagText)
    await sleep(5_000)
    const asked = s.t.ledger.length - before
    check(`M2 ${name} is ${asksAgain ? '' : 'a failed answer, not a missing route: '}NOT remembered: the page asks again at the next poll (a poll every 2 s)`, asked >= 3, `${String(asked)} request(s) in ~6 s`)
    // The route recovers: the very next poll shows the record.
    s.ledger = L.json((hostNow) => recordsFor(one, { state: 'failed', stopReason: 'error' }, hostNow))
    const recovered = await waitMenu(s, (m) => m.rows[0]?.iconState === 'failed', { timeout: 6_000 })
    check(`M2 ${name}: when the route answers again the next poll shows it ("Failed: error")`, recovered.ok && recovered.value.rows[0].iconTitle === TEXT.error, recovered.value?.rows[0] && brief(recovered.value.rows[0]))
    check(`M2 ${name}: no uncaught page error`, s.t.uncaught.length === 0, s.t.uncaught.join(' | '))
    await s.context.close()
  }
}

// ================================================================================================ M3: the model label
let twoNoRoute // the two-child session whose children never made a request (no `lastUsed`)

async function stepModel() {
  const a = await newPage('M3-lastUsed', { scheme: 'dark', scale: 2 })
  await open(a)
  one ??= await openSession(a, ONE)
  one = { ...one, ...(await openSession(a, ONE, one)) }
  const kid = one.family[0]
  await routeLedger(a, L.pass())
  await openMenu(a)
  const base = (await waitMenu(a, (m) => m.rows.length >= 1 && m.rows[0].icons === 1, { timeout: 8_000 })).value.rows[0]
  note('M3 an old child with a request of its own: what shows (DSH\'s lastUsed) and what its log says', { tag: base.tagText, real: routeText(kid.route) })
  const ledgerWith = (route) => L.json((hostNow) => recordsFor(one, { route, state: 'done' }, hostNow))
  a.ledger = ledgerWith(AZURE)
  await sleep(2_600)
  const same = (await snap(a)).rows[0]
  check('M3 a record with the same route as DSH\'s lastUsed: the tag is the same', same.iconState === 'done' && same.tagText === base.tagText, `${same.iconState} | ${same.tagText}`)
  a.ledger = ledgerWith(GLM)
  await sleep(2_600)
  const other = (await snap(a)).rows[0]
  check('M3 a record naming ANOTHER model (GLM 5.3): the row keeps showing DSH\'s lastUsed route, not the record\'s', other.iconState === 'done' && other.tagText === base.tagText && other.tags === 1, `${other.iconState} | ${other.tagText} (record said ${routeText(GLM)})`)
  a.ledger = ledgerWith(null)
  await sleep(2_600)
  const none = (await snap(a)).rows[0]
  check('M3 a record with no route: the tag is still DSH\'s', none.tagText === base.tagText, none.tagText)
  await shot(a, 'M3-lastUsed-wins')
  await a.context.close()

  // A parent whose children never made a request: DSH has no lastUsed for them.
  const b = await newPage('M3-ledger-route', { scheme: 'dark', scale: 2 })
  await open(b)
  twoNoRoute = await openSession(b, TWO_NO_ROUTE).catch(() => undefined)
  if (twoNoRoute === undefined) {
    skip('M3 a child with no lastUsed takes the ledger\'s route', 'no old session of the isolated home has a child without a request of its own')
    await b.context.close()
    return
  }
  const [k1, k2] = twoNoRoute.family
  note('M3 the two-child session without any request in its children (log)', twoNoRoute.family.map((k) => ({ label: k.label, route: routeText(k.route), ended: k.end })))
  await routeLedger(b, L.pass())
  await openMenu(b)
  const plain = (await waitMenu(b, (m) => m.rows.length === 2 && m.rows.every((r) => r.icons === 1), { timeout: 8_000 })).value
  check('M3 children with no lastUsed and no record: no model tag at all (and the neutral mark)', plain.rows.every((r) => r.tags === 0 && r.hosts === 0 && r.iconState === 'unknown'), JSON.stringify(plain.rows.map(brief)))
  const two = (route1, route2) => L.json((hostNow) => [
    ...(route1 === undefined ? [] : [record(twoNoRoute.rootId, k1.id, { route: route1, state: 'done' }, hostNow)]),
    ...(route2 === undefined ? [] : [record(twoNoRoute.rootId, k2.id, { route: route2, state: 'failed', stopReason: 'error' }, hostNow)]),
  ])
  b.ledger = two(AZURE, GLM)
  const routed = await waitMenu(b, (m) => m.rows.length === 2 && m.rows.every((r) => r.tagText !== null), { timeout: 7_000 })
  const names = routed.value?.rows.map((r) => r.tagText)
  check('M3 a child with NO lastUsed takes the record\'s route: "DeepSeek V4.1 Flash (Azure) · Medium" (display names from the composer\'s catalog)', routed.ok && names[0] === 'DeepSeek V4.1 Flash (Azure) · Medium', JSON.stringify(names))
  check('M3 ... a second child, another route: its own tag (GLM 5.3 · High), one tag per row', routed.ok && /GLM 5\.3/.test(names[1]) && /High$/.test(names[1]) && names[1] !== names[0], JSON.stringify(names))
  check('M3 identical labels, different records: the two rows follow their own child (done / failed) by position', routed.ok && routed.value.rows[0].iconState === 'done' && routed.value.rows[1].iconState === 'failed', JSON.stringify(routed.value?.rows.map((r) => r.iconState)))
  check('M3 the tag\'s tooltip is "This subagent runs on <model>, reasoning effort <Effort>"', routed.ok && routed.value.rows[0].tagTitle === 'This subagent runs on DeepSeek V4.1 Flash (Azure), reasoning effort Medium', routed.value?.rows[0]?.tagTitle)
  note('M3 the names the composer\'s catalog gave', names)
  await shot(b, 'M3-ledger-route')

  b.ledger = two({ provider: 'azure-opencode', model: 'Some-Unknown-Model-9', reasoningEffort: 'turbo' }, { provider: 'nowhere', model: 'lonely-model' })
  const raw = await waitMenu(b, (m) => m.rows.length === 2 && m.rows[0].tagText === 'Some-Unknown-Model-9 · turbo', { timeout: 7_000 })
  check('M3 a model the catalog does not know shows its raw id (and a raw effort id), a route without effort has none', raw.ok && raw.value.rows[1].tagText === 'lonely-model', JSON.stringify(raw.value?.rows.map((r) => r.tagText)))
  check('M3 ... its tooltip: "This subagent runs on <raw id>" (no effort part when there is none)', raw.ok && raw.value.rows[1].tagTitle === 'This subagent runs on lonely-model', raw.value?.rows[1]?.tagTitle)

  b.ledger = two(null, undefined)
  const none2 = await waitMenu(b, (m) => m.rows.length === 2 && m.rows[0].iconState === 'done', { timeout: 7_000 })
  check('M3 a record with no route (and a child with none of its own): no tag', none2.ok && none2.value.rows.every((r) => r.tags === 0 && r.hosts === 0), JSON.stringify(none2.value?.rows.map(brief)))

  const longId = 'some-provider/an-extremely-long-model-identifier-that-keeps-going-0123456789-abcdefghijklmnopqrstuvwxyz'
  b.ledger = two({ provider: 'p', model: longId, reasoningEffort: 'an-equally-long-effort-name' }, undefined)
  const long = await waitMenu(b, (m) => m.rows[0]?.tagText?.startsWith('some-provider/'), { timeout: 7_000 })
  const row = long.value?.rows[0]
  check('M3 a very long model id stays inside the 336 px menu, cut by an ellipsis, clear of the token column', long.ok && row.tagBox.right <= long.value.box.right + 0.5 && row.tagBox.x >= long.value.box.x && (row.metricsBox === null || row.tagBox.right <= row.metricsBox.x + 0.5) && row.tagOverflow.textOverflow === 'ellipsis' && row.tagOverflow.scrollWidth > row.tagOverflow.clientWidth, JSON.stringify({ tag: row?.tagBox, menu: long.value?.box, metrics: row?.metricsBox, overflow: row?.tagOverflow }))
  await shot(b, 'M3-long-id')
  await b.context.close()
}

// ================================================================================================ M3: the first open
async function stepFirstOpen() {
  const s = await newPage('M3-firstopen', { scheme: 'dark', scale: 2 })
  await open(s)
  one ??= await openSession(s, ONE)
  const kid = one.family[0]
  // A page reload so that nothing is cached (the model names, the ledger of an earlier open): the answer is held for 3 s.
  s.ledger = undefined
  await s.page.reload({ waitUntil: 'networkidle' })
  await sleep(800)
  await routeLedger(s, L.json((hostNow) => recordsFor(one, { state: 'failed', stopReason: 'refusal' }, hostNow), { delay: 3_000 }))
  await openSession(s, ONE, one)
  const t0 = Date.now()
  await openMenu(s, { settle: false })
  const early = (await waitMenu(s, (m) => m.rows.length >= 1 && m.rows[0].tags === 1, { timeout: 2_500, every: 60 }))
  const at = Date.now() - t0
  const row = early.value?.rows[0]
  check('M3 FIRST OPEN, answer held: the model label is drawn at once (before any ledger answer)', early.ok && row.tags === 1, `${String(at)} ms after the hover; tag ${row?.tagText}`)
  check('M3 FIRST OPEN, answer held: DSH\'s own status dot is still visible and no icon is drawn yet', early.ok && row.icons === 0 && row.dots === 1 && row.dotDisplay !== 'none' && row.dotBox.w > 0 && !row.rowMarked, `icons ${String(row?.icons)}, dot display ${row?.dotDisplay}, dot ${JSON.stringify(row?.dotBox)}, marked ${String(row?.rowMarked)}`)
  const labelX = row?.labelBox?.x
  await shot(s, 'M3-firstopen-held')
  const grace = await waitMenu(s, (m) => m.rows[0]?.icons === 1, { timeout: 5_000, every: 80 })
  const iconAfter = Date.now() - t0
  check('M3 FIRST OPEN: the status icon arrives with the answer or at the 1.5 s mark seen at the next poll (not before ~1.5 s, not after the answer)', grace.ok && iconAfter >= 1_400 && iconAfter <= 4_300, `${String(iconAfter)} ms after the hover`)
  const settled = await waitMenu(s, (m) => m.rows[0]?.iconState === 'failed', { timeout: 6_000 })
  check('M3 after the held answer arrives: "Failed: declined the task"', settled.ok && settled.value.rows[0].iconTitle === TEXT.refusal, settled.value?.rows[0] && brief(settled.value.rows[0]))
  check('M3 the label did not move when the icon replaced the dot (same x for the row\'s first line)', settled.ok && Math.abs(settled.value.rows[0].labelBox.x - labelX) <= 0.6, `${String(labelX)} -> ${String(settled.value?.rows[0]?.labelBox?.x)}`)
  // aria-describedby and the accessible description
  const done = settled.value?.rows[0]
  check('M3 aria-describedby names two ids, both in the document: our icon and our model label', done !== undefined && done.describedBy.length === 2 && done.describedTargets.every((target) => target !== null && target.ours) && done.describedBy[0] === done.iconId && done.describedBy[1] === done.tagId, JSON.stringify({ ids: done?.describedBy, icon: done?.iconId, tag: done?.tagId, targets: done?.describedTargets }))
  const items = await accessibleItems(s)
  const item = items.find((entry) => entry.name === done?.ariaLabel)
  check('M3 the browser\'s accessibility tree gives the row a description that contains the state text and the model', item !== undefined && item.description.includes(TEXT.refusal) && item.description.includes('DeepSeek'), JSON.stringify(item ?? items.map((entry) => entry.name.slice(0, 30))))
  note('M3 the row\'s accessible name and description', item)
  await s.context.close()
}

// ================================================================================================ M4: the workflow sessions
async function stepWorkflow() {
  const s = await newPage('M4-workflow', { scheme: 'dark', scale: 2 })
  await open(s)
  const wf = await openSession(s, WORKFLOW)
  note('M4 the workflow session (log)', wf.family.map((k) => ({ label: k.label, id: k.id.slice(0, 8), route: routeText(k.route) })))
  // The marks of the rows are what this step is about, so the ledger is mocked to know nothing (the "old child" case).
  await routeLedger(s, L.json(() => []))
  await openMenu(s)
  const menu = (await waitMenu(s, (m) => m.rows.length === wf.family.length && m.rows.every((r) => r.icons === 1), { timeout: 8_000 })).value
  check(`M4 every child row of the session is marked (rows = icons = ${String(wf.family.length)})`, menu.rows.length === wf.family.length && menu.rows.every((r) => r.icons === 1 && r.rowMarked && r.iconState === 'unknown'), JSON.stringify(menu.rows.map(brief)))
  check('M4 the rows keep DSH\'s order and labels (the log\'s catalog order and labels)', menu.rows.every((r, index) => r.labelText === (wf.family[index].label ?? wf.family[index].id)), JSON.stringify({ shown: menu.rows.map((r) => r.labelText), log: wf.family.map((k) => k.label ?? k.id) }))
  check('M4 every row has its model tag and one host', menu.rows.every((r) => r.tags === 1 && r.hosts === 1), JSON.stringify(menu.rows.map((r) => r.tagText)))
  const nested = menu.rows.filter((r) => r.hasExpander || r.expanded !== null)
  if (nested.length === 0) skip('M4 expanding a branch row marks its nested rows', 'no child of any old session of the home has children of its own, so the menu has no branch row')
  else note('M4 branch rows', nested.length)
  // The mutation count of the open menu: ours must not retrigger themselves.
  const windows = []
  for (let round = 0; round < 2; round += 1) {
    await s.page.evaluate(() => {
      const tree = document.querySelector('body > [role="tree"]')
      window.__mutations = { count: 0, kinds: {} }
      window.__observer = new MutationObserver((records) => {
        for (const record of records) {
          window.__mutations.count += 1
          const kind = `${record.type}:${record.target.nodeName}${record.attributeName === null ? '' : `@${record.attributeName}`}`
          window.__mutations.kinds[kind] = (window.__mutations.kinds[kind] ?? 0) + 1
        }
      })
      window.__observer.observe(tree, { subtree: true, childList: true, attributes: true, characterData: true })
    })
    await sleep(5_000)
    windows.push(await s.page.evaluate(() => { window.__observer.disconnect(); return window.__mutations }))
  }
  note('M4 DOM mutations on the open menu, two windows of 5 s (the poll runs every 2 s)', JSON.stringify(windows))
  check('M4 the mutation count of the open menu is small and does not grow (our own insertions do not retrigger themselves)', windows[0].count <= 10 && windows[1].count <= windows[0].count + 2, JSON.stringify(windows.map((w) => w.count)))
  const later = await snap(s)
  check('M4 after 12 s still no duplicates: one icon and at most one model host per row, count of icons = count of rows', noDuplicates(later) && later.rows.length === wf.family.length && later.rows.filter((r) => r.icons === 1).length === wf.family.length, JSON.stringify(later.rows.map((r) => [r.icons, r.hosts])))
  await shot(s, 'M4-workflow')
  await s.context.close()

  // Eight children (rows labelled by their ids).
  const big = await newPage('M4-eight', { scheme: 'dark', scale: 2, viewport: { width: 1280, height: 1000 } })
  await open(big)
  const eight = await openSession(big, WORKFLOW8).catch(() => undefined)
  if (eight === undefined) {
    skip('M4 a parent with many children', 'no old session with 8 workflow children was found in the sidebar')
    await big.context.close()
    return
  }
  await routeLedger(big, L.pass())
  await openMenu(big)
  const many = (await waitMenu(big, (m) => m.rows.length >= 3 && m.rows.every((r) => r.icons === 1), { timeout: 9_000 })).value
  check('M4 a parent with many children (labelled by their ids): every row is marked and has exactly one icon', many.rows.length >= 3 && many.rows.every((r) => r.icons === 1 && r.hosts <= 1) && noDuplicates(many), `${String(many.rows.length)} rows: ${JSON.stringify(many.rows.map(brief))}`)
  check('M4 ... the rows keep the catalog\'s order and labels (the child ids)', many.rows.every((r, index) => r.labelText === (eight.family[index].label ?? eight.family[index].id)), JSON.stringify(many.rows.map((r) => r.labelText?.slice(0, 8))))
  await shot(big, 'M4-eight')
  await big.context.close()
}

// ================================================================================================ M5: DSH's own behavior is intact
const focusIndex = (s) => s.page.evaluate(() => {
  const items = Array.from(document.querySelectorAll('body > [role="tree"] [role="treeitem"]:not([aria-disabled="true"])'))
  const active = document.activeElement
  return { index: items.indexOf(active), count: items.length, onTrigger: active?.matches('[aria-haspopup="tree"]') ?? false, tag: active?.tagName }
})

async function stepNative() {
  // Two rows to move between: the session with exactly two children.
  const s = await newPage('M5-native', { scheme: 'dark' })
  await open(s)
  const wf = await openSession(s, WORKFLOW)
  if (wf.family.length !== 2) {
    skip('M5 DSH\'s own row behavior is intact', `the keyboard checks move between exactly two rows and this home's session has ${String(wf.family.length)}`)
    await s.context.close()
    return
  }
  await routeLedger(s, L.pass())
  await openMenu(s)
  const menu = (await waitMenu(s, (m) => m.rows.length === wf.family.length && m.rows.every((r) => r.icons === 1), { timeout: 8_000 })).value
  const labels = menu.rows.map((r) => r.ariaLabel)
  await s.page.mouse.move(8, 8)
  await closeMenu(s)
  // Keyboard: ArrowDown on the focused trigger opens the menu and focuses the first row.
  await s.page.locator(TRIGGER).first().focus()
  await s.page.keyboard.press('ArrowDown')
  await s.page.locator(TREE).waitFor({ state: 'attached', timeout: 5_000 })
  await until(async () => (await focusIndex(s)).index >= 0, { timeout: 3_000, every: 80 })
  let f = await focusIndex(s)
  check('M5 keyboard: ArrowDown on the trigger opens the menu and focuses the first row', f.index === 0 && f.count === wf.family.length, JSON.stringify(f))
  await waitMenu(s, (m) => m.rows.every((r) => r.icons === 1), { timeout: 6_000 })
  f = await focusIndex(s)
  check('M5 keyboard: our marks did not take the focus from the row', f.index === 0, JSON.stringify(f))
  const moves = []
  for (const [key, expected] of [['ArrowDown', 1], ['ArrowDown', 0], ['ArrowUp', 1], ['Home', 0], ['End', 1], ['ArrowUp', 0], ['ArrowUp', 1]]) {
    await s.page.keyboard.press(key)
    await sleep(120)
    f = await focusIndex(s)
    moves.push(`${key}->${String(f.index)}`)
    if (f.index !== expected) check(`M5 keyboard: ${key} moves focus to row ${String(expected)}`, false, `got ${String(f.index)}`)
  }
  check('M5 keyboard: ArrowDown/ArrowUp (wrapping), Home and End move the focus between the rows as in stock DSH', !moves.some((_, index) => false) && checks.filter((c) => !c.ok && c.name.startsWith('M5 keyboard: Arrow') || !c.ok && c.name.startsWith('M5 keyboard: Home') || !c.ok && c.name.startsWith('M5 keyboard: End')).length === 0, moves.join(' '))
  await s.page.keyboard.press('Escape')
  await s.page.locator(TREE).waitFor({ state: 'detached', timeout: 4_000 }).catch(() => undefined)
  await sleep(250)
  f = await focusIndex(s)
  check('M5 keyboard: Escape closes the menu and returns focus to the trigger', (await s.page.locator(TREE).count()) === 0 && f.onTrigger, JSON.stringify(f))
  const gone = await leftovers(s)
  check('M5 after Escape nothing of ours remains in the document', noLeftovers(gone), JSON.stringify(gone))

  // The row's aria-label is the one DSH built, before and after our marks.
  await openMenu(s)
  const again = (await waitMenu(s, (m) => m.rows.length === wf.family.length && m.rows.every((r) => r.icons === 1), { timeout: 6_000 })).value
  check('M5 the rows\' aria-labels are unchanged between two openings (marks drawn or not)', JSON.stringify(again.rows.map((r) => r.ariaLabel)) === JSON.stringify(labels), JSON.stringify(labels))

  // A click on a row opens that child's conversation.
  const headerBefore = await s.page.title()
  const target = again.rows[1]
  await s.page.locator(`${TREE} [role="treeitem"]`).nth(1).click()
  await until(async () => (await s.page.locator(TREE).count()) === 0, { timeout: 4_000 })
  await sleep(1_500)
  const switcher = await s.page.locator(TRIGGER).first().getAttribute('aria-label').catch(() => null)
  const label = wf.family[1].label ?? wf.family[1].id
  check('M5 clicking a row opens that child\'s conversation (the page title and the header\'s switcher change) and closes the menu', (await s.page.locator(TREE).count()) === 0 && switcher === `Switch subagent: ${label}` && (await s.page.title()) !== headerBefore, `${switcher} | title ${(await s.page.title()).slice(0, 40)}`)
  note('M5 the child page', { title: await s.page.title(), switcher })

  // The switcher on the child's page is the same menu: marked too?
  await openMenu(s)
  const switched = await waitMenu(s, (m) => m.rows.length >= 1, { timeout: 5_000 })
  await sleep(2_600)
  const sw = await snap(s)
  check('M5 the switcher menu on the child\'s page (the same DSH component) is marked too: every row has its icon', sw !== null && sw.rows.length === wf.family.length && sw.rows.every((r) => r.icons === 1), JSON.stringify(sw?.rows.map(brief)))
  check('M5 ... the row of the page\'s own conversation keeps aria-current and its text', sw !== null && sw.rows.filter((r) => r.current === 'true').length === 1 && sw.rows[1].current === 'true' && sw.rows[1].labelText === target.labelText, JSON.stringify(sw?.rows.map((r) => r.current)))
  await shot(s, 'M5-switcher')
  await s.page.mouse.move(8, 8)
  await closeMenu(s)

  // Back to the parent; the arrow button opens the child in the sidebar.
  await openSession(s, WORKFLOW, wf)
  await openMenu(s)
  await waitMenu(s, (m) => m.rows.length === wf.family.length && m.rows.every((r) => r.icons === 1), { timeout: 6_000 })
  const arrow = s.page.locator(`${TREE} button[aria-label$="in sidebar"]`).first()
  const arrowLabel = await arrow.getAttribute('aria-label')
  check('M5 the trailing arrow button of the row is there and unchanged ("Open <label> in sidebar")', arrowLabel === `Open ${wf.family[0].label ?? wf.family[0].id} in sidebar`, arrowLabel)
  const composerBefore = await s.page.locator('[data-composer-input]').count()
  await arrow.click()
  await sleep(1_800)
  // The children of this home are continuable, so the pane the arrow opens carries a composer of its own (a one-shot
  // child shows its read-only record instead: the native behavior is the pane, whatever it holds).
  const composerAfter = await s.page.locator('[data-composer-input]').count()
  note('M5 the child pane the arrow opened', { composers: `${String(composerBefore)} -> ${String(composerAfter)}`, tail: (await s.page.locator('body').innerText()).replace(/\s+/g, ' ').slice(-140) })
  check('M5 the arrow button still opens the child in the right sidebar (the child\'s pane appears) and closes the menu', composerAfter > composerBefore && (await s.page.locator(TREE).count()) === 0, `${String(composerBefore)} -> ${String(composerAfter)} composer(s)`)
  await shot(s, 'M5-sidebar')
  await s.context.close()
}

// ================================================================================================ M6: cleanup
async function stepCleanup() {
  const s = await newPage('M6-cleanup', { scheme: 'dark' })
  await open(s)
  const wf = await openSession(s, WORKFLOW)
  const width = wf.family.length
  await routeLedger(s, L.pass())
  await openMenu(s)
  await waitMenu(s, (m) => m.rows.length === width && m.rows.every((r) => r.icons === 1), { timeout: 8_000 })
  const open1 = await leftovers(s)
  check('M6 (sanity) while the menu is open the marks are in the document', open1.icons === width && open1.hosts === width && open1.rows === width && open1.describedBy === width, JSON.stringify(open1))
  await closeMenu(s)
  await sleep(300)
  const closed = await leftovers(s)
  check('M6 closing the menu (pointer away): no .dsh-orq-sub-icon, .dsh-orq-sub-model, [data-orq-row] or aria-describedby of ours anywhere in the document', noLeftovers(closed) && closed.trees === 0, JSON.stringify(closed))
  // Escape too.
  await openMenu(s)
  await waitMenu(s, (m) => m.rows.every((r) => r.icons === 1), { timeout: 6_000 })
  await s.page.locator(TRIGGER).first().focus()
  await s.page.keyboard.press('Escape')
  await sleep(500)
  check('M6 closing with Escape: nothing of ours remains either', noLeftovers(await leftovers(s)), JSON.stringify(await leftovers(s)))
  // 15 quick open / close cycles.
  await s.page.mouse.move(8, 8)
  await sleep(300)
  const before = s.t.ledger.length
  const errorsBefore = s.t.consoleErrors.length
  const started = Date.now()
  for (let cycle = 0; cycle < 15; cycle += 1) {
    await s.page.locator(TRIGGER).first().hover()
    await s.page.locator(TREE).waitFor({ state: 'attached', timeout: 5_000 })
    await sleep(60)
    await s.page.mouse.move(8, 8)
    await s.page.locator(TREE).waitFor({ state: 'detached', timeout: 5_000 })
  }
  const spent = Date.now() - started
  await sleep(400)
  const after = await leftovers(s)
  const requests = s.t.ledger.length - before
  check('M6 15 quick open/close cycles: no leftovers anywhere in the document', noLeftovers(after) && after.trees === 0, JSON.stringify(after))
  check('M6 15 quick open/close cycles: no console error and no page error', s.t.consoleErrors.length === errorsBefore && s.t.uncaught.length === 0, JSON.stringify({ console: s.t.consoleErrors.slice(errorsBefore), uncaught: s.t.uncaught }))
  note('M6 requests to the ledger route in 15 quick open/close cycles', `${String(requests)} in ${String(spent)} ms`)
  check('M6 the requests stay bounded: at most one per opening, plus one per ~2 s while open', requests <= 15 + Math.ceil(spent / 2_000), `${String(requests)} requests, ${String(spent)} ms`)
  const quiet = s.t.ledger.length
  await sleep(5_000)
  check('M6 after the last close the page makes no more requests to the route (no poll left running)', s.t.ledger.length === quiet, `${String(s.t.ledger.length - quiet)} request(s) in 5 s`)
  // One long open: the poll is one per ~2 s.
  const longBefore = s.t.ledger.length
  await openMenu(s)
  await sleep(8_000)
  const longCount = s.t.ledger.length - longBefore
  note('M6 one 8 s opening', `${String(longCount)} request(s)`)
  check('M6 one opening of 8 s makes about one request per 2 s (3 to 6 requests)', longCount >= 3 && longCount <= 6, longCount)
  await closeMenu(s)
  void wf
  await s.context.close()
}

// ================================================================================================ M7: fail open
async function stepFailOpen() {
  const s = await newPage('M7-failopen', { scheme: 'dark' })
  s.t.expecting = true
  await s.page.route('**/dsh-orquestrator/**', (route) => route.abort('failed'))
  await open(s)
  const wf = await openSession(s, WORKFLOW).catch(async () => undefined)
  // `openSession` needs the config request to learn the root: with every plugin request aborted none is answered, so open by title.
  const handle = wf ?? await openByTitle(s, WORKFLOW)
  await openMenu(s)
  const menu = (await waitMenu(s, (m) => m.rows.length >= 2, { timeout: 8_000 })).value
  check('M7 every /dsh-orquestrator/ request aborted: the menu still opens with DSH\'s own rows', menu !== null && menu.rows.length >= 2 && menu.label === 'Subagent sessions', JSON.stringify(menu?.rows.map((r) => r.labelText)))
  await sleep(4_500)
  const later = await snap(s)
  check('M7 the rows are marked "unknown" or left alone, never broken (no duplicates, DSH\'s text intact)', later.rows.every((r) => (r.icons === 0 || r.iconState === 'unknown') && r.icons <= 1 && r.hosts <= 1 && r.labelText !== null && r.summaryText !== null && r.labelChildren === 0), JSON.stringify(later.rows.map(brief)))
  check('M7 DSH\'s own dot is visible where there is no icon, hidden where there is one', later.rows.every((r) => r.icons === 1 ? r.dotDisplay === 'none' : r.dotDisplay !== 'none'), JSON.stringify(later.rows.map((r) => [r.icons, r.dotDisplay])))
  await shot(s, 'M7-failopen')
  await s.page.locator(`${TREE} [role="treeitem"]`).first().click()
  await sleep(1_500)
  const switcher = await s.page.locator(TRIGGER).first().getAttribute('aria-label').catch(() => null)
  check('M7 a row is clickable: it opens the child\'s conversation', (await s.page.locator(TREE).count()) === 0 && /^Switch subagent: /.test(switcher ?? ''), switcher)
  check('M7 no uncaught page error', s.t.uncaught.length === 0, s.t.uncaught.join(' | '))
  void handle
  await s.context.close()
}

/** Open a session by the sidebar's row text and header count only (no config request is needed or answered). */
async function openByTitle(s, spec) {
  await expandSidebar(s)
  const rows = s.page.getByRole('tree', { name: 'Sessions' }).getByRole('treeitem').filter({ hasText: spec.title })
  const total = await rows.count()
  for (let nth = 0; nth < total; nth += 1) {
    await rows.nth(nth).click()
    await sleep(1_300)
    if (await triggerCount(s) === spec.count) return { nth }
  }
  throw new Error(`no session titled "${spec.title}" with ${String(spec.count)} subagents`)
}

// ================================================================================================ M11: README screenshots
/**
 * The states the README dropdown shows at once, over however many children the session has: the first running (spinner),
 * the second done (check), any further one failed. The home of a fresh battery holds the live run (two children), so two
 * rows is the normal picture here; a home with the old eight-child workflow session gets the failed row as well.
 */
function statesFor(session) {
  return (hostNow) => session.family.map((kid, index) => record(session.rootId, kid.id, index === 0
    ? { state: 'running', stopReason: null, startedAt: hostNow - 1_000, endedAt: null }
    : index === 1
      ? { state: 'done', stopReason: 'completed' }
      : { state: 'failed', stopReason: 'max-tokens' }, hostNow))
}

/** What the rows must show, in order: running, done, then failed for anything past the second child (three at most). */
const expectedStates = (session) => session.family.slice(0, 3).map((_, index) => (index === 0 ? 'running' : index === 1 ? 'done' : 'failed'))

async function readmeShots(session, openIt) {
  const wanted = expectedStates(session)
  for (const scheme of ['dark', 'light']) {
    const s = await newPage(`M11-${scheme}`, { scheme })
    await open(s)
    await openIt(s)
    await routeLedger(s, L.json(statesFor(session)))
    // The sidebar stays out of the picture: the screenshot is the conversation and its dropdown only.
    await s.page.getByRole('button', { name: /sidebar/i }).first().click({ timeout: 3_000 }).catch(() => undefined)
    await sleep(500)
    await openMenu(s)
    // DSH lists the children in an order of its own, so the states are compared as a set: what the picture must show is
    // a running row and a done row at the same time, each with its model tag.
    const wantedKey = [...wanted].sort().join()
    const statesOf = (menu) => menu.rows.slice(0, wanted.length).map((r) => r.iconState).sort().join()
    const shown = await waitMenu(s, (m) => m.rows.length >= wanted.length && statesOf(m) === wantedKey && m.rows.every((r) => r.hosts <= 1), { timeout: 9_000 })
    check(`M11 ${scheme}: the dropdown shows ${wanted.join(' + ')} at once (in whichever order DSH lists them), each row with its model tag`, shown.ok && shown.value.rows.slice(0, wanted.length).every((r) => r.tagText !== null), JSON.stringify(shown.value?.rows.slice(0, wanted.length).map(brief)))
    await sleep(500)
    await s.page.screenshot({ path: join(out, `readme-subagent-list-${scheme}.png`) })
    await s.context.close()
  }
}

async function stepReadme() {
  // Whatever this home has: the live session of the battery (two labelled children) or a wider old session if one exists.
  const probeSession = await newPage('M11-probe', { scheme: 'dark' })
  await open(probeSession)
  let session
  let spec
  for (const candidate of [WORKFLOW8, WORKFLOW].filter((item) => item.count >= 2)) {
    session = await openSession(probeSession, candidate).catch(() => undefined)
    if (session !== undefined) {
      spec = candidate
      break
    }
  }
  await probeSession.context.close()
  if (session === undefined || session.family.length < 2) {
    skip('M11 README screenshots', 'this home has no session with two or more subagents (run the live phase first)')
    return
  }
  note('M11 the session used for the README screenshots', `${String(session.family.length)} children, rows labelled by their creation labels; the states are driven through page.route`)
  await readmeShots(session, (s) => openSession(s, spec, session))
}

// ================================================================================================ M9: one short live run
const TASK_LIVE = [
  'Use the subagent tool three times, every call with run_in_background set to true and one call right after the other,',
  'with these labels and no other changes: "Sleep A", "Sleep B", "Sleep C".',
  'Each subagent must run the shell command `sleep 20` and then reply with exactly the word done.',
  'Then wait for all three and reply with what they said.',
].join(' ')

const dialogOf = (s) => s.page.getByRole('dialog', { name: DIALOG })
async function pickModel(s) {
  await dialogOf(s).getByRole('button', { name: /Choose a model/ }).first().click()
  const entry = s.page.getByRole('menuitem', { name: WORKER.name }).or(s.page.getByRole('option', { name: WORKER.name })).or(s.page.locator('[role=menu]').getByText(WORKER.name)).first()
  await entry.waitFor({ state: 'visible', timeout: 8_000 })
  await entry.click()
}

async function stepLive() {
  const s = await newPage('M9-live', { scheme: 'dark', scale: 2 })
  await open(s)
  // A blank conversation, whatever the page showed.
  await s.page.getByRole('button', { name: 'New session', exact: true }).first().click()
  await sleep(1_000)
  const composer = s.page.getByRole('textbox', { name: COMPOSER })
  await composer.waitFor({ state: 'visible', timeout: 15_000 })
  await composer.click()
  await s.page.keyboard.type(TASK_LIVE, { delay: 3 })
  await s.page.keyboard.press('Enter')
  await dialogOf(s).waitFor({ state: 'visible', timeout: 15_000 })
  const box = dialogOf(s).getByRole('checkbox', { name: SKILL_LABEL })
  if (await box.count() > 0 && await box.isChecked()) await box.uncheck()
  await dialogOf(s).getByRole('switch').first().click()
  await pickModel(s)
  check('M9 the dialog has DeepSeek V4.1 Flash as the subagent model and the skill unchecked', await dialogOf(s).getByRole('button', { name: WORKER.name }).first().isVisible() && !(await box.count() > 0 && await box.isChecked()))
  await dialogOf(s).getByRole('button', { name: SEND }).click()
  await dialogOf(s).waitFor({ state: 'hidden', timeout: 8_000 })
  const rootId = s.t.configIds.at(-1)?.id
  note('M9 the main session', rootId === undefined ? 'unknown' : rootId.slice(0, 16))

  // Wait for the first subagent, then open the dropdown again and again while they run.
  const appeared = await until(async () => (await triggerCount(s)) !== undefined, { timeout: 120_000, every: 1_000 })
  check('M9 the main agent started subagents (the header shows the count)', appeared.ok, `after ${String(appeared.ms)} ms`)
  if (!appeared.ok) {
    await shot(s, 'M9-no-subagents')
    await s.context.close()
    return
  }
  await routeLedger(s, L.pass())
  const spinnerSeen = []
  let runningShot = false
  let sawThree = false
  const started = Date.now()
  let lastMenu
  for (let round = 0; round < 40 && Date.now() - started < 150_000; round += 1) {
    await openMenu(s, { settle: false })
    const menu = (await waitMenu(s, (m) => m.rows.length >= 1 && m.rows.every((r) => r.icons === 1), { timeout: 6_000 })).value
    lastMenu = menu
    if (menu !== null) {
      spinnerSeen.push(menu.rows.map((r) => r.iconState).join(','))
      if (menu.rows.length === 3) sawThree = true
      if (!runningShot && menu.rows.length === 3 && menu.rows.every((r) => r.iconState === 'running' && r.tagText !== null)) {
        runningShot = true
        await sleep(1_200)
        await shot(s, 'M9-running')
        await s.page.locator(TREE).screenshot({ path: join(out, 'marks-M9-running-menu.png') })
        check('M9 while the subagents run, every row shows the spinner (animated) and the model tag', menu.rows.every((r) => r.iconState === 'running' && r.svgAnimation !== 'none' && r.tagText !== null), JSON.stringify(menu.rows.map(brief)))
        // A second page whose route answers 404 (a host with no ledger): a live child still gets a spinner from DSH's catalog.
        const b = await newPage('M9-404', { scheme: 'dark' })
        b.t.expecting = true
        await routeLedger(b, L.status(404))
        await open(b)
        const handle = await openByTitle(b, { title: 'Use the subagent tool three times', count: 3 }).catch(() => undefined)
        if (handle !== undefined) {
          await openMenu(b)
          const seen = await waitMenu(b, (m) => m.rows.length === 3 && m.rows.every((r) => r.icons === 1), { timeout: 8_000 })
          const states = seen.value?.rows.map((r) => r.iconState)
          note('M9 a page against a host with no ledger route, while the children run', JSON.stringify(seen.value?.rows.map(brief)))
          check('M9 with a 404 from the route, a child DSH says is live shows the spinner (and the neutral mark once it is not)', seen.ok && (states.every((state) => state === 'running') || states.some((state) => state === 'unknown')), JSON.stringify(states))
        } else skip('M9 spinner against a 404', 'the live session was not found in the sidebar by its title')
        await b.context.close()
      }
    }
    if (menu !== null && menu.rows.length === 3 && menu.rows.every((r) => r.iconState === 'done')) break
    await closeMenu(s)
    await sleep(2_500)
  }
  check('M9 the dropdown listed the three subagents', sawThree, JSON.stringify(spinnerSeen.slice(-4)))
  note('M9 the states seen across the openings', JSON.stringify([...new Set(spinnerSeen)]))
  const finished = await waitMenu(s, (m) => m.rows.length === 3 && m.rows.every((r) => r.iconState === 'done'), { timeout: 60_000, every: 500 }).catch(() => ({ ok: false, value: lastMenu }))
  check('M9 when they finish the rows show the check (state done, "Done")', finished.ok && finished.value.rows.every((r) => r.iconTitle === TEXT.done), JSON.stringify(finished.value?.rows.map(brief)))
  if (finished.ok) {
    await sleep(800)
    await shot(s, 'M9-done')
    await s.page.locator(TREE).screenshot({ path: join(out, 'marks-M9-done-menu.png') })
  }

  // The ledger as the page reads it, against the children in the session logs.
  const ledger = await s.page.evaluate(async (id) => {
    const response = await fetch(`/dsh-orquestrator/subagents?sessionId=${encodeURIComponent(id)}`)
    return { status: response.status, body: await response.json() }
  }, rootId)
  check('M9 GET /dsh-orquestrator/subagents?sessionId=<main session> answers 200 with the host\'s clock in `now`', ledger.status === 200 && typeof ledger.body.now === 'number' && Math.abs(ledger.body.now - Date.now()) < 60_000, `${String(ledger.status)} now=${String(ledger.body?.now)}`)
  const family = rootId === undefined ? [] : familyOf(rootId)
  note('M9 the children in the session logs', family.map((k) => ({ label: k.label, route: routeText(k.route), ended: k.end, id: k.id.slice(0, 8) })))
  const records = ledger.body?.subagents ?? []
  note('M9 the ledger\'s records', records.map((r) => ({ id: r.id.slice(0, 8), parent: r.parentId?.slice(0, 16), backend: r.backend, route: routeText(r.route), state: r.state, stop: r.stopReason, took: r.endedAt === null ? null : r.endedAt - r.startedAt })))
  check('M9 the ledger has one record per child in the logs (same ids)', family.length === 3 && records.length >= 3 && family.every((kid) => records.some((r) => r.id === kid.id)), `${String(family.length)} children, ${String(records.length)} records`)
  check('M9 every record is done, with parentId = the main session and the route the child really ran on (provider, model, effort)', family.length === 3 && family.every((kid) => {
    const r = records.find((entry) => entry.id === kid.id)
    return r !== undefined && r.state === 'done' && r.parentId === rootId && r.route !== null && r.route.provider === kid.route?.provider && r.route.model === kid.route?.model && (r.route.reasoningEffort ?? null) === (kid.route?.reasoningEffort ?? null)
  }), JSON.stringify(family.map((kid) => [routeText(kid.route), records.find((entry) => entry.id === kid.id)?.state, routeText(records.find((entry) => entry.id === kid.id)?.route ?? null)])))
  check('M9 the children really ran on DeepSeek V4.1 Flash (the logs), which is what the tags showed', family.length === 3 && family.every((kid) => kid.route?.model === WORKER.id) && lastMenu.rows.every((r) => /DeepSeek V4\.1 Flash/.test(r.tagText ?? '')), JSON.stringify(lastMenu?.rows.map((r) => r.tagText)))

  // M11 with the live session: the same three children driven through the three states, labelled by their creation labels.
  if (family.length === 3) {
    const live = { rootId, family }
    note('M11 the session used for the README screenshots', 'the live session of M9: three labelled children, the states driven through page.route')
    await s.context.close()
    await readmeShots(live, async (page) => { await openByTitle(page, { title: 'Use the subagent tool three times', count: 3 }) })
    return
  }
  await s.context.close()
}

// ================================================================================================ run
let crashed
try {
  // The sessions this home holds are read from the logs first: a fresh home (this battery) has the live children of B3,
  // not the old fixed-title sessions of the Acer home the script was written against.
  discoverSessions()
  if (steps.has('row')) await section('M1 row', stepRow)
  if (steps.has('ledger')) await section('M2 ledger states', stepLedger)
  if (steps.has('clock')) await section('M2 host clock', stepClock)
  if (steps.has('notfound')) await section('M2/M8 404', stepNotFound)
  if (steps.has('errors')) await section('M2 failing answers', stepErrors)
  if (steps.has('model')) await section('M3 model label', stepModel)
  if (steps.has('firstopen')) await section('M3 first open', stepFirstOpen)
  if (steps.has('workflow')) await section('M4 workflow', stepWorkflow)
  if (steps.has('native')) await section('M5 native behavior', stepNative)
  if (steps.has('cleanup')) await section('M6 cleanup', stepCleanup)
  if (steps.has('failopen')) await section('M7 fail open', stepFailOpen)
  if (steps.has('readme')) await section('M11 README screenshots', stepReadme)
  if (steps.has('live')) await section('M9 live run', stepLive)
} catch (error) {
  crashed = scrub(error?.stack ?? error)
  check('the run reached its end without an unhandled exception', false, crashed.split('\n')[0])
}

const failuresOf = (tracker) => ({
  uncaught: tracker.uncaught,
  // The shell asks for a file-manager icon the Linux build does not ship: not this plugin's request.
  consoleErrors: tracker.consoleErrors.filter((entry) => !entry.expected && !(tracker.failed.length > 0 && tracker.failed.every((item) => item.path.startsWith('/open-in-app/icon/') || item.expected) && entry.text.startsWith('Failed to load resource'))),
  failedOrq: tracker.failed.filter((item) => item.path.includes('/dsh-orquestrator/') && !item.expected),
  foreign: tracker.failed.filter((item) => !item.path.includes('/dsh-orquestrator/')).map((item) => `${String(item.status)} ${item.path}`),
})
const collected = trackers.map((tracker) => ({ label: tracker.label, ...failuresOf(tracker) }))
const uncaught = collected.flatMap((item) => item.uncaught.map((entry) => `${item.label}: ${entry}`))
const consoleErrors = collected.flatMap((item) => item.consoleErrors.map((entry) => `${item.label}: ${entry.text}`))
const failedOrq = collected.flatMap((item) => item.failedOrq.map((entry) => `${item.label}: ${String(entry.status)} ${entry.path}`))
const foreign = [...new Set(collected.flatMap((item) => item.foreign))]
check('M10 no uncaught page errors in any step', uncaught.length === 0, uncaught.join(' | '))
check('M10 no unexpected console errors in any step (the answers provoked on purpose and the known foreign /open-in-app/icon/ 404s excluded)', consoleErrors.length === 0, consoleErrors.join(' | '))
check('M10 no failed /dsh-orquestrator/ responses in any step beyond the ones provoked on purpose', failedOrq.length === 0, failedOrq.join(' | '))
if (foreign.length > 0) note('M10 failed responses that are not this plugin\'s (DSH\'s own)', foreign.join(' | '))

writeFileSync(join(out, `${phase}.report.json`), JSON.stringify({
  phase,
  steps: [...steps],
  checks,
  notes,
  skipped,
  trackers: trackers.map((tracker) => ({
    label: tracker.label,
    uncaught: tracker.uncaught,
    consoleErrors: tracker.consoleErrors,
    failedResponses: tracker.failed,
    ledgerRequests: tracker.ledger.length,
  })),
  crashed,
}, null, 2))
const failed = checks.filter((item) => !item.ok)
console.log(`\n${phase}: ${String(checks.length - failed.length)}/${String(checks.length)} checks passed; pages=${String(trackers.length)}; uncaught=${String(uncaught.length)}; failed /dsh-orquestrator/=${String(failedOrq.length)}; notes=${String(notes.length)}; skipped=${String(skipped.length)}`)
for (const item of failed) console.log(`FAILED: ${item.name}  [${item.detail.slice(0, 200)}]`)
await browser.close()
process.exit(failed.length === 0 ? 0 : 1)
