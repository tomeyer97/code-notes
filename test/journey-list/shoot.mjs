// The panel's Journeys home (docs/journey-list.md) in Chromium (Playwright), with 35 journeys: at 320/600/1000 px,
// dark and light. Asserts: nothing wider than the panel, no console errors, search over step text ("retry" finds
// "How charging work"), a fallback line when no journey has every word, filter chips (In <file>, Stale, areas; no
// Checks), "In <file>" capped with "Show n more", a row click selects and previews (stale steps marked, Refresh),
// the keyboard (↓ from the search into the rows, a visible focus ring, the focused row in view, chips one Tab stop
// with ← →), Enter walks, Esc clears then goes back, "‹ Journeys" from a walk selects that journey, the heading is the
// short title. The extension's part (the model) is out/src/journeyList.js, run here.
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
const { items, NOW } = require(path.join(ROOT, 'out/test/fixtures/journeyList.js'))
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : ''
if (OUT) fs.mkdirSync(OUT, { recursive: true })
const HARNESS = pathToFileURL(path.join(ROOT, 'test/journey-map/harness.html')).href
const sample = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/journey/journeys/place-order.json'), 'utf8'))
const journey = { ...sample, steps: sample.steps.map((s, i) => ({ ...s, n: i + 1 })), problems: [] }
const ACTIVE = 'api/store.js'
// The journey shown (the walk) is k30 of the list: "‹ Journeys" selects it.
const SELF = 'k30'
const tour = (home) => ({ current: 0, marks: {}, resume: 0, legendHidden: true, problems: [], key: "Ctrl+'", tutorial: false, list: [{ key: SELF, title: 'x', question: 'x', steps: 6, resume: 0, here: true }], moved: {}, home })
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
  // The extension: answers "list" with a new model, "preview" with the journey and its stale steps, "hereAll".
  let state = { query: '', kind: 'all', area: '', sort: 'area' }
  let hereAll = false
  const model = () => buildList(items(), { activeFile: ACTIVE, now: NOW, hereAll, ...state })
  let seen = 0
  const pump = async () => {
    const ps = await posted()
    for (const m of ps.slice(seen)) {
      if (m.type === 'list') { state = { query: m.query, kind: m.kind, area: m.area, sort: m.sort ?? state.sort, searchSort: m.searchSort }; await send({ type: 'tour', ...tour(model()) }) }
      if (m.type === 'preview') await send({ type: 'preview', key: m.key, journey, stale: (model().rows[m.key].staleSteps || []).map((n) => ({ n, when: 'a1b2c3d · 3 d ago' })) })
      if (m.type === 'hereAll') { hereAll = true; await send({ type: 'tour', ...tour(model()) }) }
      if (m.type === 'error') errors.push(`posted error: ${m.message}`)
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
    for (const e of document.querySelectorAll('.home .jrow, .home .chip, .home .hsearch, .home .hsort, .hprev, .walkb, .hsec, .hnote, .psteps li, .pacts > *')) {
      const r = e.getBoundingClientRect()
      if (r.right > W + 1) bad.push(`${e.className} sticks out (${Math.round(r.right)} > ${W}): ${e.textContent.slice(0, 30)}`)
      if (e.scrollWidth > e.clientWidth + 1 && !/jrow|chip/.test(e.className) && getComputedStyle(e).textOverflow !== 'ellipsis') bad.push(`${e.className} is cut (${e.scrollWidth} > ${e.clientWidth})`)
    }
    return bad
  })
  const home = () => page.evaluate(() => ({
    secs: [...document.querySelectorAll('.hsec')].map((e) => e.textContent), rows: [...document.querySelectorAll('.jrow .t')].map((e) => e.textContent),
    sel: document.querySelector('.jrow.sel')?.dataset.key, selT: document.querySelector('.jrow.sel .t')?.textContent, focus: document.activeElement?.className, focusKey: document.activeElement?.dataset?.key,
    prev: !!document.querySelector('.hprev'), unfold: !!document.querySelector('.hunfold'), marks: document.querySelectorAll('.jrow mark').length, count: document.querySelector('.hcount')?.textContent,
    chips: [...document.querySelectorAll('.chip')].map((e) => e.textContent), note: document.querySelector('.hnote')?.textContent, more: document.querySelector('.hmore')?.textContent,
    staleLis: document.querySelectorAll('.psteps li.stale').length, when: document.querySelector('.pwhen')?.textContent, refresh: !!document.querySelector('.refreshb'), pnote: document.querySelector('.pnote')?.textContent,
  }))
  let h = await home()
  if (h.secs.slice(0, 3).join('|') !== 'Continue|In store.js|New') fail(`sections ${h.secs.join(', ')}`)
  if (h.secs.includes('Checks') || h.chips.some((c) => /Check/.test(c))) fail(`checks are listed: ${h.secs} ${h.chips}`)
  if (h.count !== '35') fail(`count ${h.count}`)
  if (h.more !== 'Show 2 more') fail(`"In store.js" is not capped at 5 with "Show 2 more" (${h.more})`)
  if (!h.chips.includes('Stale 3') || h.chips[0] !== 'In store.js') fail(`chips ${h.chips.join(', ')}`)
  if (h.focus !== 'hsearch') fail(`the search field is not focused when the home opens (${h.focus})`)
  if (w >= 700 ? !h.prev : h.unfold) fail(`wide: a preview of the selected row; narrow: nothing unfolded yet (${JSON.stringify(h)})`)
  for (const b of await measure()) fail(b)
  if (OUT) await page.screenshot({ path: path.join(OUT, `home-${w}-${theme}.png`), fullPage: false })
  // Search: "retry" finds a journey by its step text; matched words are marked.
  await page.keyboard.type('retry')
  await settle()
  h = await home()
  if (!h.rows.includes('How charging work')) fail(`"retry" didn't find "How charging work": ${h.rows.join(', ')}`)
  if (!h.marks) fail('matched words are not marked')
  if (h.note) fail(`a fallback line with every word found: ${h.note}`)
  // While searching, the order is "Best match" unless another is picked; a picked one applies to the results.
  if ((await page.$eval('.hsort', (e) => e.value)) !== 'best') fail('searching: the sort does not say "Best match"')
  await page.selectOption('.hsort', 'name'); await settle()
  h = await home()
  if (h.rows.join('|') !== [...h.rows].sort((a, b) => a.localeCompare(b)).join('|')) fail(`A–Z while searching: ${h.rows.join(', ')}`)
  await page.selectOption('.hsort', 'best'); await settle()
  await page.focus('.hsearch'); await page.keyboard.press('End')
  // A word nothing has: any word, and the line says so.
  await page.keyboard.press('Home'); await page.keyboard.type('zebra '); await settle()
  h = await home()
  if (h.note !== 'No journey about “zebra”; closest for “retry”' || !h.rows.includes('How charging work')) fail(`fallback: ${h.note} / ${h.rows.join(', ')}`)
  for (const b of await measure()) fail(`fallback: ${b}`)
  if (OUT) await page.screenshot({ path: path.join(OUT, `home-search-${w}-${theme}.png`) })
  // Esc clears the search.
  await page.keyboard.press('Escape')
  await settle()
  if ((await home()).rows.length < 30) fail('Esc did not clear the search')
  // Keyboard: ↓ from the search goes into the rows (the selected one, with a ring); ↓ moves; End goes to the last one,
  // which is scrolled into view; ↑ from the first row goes back to the search.
  const first = (await home()).sel
  await page.keyboard.press('ArrowDown'); await settle()
  h = await home()
  if (!/jrow/.test(h.focus || '') || h.focusKey !== first) fail(`↓ from the search did not go into the rows (${h.focus} ${h.focusKey})`)
  const ring = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 })
  if (!ring) fail('the focused row has no focus ring')
  await page.keyboard.press('Home'); await settle()
  const top = (await home()).sel
  await page.keyboard.press('ArrowDown'); await settle()
  h = await home()
  if (h.sel === top || h.focusKey !== h.sel) fail(`↓ did not move the focus and selection (${top} → ${h.sel}, focus ${h.focusKey})`)
  await page.keyboard.press('End'); await settle()
  const inView = await page.evaluate(() => { const r = document.activeElement.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight })
  if (!inView) fail('the focused row (End) is not scrolled into view')
  if (OUT) await page.screenshot({ path: path.join(OUT, `home-keys-${w}-${theme}.png`) })
  await page.keyboard.press('Home'); await settle(); await page.keyboard.press('ArrowUp'); await settle()
  if ((await home()).focus !== 'hsearch') fail('↑ from the first row did not go back to the search')
  // Tab: search → the chips (one stop) → sort → the rows (one stop).
  await page.keyboard.press('Tab'); const t1 = await page.evaluate(() => document.activeElement.className)
  await page.keyboard.press('ArrowRight'); const t1b = await page.evaluate(() => document.activeElement.textContent)
  await page.keyboard.press('Tab'); const t2 = await page.evaluate(() => document.activeElement.className)
  await page.keyboard.press('Tab'); const t3 = await page.evaluate(() => document.activeElement.className)
  if (!/^chip/.test(t1) || t1b !== 'Stale 3' || t2 !== 'hsort' || !/jrow/.test(t3)) fail(`Tab order: ${t1}, → ${t1b}, ${t2}, ${t3}`)
  // A click selects (narrow: unfolds; no walk); Enter walks.
  await page.click('.jrow:not(.sel)')
  await settle()
  if (w < 700 && !(await home()).unfold) fail('a click on a row did not unfold its steps')
  if ((await posted()).some((m) => m.type === 'walk')) fail('a click walked (it should select)')
  await page.keyboard.press('Enter')
  await settle()
  if (!(await posted()).some((m) => m.type === 'walk')) fail('Enter did not walk the selected journey')
  // Back home: the Stale chip; a stale journey's preview marks its changed steps (and when), with Refresh.
  await send({ type: 'home' }); await settle()
  await page.click('.chip:text-is("Stale 3")'); await settle()
  h = await home()
  if (h.rows.length !== 3) fail(`Stale chip shows ${h.rows.join(', ')}`)
  await page.click('.jrow'); await settle()
  h = await home()
  if (h.staleLis !== 2 || h.when !== '⚠ changed · a1b2c3d · 3 d ago' || !h.refresh || !/^The other \d+ still match the code\.$/.test(h.pnote || '')) fail(`stale preview ${JSON.stringify(h)}`)
  for (const b of await measure()) fail(`stale preview: ${b}`)
  if (OUT) await page.screenshot({ path: path.join(OUT, `home-stale-${w}-${theme}.png`) })
  await page.click('.refreshb'); await settle()
  if (!(await posted()).some((m) => m.type === 'refresh' && m.key === h.sel)) fail('Refresh did not ask')
  await page.click('.chip:text-is("Stale 3")'); await settle()
  // "Show 2 more": In store.js in full.
  await page.click('.hmore'); await settle()
  h = await home()
  if (h.more || h.rows.filter((_, i) => i < 9).length < 9) fail(`"Show 2 more" did not list them all (${h.more})`)
  // Esc with no search goes back to the journey; its heading is the short title, the question under it.
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await settle()
  if (await page.$('.home')) fail('Esc did not go back to the journey')
  const head = await page.evaluate(() => ({ h1: document.querySelector('h1.q')?.textContent, sub: document.querySelector('.qsub')?.textContent, lines: (() => { const q = document.querySelector('h1.q'); return Math.round(q.clientHeight / parseFloat(getComputedStyle(q).lineHeight)) })() }))
  if (head.h1 !== journey.title || head.sub !== journey.question) fail(`heading ${JSON.stringify(head)}`)
  // "‹ Journeys" from the walk: that journey is selected, in view.
  await page.click('.homeb'); await settle()
  h = await home()
  const selIn = await page.evaluate(() => { const r = document.querySelector('.jrow.sel')?.getBoundingClientRect(); return !!r && r.top >= 0 && r.bottom <= innerHeight })
  if (h.sel !== SELF || !selIn) fail(`"‹ Journeys" selected ${h.sel} (in view: ${selIn}), not the journey it came from`)
  if (OUT) await page.screenshot({ path: path.join(OUT, `home-back-${w}-${theme}.png`) })
  if (errors.length) fail(`console: ${errors.join(' | ')}`)
  await page.close()
  function fail(m) { fails.push(`${tag}: ${m}`) }
}
await browser.close()
for (const f of fails) console.log(`✗ ${f}`)
console.log(fails.length ? `${fails.length} problems` : 'journeys home: all widths and themes fine')
process.exit(fails.length ? 1 : 0)
