// Drives the journey panel harness in Chromium (Playwright): screenshots at 500/1200 px, light/dark,
// and asserts what a person would notice. The map is the whole journey at once (journey-graph.js): no boxes
// overlapping or sticking out of their container, no box text cut, arrow labels on their lines and never over a box
// or each other, the current step's box ringed and in view (it follows the step), step numbers walk, boxes open code,
// drag pans without clicking, Ctrl+wheel zooms, Fit shows it all with whole names; a journey opens on the whole map
// (no text over another, nothing cut at its edge, the tutorial up or not); the home list; the storyline,
// step card, problems, deleted and the tutorial as before; every bundled sample journey (and, optionally, every journey
// in a folder you name) at every step; no console errors. Exits 1 on any failure.
//
// Each check starts on a fresh page (panel.mjs Panel.reset) and opens what it needs, so one failing leaves the others
// as they were and any of them runs alone.
//
// Usage: npm run build, then npm run test:panel (or node test/journey-map/shoot.mjs [screenshot-dir] [journeys-dir]
// [--only=check,check]).
// screenshot-dir: where the PNGs go (none are taken without it).
// journeys-dir: a folder of journey files (e.g. a repo's journeys/) also checked at every step; its journeys are the
// home's list too.
// --only: run just these checks (their names below, e.g. --only=zoom,legend).
// PLAYWRIGHT: path to playwright's index.mjs when it is not installed in node_modules; CHROME: a Chromium binary to
// use instead of Playwright's own.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { launchChromium, openHarness } from '../harness/page.mjs'
import { Panel } from './panel.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const ONLY = (args.find((a) => a.startsWith('--only=')) || '--only=').slice('--only='.length).split(',').filter(Boolean)
const [shotsArg, journeysArg] = args.filter((a) => !a.startsWith('--'))
const OUT = shotsArg ? path.resolve(shotsArg) : ''
if (OUT) fs.mkdirSync(OUT, { recursive: true })
const JOURNEYS = journeysArg ? path.resolve(journeysArg) : ''
if (JOURNEYS && !fs.existsSync(JOURNEYS)) { console.error(`no folder ${JOURNEYS}`); process.exit(2) }
const SAMPLES = path.join(ROOT, 'test/fixtures/journey/journeys')
const FIXTURES = path.join(ROOT, 'test/journey-map/fixtures')
const HARNESS = pathToFileURL(path.join(ROOT, 'test/journey-map/harness.html')).href
/** Run in each page before its own scripts: the contrast helpers and the layout rules (window.__harness:
 *  ../harness/themes.js Harness). */
const PAGE_HELPERS = [path.join(ROOT, 'test/harness/contrast.js'), path.join(ROOT, 'test/journey-map/layoutChecks.js')]

// ---------- what the build put in place ----------

const BUNDLE = path.join(ROOT, 'out/pages/map.js')
for (const f of ['out/src/core/format/journeyModel.js', 'out/src/core/list/journeyList.js', 'out/vendor/elk.bundled.js', 'out/pages/map.js', 'out/test/journey-map/messages.js']) {
  if (!fs.existsSync(path.join(ROOT, f))) { console.error(`${f} is missing: run \`npm run build\` first`); process.exit(2) }
}
/** The page's sources newer than its bundle: the build is out of date. */
const sources = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []))
const newer = sources(path.join(ROOT, 'media')).filter((f) => fs.statSync(f).mtimeMs > fs.statSync(BUNDLE).mtimeMs)
if (newer.length) { console.error(`${path.relative(ROOT, newer[0])} is newer than out/pages/map.js: run \`npm run build\` first`); process.exit(2) }

/** The extension's journey reader (src/core/format/journeyModel.ts): the page gets journeys parsed, as from the extension. */
const { parseJourney } = require(path.join(ROOT, 'out/src/core/format/journeyModel.js'))
/** The panel's messages, typed against src/protocol/map.ts (messages.ts). */
const { toMap, FROM } = require(path.join(ROOT, 'out/test/journey-map/messages.js'))
/** The home's model, as the extension builds it (journeyList.ts). */
const { buildList } = require(path.join(ROOT, 'out/src/core/list/journeyList.js'))

// ---------- fixtures: journeys as the extension sends them (parsed, steps numbered) ----------

/** The journey file `f`, parsed as the extension does. */
function journeyFile(f) {
  const r = parseJourney(fs.readFileSync(f, 'utf8'), path.basename(f, '.json'))
  if (!r.ok) throw new Error(`${f}: ${r.why}`)
  return r.value
}
const jsonIn = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(dir, f))

/** The sample most checks walk (13 steps across three systems). */
const journey = journeyFile(path.join(SAMPLES, 'v2-full.json'))
/** A record two parts hand over through (a dashed store box). */
const handoff = journeyFile(path.join(FIXTURES, 'handoff.json'))
/** A generated journey's shape: a system of modules and functions, two top-level external boxes it calls. */
const GENERATED = path.join(FIXTURES, 'billing-plan-change.json')
/** The example repository's journey (four systems, a store in each, ten steps). */
const SHOP = path.join(ROOT, 'examples/shop/journeys/place-order.json')
// The bundled samples, then the journeys of the folder named on the command line.
const extra = JOURNEYS ? jsonIn(JOURNEYS) : []
const real = [...jsonIn(SAMPLES), ...extra]
/** The home's journeys: those of the folder named, else fixtures/home.json; the first is "here", the second left at
 *  step 4 and marked "Start here" (a journey in progress shows where it is instead). */
const list = extra.length
  ? extra.map((f, i) => ({
    key: `k-${path.basename(f)}`, title: path.basename(f, '.json'), question: JSON.parse(fs.readFileSync(f, 'utf8')).question,
    steps: 13, resume: i === 1 ? 4 : 0, ...(i === 0 ? { here: true } : {}), ...(i === 1 ? { start: true } : {}),
  }))
  : JSON.parse(fs.readFileSync(path.join(FIXTURES, 'home.json'), 'utf8'))
const homeModel = buildList(list.map((x) => ({
  key: x.key, kind: 'journey', title: x.title, question: x.question, summary: '', files: ['web/a.js'], stepTitles: [],
  steps: x.steps, stale: 0, isNew: false, resume: x.resume, ...(x.start ? { start: true } : {}),
})))
/** Provenance as the extension sends it: who wrote it, when, and how many steps are out of date. */
const PROV = { text: 'Written by Model X · 1 Jan', tip: 'model-x · commit a1b2c3d', changed: 2 }

// ---------- the checks: each opens what it needs on a fresh page ----------

/** The short title, the question under it, one provenance line, the storyline; no Start button. */
async function header(p) {
  await p.open(journey, { prov: PROV })
  const head = await p.page.evaluate(() => ({
    kids: [...document.querySelector('header').children].map((c) => c.className || c.tagName).join(),
    prov: document.querySelector('.prov')?.textContent,
    amber: getComputedStyle(document.querySelector('.prov .changed')).color,
    muted: getComputedStyle(document.querySelector('.prov')).color,
    title: document.querySelector('h1.q').textContent,
    sub: document.querySelector('.qsub')?.textContent,
    q: (() => { const q = document.querySelector('h1.q'); return Math.round(q.clientHeight / parseFloat(getComputedStyle(q).lineHeight)) })(),
    sticky: getComputedStyle(document.querySelector('.head')).position,
    rows: document.querySelectorAll('.story .st').length,
    rowText: document.querySelector('.story .st').textContent,
    startBtn: [...document.querySelectorAll('button')].filter((x) => /Start/.test(x.textContent)).map((x) => x.textContent).join('|'),
  }))
  if (head.kids !== 'link homeb,top,qsub,prov') p.problem(`the header holds ${head.kids} (Journeys link, short title + controls, the question, one provenance line)`)
  if (head.title !== journey.title || head.sub !== journey.question) p.problem(`the heading is "${head.title}" over "${head.sub}" (the short title, the question under it)`)
  if (head.prov !== `${PROV.text} · ⚠ 2 steps out of date` || head.amber === head.muted) p.problem(`provenance line ${JSON.stringify(head)}`)
  if (head.q > 2) p.problem(`the title takes ${head.q} lines`)
  if (head.sticky !== 'sticky') p.problem('the header is not sticky')
  if (head.rows !== journey.steps.length || head.rowText !== `1${journey.steps[0].title}`) p.problem(`storyline ${head.rows} rows, first "${head.rowText}" (number + title only)`)
  if (head.startBtn) p.problem(`a Start button (opening a journey walks it): ${head.startBtn}`)
}

/** The map beside the storyline (wide) or above it, foldable (narrow); not walking, the whole map fits with every box. */
async function mapPlacement(p) {
  await p.open(journey)
  const toggle = () => p.page.evaluate(() => ({ map: !!document.querySelector('.mapwrap'), toggle: document.querySelector('.maptoggle')?.textContent, expanded: document.querySelector('.maptoggle')?.getAttribute('aria-expanded') }))
  if (p.width < 520) {
    const nm = await toggle()
    if (!nm.map || nm.toggle !== 'Map' || nm.expanded !== 'true') p.problem(`narrow at first ${JSON.stringify(nm)} (the map shown above the storyline, foldable)`)
    const mi = await p.rect('.mapwrap'), sto = await p.rect('.story')
    if (!mi || mi.b > sto.t + 1 || mi.h < 200) p.problem(`the map is not above the storyline at a usable height ${JSON.stringify({ mi, sto })}`)
    await p.page.click('.maptoggle')
    await p.settle()
    const shut = await toggle()
    if (shut.map || shut.expanded !== 'false') p.problem(`"Map" did not fold the map ${JSON.stringify(shut)}`)
    await p.shot('0-narrow-folded')
    await p.page.click('.maptoggle')
    await p.settle()
    if (!(await toggle()).map) p.problem('"Map" did not unfold the map')
  } else {
    const mi = await p.rect('.mapwrap'), sto = await p.rect('.story')
    if (!mi || mi.l < sto.r || mi.w < 400 || mi.h < 500) p.problem(`the map is not beside the storyline at a usable size ${JSON.stringify({ mi, sto })}`)
    if (await p.page.$('.maptoggle')) p.problem('a "Map" toggle when wide')
  }
  // Not walking: the whole map fits; every box is drawn (no "+n more").
  await p.check('start', { current: false })
  const nb = await p.page.evaluate(() => document.querySelectorAll('.gbox').length)
  if (nb !== journey.nodes.length) p.problem(`${nb} boxes drawn of ${journey.nodes.length}`)
  await p.shot('1-start')
}

/** Keyboard focus is visible on a storyline row. */
async function storylineFocus(p) {
  await p.open(journey)
  await p.page.focus('.story .st')
  await p.page.keyboard.press('Tab')
  const fv = await p.page.evaluate(() => { const a = document.activeElement; const cs = getComputedStyle(a); return { cls: a.className, style: cs.outlineStyle, w: parseFloat(cs.outlineWidth) } })
  if (!/\bst\b/.test(fv.cls) || fv.style === 'none' || fv.w < 2) p.problem(`no visible keyboard focus on a storyline row ${JSON.stringify(fv)}`)
}

/** Walking: the map follows the step (the box ringed, in view, readable), its number lit, its arrows strong. */
async function walking(p) {
  await p.open(journey, { prov: PROV })
  await p.tour({ current: 1, prov: PROV })
  await p.check('step 1')
  const s1 = await p.page.evaluate(() => ({
    cur: document.querySelector('.gbox.current')?.dataset.id,
    num: document.querySelector('.gnum.cur')?.textContent,
    on: document.querySelectorAll('path.gedge.on').length,
    faint: document.querySelectorAll('path.gedge.faint').length,
    story: document.querySelector('.story .st.cur')?.dataset.n,
  }))
  const v1 = await p.view()
  if (s1.cur !== 'place' || s1.num !== '1' || !s1.on || !s1.faint || s1.story !== '1') p.problem(`step 1 ${JSON.stringify(s1)}`)
  if (!v1 || v1.k < 0.79) p.problem(`step 1 at zoom ${v1 && v1.k} (readable: ≥ 0.8)`)
  await p.shot('2-step1')
  // A step in another module: the map moves there.
  await p.tour({ current: 8, prov: PROV })
  await p.check('step 8')
  if ((await p.page.evaluate(() => document.querySelector('.gbox.current')?.dataset.id)) !== 'pspconf') p.problem('the map did not follow to step 8')
  await p.shot('2-step8')
}

/** The splitter (wide only; none when narrow): drag resizes the map, the step's box stays put; clamped; keys;
 *  double-click resets; the width is posted for the extension to keep, and a width it sends back is used. */
async function splitter(p) {
  await p.open(journey, { current: 8, prov: PROV })
  if (p.width < 520) {
    if (await p.page.$('.splitter')) p.problem('a splitter in the narrow layout')
    return
  }
  const sp = await p.rect('.splitter')
  const cursor = await p.page.evaluate(() => getComputedStyle(document.querySelector('.splitter')).cursor)
  if (!sp || cursor !== 'col-resize') p.problem(`splitter ${JSON.stringify(sp)} cursor ${cursor}`)
  const mw0 = (await p.rect('.mapwrap')).w, box0 = await p.rect('.gbox.current')
  const drag = async (dx) => {
    const q = await p.rect('.splitter')
    await p.page.mouse.move(q.l + q.w / 2, q.t + 200)
    await p.page.mouse.down()
    await p.page.mouse.move(q.l + q.w / 2 + dx, q.t + 200, { steps: 8 })
    await p.page.mouse.up()
    await p.settle()
  }
  const widthsPosted = async () => (await p.posted()).filter((m) => m.type === FROM.mapWidth)
  await p.posted()
  await drag(-120)
  const mw1 = (await p.rect('.mapwrap')).w, box1 = await p.rect('.gbox.current'), pw = await widthsPosted()
  if (Math.abs(mw1 - mw0 - 120) > 2) p.problem(`dragging the splitter 120px left made the map ${mw0} -> ${mw1}`)
  if (Math.abs(box1.l - box0.l) > 1 || Math.abs(box1.t - box0.t) > 1) p.problem(`the step's box jumped while resizing ${JSON.stringify([box0, box1])}`)
  if (pw.length !== 1 || Math.abs(pw[0].w - mw1) > 1) p.problem(`drag end posted ${JSON.stringify(pw)} (want one mapWidth ${mw1})`)
  await p.check('splitter dragged')
  await p.shot('2-splitter')
  await drag(-2000)
  const big = await p.page.evaluate(() => ({ map: document.querySelector('.mapwrap').offsetWidth, story: document.querySelector('.story').offsetWidth }))
  if (big.story < 279) p.problem(`the storyline squeezed to ${big.story}px (min 280)`)
  await drag(3000)
  const small = (await p.rect('.mapwrap')).w
  if (Math.abs(small - 240) > 1) p.problem(`the map at its narrowest is ${small}px (min 240)`)
  await p.page.focus('.splitter')
  await p.page.keyboard.press('ArrowLeft')
  await p.settle()
  if (Math.abs((await p.rect('.mapwrap')).w - 264) > 1) p.problem('ArrowLeft on the splitter did not widen the map by 24px')
  await p.posted()
  await p.page.dblclick('.splitter')
  await p.settle()
  const reset = (await p.rect('.mapwrap')).w, pr = await widthsPosted()
  if (Math.abs(reset - mw0) > 1 || !pr.some((m) => m.w === 0)) p.problem(`double-click did not reset (${reset} vs ${mw0}, ${JSON.stringify(pr)})`)
  await p.tour({ current: 8, prov: PROV, mapWidth: 500 })
  if (Math.abs((await p.rect('.mapwrap')).w - 500) > 1) p.problem(`a remembered width (500) from the extension is not used: ${(await p.rect('.mapwrap')).w}`)
  const kept = await p.page.evaluate(() => window.__harness.state && window.__harness.state.mapW)
  if (kept !== 500) p.problem(`the width is not kept in the webview state (${kept})`)
}

/** Dragged away, the next step brings the map back. */
async function dragThenNextStep(p) {
  await p.open(journey, { current: 8, prov: PROV })
  const mb = await p.rect('.gmap')
  await p.page.mouse.move(mb.l + 40, mb.t + 60)
  await p.page.mouse.down()
  await p.page.mouse.move(mb.l + 300, mb.t + 400, { steps: 6 })
  await p.page.mouse.up()
  await p.settle()
  const dragged = await p.view()
  await p.tour({ current: 9, prov: PROV })
  await p.check('step 9 after a drag')
  if (JSON.stringify(await p.view()) === JSON.stringify(dragged)) p.problem('after a drag the next step did not move the map back')
}

/** Clicks: a step number walks there; a function box opens its code; a module zooms to it; a drag clicks nothing. */
async function clicks(p) {
  // Walked to step 9 (a journey opens on the whole map, where narrow panels show no box numbers).
  await p.open(journey, { prov: PROV })
  await p.tour({ current: 9, prov: PROV })
  await p.clickPosts('.gnum[data-n="9"]', { type: FROM.step, n: 9 }, 'a step number')
  const at = journey.nodes.find((n) => n.id === 'chargestatus').at
  await p.clickPosts('.gbox.leaf[data-id="chargestatus"] .glbl', { type: FROM.openPath, path: `${at.file}:${at.start}-${at.end}` }, 'a function box opens its code')
  const before = await p.view()
  await p.posted()
  await p.page.click('.gbox.group[data-id="payclient"] .gtitle')
  await p.settle()
  if (JSON.stringify(await p.view()) === JSON.stringify(before) || (await p.posted()).some((m) => m.type === FROM.step || m.type === FROM.openPath)) p.problem('a module click did not zoom to it, or acted otherwise')
  const lb = await p.rect('.gbox.leaf[data-id="chargestatus"]')
  await p.posted()
  await p.page.mouse.move(lb.l + 10, lb.t + 8)
  await p.page.mouse.down()
  await p.page.mouse.move(lb.l + 80, lb.t + 60, { steps: 5 })
  await p.page.mouse.up()
  await p.settle()
  if ((await p.posted()).some((m) => m.type === FROM.openPath || m.type === FROM.step)) p.problem('a drag that started on a box opened it')
}

/** Zoom: Ctrl+wheel around the cursor, the buttons, the keys (with the map focused), Fit (the far view); the plain
 *  wheel pans. */
async function zoom(p) {
  await p.open(journey, { current: 9 })
  const mb = await p.rect('.gmap')
  const z0 = await p.view()
  await p.page.mouse.move(mb.l + mb.w / 2, mb.t + mb.h / 2)
  await p.page.keyboard.down('Control')
  await p.page.mouse.wheel(0, 300)
  await p.page.keyboard.up('Control')
  await p.settle()
  const z1 = await p.view()
  if (!(z1.k < z0.k)) p.problem(`Ctrl+wheel did not zoom out (${z0.k} -> ${z1.k})`)
  await p.page.click('.gin')
  await p.settle()
  if (!((await p.view()).k > z1.k)) p.problem('+ did not zoom in')
  await p.page.focus('.gmap')
  await p.page.keyboard.press('0')
  await p.settle()
  const fit = await p.view()
  const whole = await p.page.evaluate(() => { const w = document.querySelector('.gworld').getBoundingClientRect(), m = document.querySelector('.gmap').getBoundingClientRect(); return w.left >= m.left - 1 && w.right <= m.right + 1 && w.top >= m.top - 1 && w.bottom <= m.bottom + 1 })
  if (!whole) p.problem('0 (Fit) does not show the whole map')
  await p.check('fit')
  if (fit.k < 0.55 && !(await p.page.$('.gmap.far'))) p.problem('far out without the far view')
  await p.farCheck('fit')
  await p.shot('3-fit')
  await p.page.keyboard.press('+')
  await p.settle()
  if (!((await p.view()).k > fit.k)) p.problem('the + key did not zoom in')
  await p.page.keyboard.press('+')
  await p.page.keyboard.press('+')
  await p.settle()
  const p0 = await p.view()
  await p.page.mouse.move(mb.l + mb.w / 2, mb.t + mb.h / 2)
  await p.page.mouse.wheel(0, 120)
  await p.settle()
  const p1 = await p.view()
  if (p1.k !== p0.k || p1.y === p0.y) p.problem(`the wheel did not pan (${JSON.stringify(p0)} -> ${JSON.stringify(p1)})`)
}

/** The legend on demand: it says what the ring is, never covers the current step's box; "?" again, Esc and a click
 *  elsewhere close it. */
async function legend(p) {
  await p.open(journey, { current: 9 })
  // The step's box dragged to the map's top left, clear of the legend's first corner: the legend stays in that corner
  // (bottom right) even over the step's box for now (journey-graph.js placeLegend; seen at 500 px on a fresh page).
  const stage = await p.rect('.gstage'), box = await p.rect('.gbox.current')
  const from = { x: stage.l + stage.w / 2, y: stage.t + stage.h / 2 }
  await p.page.mouse.move(from.x, from.y)
  await p.page.mouse.down()
  await p.page.mouse.move(from.x + stage.l + 20 - box.l, from.y + stage.t + 30 - box.t, { steps: 6 })
  await p.page.mouse.up()
  await p.settle()
  if (await p.page.isVisible('.glegend')) p.problem('the legend is shown before "?"')
  await p.clickPosts('.glegq', { type: FROM.legend, hidden: false }, 'the legend "?"')
  if (!(await p.page.isVisible('.glegend'))) p.problem('"?" did not show the legend')
  await p.shot('3-legend')
  const lg = await p.page.evaluate(() => {
    const l = document.querySelector('.glegend').getBoundingClientRect(), c = document.querySelector('.gbox.current')?.getBoundingClientRect()
    return { text: document.querySelector('.glegend').textContent, over: !!c && l.left < c.right && c.left < l.right && l.top < c.bottom && c.top < l.bottom }
  })
  if (!lg.text.includes('this step · drag to move, Ctrl+wheel to zoom')) p.problem(`legend says "${lg.text}"`)
  if (lg.over) p.problem("the legend covers the current step's box")
  await p.clickPosts('.glegq', { type: FROM.legend, hidden: true }, '"?" again hides the legend')
  await p.clickPosts('.glegq', { type: FROM.legend, hidden: false }, 'the legend "?" (again)')
  await p.page.keyboard.press('Escape')
  await p.settle()
  if (await p.page.isVisible('.glegend')) p.problem('Esc did not close the legend')
  await p.clickPosts('.glegq', { type: FROM.legend, hidden: false }, 'the legend "?" (third)')
  await p.page.mouse.click(5, 5)
  await p.settle()
  if (await p.page.isVisible('.glegend')) p.problem('a click elsewhere did not close the legend')
}

/** How long after a step change the map is still moving (it animates for ~300 ms), and when it has surely stopped. */
const ANIMATION_PROBE_MS = 60, ANIMATION_DONE_MS = 500

/** The step change animates when motion is allowed (the only timed check: it looks at the map mid-move). */
async function stepAnimates(p) {
  await p.open(journey, { current: 9 })
  const start = await p.view()
  await p.page.emulateMedia({ reducedMotion: 'no-preference' })
  await p.send(p.toMap.tour({ current: 2 }))
  await p.page.waitForTimeout(ANIMATION_PROBE_MS)
  const mid = await p.view()
  await p.page.waitForTimeout(ANIMATION_DONE_MS)
  const end = await p.view()
  if (JSON.stringify(mid) === JSON.stringify(end)) p.problem(`the step change did not animate (${JSON.stringify(start)} -> ${JSON.stringify(mid)} -> ${JSON.stringify(end)})`)
  await p.page.emulateMedia({ reducedMotion: 'reduce' })
  await p.check('step 2 animated')
}

/** End in the header (none on the last step); after End the storyline marks where it was left; a removed last step is
 *  clamped. */
async function endAndResume(p) {
  await p.open(journey, { current: 13 })
  if (await p.page.$('.tour .end')) p.problem('End shown on the last step')
  await p.tour({ current: 3, marks: { 9: 'stale' } })
  const stale = await p.page.evaluate(() => {
    const r = document.querySelector('.story .st[data-n="9"]')
    return { text: r.textContent, n: getComputedStyle(r.querySelector('.n')).color, plain: getComputedStyle(document.querySelector('.story .st[data-n="8"] .n')).color }
  })
  if (/⚠/.test(stale.text) || stale.n === stale.plain) p.problem(`stale row ${JSON.stringify(stale)} (amber number only)`)
  await p.clickPosts('.tour .end', { type: FROM.end }, 'End')
  await p.tour({ resume: 8 })
  // After End nothing looks half on: no button, no row marked, no box ringed.
  const res = await p.page.evaluate(() => ({
    b: !!document.querySelector('.tour button'),
    marked: [...document.querySelectorAll('.story .st')].filter((r) => r.className !== 'st').map((r) => r.className).join(),
    ring: !!document.querySelector('.gbox.current'),
  }))
  if (res.b || res.marked || res.ring) p.problem(`after End ${JSON.stringify(res)}`)
  await p.clickPosts('.story .st[data-n="8"]', { type: FROM.step, n: 8 }, 'the row where it was left')
  await p.tour({ current: 14, resume: 20 })
  if ((await p.page.evaluate(() => document.querySelector('.story .st.cur')?.dataset.n)) !== '13') p.problem('a removed last step is not clamped')
}

/** A step with no code to open: its card under its storyline row; a stale card has one Ask; links, details, Next and
 *  Finish. */
async function stepCard(p) {
  await p.open(journey, { current: 4, card: { n: 4, lead: 'x', refs: '', stale: true, staleText: "**⚠ Code changed: can't find these lines** · [Ask](ask:update)" } })
  const stl = await p.page.evaluate(() => ({
    text: document.querySelector('.sstale')?.textContent,
    asks: [...document.querySelectorAll('.scard button')].filter((x) => /Ask/.test(x.textContent)).length,
    under: document.querySelector('.scard')?.closest('li')?.querySelector('.st')?.dataset.n,
  }))
  if (stl.text !== "⚠ Code changed: can't find these lines · Ask" || stl.asks !== 1 || stl.under !== '4') p.problem(`stale card ${JSON.stringify(stl)}`)
  await p.clickPosts('.sstale .askupd', { type: FROM.ask, update: true }, 'Ask on a stale card')
  const card = {
    n: 4,
    lead: 'The loop polls, see [worker.go:12](ref:0).',
    details: '- first point\n- second, in [status.go:342-360](ref:1)',
    refs: '[a.go:1](ref:0) · ~~b.go:2~~ (file gone)\n\nThe 2 s poll interval is set in [main.go:371](ref:2).',
    stale: false,
    open: false,
    paths: ['worker/worker.go:12', 'payments/status.go:342-360', 'cmd/shop/main.go:371'],
  }
  await p.tour({ current: 4, card })
  await p.check('panel card')
  await p.clickPosts('.scard .slead .ref', { type: FROM.ref, i: 0 }, 'a link in the lead')
  await p.tour({ current: 4, card: { ...card, open: true } })
  const det = await p.page.evaluate(() => ({
    items: document.querySelectorAll('.scard .sdetails li').length,
    sentence: [...document.querySelectorAll('.scard .srefs p')].map((x) => x.textContent).join('|'),
    hover: [...document.querySelectorAll('.scard .srefs .ref')].map((r) => r.title).join(),
  }))
  if (det.items !== 2 || !det.sentence.includes('The 2 s poll interval is set in main.go:371.') || !det.hover.includes('cmd/shop/main.go:371')) p.problem(`details ${JSON.stringify(det)}`)
  await p.shot('5-panel-card', true)
  await p.clickPosts('.scard .snext', { type: FROM.step, n: 5 }, 'card Next')
  await p.tour({ current: 13, card: { ...card, n: 13 } })
  await p.clickPosts('.scard .send', { type: FROM.finish }, 'Finish on the last step')
}

/** A step low in a long storyline: its row in view under the sticky header. */
async function longStoryline(p) {
  await p.resize(420)
  await p.open(journey)
  await p.tour({ current: 1 })
  await p.tour({ current: 12 })
  const vis = await p.page.evaluate(() => {
    const x = document.querySelector('.story .st.cur').getBoundingClientRect(), h = document.querySelector('.head').getBoundingClientRect()
    return { top: x.top, bottom: x.bottom, head: h.bottom, H: window.innerHeight }
  })
  if (vis.top < vis.head - 1 || vis.bottom > vis.H + 1) p.problem(`step 12's row not in view under the header: ${JSON.stringify(vis)}`)
}

/** Problems, authors, deleted. */
async function problems(p) {
  await p.open(journey, { problems: ["Can't read the latest version of this file; showing the last good one."], authors: 2 })
  await p.check('problems', { current: false })
  const pl = await p.page.evaluate(() => ({ line: document.querySelector('.problems .plink')?.textContent, authors: document.querySelector('.authors')?.textContent }))
  if (!/Can't read the latest version/.test(pl.line ?? '') || pl.authors !== '2 rule breaks') p.problem(`problem lines ${JSON.stringify(pl)}`)
  await p.send(p.toMap.deleted('place-order.json'))
  await p.settle()
  const del = await p.page.evaluate(() => document.querySelector('.gone')?.textContent)
  if (del !== 'Deleted · Restore') p.problem(`deleted journey: ${del}`)
  await p.clickPosts('.gone .restore', { type: FROM.restore }, 'Restore a deleted journey')
}

/** What the tutorial's cards point at, in order, and what they say (the sample has no links and no animations). */
const TUTORIAL = [
  { target: '[data-tutorial="storyline"]', says: 'The steps, in the order things happen. Click one to see its code.' },
  { target: '[data-tutorial="storyline"]', says: 'In the editor, the card above the code explains the step. Highlighted there now: Next, Ask and More.' },
  { target: '[data-tutorial="map"]', says: 'Where each step happens; the numbers are the steps, click one to go there. Drag to move, Ctrl+wheel to zoom.' },
]

/**
 * The tutorial: the bar, then three cards (the storyline, the card in the editor, the map; two more where a journey
 * has links and animations) next to (never over) their element; the map does not move or act under it.
 * This harness owns the webview side: the bar's text, each card's text and placement, clicks blocked under it, Done
 * posted. test/integration/main/keysAndMap.ts owns the extension side (Skip remembered across a reopen, the replay
 * command, the step boxed in the editor for card 2, Done walking the steps).
 */
async function tutorial(p) {
  await p.resize(720)
  // Opened after another journey, as when the extension offers it on a journey's first open.
  await p.open({ ...journey, id: 'tut' }, { tutorial: true })
  await p.send(p.toMap.journey(journey, { tutorial: true }))
  await p.settle()
  const bar = await p.page.evaluate(() => document.querySelector('.tbar')?.textContent)
  if (bar !== 'New here?Show me how·Skip') p.problem(`tutorial bar "${bar}"`)
  await p.clickPosts('.tbar .tstart', { type: FROM.tutorial, action: 'card', card: 1 }, 'Show me how')
  // Cards 1 and 2: a step click under them starts nothing; Next.
  for (let c = 1; c <= 2; c++) {
    if (!(await tutorialCardShown(p, c))) return
    await p.page.click('.story .st[data-n="6"]')
    await p.settle()
    if ((await p.posted()).some((x) => x.type === FROM.step)) p.problem('a step click started the tour under the tutorial')
    // The card about the editor says so to the extension (it boxes the step's lines there).
    if (c === 1) await p.clickPosts('.tcard .tnext', { type: FROM.tutorial, action: 'card', card: 2, editor: 'card' }, 'Next to the editor card')
    else await p.page.click('.tcard .tnext')
  }
  // The last card, the map: its clicks go nowhere; Done finishes.
  if (!(await tutorialCardShown(p, 3))) return
  await p.posted()
  const before = await p.view()
  await p.page.evaluate(() => { document.querySelector('.gbox.leaf .glbl').click(); document.querySelector('.gnum').click(); document.querySelector('.gbox.group .gtitle').click() })
  await p.settle()
  if ((await p.posted()).some((x) => x.type === FROM.step || x.type === FROM.openPath) || JSON.stringify(await p.view()) !== JSON.stringify(before)) p.problem('a map click in the tutorial went through')
  await p.clickPosts('.tcard .tnext', { type: FROM.tutorial, action: 'done' }, 'Done finishes the tutorial')
  if (await p.page.isVisible('.tcard')) p.problem('tutorial card still shown after Done')
}

/** Tutorial card `c`: shown, its highlight around its element, the card beside it and inside the page, its sentence. */
async function tutorialCardShown(p, c) {
  const { target, says } = TUTORIAL[c - 1]
  await p.settle()
  const r = await p.page.evaluate((sel) => {
    const spot = document.querySelector('.spot'), cd = document.querySelector('.tcard'), t = document.querySelector(sel)
    if (!spot || !cd || !t) return { missing: true }
    const edges = (e) => { const q = e.getBoundingClientRect(); return { l: q.left, t: q.top, r: q.right, b: q.bottom } }
    const de = document.documentElement
    return { s: edges(spot), c: edges(cd), t: edges(t), text: cd.querySelector('.ttext').textContent, overflow: de.scrollWidth > de.clientWidth, H: window.innerHeight, W: de.clientWidth }
  }, target)
  if (r.missing) { p.problem(`tutorial card ${c} not shown`); return false }
  const inside = r.s.l <= r.t.l + 1 && r.s.r >= r.t.r - 1 && r.s.t <= Math.max(r.t.t, 0) + 1
  if (!inside) p.problem(`tutorial ${c}: highlight ${JSON.stringify(r.s)} does not surround ${target} ${JSON.stringify(r.t)}`)
  if (r.c.l < r.s.r && r.s.l < r.c.r && r.c.t < r.s.b && r.s.t < r.c.b) p.problem(`tutorial ${c}: the card covers the highlighted element`)
  if (r.overflow || r.c.l < 0 || r.c.r > r.W || r.c.b > r.H + 1) p.problem(`tutorial ${c}: card outside the page`)
  // Plain sentences, one thing per card.
  if (r.text !== says) p.problem(`tutorial card ${c} says "${r.text}"`)
  await p.shot(`8-tutorial-${c}`)
  return true
}

/** A record two parts hand over through: dashed, opens its path; every arrow drawn with its label. */
async function handoffRecord(p) {
  await p.open(handoff, { current: 1 })
  await p.check('hand-off')
  const ho = await p.page.evaluate(() => ({
    border: getComputedStyle(document.querySelector('.gbox[data-id="rec"]')).borderTopStyle,
    edges: document.querySelectorAll('.gworld path.gedge').length,
    labels: [...document.querySelectorAll('.glabel')].map((l) => l.textContent).sort().join(' | '),
  }))
  if (ho.border !== 'dashed' || ho.edges !== 3 || ho.labels !== 'marks it cancelled | marks it cancelling | polls') p.problem(`hand-off ${JSON.stringify(ho)}`)
  await p.clickPosts('.gbox[data-id="rec"] .glbl', { type: FROM.openPath, path: 'api/store' }, 'a store opens its path')
}

/** Home: "‹ Journeys" lists every journey (title, a quiet "n/N" right after it where one was left); a click selects,
 *  Enter walks; the extension opens the list, a step closes it. */
async function home(p) {
  await p.open(journey, { current: 2 })
  await p.clickPosts('.homeb', { type: FROM.home, on: true }, '‹ Journeys')
  // Each row the title (no "Start here" on one in progress), where it was left right after it, the question under it
  // (the list model, journeyList.ts; its own checks are in test/journey-list/shoot.mjs). A click selects; Enter walks.
  const h = await p.page.evaluate(() => ({
    rows: [...document.querySelectorAll('.jrow .jtop')].map((r) => r.textContent),
    qs: [...document.querySelectorAll('.jrow .jq')].map((r) => r.textContent),
    start: [...document.querySelectorAll('.jrow .jstart')].map((r) => r.closest('.jrow').querySelector('.t').textContent),
    gap: (() => { const r = document.querySelector('.jrow .jat'); if (!r) return -1; return r.getBoundingClientRect().left - r.previousElementSibling.getBoundingClientRect().right })(),
    map: !!document.querySelector('.hbody > .hlist .gmap'),
    h: document.querySelector('.home h1')?.textContent,
  }))
  if (h.rows.length !== list.length || h.map || !h.rows.includes(`${list[1].title}4/13`) || h.h !== 'Journeys') p.problem(`home ${JSON.stringify(h)}`)
  if (h.start.length) p.problem(`"Start here" on ${JSON.stringify(h.start)}, a journey in progress (it says where it is)`)
  if (h.qs.length !== list.length || !h.qs.includes(list[1].question)) p.problem(`home questions ${JSON.stringify(h.qs)}`)
  if (h.gap < 0 || h.gap > 20) p.problem(`home "n/N" is ${h.gap}px from its title (want right after it)`)
  await p.check('home', { current: false })
  await p.shot('10-home')
  const second = await p.page.$(`.jrow[data-key="${list[1].key}"]`)
  if (!second) p.problem(`no row for ${list[1].key}`)
  else {
    await second.click()
    await p.settle()
    if ((await p.posted()).some((m) => m.type === FROM.walk)) p.problem('a click walked (it selects)')
  }
  await p.page.keyboard.press('Enter')
  await p.settle()
  if (!(await p.posted()).some((m) => m.type === FROM.walk && m.key === list[1].key)) p.problem('Enter did not walk the selected journey')
  if (await p.page.$('.home')) p.problem('home still shown after choosing a journey')
  // The extension opens the list (a request without a question); a step opening closes it.
  await p.posted()
  await p.send(p.toMap.home())
  await p.settle()
  if (!(await p.page.$('.home')) || !(await p.posted()).some((m) => m.type === FROM.home && m.on === true)) p.problem('the extension\'s "home" did not show the list (or did not say so for the tab title)')
  await p.tour({ current: 3 })
  if (await p.page.$('.home')) p.problem('a step opened but the list stays in front')
}

/** Finish: "Done", the summary (two sentences at most), "‹ Journeys". */
async function finished(p) {
  await p.open(journey, { current: 3 })
  await p.tour({ current: 0, done: true })
  const dn = await p.page.evaluate(() => ({ t: document.querySelector('.done .dtitle')?.textContent, sum: document.querySelector('.done .dsum')?.textContent || '', home: document.querySelectorAll('.homeb, .done button').length }))
  if (dn.t !== 'Done' || !dn.sum || (dn.sum.match(/[.!?](\s|$)/g) || []).length > 2 || dn.home !== 1) p.problem(`finished ${JSON.stringify(dn)} (Done, the summary; one "‹ Journeys", the header's)`)
  await p.check('done', { current: false })
  await p.shot('10-done')
}

/** Another journey opens at the top (the map in view), whatever the last one's scroll. */
async function anotherOpensAtTop(p) {
  await p.resize(600)
  await p.open(journey, { current: 12 })
  await p.page.evaluate(() => window.scrollTo(0, 400))
  await p.settle()
  await p.open({ ...journey, id: 'another' }, { current: 1 })
  const y = await p.page.evaluate(() => window.scrollY)
  if (y !== 0) p.problem(`another journey opened scrolled to ${y} (at the top)`)
}

/** The sample journeys and those of the folder named on the command line: parsed as the extension does, the map at
 *  every step (the box ringed and in view), Fit; shots of the samples. A generated journey's shape first. */
async function samples(p) {
  for (const f of [GENERATED, ...real]) {
    const name = path.basename(f, '.json')
    const r = parseJourney(fs.readFileSync(f, 'utf8'), name)
    if (!r.ok) { p.problem(`${f}: ${r.why}`); continue }
    const j = r.value
    await p.open(j, { current: 1 })
    const pics = path.dirname(f) === SAMPLES || f === GENERATED
    for (let n = 1; n <= j.steps.length; n++) {
      if (n > 1) await p.tour({ current: n })
      await p.check(`${name} step ${n}`)
      if (pics && (n === 1 || n === 6 || n === 12)) await p.shot(`11-${name}-step${n}`)
    }
    await p.page.click('.gfit')
    await p.settle()
    await p.check(`${name} fit`, { current: false })
    await p.farCheck(`${name} fit`)
    for (const x of await p.page.evaluate(externalsFarFromCallers, j)) p.problem(`${name} fit: ${x}`)
    if (pics) await p.shot(`11-${name}-fit`)
    // After End: no current step, the whole map.
    await p.tour({ current: 0 })
    await p.check(`${name} ended`, { current: false })
    await p.farCheck(`${name} ended`)
    if (pics) await p.shot(`11-${name}-ended`)
  }
}

/**
 * A journey opens readable: on step 1, with and without the tutorial started before its map is laid out, at the
 * panel's width and in a 1440 × 900 window, no two texts of the map overlap (names, chip rows, titles, labels) and
 * the drawing's edge cuts no text and no box (layoutChecks.js openViewProblems).
 */
async function opensReadable(p) {
  let fresh = true
  for (const f of [SHOP, GENERATED, path.join(SAMPLES, 'v2-full.json')]) {
    const name = path.basename(f, '.json')
    const j = journeyFile(f)
    for (const width of [p.width, 1440]) for (const tutorial of [false, true]) {
      // A fresh page each time (the page before checked for errors first).
      if (!fresh) { await p.errorsSeen(); await p.reset() }
      fresh = false
      if (width !== p.width) await p.page.setViewportSize({ width, height: 900 })
      if (tutorial) {
        // The tutorial's first card is up before the map is laid out (ELK is async), as from the Tutorial command.
        await p.send(p.toMap.journey(j, { current: 1, tutorial: true }))
        await p.send({ type: 'tutorial' })
        await p.page.waitForFunction((r) => window.__harness.posted.some((m) => m.type === r), FROM.rendered, { timeout: 15000 })
        await p.settle()
      } else await p.open(j, { current: 1 })
      for (const x of await p.page.evaluate(() => window.__harness.openViewProblems())) p.problem(`${name} opened at ${width} px${tutorial ? ' under the tutorial' : ''}: ${x}`)
      if (name === 'place-order') await p.shot(`13-open-${width}${tutorial ? '-tutorial' : ''}`)
    }
  }
}

/** In the page: a top-level external box sits next to what calls it, not in a far corner. */
function externalsFarFromCallers(J) {
  const out = []
  const box = (id) => document.querySelector(`.gbox[data-id="${id}"]`)?.getBoundingClientRect()
  const gap = (a, b) => Math.hypot(Math.max(0, a.left - b.right, b.left - a.right), Math.max(0, a.top - b.bottom, b.top - a.bottom))
  const span = document.querySelector('.gworld').getBoundingClientRect()
  for (const n of J.nodes.filter((m) => m.kind === 'external' && !m.parent)) {
    const me = box(n.id)
    const near = J.edges.filter((e) => e.from === n.id || e.to === n.id).map((e) => box(e.from === n.id ? e.to : e.from)).filter(Boolean)
    if (me && near.length && Math.min(...near.map((r) => gap(me, r))) > 0.45 * Math.max(span.width, span.height)) out.push(`external ${n.id} far from what it talks to`)
  }
  return out
}

/** Resizing re-centres (narrow <-> wide); the narrowest panel (320 px) has the map above the storyline, nothing
 *  sideways. */
async function resize(p) {
  await p.open({ ...journey, id: 'again' }, { current: 7 })
  /** The viewport at its new width and the map redrawn for it (the resize handler draws on the next frame). */
  const resized = async () => { await p.page.waitForFunction(() => document.documentElement.clientWidth === window.innerWidth); await p.settle(); await p.settle() }
  await p.page.setViewportSize({ width: p.width === 500 ? 900 : 640, height: 900 })
  await resized()
  await p.check('resized')
  await p.page.setViewportSize({ width: 320, height: 900 })
  await resized()
  await p.check('320')
  await p.shot('12-320')
}

/**
 * The very first open of a fresh panel, with the tutorial offered: no error, the bar shown, the body there before
 * the scripts (VS Code's webview host reads document.body while the page loads). Its own page: no helpers in it.
 */
async function firstOpen(b, width, fail) {
  const { page, errors } = await openHarness(b, HARNESS, { width, height: 900, theme: 'dark', warnings: true })
  const bodyFirst = await page.evaluate(() => {
    const b = document.body
    const first = [...b.children].findIndex((c) => c.tagName === 'SCRIPT' && c.src)
    return first > [...b.children].findIndex((c) => c.id === 'app') && ![...document.head.querySelectorAll('script[src]')].length
  })
  if (!bodyFirst) fail(`first open ${width}: scripts load before the body`)
  await page.waitForFunction((r) => window.__harness.posted.some((m) => m.type === r), FROM.ready)
  await page.evaluate((x) => window.postMessage(x, '*'), toMap({ list }).journey(journey, { current: 1, tutorial: true }))
  await page.waitForFunction((r) => window.__harness.posted.some((m) => m.type === r), FROM.rendered, { timeout: 15000 })
  // The bar comes with the first drawing; the console gets until then (or 2 s) to complain.
  await page.waitForSelector('.tbar', { timeout: 2000 }).catch(() => { /* said just below */ })
  if (!(await page.$('.tbar'))) fail(`first open ${width}: no tutorial bar`)
  for (const e of [...errors, ...(await page.evaluate(() => window.__harness.errors)).map((e) => e.message)]) fail(`first open ${width}: ${e}`)
  await page.close()
}

/** The harness links the stylesheets the panel links, in its order (src/journeys/mapPanel.ts html): a sheet added
 *  there and not here would leave the checks looking at another page. */
function stylesheetsAsInThePanel(fail) {
  const panel = fs.readFileSync(path.join(ROOT, 'src/journeys/mapPanel.ts'), 'utf8')
  const css = /css: \[([^\]]*)\]/.exec(panel)
  const want = css ? [...css[1].matchAll(/file\('media', '([\w.-]+\.css)'\)/g)].map((m) => m[1]) : []
  const harness = fs.readFileSync(path.join(ROOT, 'test/journey-map/harness.html'), 'utf8')
  const have = [...harness.matchAll(/<link rel="stylesheet" href="\.\.\/\.\.\/media\/([\w.-]+\.css)">/g)].map((m) => m[1])
  if (!want.length || want.join() !== have.join()) fail(`the harness links ${have.join(', ')}; the panel links ${want.join(', ') || '(none found in mapPanel.ts)'}`)
}

// ---------- main ----------

/** Every check, by name; each on a fresh page at each width and theme. */
const CHECKS = {
  header, mapPlacement, storylineFocus, walking, splitter, dragThenNextStep, clicks, zoom, legend, stepAnimates,
  endAndResume, stepCard, longStoryline, problems, tutorial, handoffRecord, home, finished, anotherOpensAtTop, samples,
  resize, opensReadable,
}
const unknown = ONLY.filter((n) => !Object.hasOwn(CHECKS, n) && n !== 'firstOpen')
if (unknown.length) { console.error(`no check ${unknown.join(', ')} (checks: ${[...Object.keys(CHECKS), 'firstOpen'].join(', ')})`); process.exit(2) }
const chosen = (name) => !ONLY.length || ONLY.includes(name)

const failures = []
const fail = (m) => { failures.push(m); console.log(`  ✗ ${m}`) }
stylesheetsAsInThePanel(fail)
console.log(OUT ? `screenshots: ${OUT}` : 'no screenshots (give a folder as the first argument for them)')
const b = await launchChromium()
for (const width of [500, 1200]) for (const theme of ['light', 'dark']) {
  const p = new Panel(b, { harness: HARNESS, width, theme, helpers: PAGE_HELPERS, toMap: toMap({ list, home: homeModel }), from: FROM, shots: OUT, fail })
  for (const [name, run] of Object.entries(CHECKS)) {
    if (!chosen(name)) continue
    await p.reset()
    try {
      await run(p)
    } catch (e) {
      p.problem(`${name} stopped: ${e instanceof Error ? e.message.split('\n')[0] : e}`)
    }
    // No page error and nothing in the console while it ran.
    await p.errorsSeen()
  }
  await p.close()
  console.log(`${p.tag}: done`)
}
if (chosen('firstOpen')) for (const w of [500, 1200]) await firstOpen(b, w, fail)
await b.close()
console.log(failures.length ? `${failures.length} problems` : 'all checks passed')
process.exit(failures.length ? 1 : 0)
