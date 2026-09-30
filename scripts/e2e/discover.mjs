// Discovery run: what does the DSH web shell show, and which controls exist?
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const url = process.env.DSH_URL
const out = process.env.OUT_DIR ?? '.'
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' })).newPage()
const seen = []
page.on('requestfailed', (r) => seen.push(`FAILED ${r.url()}`))
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') seen.push(`console.${m.type()}: ${m.text().slice(0, 200)}`) })
await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForTimeout(2500)
await page.screenshot({ path: `${out}/discover-01.png` })
console.log('TITLE', await page.title())
console.log('URL', page.url())
console.log('TEXT', (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 900))
const controls = await page.evaluate(() => [...document.querySelectorAll('button,[role=button],textarea,input,[contenteditable=true],[role=textbox],[role=combobox]')].slice(0, 40).map((el) => `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''} aria-label="${el.getAttribute('aria-label') ?? ''}" placeholder="${el.getAttribute('placeholder') ?? ''}" text="${(el.textContent ?? '').trim().slice(0, 40)}"`))
console.log('CONTROLS\n' + controls.join('\n'))
console.log('LOG', JSON.stringify(seen.slice(0, 10)))
await browser.close()
