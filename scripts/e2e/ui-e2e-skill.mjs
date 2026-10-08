#!/usr/bin/env node
/**
 * Browser end-to-end checks of the orchestration-skill checkbox (plugin 0.8.0) against a REAL DSH web server
 * running on an isolated DSH_HOME (never the operator's own). Companion of `ui-e2e.mjs`, same style: a `check()`
 * helper, one `<phase>.report.json`, screenshots.
 *
 *   DSH_URL=<authenticated dsh web URL> ORQ_SESSIONS_DIR=<sessions dir> [OUT_DIR=<dir>] [CHROME_PATH=<chrome>] \
 *     [STEPS=conversation,child,themes,wire,queue] PHASE=skill node ui-e2e-skill.mjs
 *   STEPS=child PHASE=skill scripts/e2e/with-server.sh node scripts/e2e/ui-e2e-skill.mjs    starts that isolated server for you
 *
 * PHASE:
 *   skill   the one phase. `STEPS` (default: all five) picks which groups run:
 *     conversation  S1..S5 and S7 in ONE conversation, plus the extras that need the same conversation
 *                   S1  new task: the dialog has ONE checkbox ("Apply the orchestration skill to this task", CHECKED), the
 *                       "Orchestration skill" heading, the `/orchestrate-subagents` hint, no remember/ask-again box, the switch OFF
 *                   S2  uncheck + confirm: the message goes out as typed; the session log has no token and no skill-invocation
 *                   S3  the last answer pre-fills the next dialog (unchecked); check + confirm: the transcript and the log show the
 *                       typed text with `/orchestrate-subagents` on a line of its own AT THE END, and DSH injected the skill
 *                       (`source.kind === 'skill-invocation'`)
 *                   S4  Escape (cancel): no token, no injection, and the next dialog is unchanged; the other ways to cancel
 *                       (the close button after toggling, the Cancel button, a click on the mask) do the same
 *                   S5  `/orquestrar` (configure mode, nothing is sent): no skill section, no checkbox
 *                   S7  keyboard: Tab never leaves the dialog, Space toggles the checkbox, Escape closes; Enter confirms
 *                   X   a token the user typed (first word or inside the text) is not doubled, a multi-line task keeps the token
 *                       on its own last line, an attachment-only message gets the token as a text part in front of the file, the
 *                       answer survives a reload and reaches a new conversation, the skill + a subagent model travel together
 *                       (the configuration carries nothing about the skill), and the conversation's title is the typed text
 *     child         S10 a subagent's OWN conversation (a continuable child opened from its parent's header dropdown): the dialog
 *                       has NO skill section and the message that goes out has no token. The prompt request is captured and
 *                       aborted, so no model ever runs there. The parent and its continuable child are read from the session
 *                       logs, never from a title written down here; skipped, cleanly, when the home has no such child
 *     themes        S6  light theme (the section renders, readable) and a 1024x600 screen (dark and light) with the subagent
 *                       model on, the effort block open AND the skill section: the dialog fits, the stack scrolls
 *     wire          S8  `page.route` on the configuration route: a host without the `skill` field (older than 0.8), a host that
 *                       says `available: false`, a malformed offer and a failing route show NO section and send NO token; the
 *                       unmodified route brings the section back; a failing save keeps the dialog and the answer
 *     queue         a message sent WHILE a turn runs: the dialog opens and the token is carried by the queued message
 *   S9 (every step)     no uncaught page errors and no failed `/dsh-orquestrator/` responses
 *
 * Models: ONLY the main agent of the isolated home (GLM 5.3) and, for the subagent picker, DeepSeek V4.1 Flash. Every run
 * is a one-word answer; the script waits for the turn to end (60 s at most) and presses "Stop generating" otherwise.
 * The session logs (`<ORQ_SESSIONS_DIR>/<workspace>/<session-id>/session.v3.jsonl.zstd`, read with `zstd -dc`) are the
 * evidence of what DSH received, so `zstd` must be on PATH.
 *
 * Writes <OUT_DIR>/skill.report.json (checks, advice, the log event shapes, the wire) and screenshots `skill-*.png`.
 * The token in DSH_URL is a per-process credential: it is never written out (every message is scrubbed).
 */
import { chromium } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const url = process.env.DSH_URL
const phase = process.env.PHASE ?? 'skill'
const out = resolve(process.env.OUT_DIR ?? join(repo, '.validation-tmp', 'out-dialog'))
const steps = new Set((process.env.STEPS ?? 'conversation,child,themes,wire,queue').split(',').map((item) => item.trim()).filter(Boolean))
const sessionsDir = process.env.ORQ_SESSIONS_DIR ?? (process.env.DSH_HOME === undefined ? undefined : join(process.env.DSH_HOME, 'sessions'))
if (phase !== 'skill') {
  console.error(`unknown phase: ${phase}`)
  process.exit(2)
}
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

// DSH lands either on the new-session view ("Describe what you want to build") or on a blank conversation ("Message or run a
// task"): a start-up race of its own, so the helpers take whichever composer is there.
const COMPOSER = /Describe what you want to build|Message or run a task/
const DIALOG = 'Orchestrate subagents'
const SKILL = 'orchestrate-subagents'
const TOKEN = `/${SKILL}`
const SKILL_LABEL = 'Apply the orchestration skill to this task'
const SKILL_TITLE = 'Orchestration skill'
const MEMORY_KEY = 'dsh-orquestrator:skill:v1'
const REMEMBER_BOX = /ask again|remember|do not ask/i
const WORKER = { name: /DeepSeek V4\.1 Flash \(Azure\)/, id: 'DeepSeek-V4.1-Flash' }
const SEND = 'Send with these options'
const TRIGGER = '[aria-haspopup="tree"]'
const TREE = 'body > [role="tree"]'

const checks = []
const shapes = {}
const check = (name, ok, detail = '') => {
  const text = scrub(detail === undefined ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail))
  checks.push({ name, ok: Boolean(ok), detail: text.slice(0, 700) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${text === '' ? '' : `  [${text.slice(0, 240)}]`}`)
}

/** A soft finding: reported with its evidence, never counted as a failure (a design consequence rather than a broken promise). */
const advice = []
const advise = (name, ok, detail = '') => {
  const text = scrub(detail === undefined ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail))
  advice.push({ name, ok: Boolean(ok), detail: text.slice(0, 700) })
  console.log(`${ok ? 'ADVICE-OK  ' : 'ADVICE-FAIL'}  ${name}${text === '' ? '' : `  [${text.slice(0, 240)}]`}`)
}

/** A check this environment cannot run (it needs something the DSH home does not have): reported, never a failure. */
const skipped = []
const skip = (name, reason) => {
  skipped.push({ name, reason })
  console.log(`SKIP  ${name}  [${reason}]`)
}

const chromePath = process.env.CHROME_PATH
const browser = await chromium.launch(chromePath === undefined ? { channel: 'chrome', headless: true } : { executablePath: chromePath, headless: true, args: ['--no-sandbox'] })

// ------------------------------------------------------------------------------------------------ page, tracking, helpers

/** Everything one page reports: errors, failed responses and the plugin's configuration traffic (paths only, never the URL). */
const trackers = []
function track(label, page) {
  const tracker = { label, uncaught: [], consoleErrors: [], failed: [], wire: [], sessionIds: [], expecting: false }
  page.on('pageerror', (error) => tracker.uncaught.push(scrub(error).slice(0, 300)))
  page.on('console', (message) => {
    if (message.type() === 'error') tracker.consoleErrors.push({ text: scrub(message.text()).slice(0, 200), expected: tracker.expecting })
  })
  page.on('response', async (response) => {
    const path = new URL(response.url()).pathname
    if (response.status() >= 400) tracker.failed.push({ status: response.status(), path, method: response.request().method(), expected: tracker.expecting })
    if (path !== '/dsh-orquestrator/config') return
    const entry = { method: response.request().method(), status: response.status(), sessionId: new URL(response.url()).searchParams.get('sessionId'), body: response.request().postData() }
    try {
      const json = await response.json()
      entry.skill = 'skill' in json ? json.skill : '<absent>'
      entry.config = json.config
      entry.sessionId ??= json.sessionId
    } catch { /* an aborted or non-JSON answer has nothing to read */ }
    tracker.wire.push(entry)
  })
  page.on('request', (request) => {
    if (new URL(request.url()).pathname !== '/dsh-orquestrator/config' || request.method() !== 'GET') return
    const id = new URL(request.url()).searchParams.get('sessionId')
    if (id !== null) tracker.sessionIds.push(id)
  })
  trackers.push(tracker)
  return tracker
}

/** A page of its own (own context, so own localStorage): `{ label, context, page, t, sessionId, sent }` (`sent` counts the messages that went out in the current conversation). */
async function newPage(label, { scheme = 'dark', viewport = { width: 1280, height: 860 } } = {}) {
  const context = await browser.newContext({ viewport, colorScheme: scheme })
  const page = await context.newPage()
  return { label, context, page, t: track(label, page), sessionId: undefined, sent: 0 }
}

const dialog = (s) => s.page.getByRole('dialog', { name: DIALOG })
const skillBox = (s) => dialog(s).getByRole('checkbox', { name: SKILL_LABEL })
const skillRegion = (s) => dialog(s).getByRole('region', { name: SKILL_TITLE })
const memory = (s) => s.page.evaluate((key) => localStorage.getItem(key), MEMORY_KEY)
const shot = async (s, name) => { await s.page.screenshot({ path: join(out, `skill-${name}.png`) }) }
const slug = (value) => value.replace(/[^A-Za-z0-9]+/g, '-')

async function open(s) {
  await s.page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await s.page.getByRole('textbox', { name: COMPOSER }).waitFor({ state: 'visible', timeout: 30_000 })
  // DSH lands either on the new-session view or on a conversation (a start-up race of its own). Start from a blank one, so the
  // choice stored for an old conversation never leaks into a check: "New session" reuses an empty session when there is one.
  if (await s.page.getByRole('textbox', { name: /Message or run a task/ }).count() > 0) await newConversation(s)
  s.sent = 0
}

/** The "New session" button of the sidebar: a blank conversation, whatever the page showed. */
async function newConversation(s) {
  await s.page.getByRole('button', { name: 'New session', exact: true }).first().click()
  await s.page.waitForTimeout(1_000)
  await s.page.getByRole('textbox', { name: COMPOSER }).waitFor({ state: 'visible', timeout: 15_000 })
  s.sent = 0
}

/** Type a task in the composer and press Enter: the dialog must appear. */
async function ask(s, text) {
  const composer = s.page.getByRole('textbox', { name: COMPOSER })
  await composer.click()
  await s.page.keyboard.type(text, { delay: 4 })
  await s.page.keyboard.press('Enter')
  await dialog(s).waitFor({ state: 'visible', timeout: 15_000 })
  s.sessionId = s.t.sessionIds.at(-1)
}

/** Answer the dialog the way a click would: the footer button. */
async function sendWith(s) {
  await dialog(s).getByRole('button', { name: SEND }).click()
  await dialog(s).waitFor({ state: 'hidden', timeout: 8_000 })
}

async function pick(s, triggerText, entryPattern) {
  await dialog(s).getByRole('button', { name: triggerText }).first().click()
  const entry = s.page.getByRole('menuitem', { name: entryPattern }).or(s.page.getByRole('option', { name: entryPattern })).or(s.page.locator('[role=menu]').getByText(entryPattern)).first()
  await entry.waitFor({ state: 'visible', timeout: 8_000 })
  await entry.click()
}

// ------------------------------------------------------------------------------------------------ the DSH session log

function logFile(sessionId) {
  if (sessionId === undefined) return undefined
  for (const directory of readdirSync(sessionsDir)) {
    const file = join(sessionsDir, directory, sessionId, 'session.v3.jsonl.zstd')
    if (existsSync(file)) return file
  }
  return undefined
}

/** Every event of one session log file decoded so far (a log being written yields its complete lines). */
function readEventsAt(file) {
  let text = ''
  try {
    text = execFileSync('zstd', ['-dc', file], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8')
  } catch (error) {
    text = error.stdout?.toString('utf8') ?? ''
  }
  return text.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
}

/** Every event of a session log decoded so far, by session id. */
function readEvents(sessionId) {
  const file = logFile(sessionId)
  return file === undefined ? [] : readEventsAt(file)
}

const textOfMessage = (event) => (event.data.content ?? []).map((part) => part.text ?? '').join('')

/** The log grouped by turn: the user's own messages, the skill injections, the answer and how the turn ended. */
function turnsOf(events) {
  const turns = []
  let current = null
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = { turn: event.data.turn, users: [], injections: [], others: [], answer: '', end: null }
      turns.push(current)
    } else if (current !== null && event.type === 'user/message') {
      const source = event.data.source ?? {}
      const text = textOfMessage(event)
      if (source.kind === 'user') current.users.push({ text, source, event })
      else if (source.kind === 'skill-invocation') current.injections.push({ name: source.name, form: source.form, text, event })
      else current.others.push({ kind: source.kind, text })
    } else if (current !== null && event.type === 'assistant/message') {
      current.answer += (event.data.message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('')
    } else if (current !== null && event.type === 'turn/end') {
      current.end = event.data.reason ?? {}
    }
  }
  return turns
}

const isInjection = (event) => event.type === 'user/message' && event.data?.source?.kind === 'skill-invocation'

/** One-line shape of an event: keys and sources kept, long strings cut. */
function shapeOf(event) {
  const cut = (_key, value) => (typeof value === 'string' && value.length > 70 ? `${value.slice(0, 60)}...(${String(value.length)} chars)` : value)
  return JSON.stringify(event, cut)
}

/** Wait for turn `n` of the session to end (60 s at most; then press "Stop generating" so a long run never lingers). */
async function awaitTurn(s, n, ms = 60_000) {
  const started = Date.now()
  while (Date.now() - started < ms) {
    const turn = turnsOf(readEvents(s.sessionId))[n - 1]
    if (turn !== undefined && turn.end !== null) { s.turns = n; return { ok: true, turn, ms: Date.now() - started } }
    await s.page.waitForTimeout(500)
  }
  const stop = s.page.getByRole('button', { name: 'Stop generating' })
  if (await stop.count() > 0) await stop.first().click().catch(() => undefined)
  await s.page.waitForTimeout(1_500)
  return { ok: false, turn: turnsOf(readEvents(s.sessionId))[n - 1], ms }
}

/** The next message of the conversation went out: wait for its turn to end and return it (`awaitTurn` on the running count). */
async function landed(s, ms) {
  s.sent += 1
  return awaitTurn(s, s.sent, ms)
}

// ------------------------------------------------------------------------------------------------ transcript helpers

const chips = (s) => s.page.locator('button[data-ref-chip="skill"]', { hasText: TOKEN })
const bodyText = async (s) => (await s.page.locator('body').innerText()).replace(/[ \t]+/g, ' ')
const occurrences = (text, needle) => text.split(needle).length - 1

/** The visible text of the user bubble that holds `needle` (the chip and the plain run side by side). */
async function bubbleOf(s, needle) {
  const run = s.page.locator('span', { hasText: needle }).filter({ visible: true }).last()
  if (await run.count() === 0) return undefined
  return run.evaluate((element) => {
    const holder = element.closest('[class*="bubble"]') ?? element.parentElement
    return (holder?.textContent ?? '').replace(/\s+/g, ' ').trim()
  })
}

/** Run one named part; an exception is a FAIL of its own with a screenshot, never the end of the run. */
async function section(name, s, body) {
  try {
    await body()
  } catch (error) {
    check(`${name} ran to the end without an exception`, false, scrub(error?.message ?? error).split('\n')[0])
    if (s !== undefined) await shot(s, `${name}-exception`).catch(() => undefined)
  }
}

/** Contrast ratio of two `rgb(a)` strings (WCAG 2.x relative luminance). */
function contrast(foreground, background) {
  const parse = (value) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
  const luminance = (rgb) => {
    const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const [a, b] = [luminance(parse(foreground)), luminance(parse(background))]
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** What goes out when the checkbox applies the skill (0.8.0): the typed text, then the token on a line of its own. */
const withToken = (text) => `${text}\n${TOKEN}`

const T = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo'].map((word) => `Reply with exactly the word: ${word}`)

// ------------------------------------------------------------------------------------------------ conversation: S1..S5, S7 and the extras

async function conversation() {
  const s = await newPage('conversation')
  await open(s)

  // ---- S1: a new task raises the dialog with the skill checkbox
  await section('S1', s, async () => {
    await ask(s, T[0])
    const dlg = dialog(s)
    const boxes = dlg.getByRole('checkbox')
    check('S1 the dialog has exactly ONE checkbox', (await boxes.count()) === 1, await boxes.count())
    const box = skillBox(s)
    check(`S1 it is named "${SKILL_LABEL}" and is CHECKED`, (await box.count()) === 1 && await box.isChecked())
    check(`S1 the section heading "${SKILL_TITLE}" is there`, (await dlg.getByRole('heading', { name: SKILL_TITLE, exact: true }).count()) === 1)
    const region = skillRegion(s)
    const regionText = (await region.count()) === 1 ? (await region.innerText()).replace(/\s+/g, ' ') : ''
    check('S1 the section hint mentions /orchestrate-subagents and holds the checkbox', regionText.includes(TOKEN) && (await region.getByRole('checkbox').count()) === 1, regionText.slice(0, 200))
    check('S1 no checkbox named like "ask again" / "remember" / "do not ask"', (await dlg.getByRole('checkbox', { name: REMEMBER_BOX }).count()) === 0)
    const switches = dlg.getByRole('switch')
    check('S1 the subagent-model switch is still there, once, and OFF', (await switches.count()) === 1 && (await switches.first().getAttribute('aria-checked')) === 'false')
    check('S1 the dialog previews exactly what was typed', await dlg.getByText(T[0], { exact: true }).isVisible())
    const answered = s.t.wire.find((entry) => entry.method === 'GET' && entry.sessionId === s.sessionId)
    check('S1 the host answered skill {name: orchestrate-subagents, available: true}', answered?.skill?.name === SKILL && answered?.skill?.available === true, JSON.stringify(answered?.skill))
    await shot(s, 'S1-dialog-dark')
  })

  // ---- S2: unchecked -> the message goes out exactly as typed
  await section('S2', s, async () => {
    const dlg = dialog(s)
    await skillBox(s).uncheck()
    check('S2 the checkbox is unchecked before sending', !(await skillBox(s).isChecked()))
    await sendWith(s)
    check('S2 the answer is remembered as "off" (localStorage)', (await memory(s)) === 'off', await memory(s))
    const { ok, turn, ms } = await landed(s)
    check('S2 the model answered (turn 1 ended)', ok && turn?.end?.kind === 'completed', `${String(ms)} ms, answer=${JSON.stringify(turn?.answer?.slice(0, 40))}`)
    const events = readEvents(s.sessionId)
    const user = turn?.users[0]
    check('S2 log: the user/message text is exactly what was typed', user?.text === T[0], JSON.stringify(user?.text))
    check('S2 log: no user/message mentions /orchestrate-subagents (the skill catalog lists it by name, never as a token)', turnsOf(events).every((item) => item.users.every((u) => !u.text.includes(TOKEN))))
    check('S2 log: NO message injected with a skill-invocation source', events.filter(isInjection).length === 0, events.filter(isInjection).length)
    const catalog = events.find((event) => event.type === 'user/message' && event.data.source?.kind === 'skill-catalog')
    check('S2 log: the skill catalog lists orchestrate-subagents (the model may load it itself)', catalog?.data.source.entries?.some((entry) => entry.name === SKILL) === true)
    shapes.S2_userMessage = user === undefined ? null : shapeOf(user.event)
    check('S2 transcript: the user bubble shows the typed text and no skill chip', (await bubbleOf(s, T[0])) === T[0] && (await chips(s).count()) === 0, await bubbleOf(s, T[0]))
    check('S2 transcript: the typed text appears exactly once (no duplicate bubble)', occurrences(await bodyText(s), T[0]) === 1, occurrences(await bodyText(s), T[0]))
    await shot(s, 'S2-transcript-no-token')
  })

  // ---- S3: the last answer pre-fills the next dialog; check it and send
  await section('S3', s, async () => {
    await ask(s, T[1])
    check('S3 the next dialog opens with the checkbox UNCHECKED (the last answer is remembered)', !(await skillBox(s).isChecked()), await memory(s))
    check('S3 the preview shows what was typed, without any token', await dialog(s).getByText(T[1], { exact: true }).isVisible())
    await skillBox(s).check()
    check('S3 the checkbox is checked before sending', await skillBox(s).isChecked())
    await shot(s, 'S3-dialog-checked')
    await sendWith(s)
    check('S3 the answer is remembered as "on"', (await memory(s)) === 'on', await memory(s))
    await chips(s).first().waitFor({ state: 'visible', timeout: 15_000 })
    const { ok, turn, ms } = await landed(s)
    check('S3 the model answered (turn 2 ended)', ok && turn?.end?.kind === 'completed', `${String(ms)} ms, answer=${JSON.stringify(turn?.answer?.slice(0, 40))}`)
    const bubble = await bubbleOf(s, T[1])
    check('S3 transcript: the message shows the typed text, then ONE /orchestrate-subagents chip on a line of its own', bubble === `${T[1]} ${TOKEN}` && (await chips(s).count()) === 1 && await chips(s).last().evaluate((chip) => chip.nextSibling === null && (chip.previousSibling?.textContent ?? '').endsWith('\n')), bubble)
    check('S3 transcript: the message appears once (the optimistic echo was replaced, not duplicated)', occurrences(await bodyText(s), T[1]) === 1, occurrences(await bodyText(s), T[1]))
    const user = turn?.users[0]
    check('S3 log: the user/message text is the typed text, a newline and /orchestrate-subagents (the token goes at the END)', user?.text === withToken(T[1]) && user.text.startsWith(T[1]) && user.text.endsWith(`\n${TOKEN}`), JSON.stringify(user?.text))
    check('S3 log: the token is there exactly once', occurrences(user?.text ?? '', TOKEN) === 1)
    const injection = turn?.injections.find((item) => item.name === SKILL)
    check('S3 log: DSH injected a message whose source is {kind: skill-invocation, name: orchestrate-subagents}', injection !== undefined && injection.event.data.source.kind === 'skill-invocation', injection === undefined ? 'none' : JSON.stringify(injection.event.data.source))
    check('S3 log: the injected text contains "Do not read code yourself"', injection?.text.includes('Do not read code yourself') === true, injection?.text.length)
    check('S3 log: exactly one injection in this turn, after the user message', turn?.injections.length === 1 && injection !== undefined && injection.event.seq > (user?.event.seq ?? Infinity), turn?.injections.length)
    const skillFile = join(repo, 'skills', SKILL, 'SKILL.md')
    if (existsSync(skillFile) && injection !== undefined) {
      const body = readFileSync(skillFile, 'utf8').replace(/^---[\s\S]*?\n---\n/, '').trim()
      check('S3 log: the injected text carries the whole body of skills/orchestrate-subagents/SKILL.md', injection.text.includes(body), `${String(body.length)} chars in the file, ${String(injection.text.length)} injected`)
    }
    shapes.S3_userMessage = user === undefined ? null : shapeOf(user.event)
    shapes.S3_injectedMessage = injection === undefined ? null : shapeOf(injection.event)
    await shot(s, 'S3-transcript-with-token')
  })

  // ---- S4: Escape cancels: no token, no injection, the next dialog is unchanged
  await section('S4', s, async () => {
    await ask(s, T[2])
    check('S4 the dialog opens CHECKED (the S3 answer)', await skillBox(s).isChecked())
    await s.page.keyboard.press('Escape')
    await dialog(s).waitFor({ state: 'hidden', timeout: 8_000 }).then(() => check('S4 Escape closes the dialog', true), () => check('S4 Escape closes the dialog', false))
    const { ok, turn } = await landed(s)
    check('S4 the message went out after Escape (turn 3 ended)', ok, turn?.end?.kind)
    check('S4 log: the message is exactly what was typed (no token)', turn?.users[0]?.text === T[2], JSON.stringify(turn?.users[0]?.text))
    check('S4 log: no skill-invocation injection in that turn, and the S3 injection is still the only one', turn?.injections.length === 0 && readEvents(s.sessionId).filter(isInjection).length === 1)
    check('S4 transcript: still ONE skill chip (message 3 carries none)', (await chips(s).count()) === 1 && (await bubbleOf(s, T[2])) === T[2], await bubbleOf(s, T[2]))
    check('S4 the cancel left the remembered answer alone ("on")', (await memory(s)) === 'on', await memory(s))
    await shot(s, 'S4-after-escape')

    // The NEXT dialog is unchanged; toggle it and close with the X: nothing of that toggle may stick.
    await ask(s, T[3])
    check('S4 the NEXT dialog is still CHECKED after the Escape-cancel', await skillBox(s).isChecked())
    await skillBox(s).uncheck()
    await dialog(s).getByRole('button', { name: 'Close', exact: true }).click()
    await dialog(s).waitFor({ state: 'hidden', timeout: 8_000 })
    const second = await landed(s)
    check('S4+ closing with the X after unchecking: no token, no injection', second.turn?.users[0]?.text === T[3] && second.turn?.injections.length === 0, JSON.stringify(second.turn?.users[0]?.text))
    check('S4+ an unconfirmed toggle is not remembered (still "on")', (await memory(s)) === 'on', await memory(s))

    await ask(s, T[4])
    check('S4+ the next dialog is CHECKED again (the X-cancel changed nothing)', await skillBox(s).isChecked())
    await dialog(s).getByRole('button', { name: 'Cancel', exact: true }).click()
    await dialog(s).waitFor({ state: 'hidden', timeout: 8_000 })
    const third = await landed(s)
    check('S4+ the Cancel button: no token, no injection', third.turn?.users[0]?.text === T[4] && third.turn?.injections.length === 0, JSON.stringify(third.turn?.users[0]?.text))

    await ask(s, T[5])
    check('S4+ the next dialog is still CHECKED', await skillBox(s).isChecked())
    await s.page.mouse.click(30, 400)
    await dialog(s).waitFor({ state: 'hidden', timeout: 8_000 }).then(() => check('S4+ a click on the mask closes the dialog', true), () => check('S4+ a click on the mask closes the dialog', false))
    const fourth = await landed(s)
    check('S4+ the mask click: no token, no injection', fourth.turn?.users[0]?.text === T[5] && fourth.turn?.injections.length === 0, JSON.stringify(fourth.turn?.users[0]?.text))
    check('S4+ after four cancels the remembered answer is still "on" and exactly one chip is in the transcript', (await memory(s)) === 'on' && (await chips(s).count()) === 1, `${String(await memory(s))}, chips=${String(await chips(s).count())}`)
  })

  // ---- S5: /orquestrar opens the configure dialog: nothing is being sent, so no skill section
  await section('S5', s, async () => {
    const before = turnsOf(readEvents(s.sessionId)).reduce((total, turn) => total + turn.users.length, 0)
    const composer = s.page.getByRole('textbox', { name: COMPOSER })
    await composer.click()
    await s.page.keyboard.type('/orquestrar', { delay: 6 })
    await s.page.waitForTimeout(800)
    check('S5 the /orquestrar command is offered by the slash palette', await s.page.getByText(DIALOG).first().isVisible().catch(() => false))
    await s.page.keyboard.press('Enter')
    const opened = await dialog(s).waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)
    check('S5 the command opens the dialog in configure mode', opened && (await dialog(s).getByText('The options apply from the next task.').isVisible()))
    if (opened) {
      const dlg = dialog(s)
      check('S5 configure dialog: NO checkbox at all', (await dlg.getByRole('checkbox').count()) === 0, await dlg.getByRole('checkbox').count())
      check('S5 configure dialog: no "Orchestration skill" section, label or token text', (await dlg.getByRole('heading', { name: SKILL_TITLE }).count()) === 0 && (await dlg.getByText(/orchestration skill/i).count()) === 0 && (await dlg.getByText(TOKEN).count()) === 0)
      check('S5 configure dialog: the subagent switch and Save are there', (await dlg.getByRole('switch').count()) === 1 && (await dlg.getByRole('button', { name: 'Save', exact: true }).isVisible()))
      await shot(s, 'S5-configure')
      await s.page.keyboard.press('Escape')
      await dlg.waitFor({ state: 'hidden', timeout: 8_000 })
    }
    await composer.click()
    await s.page.keyboard.press('Control+A')
    await s.page.keyboard.press('Backspace')
    await s.page.waitForTimeout(1_500)
    const after = turnsOf(readEvents(s.sessionId)).reduce((total, turn) => total + turn.users.length, 0)
    check('S5 nothing was sent by the command or by closing its dialog', after === before, `${String(before)} -> ${String(after)} user messages`)

    // The dock chip is the other way into the configure dialog.
    const chip = s.page.getByRole('button', { name: /Subagent orchestration in this conversation/ })
    if (await chip.count() === 1) {
      await chip.click()
      const chipOpened = await dialog(s).waitFor({ state: 'visible', timeout: 8_000 }).then(() => true, () => false)
      check('S5 the dock chip opens the configure dialog, also without a skill section', chipOpened && (await dialog(s).getByRole('checkbox').count()) === 0 && (await dialog(s).getByText(/orchestration skill/i).count()) === 0)
      await s.page.keyboard.press('Escape')
      await dialog(s).waitFor({ state: 'hidden', timeout: 8_000 })
    }
  })

  // ---- S7: keyboard
  await section('S7', s, async () => {
    await ask(s, T[6])
    const dlg = dialog(s)
    const focused = () => s.page.evaluate(() => {
      const element = document.activeElement
      const name = element?.getAttribute('aria-label') ?? element?.labels?.[0]?.textContent ?? element?.textContent ?? ''
      return { inside: element !== null && element.closest('[role=dialog]') !== null, label: `${element?.tagName.toLowerCase() ?? '?'}:${name.trim().slice(0, 90)}` }
    })
    const walk = []
    let escaped = 0
    for (let index = 0; index < 14; index += 1) {
      await s.page.keyboard.press('Tab')
      const state = await focused()
      walk.push(state.label)
      if (!state.inside) escaped += 1
    }
    check('S7 Tab never leaves the dialog (14 tabs)', escaped === 0, `${String(escaped)} escaped; ${walk.slice(0, 6).join(' > ')}`)
    check('S7 the skill checkbox is part of the Tab cycle', walk.some((label) => label.startsWith('input:') && label.includes(SKILL_LABEL)), walk.join(' | '))
    let backEscaped = 0
    for (let index = 0; index < 14; index += 1) {
      await s.page.keyboard.press('Shift+Tab')
      if (!(await focused()).inside) backEscaped += 1
    }
    check('S7 Shift+Tab never leaves the dialog either (14 presses)', backEscaped === 0, backEscaped)
    for (let index = 0; index < 8 && !(await focused()).label.includes(SKILL_LABEL); index += 1) await s.page.keyboard.press('Tab')
    check('S7 the checkbox can be focused from the keyboard', (await focused()).label.includes(SKILL_LABEL), (await focused()).label)
    const before = await skillBox(s).isChecked()
    await s.page.keyboard.press('Space')
    check('S7 Space toggles the focused checkbox', (await skillBox(s).isChecked()) === !before, `${String(before)} -> ${String(await skillBox(s).isChecked())}`)
    await s.page.keyboard.press('Space')
    check('S7 Space again toggles it back', (await skillBox(s).isChecked()) === before)
    await dlg.getByText(SKILL_LABEL, { exact: true }).click()
    check('S7 a click on the label text toggles it too', (await skillBox(s).isChecked()) === !before)
    await dlg.getByText(SKILL_LABEL, { exact: true }).click()
    check('S7 and back', (await skillBox(s).isChecked()) === before)
    await shot(s, 'S7-keyboard')
    await s.page.keyboard.press('Escape')
    await dlg.waitFor({ state: 'hidden', timeout: 8_000 }).then(() => check('S7 Escape closes the dialog', true), () => check('S7 Escape closes the dialog', false))
    const result = await landed(s)
    check('S7 Escape sent the message as stock (no token, no injection)', result.turn?.users[0]?.text === T[6] && result.turn?.injections.length === 0, JSON.stringify(result.turn?.users[0]?.text))
  })

  // ---- X: Enter on the focused primary button confirms with the default (checked) answer
  await section('X-enter', s, async () => {
    await ask(s, T[7])
    check('X the primary button holds the focus when the dialog opens', await dialog(s).getByRole('button', { name: SEND }).evaluate((element) => element === document.activeElement))
    await s.page.keyboard.press('Enter')
    await dialog(s).waitFor({ state: 'hidden', timeout: 8_000 })
    const result = await landed(s)
    check('X Enter on the dialog confirms: the message carries the token and DSH injected the skill', result.turn?.users[0]?.text === withToken(T[7]) && result.turn?.injections.length === 1, JSON.stringify(result.turn?.users[0]?.text))
  })

  // ---- X: a token the user typed is not doubled, wherever it is
  await section('X-typed', s, async () => {
    // At the end of the text the slash palette stays open (Enter would pick its entry), so a space closes it; DSH trims it again.
    for (const [where, keys, typed] of [
      ['as the first word', `${TOKEN} ${T[8]}`, `${TOKEN} ${T[8]}`],
      ['inside the text', `${T[13]} ${TOKEN} please`, `${T[13]} ${TOKEN} please`],
      ['as the last word', `${T[14]} ${TOKEN} `, `${T[14]} ${TOKEN}`],
    ]) {
      await ask(s, keys)
      check(`X typing the token yourself (${where}) still raises the dialog, checked`, await skillBox(s).isChecked())
      await sendWith(s)
      const result = await landed(s)
      const text = result.turn?.users[0]?.text ?? ''
      check(`X a token typed ${where} is not doubled: the message is exactly what was typed, with one injection`, text === typed && occurrences(text, TOKEN) === 1 && result.turn?.injections.length === 1, `${JSON.stringify(text)}, injections=${String(result.turn?.injections.length)}`)
    }
  })

  // ---- X: a multi-line task keeps the token on its own LAST line
  await section('X-multiline', s, async () => {
    const typed = `${T[15]}\nand nothing else`
    await s.page.getByRole('textbox', { name: COMPOSER }).click()
    await s.page.getByRole('textbox', { name: COMPOSER }).fill(typed)
    await s.page.keyboard.press('Enter')
    await dialog(s).waitFor({ state: 'visible', timeout: 15_000 })
    s.sessionId = s.t.sessionIds.at(-1)
    check('X multi-line task: the dialog previews it on one line, whitespace collapsed', await dialog(s).getByText(`${T[15]} and nothing else`, { exact: true }).isVisible())
    await sendWith(s)
    const result = await landed(s)
    const text = result.turn?.users[0]?.text ?? ''
    check('X multi-line task: the lines are untouched and the token is the last line, on its own', text === withToken(typed) && text.split('\n').at(-1) === TOKEN && text.split('\n').length === 3, JSON.stringify(text))
    check('X multi-line task: DSH injected the skill', result.turn?.injections.length === 1)
  })

  // ---- X: a message with an attachment and no text: the token becomes a text part of its own
  await section('X-attach', s, async () => {
    const file = join(out, 'skill-attachment.txt')
    writeFileSync(file, 'one line of text for the attachment-only message\n')
    await s.page.locator('input[type=file]').first().setInputFiles(file)
    await s.page.waitForTimeout(800)
    const composer = s.page.getByRole('textbox', { name: COMPOSER })
    await composer.click()
    await s.page.keyboard.press('Enter')
    const asked = await dialog(s).waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)
    check('X an attachment with no text still raises the dialog, with the checkbox', asked && (await skillBox(s).count()) === 1)
    if (!asked) return
    s.sessionId = s.t.sessionIds.at(-1)
    await sendWith(s)
    const result = await landed(s)
    const parts = result.turn?.users[0]?.event.data.content.map((part) => part.type) ?? []
    check('X attachment-only message: the token is a text part of its own, in front of the file, and the skill was injected', result.turn?.users[0]?.text === TOKEN && parts.length === 2 && parts[0] === 'text' && result.turn?.injections.length === 1, `${parts.join(',')} | ${JSON.stringify(result.turn?.users[0]?.text)}`)
  })

  // ---- X: the answers so far, as the conversation's log sees them
  await section('X-log', s, async () => {
    const events = readEvents(s.sessionId)
    const copies = events.filter(isInjection)
    const tokened = turnsOf(events).filter((turn) => turn.users.some((user) => user.text.includes(TOKEN))).length
    check('X every message that carried the token got exactly one injection, none of the others got any', copies.length === tokened && turnsOf(events).every((turn) => turn.injections.length === (turn.users.some((user) => user.text.includes(TOKEN)) ? 1 : 0)), `${String(copies.length)} injections for ${String(tokened)} tokened messages`)
    advise('the skill text is injected again by EVERY tokened message (the history keeps each copy)', copies.length <= 1, `${String(copies.length)} copies x ${String(copies[0] === undefined ? 0 : textOfMessage(copies[0]).length)} chars in one conversation of ${String(turnsOf(events).length)} turns`)
  })

  // ---- X: the answer survives a reload and reaches a new conversation; the skill and a subagent model travel together
  await section('X-reload', s, async () => {
    await s.page.reload({ waitUntil: 'networkidle', timeout: 60_000 })
    await s.page.getByRole('textbox', { name: COMPOSER }).waitFor({ state: 'visible', timeout: 30_000 })
    check('X after a reload the remembered answer is still "on"', (await memory(s)) === 'on', await memory(s))
    await newConversation(s)
    const fresh = s.sessionId
    await ask(s, T[9])
    check('X a NEW conversation opens with the same remembered answer (CHECKED)', await skillBox(s).isChecked())
    check('X the new conversation is another session', s.sessionId !== undefined && s.sessionId !== fresh, `${String(s.sessionId).slice(0, 16)} vs ${String(fresh).slice(0, 16)}`)
    await dialog(s).getByRole('switch').click()
    await pick(s, /Choose a model/, WORKER.name)
    await s.page.waitForTimeout(300)
    check('X the skill checkbox is untouched by the switch and the model pick', await skillBox(s).isChecked())
    const postsBefore = s.t.wire.filter((entry) => entry.method === 'POST').length
    await sendWith(s)
    await s.page.waitForTimeout(500)
    const posts = s.t.wire.filter((entry) => entry.method === 'POST')
    const saved = posts.length > postsBefore ? JSON.parse(posts.at(-1).body ?? '{}').config : null
    check('X the stored configuration carries the model and NOTHING about the skill', saved?.subagentModel?.model === WORKER.id && Object.keys(saved).sort().join() === 'reviewer,subagentModel,version,workerEffort', JSON.stringify(saved))
    check('X the host accepted it (200)', posts.at(-1)?.status === 200, posts.at(-1)?.status)
    const result = await landed(s)
    check('X skill + subagent model: the message still carries the token and the skill was injected', result.turn?.users[0]?.text === withToken(T[9]) && result.turn?.injections.length === 1, JSON.stringify(result.turn?.users[0]?.text))
    const title = readEvents(s.sessionId).filter((event) => event.type === 'session/title').at(-1)?.data
    check('X the conversation title (DSH derives it from the first words of the first message) is the typed text, with no token', title !== undefined && !title.title.includes(TOKEN) && T[9].startsWith(title.title), `title=${JSON.stringify(title?.title)} source=${JSON.stringify(title?.source)}`)
    await shot(s, 'X-skill-and-model')

    // A SHORT first message: DSH's fallback title takes up to five words, so the token on its own line can still make it in.
    await newConversation(s)
    await ask(s, 'Say ok')
    await sendWith(s)
    const short = await landed(s)
    const shortTitle = readEvents(s.sessionId).filter((event) => event.type === 'session/title').at(-1)?.data
    check('X a short first message ("Say ok") still carries the token and gets the skill', short.turn?.users[0]?.text === withToken('Say ok') && short.turn?.injections.length === 1, JSON.stringify(short.turn?.users[0]?.text))
    advise('the title of a conversation that starts with a SHORT message (fewer than five words) does not contain the token', shortTitle !== undefined && !shortTitle.title.includes(TOKEN), `title=${JSON.stringify(shortTitle?.title)} source=${JSON.stringify(shortTitle?.source)}`)
    await shot(s, 'X-short-title')
  })

  await s.context.close()
}

// ------------------------------------------------------------------------------------------------ S10: a subagent's own conversation

/**
 * Every ROOT session of this home that has subagent children, read from the logs: `{ rootId, titles, kids }`. A subagent's
 * own log is headed by `origin: 'subagent'` and names its `parentSession`, so the roots are the sessions whose first event
 * carries neither; the parent's `subagent/catalog` events give each child's mode — `continuable` is the child that takes
 * further messages, the one the header dropdown offers as a conversation of its own. A title is no way to find a session:
 * DSH rewrites it (a rename, source `user`) and a generated title can win the sidebar over the rewrite (measured here), so
 * every title the log ever carried is kept, most recent first, and the row is looked up by whichever one the sidebar shows.
 */
function parentsWithChildren() {
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
      if (events[0]?.origin === 'subagent' || events[0]?.parentSession !== undefined) continue
      const titles = [...new Set(events.filter((event) => event.type === 'session/title' && typeof event.data?.title === 'string').map((event) => event.data.title))].reverse()
      const kids = []
      const seen = new Set()
      for (const event of events) {
        if (event.type !== 'subagent/catalog' || seen.has(event.data.childId)) continue
        seen.add(event.data.childId)
        kids.push({ id: event.data.childId, mode: event.data.mode ?? null, label: event.data.label ?? null })
      }
      if (titles.length > 0 && kids.length > 0) found.push({ rootId: id, titles, kids })
    }
  }
  return found
}

/** The sidebar row of the session whose log carried one of `titles` (a long title may be cut in the row: its opening words count too). */
async function sessionRow(s, titles) {
  const sidebar = s.page.getByRole('tree', { name: 'Sessions' })
  const candidates = [...titles, ...titles.filter((title) => title.length > 30).map((title) => title.slice(0, 30))]
  for (const title of candidates) {
    const rows = sidebar.getByRole('treeitem').filter({ hasText: title })
    if (await rows.count() > 0) return { row: rows.first(), title }
  }
  return undefined
}

/** The whole sidebar loaded: collapsed groups opened and "Show more sessions" pressed until it stops offering more. */
async function expandSidebar(s) {
  const sidebar = s.page.getByRole('tree', { name: 'Sessions' })
  for (let index = 0; index < 20; index += 1) {
    const collapsed = sidebar.locator('[role=treeitem][aria-expanded=false]').first()
    if (await collapsed.count() === 0) break
    await collapsed.click()
    await s.page.waitForTimeout(200)
  }
  for (let index = 0; index < 20; index += 1) {
    const more = sidebar.getByRole('button', { name: /Show \d+ more sessions/ }).first()
    if (await more.count() === 0) break
    await more.click()
    await s.page.waitForTimeout(200)
  }
}

/**
 * From the header dropdown of a parent session, open a child that takes messages: a continuable one. The parent and its
 * children come from the logs (`parentsWithChildren`), never from a title written down here, so this works on any home.
 * `undefined` = this home holds no continuable child at all (the step SKIPs, cleanly); an exception = it holds one that
 * could not be opened, which is a FAIL of the step and not a SKIP.
 */
async function openContinuableChild(s) {
  const parents = parentsWithChildren().filter((parent) => parent.kids.some((kid) => kid.mode === 'continuable'))
  if (parents.length === 0) return undefined
  await expandSidebar(s)
  for (const parent of parents.sort((left, right) => left.kids.length - right.kids.length)) {
    const hit = await sessionRow(s, parent.titles)
    if (hit === undefined) continue
    const before = s.t.sessionIds.length
    await hit.row.click()
    for (let waited = 0; waited < 5_000 && s.t.sessionIds.length === before; waited += 100) await s.page.waitForTimeout(100)
    await s.page.waitForTimeout(700)
    await s.page.mouse.move(8, 8)
    await s.page.waitForTimeout(150)
    await s.page.locator(TRIGGER).first().hover()
    const menu = s.page.locator(TREE)
    if (!(await menu.waitFor({ state: 'attached', timeout: 6_000 }).then(() => true, () => false))) continue
    await s.page.waitForTimeout(250)
    const items = menu.getByRole('treeitem')
    const texts = await items.evaluateAll((elements) => elements.map((element) => (element.textContent ?? '').replace(/\s+/g, ' ')))
    const wanted = texts.findIndex((text) => text.includes('continuable'))
    if (wanted < 0) {
      await s.page.mouse.move(8, 8)
      continue
    }
    await items.nth(wanted).click()
    await s.page.waitForTimeout(2_000)
    return { parent, row: hit.title, label: texts[wanted], switcher: await s.page.locator(TRIGGER).first().getAttribute('aria-label').catch(() => null) }
  }
  throw new Error(`this home holds ${String(parents.length)} parent(s) with a continuable child (titles: ${parents.map((parent) => parent.titles.join(' / ')).join('; ')}) but none could be opened from the sidebar`)
}

async function child() {
  const s = await newPage('S10-child')
  await open(s)
  await section('S10', s, async () => {
    const opened = await openContinuableChild(s)
    if (opened === undefined) {
      skip('S10 a subagent\'s own conversation', 'no continuable child in this DSH home (run a background `subagent` task first)')
      return
    }
    check('S10 the parent\'s header dropdown opens the child\'s own conversation (the header switcher names it)', /^Switch subagent: /.test(opened.switcher ?? ''), `child=${opened.label} :: switcher=${String(opened.switcher)} :: parent titles=${opened.parent.titles.join(' / ')} :: shown as=${opened.row}`)
    // The prompt is captured and ABORTED: no model runs in the child, and the content that would go out is what is judged.
    const toChild = []
    const toMain = []
    await s.page.route('**/api/subagents/prompt', async (route) => { toChild.push(route.request().postData() ?? ''); await route.abort() })
    await s.page.route('**/api/session/prompt', async (route) => { toMain.push(route.request().postData() ?? ''); await route.abort() })
    s.t.expecting = true
    const outgoing = (body) => { try { return JSON.parse(body).payload.args.request.content.map((part) => part.text ?? `<${part.type}>`).join('') } catch { return undefined } }
    const waitSends = async (count) => { for (let waited = 0; waited < 8_000 && toChild.length < count; waited += 250) await s.page.waitForTimeout(250) }

    await ask(s, T[16])
    const dlg = dialog(s)
    check('S10 a subagent\'s own conversation raises the dialog too', await dlg.isVisible())
    check('S10 ...with NO skill section and NO checkbox (the skill is for the agent that coordinates)', (await dlg.getByRole('checkbox').count()) === 0 && (await dlg.getByRole('heading', { name: SKILL_TITLE }).count()) === 0 && (await dlg.getByText(/orchestration skill/i).count()) === 0 && (await dlg.getByText(TOKEN).count()) === 0)
    check('S10 ...and still has the subagent switch and the Send button', (await dlg.getByRole('switch').count()) === 1 && (await dlg.getByRole('button', { name: SEND }).isVisible()))
    await shot(s, 'S10-subagent-dialog')
    await s.page.keyboard.press('Escape')
    await dlg.waitFor({ state: 'hidden', timeout: 8_000 })
    await waitSends(1)
    check('S10 Escape: the message that goes out is exactly what was typed, with no token (and it goes to the subagent, not to the main agent)', toChild.length === 1 && toMain.length === 0 && outgoing(toChild[0]) === T[16], JSON.stringify(outgoing(toChild[0])))

    // The aborted send left its text in the composer (DSH gives a failed send back, asynchronously): wait until the composer
    // stops changing, then empty it, or the restored text lands after the new task and travels out with it.
    const composer = s.page.getByRole('textbox', { name: COMPOSER })
    let previous = null
    for (let stable = 0; stable < 4;) {
      await s.page.waitForTimeout(500)
      const now = (await composer.innerText()).trim()
      stable = now === previous ? stable + 1 : 0
      previous = now
    }
    await composer.click()
    await s.page.keyboard.press('Control+A')
    await s.page.keyboard.press('Backspace')
    await ask(s, T[17])
    check('S10 the next dialog in the subagent conversation has no checkbox either', (await dialog(s).getByRole('checkbox').count()) === 0)
    await sendWith(s)
    await waitSends(2)
    // DSH's give-back of the aborted message can still land in the composer after the clear (measured on this home), so the
    // payload may be the typed task followed by that leftover. What S10 is about is that no token ever goes out to a child.
    const second = outgoing(toChild[1]) ?? ''
    check('S10 "Send with these options": the message that goes out has no token either', toChild.length === 2 && toMain.length === 0 && second.includes(T[17]) && !second.includes(TOKEN), JSON.stringify(second))
    await s.page.waitForTimeout(1_000)
    s.t.expecting = false
  })
  await s.context.close()
}

// ------------------------------------------------------------------------------------------------ S6: both themes, a short screen

async function colorsOf(s) {
  return s.page.evaluate((labelText) => {
    const dialogElement = document.querySelector('[role=dialog]')
    const label = [...dialogElement.querySelectorAll('span')].find((element) => element.textContent === labelText)
    const hint = dialogElement.querySelector('.dsh-orq-skill-hint')
    const heading = [...dialogElement.querySelectorAll('h3')].find((element) => element.textContent?.includes('Orchestration skill'))
    const backdrop = (start) => {
      for (let node = start; node !== null; node = node.parentElement) {
        const color = getComputedStyle(node).backgroundColor
        const alpha = color.startsWith('rgba') ? Number(color.split(',')[3]) : 1
        if (alpha > 0.5) return color
      }
      return 'rgb(255, 255, 255)'
    }
    return {
      label: label === undefined ? null : { color: getComputedStyle(label).color, background: backdrop(label) },
      hint: hint === null ? null : { color: getComputedStyle(hint).color, background: backdrop(hint) },
      heading: heading === undefined ? null : { color: getComputedStyle(heading).color, background: backdrop(heading) },
    }
  }, SKILL_LABEL)
}

async function themes() {
  // light theme, a normal desktop window
  const light = await newPage('S6-light', { scheme: 'light' })
  await section('S6-light', light, async () => {
    await open(light)
    await ask(light, T[10])
    const dlg = dialog(light)
    await dlg.getByRole('checkbox').first().waitFor({ state: 'visible', timeout: 8_000 })
    check('S6 light theme: the skill section renders (heading, one checked checkbox, the hint)', (await skillRegion(light).count()) === 1 && (await skillRegion(light).isVisible()) && (await skillBox(light).isVisible()) && await skillBox(light).isChecked() && (await skillRegion(light).innerText()).includes(TOKEN))
    check('S6 light theme: the rest of the dialog is intact (one switch, off; Send is visible)', (await dlg.getByRole('switch').count()) === 1 && (await dlg.getByRole('button', { name: SEND }).isVisible()))
    const colors = await colorsOf(light)
    const ratio = (entry) => (entry === null ? 0 : contrast(entry.color, entry.background))
    check('S6 light theme: checkbox label, heading and hint are legible on the dialog (contrast >= 4.5 / 4.5 / 3)', ratio(colors.label) >= 4.5 && ratio(colors.heading) >= 4.5 && ratio(colors.hint) >= 3, `label ${ratio(colors.label).toFixed(1)}, heading ${ratio(colors.heading).toFixed(1)}, hint ${ratio(colors.hint).toFixed(1)}`)
    await shot(light, 'S6-light')
  })
  await light.context.close()

  // a short laptop screen, in both themes: model on, effort block open, skill section present
  for (const scheme of ['dark', 'light']) {
    const small = await newPage(`S6-small-${scheme}`, { scheme, viewport: { width: 1024, height: 600 } })
    await section(`S6-small-${scheme}`, small, async () => {
      await open(small)
      await ask(small, T[11])
      const dlg = dialog(small)
      await dlg.getByRole('switch').click()
      await pick(small, /Choose a model/, WORKER.name)
      await dlg.getByRole('button', { name: 'Show', exact: true }).click()
      await small.page.waitForTimeout(600)
      const box = await dlg.boundingBox()
      const sendBox = await dlg.getByRole('button', { name: SEND }).boundingBox()
      const label = `S6 ${scheme} 1024x600 (model on, effort open)`
      check(`${label}: the dialog is not taller than the viewport and is inside it`, box !== null && box.height <= 600 && box.y >= 0 && box.y + box.height <= 600, JSON.stringify(box))
      check(`${label}: "${SEND}" is inside the viewport and the dialog`, sendBox !== null && box !== null && sendBox.y >= box.y && sendBox.y + sendBox.height <= Math.min(600, box.y + box.height), JSON.stringify(sendBox))
      check(`${label}: the skill section is present, with one checked checkbox`, (await skillRegion(small).count()) === 1 && (await skillBox(small).count()) === 1 && await skillBox(small).isChecked())
      const info = await skillBox(small).evaluate((element) => {
        for (let node = element.parentElement; node !== null && node !== document.body; node = node.parentElement) {
          const style = getComputedStyle(node)
          if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1) return { scrolls: true, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }
        }
        return { scrolls: false }
      })
      check(`${label}: the stack scrolls (its content is taller than its box)`, info.scrolls, JSON.stringify(info))
      await skillBox(small).scrollIntoViewIfNeeded()
      const placed = await skillBox(small).evaluate((element) => {
        const rect = element.getBoundingClientRect()
        const dialogRect = document.querySelector('[role=dialog]').getBoundingClientRect()
        const footer = [...document.querySelectorAll('[role=dialog] button')].find((button) => button.textContent === 'Send with these options')?.getBoundingClientRect()
        return { top: rect.top, bottom: rect.bottom, dialogTop: dialogRect.top, footerTop: footer?.top ?? 0 }
      })
      check(`${label}: scrolled to the end, the checkbox is fully visible above the footer buttons`, placed.top >= placed.dialogTop && placed.bottom <= placed.footerTop + 1, JSON.stringify(placed))
      const state = await skillBox(small).isChecked()
      await dlg.getByText(SKILL_LABEL, { exact: true }).click({ timeout: 4_000 })
      check(`${label}: a real click on the checkbox label toggles it (nothing covers it)`, (await skillBox(small).isChecked()) === !state)
      await dlg.getByText(SKILL_LABEL, { exact: true }).click({ timeout: 4_000 })
      await shot(small, `S6-small-${scheme}`)
    })
    await small.context.close()
  }
}

// ------------------------------------------------------------------------------------------------ S8: wire compatibility

async function wire() {
  const s = await newPage('S8-wire')
  const pattern = '**/dsh-orquestrator/config*'
  let mode = 'passthrough'
  await s.page.route(pattern, async (route) => {
    if (mode === 'passthrough') return route.continue()
    if (mode === 'error' && route.request().method() === 'GET') return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'internal', message: 'injected failure' }) })
    const response = await route.fetch()
    const json = await response.json()
    if (mode === 'absent') delete json.skill
    if (mode === 'unavailable') json.skill = { name: SKILL, available: false }
    if (mode === 'malformed') json.skill = { name: 'Not A Name!', available: true }
    await route.fulfill({ response, json })
  })
  await open(s)
  let turn = 0

  /** One message under one route behaviour: the dialog must show no skill section, and a confirm must send no token. */
  const noSection = async (name, behaviour, text, how) => {
    mode = behaviour
    if (behaviour === 'error') s.t.expecting = true
    await ask(s, text)
    const dlg = dialog(s)
    await dlg.getByRole('switch').waitFor({ state: 'visible', timeout: 8_000 })
    check(`S8 ${name}: the dialog still asks (the subagent switch is there)`, (await dlg.getByRole('switch').count()) === 1)
    check(`S8 ${name}: NO skill section and NO checkbox`, (await dlg.getByRole('checkbox').count()) === 0 && (await dlg.getByRole('heading', { name: SKILL_TITLE }).count()) === 0 && (await dlg.getByText(TOKEN).count()) === 0, await dlg.getByRole('checkbox').count())
    await shot(s, `S8-${slug(name)}`)
    if (how === 'confirm') await sendWith(s)
    else { await s.page.keyboard.press('Escape'); await dlg.waitFor({ state: 'hidden', timeout: 8_000 }) }
    turn += 1
    const result = await awaitTurn(s, turn)
    check(`S8 ${name}: the message went out as typed, with no token and no injection`, result.turn?.users[0]?.text === text && result.turn?.injections.length === 0, JSON.stringify(result.turn?.users[0]?.text))
    s.t.expecting = false
  }

  await section('S8-absent', s, () => noSection('a host without the skill field (older than 0.8)', 'absent', T[0], 'confirm'))
  const seen = s.t.wire.filter((entry) => entry.method === 'GET').at(-1)
  check('S8 the page really received an answer without the skill field', seen !== undefined && seen.skill === '<absent>', JSON.stringify(seen?.skill))
  await section('S8-unavailable', s, () => noSection('a host that says available: false', 'unavailable', T[1], 'confirm'))
  check('S8 a send with no skill on offer does not touch the remembered answer', (await memory(s)) === null, await memory(s))
  await section('S8-malformed', s, () => noSection('a malformed offer (name "Not A Name!")', 'malformed', T[2], 'escape'))
  await section('S8-error', s, () => noSection('a configuration route that fails (HTTP 500)', 'error', T[3], 'confirm'))

  // The unmodified route: the section is back, checked (nothing was ever answered), and a confirm carries the token.
  await section('S8-passthrough', s, async () => {
    mode = 'passthrough'
    await s.page.unroute(pattern)
    await ask(s, T[4])
    const dlg = dialog(s)
    check('S8 unmodified route: the skill section is back (one checkbox, named, in the section)', (await dlg.getByRole('checkbox').count()) === 1 && (await skillBox(s).count()) === 1 && (await skillRegion(s).count()) === 1)
    check('S8 unmodified route: the checkbox opens CHECKED (the earlier sends never recorded an answer)', await skillBox(s).isChecked())
    await shot(s, 'S8-unmodified')
    await sendWith(s)
    turn += 1
    const result = await awaitTurn(s, turn)
    check('S8 unmodified route: confirm sends the token and DSH injects the skill', result.turn?.users[0]?.text === withToken(T[4]) && result.turn?.injections.length === 1, JSON.stringify(result.turn?.users[0]?.text))
  })

  // A save that fails: the dialog stays open with the error, the user's answer is kept, nothing is sent, and a retry sends it.
  await section('S8-save-fails', s, async () => {
    s.t.expecting = true
    await s.page.route(pattern, (route) => (route.request().method() === 'POST'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'internal', message: 'disk full (injected)' }) })
      : route.continue()))
    await ask(s, T[5])
    const dlg = dialog(s)
    const before = turnsOf(readEvents(s.sessionId)).length
    await skillBox(s).uncheck()
    await dlg.getByRole('button', { name: SEND }).click()
    await s.page.waitForTimeout(1_500)
    check('S8 a failing save keeps the dialog open with an alert, and the answer the user gave (unchecked) is still there', (await dlg.isVisible()) && (await dlg.getByRole('alert').count()) === 1 && !(await skillBox(s).isChecked()), await dlg.getByRole('alert').allInnerTexts())
    check('S8 a failing save sends nothing and remembers nothing new (still "on" from the last confirm)', turnsOf(readEvents(s.sessionId)).length === before && (await memory(s)) === 'on', await memory(s))
    await shot(s, 'S8-save-failed')
    await s.page.unroute(pattern)
    s.t.expecting = false
    await skillBox(s).check()
    await sendWith(s)
    turn += 1
    const result = await awaitTurn(s, turn)
    check('S8 after the retry the message goes out with the token and the skill is injected', result.turn?.users[0]?.text === withToken(T[5]) && result.turn?.injections.length === 1, JSON.stringify(result.turn?.users[0]?.text))
  })
  await s.context.close()
}

// ------------------------------------------------------------------------------------------------ X: a message sent while a turn runs

async function queued() {
  const s = await newPage('X-queue')
  await open(s)
  await section('X-queue', s, async () => {
    await ask(s, 'Run the shell command: sleep 15 ; then reply with exactly the word: slept')
    await skillBox(s).uncheck()
    await sendWith(s)
    await s.page.getByRole('button', { name: 'Stop generating' }).waitFor({ state: 'visible', timeout: 20_000 })
    await s.page.waitForTimeout(2_500)
    await ask(s, T[12])
    check('X-queue the dialog also opens while a turn is running (checkbox unchecked: the last answer)', !(await skillBox(s).isChecked()))
    await skillBox(s).check()
    await sendWith(s)
    const first = await awaitTurn(s, 1, 90_000)
    const second = await awaitTurn(s, 2, 60_000)
    check('X-queue the first message went out as typed, with no injection', first.turn?.users[0]?.text.startsWith('Run the shell command') && first.turn?.injections.length === 0)
    check('X-queue the message sent during the run carries the token, and DSH injects the skill when its turn starts', second.turn?.users[0]?.text === withToken(T[12]) && second.turn?.injections.length === 1, JSON.stringify(second.turn?.users[0]?.text))
  })
  await s.context.close()
}

// ------------------------------------------------------------------------------------------------ run

const failuresOf = (tracker) => ({
  uncaught: tracker.uncaught,
  // The shell asks for a file-manager icon the Linux build does not ship: not this plugin's request.
  consoleErrors: tracker.consoleErrors.filter((entry) => !entry.expected && !(tracker.failed.length > 0 && tracker.failed.every((item) => item.path.startsWith('/open-in-app/icon/') || item.expected) && entry.text.startsWith('Failed to load resource'))),
  failedOrq: tracker.failed.filter((item) => item.path.includes('/dsh-orquestrator/') && !item.expected),
})

let crashed
try {
  if (steps.has('conversation')) await conversation()
  if (steps.has('child')) await child()
  if (steps.has('themes')) await themes()
  if (steps.has('wire')) await wire()
  if (steps.has('queue')) await queued()
} catch (error) {
  crashed = scrub(error?.stack ?? error)
  check('the run reached its end without an unhandled exception', false, crashed.split('\n')[0])
}

const collected = trackers.map((tracker) => ({ label: tracker.label, ...failuresOf(tracker) }))
const uncaught = collected.flatMap((item) => item.uncaught.map((text) => `${item.label}: ${text}`))
const consoleErrors = collected.flatMap((item) => item.consoleErrors.map((entry) => `${item.label}: ${entry.text}`))
const failedOrq = collected.flatMap((item) => item.failedOrq.map((entry) => `${item.label}: ${entry.method} ${entry.path} -> ${String(entry.status)}`))
check('S9 no uncaught page errors in any step', uncaught.length === 0, uncaught.join(' | '))
check('S9 no console errors in any step (the known foreign /open-in-app/icon/ 404s, the injected HTTP 500s and the aborted subagent prompts excluded)', consoleErrors.length === 0, consoleErrors.join(' | '))
check('S9 no failed /dsh-orquestrator/ responses in any step (the deliberately injected HTTP 500s excluded)', failedOrq.length === 0, failedOrq.join(' | '))

writeFileSync(join(out, `${phase}.report.json`), JSON.stringify({
  phase,
  steps: [...steps],
  checks,
  advice,
  skipped,
  eventShapes: shapes,
  trackers: trackers.map((tracker) => ({
    label: tracker.label,
    uncaught: tracker.uncaught,
    consoleErrors: tracker.consoleErrors,
    failedResponses: tracker.failed,
    wire: tracker.wire.map((entry) => ({ method: entry.method, status: entry.status, skill: entry.skill, config: entry.config === null ? null : (entry.config === undefined ? undefined : 'set'), body: entry.body === null ? null : String(entry.body).slice(0, 300) })),
  })),
  crashed,
}, null, 2))
const failed = checks.filter((item) => !item.ok)
console.log(`\n${phase}: ${String(checks.length - failed.length)}/${String(checks.length)} checks passed; pages=${String(trackers.length)}; uncaught=${String(uncaught.length)}; failed /dsh-orquestrator/=${String(failedOrq.length)}`)
console.log(`advice (not counted): ${String(advice.filter((item) => item.ok).length)}/${String(advice.length)} ok; skipped: ${String(skipped.length)}`)
if (shapes.S2_userMessage !== undefined) console.log(`SHAPE S2 user/message: ${shapes.S2_userMessage}`)
if (shapes.S3_userMessage !== undefined) console.log(`SHAPE S3 user/message: ${shapes.S3_userMessage}`)
if (shapes.S3_injectedMessage !== undefined) console.log(`SHAPE S3 injected   : ${shapes.S3_injectedMessage}`)
await browser.close()
process.exit(failed.length === 0 ? 0 : 1)
