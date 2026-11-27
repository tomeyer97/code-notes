// Records one step's animation as a video, from the same player the panel uses (test/journey-scene/player.html), so
// videos and the extension always look alike. A tool for demo videos, not a test; run `npm run build` first.
//   node scripts/scene-video/record.mjs <journey.json> <step> <out.webm> [dark|light]
// Chromium as the headless checks get it (test/harness/page.mjs launchChromium: PLAYWRIGHT, CHROME).
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { launchChromium } from '../../test/harness/page.mjs'

const PLAYER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../test/journey-scene/player.html')
/** The video's size, the player's stage (test/journey-scene/player.css). */
const SIZE = { width: 1280, height: 720 }
/** How long a whole scene may take to play. */
const PLAY_TIMEOUT_MS = 180000

const [file, step = '1', out = 'scene.webm', theme = 'dark'] = process.argv.slice(2)
if (!file) { console.error('usage: node scripts/scene-video/record.mjs <journey.json> <step> <out.webm> [dark|light]'); process.exit(2) }
const journey = JSON.parse(fs.readFileSync(file, 'utf8'))
if (!journey.steps[Number(step) - 1]?.scene) { console.error(`step ${step} has no scene`); process.exit(2) }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-'))
const b = await launchChromium()
const ctx = await b.newContext({ viewport: SIZE, deviceScaleFactor: 1, recordVideo: { dir, size: SIZE } })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
// The journey and the end of the video go through test/harness/themes.js Harness.
await page.addInitScript((j) => { globalThis.__harness = { ...globalThis.__harness, journey: j } }, journey)
await page.goto(`${pathToFileURL(PLAYER).href}?step=${step}&theme=${theme}&play=1`)
await page.waitForFunction(() => globalThis.__harness.done === true, null, { timeout: PLAY_TIMEOUT_MS })
await ctx.close()
await b.close()
const made = fs.readdirSync(dir).find((f) => f.endsWith('.webm'))
fs.copyFileSync(path.join(dir, made), out)
fs.rmSync(dir, { recursive: true, force: true })
if (errors.length) { console.error(errors.join('\n')); process.exit(1) }
console.log(out)
