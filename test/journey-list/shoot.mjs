// The panel's Journeys home (docs/journey-list.md) in Chromium (Playwright), with ~40 journeys and a check: at
// 320/600/1000 px, dark and light. Asserts: nothing wider than the panel, no console errors, search over step text
// ("retry" finds "How charging work"), chips filter, a row click selects and previews (wide: a mini map), ↓ moves,
// Enter walks, Esc clears then goes back. The extension's part (the model) is out/src/journeyList.js, run here.
// Usage (after `npm run build`): node test/journey-list/shoot.mjs [screenshot-dir]   (PLAYWRIGHT=…, CHROME=… as in journey-map)
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pw = await import(process.env.PLAYWRIGHT ? pathToFileURL(path.resolve(process.env.PLAYWRIGHT)).href : 'playwright')
const chromium = pw.chromium ?? pw.default.chromium
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const { buildList } = require(path.join(ROOT, 'out/src/journeyList.js'))
const { items, NOW } = require('./fixture.js')
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : ''
if (OUT) fs.mkdirSync(OUT, { recursive: true })
const HARNESS = pathToFileURL(path.join(ROOT, 'test/journey-map/harness.html')).href
const sample = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/journey/journeys/place-order.json'), 'utf8'))
const journey = { ...sample, steps: sample.steps.map((s, i) => ({ ...s, n: i + 1 })), problems: [] }
const ACTIVE = 'api/store.js'
const tour = (home) => ({ current: 0, marks: {}, resume: 0, legendHidden: true, problems: [], key: "Ctrl+'", tutorial: false, list: [], moved: {}, home })
const fails = []
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {})
for (const theme of ['dark', 'light']) for (const w of [320, 600, 1000]) {
  const tag = `${w}px ${theme}`
  const page = await browser.newPage({ viewport: { width: w, height: 760 } })
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`${HARNESS}?theme=${theme}`)
  const send = (m) => page.evaluate((x) => window.postMessage(x, '*'), m)
  const posted = () => page.evaluate(() => window.__posted)
  // The extension: answers "list" with a new model, "preview" with the journey.
  let state = { query: '', kind: 'all', area: '', sort: 'area' }
  const model = () => buildList(items(), { activeFile: ACTIVE, now: NOW, ...state })
  let seen = 0
  const pump = async () => {
    const ps = await posted()
    for (const m of ps.slice(seen)) {
      if (m.type === 'list') { state = { query: m.query, kind: m.kind, area: m.area, sort: m.sort ?? state.sort }; await send({ type: 'tour', ...tour(model()) }) }
      if (m.type === 'preview') await send({ type: 'preview', key: m.key, journey })
    }
    seen = ps.length
  }
  const settle = async () => { for (let i = 0; i < 4; i++) { await page.waitForTimeout(140); await pump() } }
  await send({ type: 'journey', journey, ...tour(model()) })
  await send({ type: 'home' })
  await settle()
  const measure = () => page.evaluate(() => {
    const W = document.documentElement.clientWidth, bad = []
    if (document.documentElement.scrollWidth > W + 1) bad.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${W})`)
    for (const e of document.querySelectorAll('.home .jrow, .home .chip, .home .hsearch, .home .hsort, .hprev, .walkb, .hsec')) {
      const r = e.getBoundingClientRect()
      if (r.right > W + 1) bad.push(`${e.className} sticks out (${Math.round(r.right)} > ${W}): ${e.textContent.slice(0, 30)}`)
    }
    return bad
  })
  const home = () => page.evaluate(() => ({
    secs: [...document.querySelectorAll('.hsec')].map((e) => e.textContent), rows: [...document.querySelectorAll('.jrow .t')].map((e) => e.textContent),
    sel: document.querySelector('.jrow.sel .t')?.textContent, focus: document.activeElement?.className, prev: !!document.querySelector('.hprev'), mini: !!document.querySelector('.minimap .gmap, .minimap svg'),
    unfold: !!document.querySelector('.hunfold'), marks: document.querySelectorAll('.jrow mark').length, count: document.querySelector('.hcount')?.textContent,
  }))
  let h = await home()
  if (h.secs.slice(0, 4).join('|') !== 'Continue|In store.js|Checks|New') fail(`sections ${h.secs.join(', ')}`)
  if (h.focus !== 'hsearch') fail(`the search field is not focused when the home opens (${h.focus})`)
  if (w >= 700 ? !h.prev : h.unfold) fail(`wide: a preview of the selected row; narrow: nothing unfolded yet (${JSON.stringify(h)})`)
  if (w >= 700) { await page.waitForTimeout(600); if (!(await home()).mini) fail('no mini map in the preview') }
  for (const b of await measure()) fail(b)
  if (OUT) await page.screenshot({ path: path.join(OUT, `home-${w}-${theme}.png`), fullPage: false })
  // Search: "retry" finds a journey by its step text; matched words are marked.
  await page.keyboard.type('retry')
  await settle()
  h = await home()
  if (!h.rows.includes('How charging work')) fail(`"retry" didn't find "How charging work": ${h.rows.join(', ')}`)
  if (!h.marks) fail('matched words are not marked')
  if (OUT) await page.screenshot({ path: path.join(OUT, `home-search-${w}-${theme}.png`) })
  // Esc clears the search; ↓ moves the selection; a click selects (no walk); Enter walks.
  await page.keyboard.press('Escape')
  await settle()
  if ((await home()).rows.length < 30) fail('Esc did not clear the search')
  const first = (await home()).sel
  await page.keyboard.press('ArrowDown')
  await settle()
  if ((await home()).sel === first) fail('↓ did not move the selection')
  await page.click('.jrow:not(.sel)')
  await settle()
  if (w < 700 && !(await home()).unfold) fail('a click on a row did not unfold its steps')
  if ((await posted()).some((m) => m.type === 'walk')) fail('a click walked (it should select)')
  await page.keyboard.press('Enter')
  await settle()
  if (!(await posted()).some((m) => m.type === 'walk')) fail('Enter did not walk the selected journey')
  // Back home: a chip filters to checks.
  await send({ type: 'home' }); await settle()
  const chip = await page.$('.chip:text-is("Checks")')
  if (!chip) fail('no Checks chip')
  else { await chip.click(); await settle(); h = await home(); if (h.rows.join() !== 'Check · feat/retry-charges') fail(`Checks chip shows ${h.rows.join(', ')}`); await page.click('.chip:text-is("All")'); await settle() }
  // Esc with no search goes back to the journey.
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await settle()
  if (await page.$('.home')) fail('Esc did not go back to the journey')
  if (errors.length) fail(`console: ${errors.join(' | ')}`)
  await page.close()
  function fail(m) { fails.push(`${tag}: ${m}`) }
}
await browser.close()
for (const f of fails) console.log(`✗ ${f}`)
console.log(fails.length ? `${fails.length} problems` : 'journeys home: all widths and themes fine')
process.exit(fails.length ? 1 : 0)
