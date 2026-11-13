// Records one step's animation as a video, from the same player the panel uses (player.html), so videos and the
// extension always look alike:  node record.mjs <journey.json> <step> <out.webm> [dark|light]
// Needs Playwright with Chromium (PLAYWRIGHT=<path to playwright/index.mjs>, CHROME=<chrome binary> when not installed here).
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright')
const [file, step = '1', out = 'scene.webm', theme = 'dark'] = process.argv.slice(2)
if (!file) { console.error('usage: node record.mjs <journey.json> <step> <out.webm> [dark|light]'); process.exit(2) }
const here = path.dirname(fileURLToPath(import.meta.url))
const journey = JSON.parse(fs.readFileSync(file, 'utf8'))
if (!journey.steps[Number(step) - 1]?.scene) { console.error(`step ${step} has no scene`); process.exit(2) }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-'))
const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {})
const ctx = await b.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, recordVideo: { dir, size: { width: 1280, height: 720 } } })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
await page.addInitScript((j) => { window.__journey = j }, journey)
await page.goto(`file://${here}/player.html?step=${step}&theme=${theme}&play=1`)
await page.waitForFunction(() => window.__done === true, null, { timeout: 180000 })
await ctx.close()
await b.close()
const made = fs.readdirSync(dir).find((f) => f.endsWith('.webm'))
fs.copyFileSync(path.join(dir, made), out)
fs.rmSync(dir, { recursive: true, force: true })
if (errors.length) { console.error(errors.join('\n')); process.exit(1) }
console.log(out)
