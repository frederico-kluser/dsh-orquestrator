#!/usr/bin/env node
/**
 * Browser end-to-end checks of the dsh-orquestrator modal against a REAL DSH
 * web server (run on the validation machine with an isolated DSH_HOME).
 *
 *   DSH_URL=<authenticated dsh web URL> OUT_DIR=<dir> PHASE=<name> node ui-e2e.mjs
 *   PHASE=<name> scripts/e2e/with-server.sh node scripts/e2e/ui-e2e.mjs    starts that isolated server (and DSH_URL) for you
 *
 * PHASE:
 *   cancel    a new task raises the modal (one switch, no "do not ask again"); Escape/Cancel sends it as stock DSH
 *   small     a short laptop screen with the model chosen and the effort select on screen: the actions stay reachable
 *   light     light theme, keyboard focus trap, Esc handling while a menu is open
 *   command   /orquestrar opens the configure dialog, Save persists, and the next send asks again (pre-filled)
 *   effort    the native reasoning-effort select (always visible, a first neutral option, the model's own ladder,
 *             auto-max on a model pick) and the model notes; it only clicks through the dialog and sends one-word tasks
 *   confirm   choose the subagent model, send, and read the child back from the DSH session logs (needs ORQ_SESSIONS_DIR)
 *   readme    README screenshots: a realistic task, the dialog empty and then with a model chosen. The browser is closed
 *             without answering the dialog, so the task is never sent to a model (`readme` is dark, `readme-light` light)
 *   workflow  the choice made in the dialog (stored through the route, not a `defaults` config) governs the agents
 *             of a `workflow` the main agent starts; needs ORQ_SESSIONS_DIR (the DSH home's sessions directory of
 *             this server's workspace, which is the LAST workspace any DSH registered in that home, not the directory the
 *             server was started in) so the children's route, effort and token cap are read back from the logs
 *
 * Models: ONLY the three target models are ever picked or run. The main agent is the DSH home's
 * default model (GLM 5.3); the dialog picks DeepSeek V4.1 Flash for subagents (the `TRIO` patterns below). The
 * phases that need no model run only click through the dialog.
 *
 * Writes <OUT_DIR>/<phase>.report.json (one entry per check) and screenshots. A run that dies on the browser (a step
 * that times out) still writes its report, a screenshot and the page's own timeline as <phase>.crash.*: the phases drive
 * a real server, and a crash used to leave nothing behind but a Playwright stack. `ORQ_E2E_TRACE=0` silences the
 * per-step TRACE lines; the timeline kept for the crash dump is always recorded.
 * The token in DSH_URL is a per-process credential: it is never written out (the traced URL keeps its path only).
 */
import { chromium } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const url = process.env.DSH_URL
const out = process.env.OUT_DIR ?? '.'
const phase = process.env.PHASE ?? 'cancel'
if (url === undefined) throw new Error('DSH_URL is required')
mkdirSync(out, { recursive: true })

// DSH lands either on the new-session view ("Describe what you want to build") or on a blank conversation ("Message or
// run a task"): a start-up race of its own, so `open()` takes whichever composer is there (same as the skill script).
const COMPOSER = /Describe what you want to build|Message or run a task/
/**
 * The HERO composer's own placeholder: the one a BLANK session draws (DSH renders a session with no turns as the
 * new-session view). It is the marker that "New session" has finished switching — see `newSession()`.
 */
const HERO = /Describe what you want to build/
/** The three target models, as the dialog's catalog names them and as the wire carries them. */
const TRIO = {
  worker: /DeepSeek V4\.1 Flash \(Azure\)/,
  workerId: 'DeepSeek-V4.1-Flash',
  mimo: /MiMo-V2\.6-Pro/i,
  mimoId: 'xiaomi/mimo-v2.6-pro',
  glm: /GLM 5\.3/,
  glmId: 'z-ai/glm-5.3',
}
/** The names a model catalog lists: a native select that draws them is the model picker, not the effort select. */
const MODELISH = /GLM|DeepSeek|MiMo|Claude|GPT|Gemini|Kimi|Qwen|Grok|Llama|Mistral|Sonnet|Haiku/i
/** The reasoning levels DSH itself uses (pi-ai's escalation order), matched as words and never as the whole option. */
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const levelOf = (text) => LEVELS.find((level) => new RegExp(`(^|[^a-z])${level}([^a-z]|$)`, 'i').test(text))
const DIALOG = 'Orchestrate subagents'
const checks = []
const wire = []

const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 400) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  [${String(detail).slice(0, 200)}]`}`)
}

// CHROME_PATH points at a Chrome/Chromium binary when there is no system Chrome (the default `channel: 'chrome'`).
const chromePath = process.env.CHROME_PATH
const browser = await chromium.launch(chromePath === undefined ? { channel: 'chrome', headless: true } : { executablePath: chromePath, headless: true, args: ['--no-sandbox'] })
const scheme = phase === 'light' || phase === 'readme-light' ? 'light' : 'dark'
const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: scheme })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 300)))
page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(`console: ${message.text().slice(0, 200)}`) })
const failedUrls = []
// The shell asks for a file-manager icon the Linux build does not ship; it is not this plugin's request.
const relevantErrors = () => {
  const foreign = failedUrls.length > 0 && failedUrls.every((entry) => entry.includes(' /open-in-app/icon/'))
  return pageErrors.filter((error) => !(foreign && error.startsWith('console: Failed to load resource')))
}
page.on('response', (response) => {
  // Name the URL behind a console "Failed to load resource": the token never reaches the report.
  if (response.status() >= 400) failedUrls.push(`${String(response.status())} ${new URL(response.url()).pathname}`)
})
page.on('request', (request) => {
  if (!request.url().includes('/dsh-orquestrator/config')) return
  wire.push({ method: request.method(), path: new URL(request.url()).pathname, query: new URL(request.url()).search, body: request.postData() ?? null })
})
page.on('response', (response) => {
  if (!response.url().includes('/dsh-orquestrator/config')) return
  const entry = [...wire].reverse().find((item) => item.status === undefined)
  if (entry === undefined) return
  entry.status = response.status()
  // The host's own answer, kept on the entry: what it had stored for the session the gate asked about (or null). A
  // phase must compare a dialog's pre-fill against THIS: "New session" may reuse an abandoned session, and a reused
  // session legitimately reopens with the level a PREVIOUS run stored for it.
  void response.text().then((text) => { entry.response = text.slice(0, 4000) }).catch(() => undefined)
})

const shot = async (name) => { await page.screenshot({ path: `${out}/${phase}-${name}.png` }) }
const composer = () => page.getByRole('textbox', { name: COMPOSER }).first()
const dialog = () => page.getByRole('dialog', { name: DIALOG })

// --------------------------------------------------------------------------- the page's own timeline (crash evidence)
/**
 * Who moved the page, recorded while it happens. A phase that dies on the browser leaves nothing but a Playwright
 * stack, and the question a dialog that never showed (or that vanished after a passing check) asks is always the same:
 * did the SCRIPT leave the composer it typed into, or did the PRODUCT take the dialog away? So earlier steps record
 * what they did (`trace`), and a MutationObserver installed before the first paint watches the two nodes that decide
 * it — the plugin's dialog and the host's composer (`data-composer-input`, the attribute DSH's own e2e tests use):
 * a composer ADDED/REMOVED is a pane swap or a remount, a dialog REMOVED is the dialog leaving. Both counters are
 * sampled with each event, so a dialog that goes away while the composer is replaced is told from one that goes away
 * with the composer untouched. Nothing here reaches the report: the timeline names steps and carries no token.
 */
const TRACE = process.env.ORQ_E2E_TRACE !== '0'
await page.addInitScript(() => {
  window.__orqTimeline = []
  const interest = (node) => node instanceof Element
    && (node.matches('[role=dialog],[data-composer-input]') || node.querySelector('[role=dialog],[data-composer-input]') !== null)
  const note = (kind, node) => {
    if (!interest(node)) return
    window.__orqTimeline.push({
      at: Math.round(performance.now()),
      kind,
      dialogs: document.querySelectorAll('[role=dialog]').length,
      composers: document.querySelectorAll('[data-composer-input]').length,
    })
    if (window.__orqTimeline.length > 400) window.__orqTimeline.shift()
  }
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) note('added', node)
      for (const node of record.removedNodes) note('removed', node)
    }
  }).observe(document, { childList: true, subtree: true }) // `document` is there from the first script; documentElement is not
})
/** Name a step in the page's timeline (read back by a crash dump, and printed when tracing is on). */
async function trace(step) {
  await page.evaluate((name) => { (window.__orqTimeline ??= []).push({ at: Math.round(performance.now()), step: name }) }, step).catch(() => undefined)
  if (TRACE) console.log(`TRACE ${step} ${JSON.stringify(await shape())}`)
}
/** The URL without its query: the token lives there and is never written out. */
const cleanUrl = (value) => { try { const parsed = new URL(value); return `${parsed.origin}${parsed.pathname}` } catch { return '<url>' } }
/** The page's shape right now, read without waiting: what this step believes about the dialog and the composer. */
async function shape() {
  return {
    url: cleanUrl(page.url()),
    dialogs: await page.locator('[role=dialog]').count().catch(() => -1),
    composers: await page.locator('[data-composer-input]').count().catch(() => -1),
    hero: await page.getByRole('textbox', { name: HERO }).first().isVisible().catch(() => false),
    held: (await composerText()).slice(0, 70),
  }
}
/** The dialog's own text and the composer's, as the DOM holds them now: small, and free of the boot payload. */
async function domNow() {
  const of = async (locator) => locator.first().evaluate((element) => element.outerHTML.replace(/\s+/g, ' ').slice(0, 1500)).catch(() => '<none>')
  return { dialog: await of(page.locator('[role=dialog]')), composer: await of(page.locator('[data-composer-input]')) }
}

/** The session id of a config request on the wire (the state route carries it as a query parameter). */
const sessionOf = (entry) => (entry === undefined ? undefined : new URLSearchParams(entry.query ?? '').get('sessionId') ?? undefined)

/**
 * The session the dialog on screen belongs to: the one whose stored state the gate read before raising it. Every send
 * reads it (`beforePrompt` -> `loadState`), so the LAST read is that dialog's session — the phase needs it to know what
 * the dialog is allowed to pre-fill from.
 */
function lastReadSession() {
  return sessionOf([...wire].reverse().find((item) => item.method === 'GET' && item.response !== undefined))
}

/** The host's answer about one session, as it answered the gate: `{sessionId, config, skill}`, or undefined if unread. */
function hostAnswer(sessionId) {
  if (sessionId === undefined) return undefined
  const entry = [...wire].reverse().find((item) => item.method === 'GET' && sessionOf(item) === sessionId && item.response !== undefined)
  if (entry === undefined) return undefined
  try {
    return JSON.parse(entry.response)
  } catch {
    return undefined
  }
}

/** The session a POST carries in its body (the write route names it there, not in the query). */
const bodySession = (entry) => {
  try {
    return JSON.parse(entry.body ?? '{}').sessionId ?? undefined
  } catch {
    return undefined
  }
}

/** Whether the plugin's own clear (`config: null`) for a session already went out on the wire. */
const clearedOnWire = (sessionId) => wire.some((item) => {
  if (item.method !== 'POST' || bodySession(item) !== sessionId) return false
  try {
    return JSON.parse(item.body ?? '{}').config === null
  } catch {
    return false
  }
})

/**
 * Ask a task whose dialog opens on the INERT configuration, whatever the page landed on.
 *
 * A shared validation home keeps one choice per conversation — the plugin stores it per session, `New session` reuses
 * an abandoned session, and the server restores the last conversation on load — so a dialog can arrive with the switch
 * already on and a level already picked, which is the opposite of what the phases that witness the dialog's INITIAL
 * state (the switch off, the neutral effort row, "confirm waits for a model") need. Cancelling the first dialog IS the
 * clear: a gate-mode cancel stores null for that session (`save(null)`), and the message goes out as stock DSH. The
 * same task is then asked again, and that dialog opens inert — nothing is remembered by a cancel, and the browser
 * context is new, so the plugin's fallback is its OFF configuration.
 * @param task - the task text to ask with.
 * @returns the session the dialog belongs to and whether a stored choice had to be cleared first.
 */
async function askClean(task) {
  await typeTask(task)
  await page.keyboard.press('Enter')
  await dialog().waitFor({ state: 'visible', timeout: 15_000 })
  const session = lastReadSession()
  const stored = hostAnswer(session)?.config ?? null
  if (stored === null) return { session, cleaned: false }
  await trace(`clean-ask: ${String(session).slice(0, 12)} arrived with a stored choice`)
  await page.keyboard.press('Escape')
  await dialog().waitFor({ state: 'hidden', timeout: 8_000 })
  // The clear is its own request: wait for it to be on the wire before asking again, or the second dialog reads the
  // choice the cancel is still clearing. The cancelled task runs as stock DSH meanwhile, so let its turn finish too.
  for (let waited = 0; waited < 8_000 && !clearedOnWire(session); waited += 200) await page.waitForTimeout(200)
  await turnDown()
  await typeTask(task)
  await page.keyboard.press('Enter')
  await dialog().waitFor({ state: 'visible', timeout: 15_000 })
  return { session, cleaned: true }
}

/**
 * The subagent-model switch ON, whatever the dialog opened with: a dialog restored from a stored choice already has it
 * on, and clicking it there turns the choice OFF and takes the model picker away with it (the pick that follows then
 * waits on a control that is no longer on screen). Waits for the picker the switch reveals.
 */
async function switchOn() {
  const toggle = dialog().getByRole('switch').nth(0)
  if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click()
  const trigger = dialog().locator('button[aria-haspopup]').first()
  for (let waited = 0; waited < 5_000 && await trigger.count() === 0; waited += 200) await page.waitForTimeout(200)
}

async function open() {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  // Either composer: waiting only for the new-session placeholder made the command phase die on a start-up race.
  await composer().waitFor({ state: 'visible', timeout: 30_000 })
  await trace('open')
}

/**
 * A blank conversation, whatever the page showed. DSH's "New session" is ASYNCHRONOUS — it reuses a blank session or
 * creates one on the server and only then swaps the main pane — so until the swap lands the PREVIOUS conversation's
 * composer is still on screen and perfectly usable: "a composer is visible" is satisfied by the composer being LEFT
 * BEHIND. Typing into that one sends the next task into the old conversation, and the swap landing afterwards takes
 * away the presenter of the session that raised the plugin's dialog, which cancels it on the spot (`DialogHost.advance`:
 * a request whose last presenter left is cancelled). Both shapes were measured in the effort phase (a dialog that
 * vanished right after a passing check, and a send that raised no dialog at all). A blank session renders the HERO
 * composer, so waiting for THAT placeholder is waiting for the switch to have landed.
 */
async function newSession() {
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const hero = await page.getByRole('textbox', { name: HERO }).first().waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false)
  if (!hero) console.log(`DEBUG no hero composer after "New session": ${JSON.stringify(await shape())}`)
  await settleComposer()
  await trace(`new-session${hero ? '' : ' (no hero)'}`)
}

/** One line of composer text: whitespace collapsed, and the invisible characters a contenteditable leaves behind gone. */
const cleanText = (value) => value.replace(/[\u200b\u00a0]/g, ' ').replace(/\s+/g, ' ').trim()

/** What the composer holds right now (a textarea, an input or the host's contenteditable: read whichever it is). */
const composerText = () => composer().evaluate((element) => ('value' in element && typeof element.value === 'string' ? element.value : (element.innerText ?? element.textContent ?? '')))
  .then(cleanText).catch(() => '<no composer>')

/**
 * The composer a send is typed into: on screen, EMPTY (a draft left by an earlier step would ride along with the next
 * message) and past the pane swap that a "New session" click starts. The mount is followed by effects — the gate
 * attaches to the session face and the overlay registers as the presenter — and a send that beats them raises no
 * dialog at all: the gate answers a session nobody can present for with the task as stock DSH.
 */
async function settleComposer() {
  await composer().waitFor({ state: 'visible', timeout: 15_000 })
  for (let round = 0; round < 6; round += 1) {
    if ((await composerText()) === '') break
    await composer().click()
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(300)
  }
  await page.waitForTimeout(600)
}

/**
 * Type a task in the composer. What the composer really holds is read back (a keystroke lost to a re-render sent a
 * truncated task, and an EMPTY composer sends nothing at all: the gate passes a send with no content straight through,
 * so the dialog never appears and every later check waits on a modal that was never asked for).
 */
async function typeTask(text) {
  await settleComposer()
  const wanted = cleanText(text)
  let held = ''
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await composer().click()
    await page.keyboard.type(text, { delay: 5 })
    await page.waitForTimeout(200)
    held = await composerText()
    if (held === wanted) break
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(300)
  }
  if (held !== wanted) console.log(`DEBUG the composer holds ${JSON.stringify(held)} for the task ${JSON.stringify(wanted)}`)
}

/** Wait out the turn that is running (its "Stop generating" control gone), so the next send is a turn of its own. */
async function turnDown(ms = 30_000) {
  const stop = page.getByRole('button', { name: 'Stop generating' })
  for (let waited = 0; waited < ms && await stop.first().isVisible().catch(() => false); waited += 500) await page.waitForTimeout(500)
}

async function finish() {
  const timeline = await page.evaluate(() => window.__orqTimeline ?? []).catch(() => [])
  writeFileSync(`${out}/${phase}.report.json`, JSON.stringify({ phase, checks, wire, pageErrors, failedResponses: failedUrls, timeline }, null, 2))
  const failed = checks.filter((item) => !item.ok)
  console.log(`\n${phase}: ${String(checks.length - failed.length)}/${String(checks.length)} checks passed; wire=${String(wire.length)} requests; pageErrors=${String(pageErrors.length)}`)
  await browser.close()
  process.exit(failed.length === 0 ? 0 : 1)
}

/**
 * A step that threw: keep the evidence a Playwright stack does not carry — the checks made so far (the report is
 * written here too, so a crash no longer loses the run), a screenshot, the dialog's and the composer's own DOM, the
 * page's timeline and every session log the home holds, with the last user message of each. A task that went to the
 * WRONG conversation, and a dialog the page took away, are both read from those two.
 */
async function crash(where, error) {
  const stamp = `${out}/${phase}-crash`
  const sessions = (() => {
    try { return sessionSnapshot(process.env.ORQ_SESSIONS_DIR) } catch { return [] }
  })()
  const detail = { phase, where, error: String(error).slice(0, 1200), shape: await shape().catch(() => null), dom: await domNow().catch(() => null), timeline: await page.evaluate(() => window.__orqTimeline ?? []).catch(() => []), wire, pageErrors, failedResponses: failedUrls, checks, sessions }
  console.log(`\nCRASH ${phase} at ${where}: ${String(error).split('\n')[0]}`)
  console.log(`CRASH shape=${JSON.stringify(detail.shape)} sessions=${JSON.stringify(sessions)}`)
  try { writeFileSync(`${stamp}.json`, JSON.stringify(detail, null, 2)) } catch { /* the console lines above already carry the essentials */ }
  try { writeFileSync(`${out}/${phase}.report.json`, JSON.stringify({ phase, crashed: where, checks, wire, pageErrors, failedResponses: failedUrls }, null, 2)) } catch { /* ditto */ }
  await page.screenshot({ path: `${stamp}.png` }).catch(() => undefined)
  await browser.close().catch(() => undefined)
  process.exit(3)
}
// Top-level await puts a rejected step here instead of nowhere: the report and the timeline are written either way.
process.on('unhandledRejection', (error) => { void crash('unhandledRejection', error) })
process.on('uncaughtException', (error) => { void crash('uncaughtException', error) })

const TASK_CANCEL = 'Reply with exactly the word: stock'

if (phase === 'cancel') {
  await open()
  await shot('01-home')
  // The switch must START off for this phase, so the question is asked on a session with no stored choice (see `askClean`).
  await askClean(TASK_CANCEL)

  const visible = await dialog().waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false)
  check('modal appears when a new task is sent from the composer', visible)
  await shot('02-modal')
  if (visible) {
    check('title and gate description shown', await dialog().getByText('Cancel sends the task as usual.').isVisible())
    check('task preview shows what is being sent', await dialog().getByText(TASK_CANCEL).isVisible())
    const switches = dialog().getByRole('switch')
    check('one switch (the subagent model); there is no reviewer', (await switches.count()) === 1 && (await dialog().getByText(/reviewer/i).count()) === 0, await switches.count())
    check('the switch starts off', (await switches.nth(0).getAttribute('aria-checked')) === 'false')
    // 0.8.0: the one checkbox is the orchestration skill (checked by default); nothing offers to stop asking.
    const boxes = dialog().getByRole('checkbox')
    check('there is no "do not ask again" checkbox: the modal always asks', (await dialog().getByRole('checkbox', { name: /ask again|remember|do not ask/i }).count()) === 0 && (await boxes.count()) <= 1, await boxes.count())
    check('primary action is focused', await dialog().getByRole('button', { name: 'Send with these options' }).evaluate((element) => element === document.activeElement))

    await page.keyboard.press('Escape')
    await dialog().waitFor({ state: 'hidden', timeout: 8_000 }).then(() => check('Escape closes the modal', true), () => check('Escape closes the modal', false))
  }
  // The task must have been sent anyway (stock behavior): the user message shows in the transcript.
  const sent = await page.getByText(TASK_CANCEL).first().isVisible().catch(() => false)
  await page.waitForTimeout(2500)
  check('after Cancel/Escape the task is sent as stock DSH', sent || (await page.getByText(TASK_CANCEL).count()) > 0)
  await shot('03-after-cancel')
  const config = wire.filter((item) => item.method === 'POST')
  check('cancel wrote null (no orchestration stored)', config.length >= 1 && config.every((item) => JSON.parse(item.body ?? '{}').config === null), JSON.stringify(config.map((item) => ({ s: item.status, b: item.body?.slice(0, 80) }))))
  check('no page errors', relevantErrors().length === 0, relevantErrors().join(' | '))
  await finish()
}


/**
 * The model picker's menu: the portalled list the DSH `Menu` primitive renders as a direct child of `<body>`. The
 * native effort `<select>` lives inside the dialog and its `<option>`s carry the implicit role `option` too, so a bare
 * `getByRole('option')` used to resolve to a HIDDEN option ("Model default") and time the pick out (found by the 0.8.2
 * verifier). Every model entry is looked up inside this list and nowhere else.
 */
const modelMenu = () => page.locator('body > [role="menu"]').filter({ visible: true }).first()

/**
 * Open the model picker by the text of its trigger and wait for the menu it portals. A dialog restored from a stored
 * choice shows the picked MODEL on the trigger instead of "Choose a model", so the trigger falls back to the picker
 * itself (the dialog's one control with a popup): the menu it portals is what the caller is after either way.
 */
async function openModelMenu(triggerText) {
  const byName = dialog().getByRole('button', { name: triggerText }).first()
  const target = (await byName.count()) > 0 ? byName : dialog().locator('button[aria-haspopup]').first()
  await target.click()
  await modelMenu().waitFor({ state: 'visible', timeout: 8_000 })
}

/** Choose the entry of the OPEN model menu whose text matches (never an `<option>` of the effort select). */
async function pickEntry(pattern) {
  const entry = modelMenu().getByRole('menuitem', { name: pattern })
    .or(modelMenu().locator('[role=menuitem]').filter({ hasText: pattern })).first()
  await entry.waitFor({ state: 'visible', timeout: 8_000 })
  await entry.click()
  await modelMenu().waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => undefined)
}

/** Open a picker (by the text of its trigger), then choose the entry whose text matches. */
async function pick(triggerText, entryPattern) {
  await openModelMenu(triggerText)
  await pickEntry(entryPattern)
}

/**
 * The dialog's reasoning-effort `<select>`: the native, always-visible select that does NOT list models. 0.8.2 removed
 * the old "Reasoning effort" section (and its Show/Hide button) in favour of this control.
 */
async function effortSelect() {
  const nodes = dialog().locator('select')
  const found = []
  for (let index = 0; index < await nodes.count(); index += 1) {
    const handle = nodes.nth(index)
    if (!(await handle.isVisible())) continue
    found.push({
      handle,
      options: (await handle.locator('option').allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim()),
      values: await handle.locator('option').evaluateAll((elements) => elements.map((element) => element.value)),
      selected: await handle.evaluate((element) => element.selectedIndex),
      disabled: await handle.isDisabled(),
    })
  }
  return found.find((item) => !item.options.some((text) => MODELISH.test(text))) ?? found.at(-1)
}

/** The option the select shows right now. */
const shownEffort = (select) => (select === undefined ? { value: null, text: null } : { value: select.values[select.selected] ?? null, text: select.options[select.selected] ?? null })

/**
 * The reasoning levels the isolated home declares for one model id: the witness for "the model's own ladder plus ONE
 * neutral option" (DSH lists exactly the levels a profile declares). Empty when the home is not readable or does not
 * declare that id, in which case only the structural checks apply.
 */
function declaredLadders(modelId) {
  const home = process.env.DSH_HOME
  if (home === undefined) return []
  const file = join(home, 'settings.yaml')
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').split('\n')
  const pattern = new RegExp(`^\\s*-\\s*id:\\s*['"]?${modelId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*$`)
  const ladders = []
  for (let start = 0; start < lines.length; start += 1) {
    if (!pattern.test(lines[start])) continue
    let indent
    const levels = []
    for (const line of lines.slice(start + 1)) {
      if (/^\s*-\s*id:/.test(line)) break
      const header = /^(\s*)reasoningEfforts:\s*$/.exec(line)
      if (header !== null) { indent = header[1].length; continue }
      if (indent === undefined) continue
      if (line.trim() === '' || line.trim().startsWith('#')) continue
      const key = /^(\s*)([A-Za-z_]+):/.exec(line)
      if (key === null || key[1].length <= indent) { if (key !== null) break; continue }
      levels.push(key[2])
    }
    if (levels.length > 0) ladders.push(levels)
  }
  return ladders
}

const TASK_WORKFLOW = `Use the workflow tool exactly once, with exactly this meta and exactly this script, and change nothing in them.

meta: {"name":"echo-two","description":"Ask two agents for one word each","phases":[{"title":"Ask"}]}

script:
const words = await parallel([
  () => agent('Reply with exactly the single word ALPHA and nothing else.', { label: 'alpha', phase: 'Ask' }),
  () => agent('Reply with exactly the single word BETA and nothing else.', { label: 'beta', phase: 'Ask' }),
])
return words

When the workflow tool returns, reply with its result verbatim and nothing else.`

/**
 * Every session log this home holds, wherever DSH wrote it. DSH nests them one WORKSPACE-SLUG level down
 * (`<sessionsDir>/<workspace-slug>/<session-id>/session.v3.jsonl.zstd`); reading the top level alone found 0 sessions
 * on a real home, so the confirm and workflow phases reported "no children" while the children were sitting right
 * there (found by the 0.8.2 verifier: 4 subagent rows, all `azure-opencode/DeepSeek-V4.1-Flash`). The flat
 * `<sessionsDir>/<session-id>/...` shape is tried as well, so a home that writes it keeps working.
 */
function sessionLogFiles(sessionsDir) {
  const files = []
  const add = (directory) => {
    const file = join(directory, 'session.v3.jsonl.zstd')
    if (existsSync(file)) files.push(file)
  }
  for (const entry of readdirSync(sessionsDir)) {
    const first = join(sessionsDir, entry)
    add(first) // flat: <sessionsDir>/<session-id>/session.v3.jsonl.zstd
    let children = []
    try {
      children = readdirSync(first, { withFileTypes: true })
    } catch {
      continue // a plain file at the top level (a lock, a readme): not a workspace
    }
    for (const child of children) if (child.isDirectory()) add(join(first, child.name)) // nested
  }
  return files
}

/**
 * Every complete JSON line one log holds right now: a log being written decodes to its complete lines (the decoder
 * exits non-zero on a half-written last line and its stdout keeps what it did decode), which is what the polling
 * phases read while a subagent is still running.
 */
function readEventsAt(file) {
  let text = ''
  try {
    text = execFileSync('zstd', ['-dc', file], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8')
  } catch (error) {
    text = error.stdout?.toString('utf8') ?? ''
  }
  return text.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
}

/** Subagent children created at or after `since`, read back from the DSH session logs: route, effort, token cap and last stop. */
function childrenSince(sessionsDir, since) {
  const rows = []
  for (const file of sessionLogFiles(sessionsDir)) {
    const events = readEventsAt(file)
    const header = events[0] ?? {}
    if (header.origin !== 'subagent' || !(header.createdAt >= since)) continue
    const config = events.find((event) => event.type === 'request/header')?.data?.header?.config ?? {}
    const end = events.findLast((event) => event.type === 'turn/end')
    rows.push({ id: basename(dirname(file)).slice(0, 8), route: `${config.provider ?? '?'}/${config.model ?? '?'}`, effort: config.reasoningEffort, maxTokens: config.maxTokens, ended: end?.data?.reason?.kind })
  }
  return rows
}

/** What each session log of the home holds: its origin, how many user messages and the last one, oldest first. */
function sessionSnapshot(sessionsDir) {
  if (sessionsDir === undefined) return []
  return sessionLogFiles(sessionsDir).map((file) => {
    const events = readEventsAt(file)
    const header = events[0] ?? {}
    const users = events.filter((event) => event.type === 'user/message' && event.data?.source?.kind === 'user')
      .map((event) => (event.data.content ?? []).map((part) => part.text ?? '').join('').replace(/\s+/g, ' ').slice(0, 45))
    return { id: basename(dirname(file)).slice(0, 8), origin: header.origin ?? 'root', createdAt: header.createdAt ?? null, events: events.length, users: users.length, last: users.at(-1) ?? null }
  }).sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0))
}

if (phase === 'workflow') {
  const sessionsDir = process.env.ORQ_SESSIONS_DIR
  if (sessionsDir === undefined) throw new Error('ORQ_SESSIONS_DIR is required for the workflow phase')
  const since = Date.now()
  await open()
  await newSession() // the gate asks for a NEW task: an earlier conversation on this server would be a follow-up
  // The task has line breaks: typing them would press Enter and send its first line alone, so the text is filled in whole.
  await composer().click()
  await composer().fill(TASK_WORKFLOW)
  await page.keyboard.press('Enter')
  await dialog().waitFor({ state: 'visible', timeout: 15_000 })
  check('modal appears for the workflow task', true)
  await switchOn()
  await pick(/Choose a model/, TRIO.worker)
  check('subagent model chosen: DeepSeek V4.1 Flash', await dialog().getByRole('button', { name: TRIO.worker }).first().isVisible())
  // 0.8.2: picking a model AUTO-MAXes the effort select to that model's highest level, and that stored level is the
  // explicit choice the children inherit — so it, not the old "recommended medium", is what the delegated agents run at.
  const auto = shownEffort(await effortSelect())
  check('the pick AUTO-MAXed the effort select to a real level (the model\'s highest, never the neutral one)', auto.value !== null && auto.value !== '', JSON.stringify(auto))
  check('the dialog says the choice covers the agents a workflow starts', (await dialog().innerText()).replace(/\s+/g, ' ').includes('Applies to every subagent, including the agents a workflow starts.'))
  await shot('01-modal-subagent-model')
  await dialog().getByRole('button', { name: 'Send with these options' }).click()
  await dialog().waitFor({ state: 'hidden', timeout: 8_000 }).then(() => check('modal closes after confirm', true), () => check('modal closes after confirm', false))
  const posts = wire.filter((item) => item.method === 'POST')
  const saved = posts.length > 0 ? JSON.parse(posts.at(-1).body ?? '{}').config : null
  check('POST stored the subagent model and its auto-maxed effort (a stored choice, not a `defaults` config), the legacy reviewer block disabled', saved?.subagentModel?.model === TRIO.workerId && saved?.workerEffort === auto.value && saved?.reviewer?.enabled === false, JSON.stringify(saved))

  // The main agent now calls the workflow tool; its two agents appear as child sessions in the DSH logs.
  let rows = []
  for (let waited = 0; waited < 240_000; waited += 3_000) {
    rows = childrenSince(sessionsDir, since)
    if (rows.length >= 2 && rows.every((row) => row.ended !== undefined)) break
    await page.waitForTimeout(3_000)
  }
  console.log('DEBUG children read back from the session logs:', JSON.stringify(rows))
  await shot('02-after-workflow')
  check('the workflow started two agents', rows.length === 2, rows.length)
  check('both ran on DeepSeek V4.1 Flash, not on the main agent\'s model', rows.length > 0 && rows.every((row) => row.route === `azure-opencode/${TRIO.workerId}`), JSON.stringify(rows.map((row) => row.route)))
  check('both at the level the dialog AUTO-MAXed to (the model\'s highest) with the 64 000-token cap', rows.length > 0 && rows.every((row) => row.effort === auto.value && row.maxTokens === 64000), JSON.stringify({ auto: auto.value, rows: rows.map((row) => [row.effort, row.maxTokens]) }))
  check('both finished', rows.length > 0 && rows.every((row) => row.ended === 'completed'), JSON.stringify(rows.map((row) => row.ended)))
  check('no page errors', relevantErrors().length === 0, relevantErrors().join(' | '))
  await finish()
}

const TASK_CONFIRM = 'Use the subagent tool exactly once, with run_in_background set to false, to answer this question: "What is 17 plus 25?" When the subagent tool returns, reply with its result verbatim and nothing else.'

if (phase === 'confirm') {
  const sessionsDir = process.env.ORQ_SESSIONS_DIR
  if (sessionsDir === undefined) throw new Error('ORQ_SESSIONS_DIR is required for the confirm phase')
  const since = Date.now()
  await open()
  await newSession()
  // "confirm waits for a model" is a check of the dialog's INITIAL state: ask on a session with no stored choice.
  await askClean(TASK_CONFIRM)
  check('modal appears for the delegation task', true)

  await switchOn()
  check('the switch reveals the model picker and the scope line', (await dialog().getByText('Model for subagents').isVisible()) && (await dialog().getByText('including the agents a workflow starts').isVisible()))
  check('confirm is disabled until a subagent model is chosen', await dialog().getByRole('button', { name: 'Send with these options' }).isDisabled())
  await pick(/Choose a model/, TRIO.worker)
  check('subagent model chosen', await dialog().getByRole('button', { name: TRIO.worker }).first().isVisible())
  // 0.8.2: the pick AUTO-MAXes the effort select to the model's highest level; that level is the explicit choice the
  // child inherits (the user's pick always wins), so it — not the old "recommended medium" — is what the POST stores.
  const auto = shownEffort(await effortSelect())
  check('the pick AUTO-MAXed the effort select to a real level (the model\'s highest, never the neutral one)', auto.value !== null && auto.value !== '', JSON.stringify(auto))
  await page.waitForTimeout(400)
  await shot('01-modal-filled')
  check('confirm is enabled', await dialog().getByRole('button', { name: 'Send with these options' }).isEnabled())

  await dialog().getByRole('button', { name: 'Send with these options' }).click()
  await dialog().waitFor({ state: 'hidden', timeout: 8_000 }).then(() => check('modal closes after confirm', true), () => check('modal closes after confirm', false))
  const posts = wire.filter((item) => item.method === 'POST')
  const saved = posts.length > 0 ? JSON.parse(posts.at(-1).body ?? '{}').config : null
  check('POST carried the chosen route with its auto-maxed effort, and only the disabled legacy reviewer block besides', saved !== null && saved.subagentModel?.model === TRIO.workerId && saved.workerEffort === auto.value && saved.reviewer?.enabled === false && Object.keys(saved).sort().join() === 'reviewer,subagentModel,version,workerEffort', JSON.stringify({ saved, auto }))
  check('host accepted the config (200)', posts.at(-1)?.status === 200, posts.at(-1)?.status)
  await shot('02-running')

  // The real thing: the main agent (GLM 5.3) delegates and the subagent runs on DeepSeek V4.1 Flash.
  let rows = []
  for (let waited = 0; waited < 240_000; waited += 3_000) {
    rows = childrenSince(sessionsDir, since)
    if (rows.length >= 1 && rows.every((row) => row.ended !== undefined)) break
    await page.waitForTimeout(3_000)
  }
  console.log('DEBUG children read back from the session logs:', JSON.stringify(rows))
  await page.waitForTimeout(1500)
  await shot('03-delivered')
  check('the main agent started one subagent', rows.length === 1, rows.length)
  check('it ran on DeepSeek V4.1 Flash, not on the main agent\'s model', rows.length === 1 && rows[0].route === `azure-opencode/${TRIO.workerId}`, JSON.stringify(rows.map((row) => row.route)))
  check('at the level the dialog AUTO-MAXed to (the model\'s highest) with the 64 000-token cap', rows.length === 1 && rows[0].effort === auto.value && rows[0].maxTokens === 64000, JSON.stringify({ auto: auto.value, rows: rows.map((row) => [row.effort, row.maxTokens]) }))
  check('it finished and the transcript shows its answer (42)', rows.length === 1 && rows[0].ended === 'completed' && /42/.test(await page.locator('body').innerText()))
  check('no page errors', relevantErrors().length === 0, relevantErrors().join(' | '))
  await finish()
}

if (phase === 'light') {
  await open()
  await typeTask('Reply with exactly the word: light')
  await page.keyboard.press('Enter')
  await dialog().waitFor({ state: 'visible', timeout: 15_000 })
  await shot('01-modal-light')
  check('modal renders in the light theme', await dialog().isVisible())

  // Focus stays inside the dialog while tabbing (a modal must trap focus).
  let escaped = 0
  for (let index = 0; index < 14; index += 1) {
    await page.keyboard.press('Tab')
    const inside = await page.evaluate(() => document.activeElement !== null && document.activeElement.closest('[role=dialog]') !== null)
    if (!inside) escaped += 1
  }
  check('Tab never leaves the dialog (focus trap)', escaped === 0, `${String(escaped)} of 14 tabs escaped`)
  console.log('DEBUG dialog visible after tabs:', await dialog().isVisible(), '| text:', (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 160))

  // Escape belongs to an open menu first; the dialog survives and closes on the next Escape.
  await switchOn().catch((error) => console.log('DEBUG switch click failed:', String(error).slice(0, 200)))
  await page.waitForTimeout(600)
  await shot('01b-after-switch')
  console.log('DEBUG dialog text after switch:', (await dialog().innerText().catch(() => 'no dialog')).replace(/\s+/g, ' ').slice(0, 300))
  // The model menu only (the portalled list): a bare getByRole('option') also matched the effort select's hidden options.
  await openModelMenu(/Choose a model/)
  await shot('02-menu-open-light')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  check('Escape closes the open menu but keeps the dialog', await dialog().isVisible())
  await page.keyboard.press('Escape')
  await dialog().waitFor({ state: 'hidden', timeout: 8_000 }).then(() => check('a second Escape closes the dialog', true), () => check('a second Escape closes the dialog', false))
  check('no page errors', relevantErrors().length === 0, relevantErrors().join(' | '))
  await finish()
}

if (phase === 'command') {
  await open()
  await newSession()
  await typeTask('/orquestrar')
  await page.waitForTimeout(800)
  await shot('01-palette')
  const listed = await page.getByText('Orchestrate subagents').first().isVisible().catch(() => false)
  check('the /orquestrar command is offered by the slash palette', listed)
  await page.keyboard.press('Enter')
  const opened = await dialog().waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)
  check('the command opens the dialog in configure mode', opened && (await dialog().getByText('The options apply from the next task.').isVisible()))
  await shot('02-configure')
  if (opened) {
    await switchOn()
    await pick(/Choose a model/, TRIO.worker)
    await dialog().getByRole('button', { name: 'Save' }).click()
    await dialog().waitFor({ state: 'hidden', timeout: 8_000 }).then(() => check('Save closes the dialog', true), () => check('Save closes the dialog', false))
    const posts = wire.filter((item) => item.method === 'POST')
    const saved = posts.length > 0 ? JSON.parse(posts.at(-1).body ?? '{}').config : null
    check('Save stored the subagent model and no "remember" flag', saved?.subagentModel?.model === TRIO.workerId && !('remember' in saved), JSON.stringify(saved))
    // There is no "do not ask again", so the next task raises the modal again, pre-filled.
    await typeTask('Reply with exactly the word: asks')
    await page.keyboard.press('Enter')
    const asked = await dialog().waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false)
    check('the next task raises the modal again (nothing can silence it)', asked)
    check('the dialog is pre-filled with the saved choice (switch on, DeepSeek V4.1 Flash)', asked && (await dialog().getByRole('switch').nth(0).getAttribute('aria-checked')) === 'true' && (await dialog().getByRole('button', { name: TRIO.worker }).first().isVisible()))
    await shot('03-asks-again')
    await page.keyboard.press('Escape')
  }
  check('no page errors', relevantErrors().length === 0, relevantErrors().join(' | '))
  await finish()
}

if (phase === 'effort') {
  // The 0.8.2 dialog: the "Reasoning effort" SECTION is gone (no Show/Hide button, no heading, no paragraph) and the
  // effort is a native <select> that is ALWAYS visible: below the model select when the switch is on, below the switch
  // when it is not. Its own visible LABEL reads "Reasoning effort" as well, so "no section" can never key on those two
  // words — the evidence is the absence of the control and of a heading/paragraph. The tasks it sends are one-word
  // answers; the phase only clicks through the dialog and reads the wire.
  // The tasks it sends are one-word answers; the phase only clicks through the dialog and reads the wire. Its opening
  // checks witness the dialog's INITIAL state, so the question is asked on a session with no stored choice (`askClean`).
  await open()
  await askClean('Reply with exactly the word: effort')
  const text = async () => (await dialog().innerText()).replace(/\s+/g, ' ')

  const block = await dialog().evaluate((root) => {
    const clean = (element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim()
    const select = root.querySelector('select')
    const label = select === null ? undefined : [...root.querySelectorAll('label')].find((item) => item.htmlFor === select.id)
    return {
      showHide: [...root.querySelectorAll('button')].map(clean).filter((name) => /^(show|hide|mostrar|ocultar)$/i.test(name)),
      headings: [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(clean).filter((name) => /effort|esforço|reasoning/i.test(name)),
      paragraphs: [...root.querySelectorAll('p')].map(clean).filter((name) => /reasoning effort|recommended level|how long the model may think/i.test(name)),
      label: label === undefined ? null : clean(label),
      selects: root.querySelectorAll('select').length,
    }
  })
  check('no "Reasoning effort" SECTION: no Show/Hide button, no heading and no paragraph around the effort', block.showHide.length === 0 && block.headings.length === 0 && block.paragraphs.length === 0 && block.selects === 1, JSON.stringify(block))
  check('those two words are the select\'s own visible LABEL (which is why "no section" cannot key on them)', block.label !== null && /effort|esforço|reasoning/i.test(block.label), JSON.stringify(block.label))

  const off = await effortSelect()
  check('with the switch OFF the select is ALWAYS visible and shows its first, NEUTRAL option', off !== undefined && off.options.length >= 1 && off.selected === 0 && levelOf(off.options[0] ?? '') === undefined, JSON.stringify({ options: off?.options, selected: off?.selected }))
  await shot('01-effort-off')

  await switchOn()
  const noModel = await effortSelect()
  check('with the switch ON and no model picked it is still on screen, neutral, and DISABLED (no effective model, so no ladder to draw)', noModel !== undefined && noModel.selected === 0 && noModel.disabled === true, JSON.stringify({ options: noModel?.options, selected: noModel?.selected, disabled: noModel?.disabled }))

  // Per model: ONE first neutral option plus that model's own ladder, low to high, and a fresh pick AUTO-MAXES.
  const exercised = []
  const cases = [
    { label: 'the DeepSeek V4.1 Flash subagent', trigger: /Choose a model/, model: TRIO.worker, id: TRIO.workerId, note: 'spend its whole token budget on one numeric edge case' },
    { label: 'GLM 5.3', trigger: TRIO.worker, model: TRIO.glm, id: TRIO.glmId, note: 'Text only: it cannot look at screenshots' },
    { label: 'MiMo-V2.6-Pro', trigger: TRIO.glm, model: TRIO.mimo, id: TRIO.mimoId, note: 'about two minutes per turn at high effort' },
  ]
  for (const [index, item] of cases.entries()) {
    await pick(item.trigger, item.model)
    const shown = await dialog().getByRole('button', { name: item.model }).first().isVisible()
    const effort = await effortSelect()
    const levels = (effort?.options ?? []).slice(1)
    const ranks = levels.map((level) => LEVELS.indexOf(levelOf(level) ?? ''))
    const ascending = levels.length > 0 && ranks.every((rank, position) => rank >= 0 && (position === 0 || rank > ranks[position - 1]))
    check(`${item.label}: the pick draws ONE first neutral option plus that model's ladder, low to high`, shown && effort !== undefined && levelOf(effort.options[0] ?? '') === undefined && ascending, JSON.stringify({ options: effort?.options }))
    check(`${item.label}: AUTO-MAX — the fresh pick selects the model's HIGHEST level (the LAST option, never the neutral one)`, effort !== undefined && effort.selected > 0 && effort.selected === effort.options.length - 1, JSON.stringify({ selected: effort?.selected, options: effort?.options }))
    const ladders = declaredLadders(item.id)
    const declared = ladders.map((levelsOfHome) => levelsOfHome.join(',')).join(' / ')
    if (ladders.length > 0) {
      const wanted = ladders.map((levelsOfHome) => levelsOfHome.length + 1)
      check(`${item.label}: the select offers EXACTLY the ladder the home declares for ${item.id} plus ONE neutral option`, effort !== undefined && wanted.includes(effort.options.length), `${String(effort?.options.length)} options (${JSON.stringify(effort?.options)}) vs declared ${declared}`)
      exercised.push({ label: item.label, id: item.id, declared, options: effort?.options ?? [] })
    } else {
      console.log(`DEBUG ${item.label}: no reasoningEfforts declared for ${item.id} in ${String(process.env.DSH_HOME)}/settings.yaml — the ladder size is not witnessed`)
    }
    check(`${item.label} carries its advice note`, (await text()).includes(item.note))
    await shot(`0${String(index + 2)}-${item.label.replace(/[^A-Za-z0-9]+/g, '-')}`)
  }
  // Only a pair whose DECLARED ladders differ can witness "the ladder follows the model": two models whose settings
  // declare the same levels are expected to draw the same options.
  const differing = exercised.flatMap((item, index) => exercised.slice(index + 1)
    .filter((other) => other.declared !== item.declared)
    .map((other) => [item, other]))
  check('the ladder follows the MODEL: two models whose DECLARED ladders differ do not show the same option set', differing.length === 0 || differing.some(([left, right]) => left.options.join('|') !== right.options.join('|')), JSON.stringify({ compared: exercised.map((item) => ({ model: item.id, declared: item.declared, options: item.options })), differingPairs: differing.length }))

  // Back to the subagent model this home carries: the level AUTO-MAX chose is what the confirm must store.
  await pick(TRIO.mimo, TRIO.worker)
  const auto = await effortSelect()
  const autoShown = shownEffort(auto)
  await dialog().getByRole('button', { name: 'Send with these options' }).click()
  await dialog().waitFor({ state: 'hidden', timeout: 8_000 }).then(() => check('modal closes after confirm', true), () => check('modal closes after confirm', false))
  const posts = wire.filter((item) => item.method === 'POST')
  const saved = posts.length > 0 ? JSON.parse(posts.at(-1).body ?? '{}').config : null
  check('the wire carries the picked model and the level AUTO-MAX chose (never the neutral one), the legacy reviewer block disabled', saved?.subagentModel?.model === TRIO.workerId && autoShown.value !== null && autoShown.value !== '' && saved?.workerEffort === autoShown.value && saved?.reviewer?.enabled === false, JSON.stringify({ saved, auto: autoShown }))
  check('host accepted the config (200)', posts.at(-1)?.status === 200, posts.at(-1)?.status)
  await trace('effort: confirmed the first task')
  // The turn that send started is still running here: the tasks are one-word answers, so it ends on its own, and the
  // next send belongs to a new conversation (the skill script's sends are serialized the same way, by waiting for the
  // turn of each message to end). Waiting it out takes the background turn out of the picture: what the next dialog
  // does is then about the dialog, not about a workspace refresh racing it.
  await turnDown()
  await trace('effort: the first turn is down')

  // The dialog reopens with the last confirmed choice, its stored level PRE-FILLED: opening is not a model change.
  // "New session" may REUSE an abandoned session (DSH's own rule, and the log of the reused one already holds turns),
  // so the level it must show is read from the host's own answer to the gate's read — a reused session legitimately
  // reopens with the level some earlier run stored for it, not with the one this phase just confirmed.
  await newSession()
  await typeTask('Reply with exactly the word: again')
  await trace('effort: typed the second task')
  await page.keyboard.press('Enter')
  await trace('effort: pressed Enter for the second task')
  await dialog().waitFor({ state: 'visible', timeout: 15_000 })
  const again = await effortSelect()
  const reopened = lastReadSession()
  const storedAgain = hostAnswer(reopened)?.config ?? null
  const wantedModel = storedAgain === null ? TRIO.workerId : storedAgain.subagentModel?.model
  const wantedEffort = storedAgain === null ? autoShown.value : (storedAgain.workerEffort ?? '')
  check('the dialog reopens with the stored model and its stored level pre-filled', (wantedModel !== TRIO.workerId || await dialog().getByRole('button', { name: TRIO.worker }).first().isVisible()) && again !== undefined && (wantedEffort === '' || again.selected > 0) && again.values[again.selected] === wantedEffort, JSON.stringify({ selected: again?.selected, options: again?.options, wanted: wantedEffort, session: reopened?.slice(0, 12), stored: storedAgain }))
  await trace('effort: read the reopened dialog back')
  await shot('05-reopened')
  await trace('effort: screenshot 05-reopened')

  // A level the user picks by hand is stored exactly as picked: reopening must not raise it to the model's highest.
  // Index 1 is the ladder's lowest level; a single-level ladder leaves the neutral row as the only other choice.
  const lowerIndex = again !== undefined && again.options.length > 2 ? 1 : 0
  await trace(`effort: before selectOption(${String(lowerIndex)})`)
  if (again !== undefined) await again.handle.selectOption({ index: lowerIndex })
  // The select is read AGAIN after the change: `again` holds the snapshot taken when the dialog opened, so reading the
  // chosen level off it reported "Max" for a level the user had just set to "Off" (the wire carried the picked level
  // while the check compared against the stale one, and the next check inherited the same wrong value).
  const lower = shownEffort(await effortSelect())
  await dialog().getByRole('button', { name: 'Send with these options' }).click()
  await dialog().waitFor({ state: 'hidden', timeout: 8_000 })
  const posts2 = wire.filter((item) => item.method === 'POST')
  const saved2 = posts2.length > 0 ? JSON.parse(posts2.at(-1).body ?? '{}').config : null
  const handPicked = lower.value === '' ? null : lower.value
  check('a level chosen by hand reaches the wire as it is (the neutral row stores null)', handPicked !== autoShown.value && saved2?.workerEffort === handPicked, JSON.stringify({ saved: saved2?.workerEffort, picked: lower }))
  await turnDown()
  // The hand-picked level is stored for THIS conversation, and the next task asks about it again: a follow-up in the
  // same conversation always reaches that conversation's own store. A "New session" here would ask whichever abandoned
  // session DSH reuses (the check above reads the host's own answer for that case); this one is the exact witness that
  // the level on screen is the one just picked by hand — never the model's highest, so AUTO-MAX fires on a model pick
  // and never when the dialog opens.
  await typeTask('Reply with exactly the word: kept')
  await page.keyboard.press('Enter')
  await dialog().waitFor({ state: 'visible', timeout: 15_000 })
  const kept = await effortSelect()
  const storedKept = hostAnswer(lastReadSession())?.config ?? null
  const wantedKept = storedKept === null ? lower.value : (storedKept.workerEffort ?? '')
  check('reopening pre-fills THAT level: AUTO-MAX fires on a model pick, never when the dialog opens', kept !== undefined && kept.values[kept.selected] === wantedKept && kept.selected !== kept.options.length - 1, JSON.stringify({ selected: kept?.selected, options: kept?.options, value: kept === undefined ? null : kept.values[kept.selected], wanted: wantedKept }))
  await shot('06-stored-level-kept')
  await page.keyboard.press('Escape')
  check('no page errors', relevantErrors().length === 0, relevantErrors().join(' | '))
  await finish()
}

if (phase === 'readme' || phase === 'readme-light') {
  await open()
  await newSession()
  await typeTask('Add input validation to the signup form and cover it with tests')
  await page.keyboard.press('Enter')
  await dialog().waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForTimeout(400)
  await shot('01-empty')
  check('the dialog is up, with one switch', (await dialog().getByRole('switch').count()) === 1)
  if (phase === 'readme') {
    await switchOn()
    await pick(/Choose a model/, TRIO.worker)
    await page.waitForTimeout(400)
    await shot('02-filled')
    check('a model is chosen', await dialog().getByRole('button', { name: TRIO.worker }).first().isVisible())
  }
  // No answer on purpose: closing the browser leaves the dialog unanswered, so the task is never sent.
  await finish()
}

if (phase === 'small') {
  // A short laptop screen with the model chosen and the effort select on screen: the actions must stay reachable.
  // 0.8.2 dropped the "Reasoning effort" section, so there is no Show/Hide step any more: the select is simply there.
  await page.setViewportSize({ width: 1024, height: 600 })
  await open()
  // "with the switch ON and no model picked" is an INITIAL state: ask on a session with no stored choice (`askClean`).
  await askClean('Reply with exactly the word: small')
  await switchOn()
  const beforePick = await effortSelect()
  check('the effort select needs no expand step: it is already on screen with the switch ON and no model picked', beforePick !== undefined && levelOf(beforePick.options[0] ?? '') === undefined, JSON.stringify({ options: beforePick?.options, selected: beforePick?.selected }))
  await pick(/Choose a model/, TRIO.worker)
  const afterPick = await effortSelect()
  check('...and it stays on screen, enabled and auto-maxed, once the model is picked', afterPick !== undefined && afterPick.disabled === false && afterPick.selected > 0 && afterPick.selected === afterPick.options.length - 1, JSON.stringify({ options: afterPick?.options, selected: afterPick?.selected }))
  check('no Show/Hide control anywhere in the dialog', (await dialog().getByRole('button', { name: /^(show|hide|mostrar|ocultar)$/i }).count()) === 0)
  await page.waitForTimeout(600)
  await shot('01-open-600px')
  const box = await dialog().boundingBox()
  const send = dialog().getByRole('button', { name: 'Send with these options' })
  const sendBox = await send.boundingBox()
  check('dialog is not taller than the viewport', box !== null && box.height <= 600, JSON.stringify(box))
  check('primary action is inside the viewport', sendBox !== null && sendBox.y >= 0 && sendBox.y + sendBox.height <= 600, JSON.stringify(sendBox))
  await page.keyboard.press('Escape')
  check('no page errors', relevantErrors().length === 0, relevantErrors().join(' | '))
  await finish()
}

console.error(`unknown phase: ${phase}`)
process.exit(2)
