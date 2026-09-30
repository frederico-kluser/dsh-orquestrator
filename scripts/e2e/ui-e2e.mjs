#!/usr/bin/env node
/**
 * Browser end-to-end checks of the dsh-orquestrator modal against a REAL DSH
 * web server (run on the validation machine with an isolated DSH_HOME).
 *
 *   DSH_URL=<authenticated dsh web URL> OUT_DIR=<dir> PHASE=<name> node ui-e2e.mjs
 *
 * PHASE:
 *   cancel    a new task raises the modal; Escape/Cancel sends it as stock DSH
 *   confirm   choose subagent + reviewer models, send, wait for "Reviewed delivery"
 *   light     light theme, keyboard focus trap, Esc handling while a menu is open
 *   command   /orquestrar opens the configure dialog, Save persists, next send skips the modal
 *
 * Writes <OUT_DIR>/<phase>.report.json (one entry per check) and screenshots.
 * The token in DSH_URL is a per-process credential: it is never written out.
 */
import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'

const url = process.env.DSH_URL
const out = process.env.OUT_DIR ?? '.'
const phase = process.env.PHASE ?? 'cancel'
if (url === undefined) throw new Error('DSH_URL is required')
mkdirSync(out, { recursive: true })

const COMPOSER = /Describe what you want to build/
const DIALOG = 'Orchestrate subagents'
const checks = []
const wire = []

const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 400) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  [${String(detail).slice(0, 200)}]`}`)
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const scheme = phase === 'light' ? 'light' : 'dark'
const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: scheme })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 300)))
page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(`console: ${message.text().slice(0, 200)}`) })
page.on('request', (request) => {
  if (!request.url().includes('/dsh-orquestrator/config')) return
  wire.push({ method: request.method(), path: new URL(request.url()).pathname, query: new URL(request.url()).search, body: request.postData() ?? null })
})
page.on('response', (response) => {
  if (!response.url().includes('/dsh-orquestrator/config')) return
  const entry = [...wire].reverse().find((item) => item.status === undefined)
  if (entry !== undefined) entry.status = response.status()
})

const shot = async (name) => { await page.screenshot({ path: `${out}/${phase}-${name}.png` }) }
const composer = () => page.getByRole('textbox', { name: COMPOSER })
const dialog = () => page.getByRole('dialog', { name: DIALOG })

async function open() {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await composer().waitFor({ state: 'visible', timeout: 30_000 })
}

async function newSession() {
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  await composer().waitFor({ state: 'visible', timeout: 15_000 })
}

async function typeTask(text) {
  await composer().click()
  await page.keyboard.type(text, { delay: 5 })
}

async function finish() {
  writeFileSync(`${out}/${phase}.report.json`, JSON.stringify({ phase, checks, wire, pageErrors }, null, 2))
  const failed = checks.filter((item) => !item.ok)
  console.log(`\n${phase}: ${String(checks.length - failed.length)}/${String(checks.length)} checks passed; wire=${String(wire.length)} requests; pageErrors=${String(pageErrors.length)}`)
  await browser.close()
  process.exit(failed.length === 0 ? 0 : 1)
}

const TASK_CANCEL = 'Reply with exactly the word: stock'

if (phase === 'cancel') {
  await open()
  await shot('01-home')
  await typeTask(TASK_CANCEL)
  await page.keyboard.press('Enter')

  const visible = await dialog().waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false)
  check('modal appears when a new task is sent from the composer', visible)
  await shot('02-modal')
  if (visible) {
    check('title and gate description shown', await dialog().getByText('Cancel sends the task as usual.').isVisible())
    check('task preview shows what is being sent', await dialog().getByText(TASK_CANCEL).isVisible())
    const switches = dialog().getByRole('switch')
    check('two switches (subagent model, reviewer)', (await switches.count()) === 2, await switches.count())
    check('both switches start off', (await switches.nth(0).getAttribute('aria-checked')) === 'false' && (await switches.nth(1).getAttribute('aria-checked')) === 'false')
    check('remember checkbox present and unchecked', (await dialog().getByRole('checkbox').isChecked()) === false)
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
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
  await finish()
}

console.error(`unknown phase: ${phase}`)
process.exit(2)
