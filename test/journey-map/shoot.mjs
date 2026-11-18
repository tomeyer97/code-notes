// Drives the journey panel harness in Chromium (Playwright): screenshots at 500/1200 px, light/dark,
// and asserts what a person would notice. The map (0.21) is the whole journey at once (journey-graph.js): no boxes
// overlapping or sticking out of their container, no box text cut, arrow labels on their lines and never over a box
// or each other, the current step's box ringed and in view (it follows the step), step numbers walk, boxes open code,
// drag pans without clicking, Ctrl+wheel zooms, Fit shows it all with whole names; the home list; the storyline,
// step card, problems, deleted and the tutorial as before; every bundled sample journey (and, optionally, every journey
// in a folder you name) at every step; no console errors. Exits 1 on any failure.
//
// Usage (after `npm run build`, which puts out/src and out/vendor in place):
//   node test/journey-map/shoot.mjs [screenshot-dir] [journeys-dir]
// screenshot-dir: where the PNGs go (none are taken without it).
// journeys-dir: a folder of journey files (e.g. a repo's journeys/) also checked at every step.
// PLAYWRIGHT: path to playwright's index.mjs when it is not installed in node_modules; CHROME: a Chromium binary to
// use instead of Playwright's own.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { launchChromium, openHarness } from '../harness/page.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : ''
if (OUT) fs.mkdirSync(OUT, { recursive: true })
const JOURNEYS = process.argv[3] ? path.resolve(process.argv[3]) : ''
if (JOURNEYS && !fs.existsSync(JOURNEYS)) { console.error(`no folder ${JOURNEYS}`); process.exit(2) }
const SAMPLES = path.join(ROOT, 'test/fixtures/journey/journeys')
const HARNESS = pathToFileURL(path.join(ROOT, 'test/journey-map/harness.html')).href
/** Run in each page before its own scripts: the contrast helpers (window.contrast) and the layout rules `check` uses. */
const PAGE_HELPERS = [path.join(ROOT, 'test/harness/contrast.js'), path.join(ROOT, 'test/journey-map/layoutChecks.js')]
for (const f of [path.join(ROOT, 'out/src/journeyModel.js'), path.join(ROOT, 'out/vendor/elk.bundled.js')]) {
  if (!fs.existsSync(f)) { console.error(`${path.relative(ROOT, f)} is missing: run \`npm run build\` first`); process.exit(2) }
}

// ---------- fixtures: journeys as the extension sends them (parsed, steps numbered) ----------

// As the extension sends it: parsed (journeyModel.parseJourney), so steps carry their number.
const parse = (f) => { const r = JSON.parse(fs.readFileSync(f, 'utf8')); return { ...r, steps: r.steps.map((s, i) => ({ ...s, n: i + 1 })), problems: [] } }
const journey = parse(path.join(SAMPLES, 'place-order.json'))
/** Step `n` of a made-up journey, in box `node` (file a.go, line n). */
const stepIn = (n, node) => ({ id: `s${n}`, n, title: `Step ${n} in ${node}`, node, file: 'a.go', range: { start: n, end: n }, lead: '', refs: [] })
/** A record two parts hand over through (a dashed store box). */
const handoff = {
  id: 'handoff',
  question: 'How does a cancel reach the worker?',
  title: 'Cancel',
  summary: 'The API marks the order; the worker polls it.',
  problems: [],
  nodes: [
    { id: 'srv', kind: 'system', label: 'Server', summary: '' },
    { id: 'api', kind: 'module', label: 'Orders API', summary: '', parent: 'srv' },
    { id: 'loop', kind: 'module', label: 'Order worker', summary: '', parent: 'srv' },
    { id: 'rec', kind: 'store', label: 'Order record', path: 'api/store', summary: '', parent: 'srv' },
  ],
  edges: [
    { from: 'api', to: 'rec', label: 'marks it cancelling' },
    { from: 'loop', to: 'rec', label: 'polls every 2 s', async: true },
    { from: 'loop', to: 'rec', label: 'marks it cancelled' },
  ],
  steps: [stepIn(1, 'api'), stepIn(2, 'loop')],
}
// A generated journey's shape: a system of modules and functions, two top-level external boxes it calls.
const stripe = {
  id: 'stripe-plan-change',
  question: 'How does a plan change reach Stripe and come back?',
  title: 'Plan change',
  summary: '',
  problems: [],
  nodes: [
    { id: 'console', kind: 'system', label: 'Console', summary: '' },
    { id: 'page', kind: 'module', label: 'Billing page', summary: '', parent: 'console' },
    { id: 'picker', kind: 'function', label: 'PlanPicker', summary: '', parent: 'page' },
    { id: 'srv', kind: 'system', label: 'Server', summary: '' },
    { id: 'http', kind: 'module', label: 'HTTP API', summary: '', parent: 'srv' },
    { id: 'change', kind: 'function', label: 'changePlan', summary: '', parent: 'http' },
    { id: 'hook', kind: 'function', label: 'handleStripeWebhook', summary: '', parent: 'http' },
    { id: 'bill', kind: 'module', label: 'Billing', summary: '', parent: 'srv' },
    { id: 'apply', kind: 'function', label: 'applyPlan', summary: '', parent: 'bill' },
    { id: 'sync', kind: 'function', label: 'syncSubscription', summary: '', parent: 'bill' },
    { id: 'receipt', kind: 'function', label: 'sendReceipt', summary: '', parent: 'bill' },
    { id: 'rec', kind: 'store', label: 'Subscription record', summary: '', parent: 'srv' },
    { id: 'stripe', kind: 'external', label: 'Stripe', summary: '' },
    { id: 'mail', kind: 'external', label: 'Email provider', summary: '' },
  ],
  edges: [
    { from: 'picker', to: 'change', label: 'POST /billing/plan' },
    { from: 'change', to: 'apply', label: 'validates' },
    { from: 'apply', to: 'stripe', label: 'updates the subscription' },
    { from: 'stripe', to: 'hook', label: 'webhook', async: true },
    { from: 'hook', to: 'sync', label: 'verified event' },
    { from: 'sync', to: 'rec', label: 'writes' },
    { from: 'sync', to: 'receipt', label: 'on upgrade' },
    { from: 'receipt', to: 'mail', label: 'sends' },
  ],
  steps: ['picker', 'change', 'apply', 'stripe', 'hook', 'sync', 'receipt', 'mail'].map((node, i) => stepIn(i + 1, node)),
}
// The bundled samples, then the journeys of the folder named on the command line.
const jsonIn = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(dir, f))
const extra = JOURNEYS ? jsonIn(JOURNEYS) : []
const real = [...jsonIn(SAMPLES), ...extra]
/** The home's journeys: those of the folder named, else two made up; the first is "here", the second left at step 4. */
const list = (extra.length ? extra : ['place-order.json', 'other.json']).map((f, i) => ({
  key: `k-${path.basename(f)}`,
  title: path.basename(f).replace(/\.json$/, ''),
  question: extra.length ? JSON.parse(fs.readFileSync(f, 'utf8')).question : `What is ${f}?`,
  steps: 13,
  resume: i === 1 ? 4 : 0,
  ...(i === 0 ? { here: true } : {}),
  ...(i === 1 ? { start: true } : {}),
}))
// The home's model, as the extension builds it from the same journeys (journeyList.ts).
const { buildList } = (await import(pathToFileURL(path.join(ROOT, 'out/src/journeyList.js')).href)).default
const homeModel = buildList(list.map((x) => ({
  key: x.key, kind: 'journey', title: x.title, question: x.question, summary: '', files: ['web/a.js'], stepTitles: [],
  steps: x.steps, stale: 0, isNew: false, resume: x.resume, ...(x.start ? { start: true } : {}),
})))
/** The rest of a "journey" or "tour" message (the walk's state), `x` over the defaults: not walking, no tutorial. */
const tour = (x = {}) => ({
  current: 0,
  marks: {},
  resume: 0,
  legendHidden: true,
  problems: [],
  key: "Ctrl+'",
  tutorial: false,
  list,
  home: homeModel,
  ...x,
})

// ---------- reporting ----------

const failures = []
const fail = (m) => { failures.push(m); console.log(`  ✗ ${m}`) }

// ---------- the page under test (one per width × theme) and what every check uses ----------

let page, tag, width, theme
/** Console errors and warnings, page errors, failed requests on the current page. */
let errors = []
/** Provenance as the extension sends it: the model and date, and how many steps are out of date. */
const prov = { text: 'Written by Fable · 11 Nov', tip: 'claude-fable-5-2 · commit a1b2c3d', changed: 2 }

/** A fresh page on the harness at `w` × 900, in `th`'s colours; the map jumps instead of animating. */
async function newPage(b, w, th) {
  width = w
  theme = th
  tag = `${width}-${theme}`
  // The map jumps instead of animating (prefers-reduced-motion): checks see where it ends up. One check below animates.
  const context = { deviceScaleFactor: 1, reducedMotion: 'reduce' }
  ;({ page, errors } = await openHarness(b, HARNESS, { width, height: 900, theme, warnings: true, failedRequests: true, context, timeout: 4000, initScripts: PAGE_HELPERS, ready: true }))
}

const send = (m) => page.evaluate((x) => window.postMessage(x, '*'), m)
const posted = () => page.evaluate(() => window.__posted.splice(0))
/**
 * Until the page has handled what was just sent or clicked and drawn it: two animation frames. Messages and clicks
 * are handled before the next frame and the map (prefers-reduced-motion) jumps in one; nothing checked here waits
 * on a timer.
 */
const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
/** A journey sent, and its map laid out (ELK is async). */
const open = async (j, t) => {
  await posted()
  await send({ type: 'journey', journey: j, ...tour(t) })
  await page.waitForFunction(() => window.__posted.some((m) => m.type === 'rendered') || !document.querySelector('.gmap'), null, { timeout: 15000 })
  await settle()
}
const clickPosts = async (sel, want, what) => {
  await posted()
  await page.click(sel)
  await settle()
  const m = await posted()
  if (!m.some((x) => Object.entries(want).every(([k, v]) => x[k] === v))) fail(`${tag}: ${what}: click ${sel} posted ${JSON.stringify(m)}, want ${JSON.stringify(want)}`)
  return m
}
const view = () => page.evaluate(() => { const m = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(document.querySelector('.gworld')?.style.transform || ''); return m ? { x: +m[1], y: +m[2], k: +m[3] } : null })

/** Layout checks on whatever is shown now (the rules: layoutChecks.js); in dark, the text's contrast too. */
const check = async (what, { current = true } = {}) => {
  await page.mouse.move(0, 0)
  const r = await page.evaluate((wantCurrent) => window.mapLayoutProblems(wantCurrent), current)
  for (const x of r) fail(`${tag} ${what}: ${x}`)
  if (theme === 'dark') for (const x of await lowContrast()) fail(`${tag} ${what}: ${x}`)
}
/** Map text at ≥ 4.5:1 in dark (labels, numbers and names you are meant to read; faint ones are faint on purpose). */
const lowContrast = () => page.evaluate(() => {
  const { rgba, over, backgroundOf, ratio } = window.contrast
  const out = []
  for (const e of document.querySelectorAll('.gmap:not(.far) .glabel:not(.faint), .gmap:not(.far) .gnum:not(.cur), .gmap:not(.far) .gtitle, .gmap:not(.far) .glbl')) {
    if (e.getClientRects().length === 0 || getComputedStyle(e).visibility === 'hidden') continue
    // The text's colour as shown: faded by its own and its ancestors' opacity, over its background.
    let a = 1
    for (let x = e; x; x = x.parentElement) a *= Number(getComputedStyle(x).opacity)
    const bg = backgroundOf(e), fg0 = rgba(getComputedStyle(e).color)
    const fg = over([fg0[0], fg0[1], fg0[2], fg0[3] * a], bg)
    const r = ratio(fg, bg)
    if (r < 4.5) out.push(`"${e.textContent.trim()}" (${e.className}) contrast ${r.toFixed(2)}:1 < 4.5`)
  }
  return out
})
/** A picture of the page (the whole page with `full`) into OUT as <tag>-<name>.png, the mouse out of the way. */
const shot = async (name, full = false) => {
  if (!OUT) return
  await page.mouse.move(0, 0)
  await page.screenshot({ path: path.join(OUT, `${tag}-${name}.png`), fullPage: full })
}
/** Where the first element matching `sel` is: { l, t, r, b, w, h }, null when there is none. */
const R = (sel) => page.evaluate((q) => {
  const e = document.querySelector(q)
  if (!e) return null
  const r = e.getBoundingClientRect()
  return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }
}, sel)
/** Tells the page's layout rules which journey is drawn (they check every one of its boxes). */
const setJ = (j) => page.evaluate((x) => { window.__J = x }, j)
/**
 * Fit and the far view: the map centred in its area; far names never over each other or the buttons,
 * readable in dark (≥ 4.5:1 over the page and over a block); while walking, the current step's box ringed and its
 * number lit.
 */
const farCheck = async (what) => {
  for (const x of await page.evaluate((dark) => {
    const out = []
    const m = document.querySelector('.gmap'), w = document.querySelector('.gworld')
    if (!m || !w) return out
    const M = m.querySelector('.gstage').getBoundingClientRect(), W = w.getBoundingClientRect()
    if (W.width < M.width - 4 && Math.abs((W.left - M.left) - (M.right - W.right)) > 3) out.push(`map not centred across (${Math.round(W.left - M.left)} | ${Math.round(M.right - W.right)})`)
    if (W.height < M.height - 4 && Math.abs((W.top - M.top) - (M.bottom - W.bottom)) > 3) out.push(`map not centred down (${Math.round(W.top - M.top)} | ${Math.round(M.bottom - W.bottom)})`)
    if (!m.classList.contains('far')) return out
    const shown = [...m.querySelectorAll('.gname')].filter((t) => getComputedStyle(t).display !== 'none' && t.getClientRects().length)
    const R = shown.map((t) => ({ t: t.querySelector('.gnt').textContent.replace(/\n/g, ' '), r: t.getBoundingClientRect() }))
    const ov = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1
    for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) if (ov(R[i].r, R[j].r)) out.push(`far names "${R[i].t}" and "${R[j].t}" overlap`)
    const c = m.querySelector('.gctl').getBoundingClientRect()
    for (const x of R) { const r = { left: Math.max(x.r.left, M.left), right: Math.min(x.r.right, M.right), top: Math.max(x.r.top, M.top), bottom: Math.min(x.r.bottom, M.bottom) }; if (r.right > r.left && r.bottom > r.top && ov(r, c)) out.push(`far name "${x.t}" under the map's buttons`) }
    for (const x of R) if (/\S…\S/.test(x.t) || (/…$/.test(x.t) && !/\s/.test(x.t.slice(0, -1)) && x.t.length < 3)) out.push(`far name "${x.t}" cut badly`)
    if (!shown.length) out.push('far view with no names')
    const cur = Number(document.querySelector('.story .st.cur')?.dataset.n || 0)
    if (cur) {
      const g = m.querySelector('.gring')
      const gr = g && g.getBoundingClientRect()
      if (!gr || getComputedStyle(g).display === 'none' || gr.right < M.left || gr.left > M.right || gr.bottom < M.top || gr.top > M.bottom) out.push('far: the current step is not ringed in view')
      const lit = [...m.querySelectorAll('.gfn.cur')].filter((b) => b.getClientRects().length && getComputedStyle(b.closest('.gname')).display !== 'none')
      if (!lit.some((b) => b.textContent === String(cur))) out.push(`far: step ${cur}'s number not shown lit`)
    }
    if (dark) {
      const { over, ratio: contrastOf } = window.contrast
      // Not contrast.rgba: this one reads a color(srgb …) value's 0-1 numbers as 0-255 (as this check always has).
      const rgba = (s) => { const n = (s.match(/[\d.]+/g) || []).map(Number); return [n[0], n[1], n[2], n.length > 3 ? n[3] : 1] }
      const page = rgba(getComputedStyle(document.body).backgroundColor)
      const cover = document.querySelector('.gcover') ? over(rgba(getComputedStyle(document.querySelector('.gcover')).backgroundColor), page) : page
      for (const t of shown) for (const e of [t.querySelector('.gnt'), ...t.querySelectorAll('.gfn:not(.cur)')]) {
        let bg = null
        for (let x = e; x && x !== m; x = x.parentElement) { const q = rgba(getComputedStyle(x).backgroundColor); if (q[3] > 0) { bg = q; break } }
        for (const under of [page, cover]) {
          const b = bg ? over(bg, under) : under, f = over(rgba(getComputedStyle(e).color), b)
          const ratio = contrastOf(f, b)
          if (ratio < 4.5) { out.push(`far "${e.textContent}" at ${ratio.toFixed(2)}:1`); break }
        }
      }
    }
    return out
  }, theme === 'dark')) fail(`${tag} ${what}: ${x}`)
}

// ---------- the checks, in the order they run on each page ----------

/** The short title, the question under it, one provenance line, the storyline; no Start button. */
async function header() {
  await setJ(journey)
  await open(journey, { prov })
  const head = await page.evaluate(() => ({
    kids: [...document.querySelector('header').children].map((c) => c.className || c.tagName).join(),
    prov: document.querySelector('.prov')?.textContent, amber: getComputedStyle(document.querySelector('.prov .changed')).color, muted: getComputedStyle(document.querySelector('.prov')).color,
    title: document.querySelector('h1.q').textContent, sub: document.querySelector('.qsub')?.textContent,
    q: (() => { const q = document.querySelector('h1.q'); return Math.round(q.clientHeight / parseFloat(getComputedStyle(q).lineHeight)) })(),
    sticky: getComputedStyle(document.querySelector('.head')).position,
    rows: document.querySelectorAll('.story .st').length, rowText: document.querySelector('.story .st').textContent,
    startBtn: [...document.querySelectorAll('button')].filter((x) => /Start/.test(x.textContent)).map((x) => x.textContent).join('|'),
  }))
  if (head.kids !== 'link homeb,top,qsub,prov') fail(`${tag}: the header holds ${head.kids} (Journeys link, short title + controls, the question, one provenance line)`)
  if (head.title !== journey.title || head.sub !== journey.question) fail(`${tag}: the heading is "${head.title}" over "${head.sub}" (the short title, the question under it)`)
  if (head.prov !== 'Written by Fable · 11 Nov · ⚠ 2 steps out of date' || head.amber === head.muted) fail(`${tag}: provenance line ${JSON.stringify(head)}`)
  if (head.q > 2) fail(`${tag}: the title takes ${head.q} lines`)
  if (head.sticky !== 'sticky') fail(`${tag}: the header is not sticky`)
  if (head.rows !== journey.steps.length || head.rowText !== `1${journey.steps[0].title}`) fail(`${tag}: storyline ${head.rows} rows, first "${head.rowText}" (number + title only)`)
  if (head.startBtn) fail(`${tag}: a Start button (opening a journey walks it): ${head.startBtn}`)
}

/** The map beside the storyline (wide) or above it, foldable (narrow); not walking, the whole map fits with every box. */
async function mapPlacement() {
  const tg = () => page.evaluate(() => ({ map: !!document.querySelector('.mapwrap'), toggle: document.querySelector('.maptoggle')?.textContent, expanded: document.querySelector('.maptoggle')?.getAttribute('aria-expanded') }))
  if (width < 520) {
    const nm = await tg()
    if (!nm.map || nm.toggle !== 'Map' || nm.expanded !== 'true') fail(`${tag}: narrow at first ${JSON.stringify(nm)} (the map shown above the storyline, foldable)`)
    const mi = await R('.mapwrap'), sto = await R('.story')
    if (!mi || mi.b > sto.t + 1 || mi.h < 200) fail(`${tag}: the map is not above the storyline at a usable height ${JSON.stringify({ mi, sto })}`)
    await page.click('.maptoggle')
    await settle()
    const shut = await tg()
    if (shut.map || shut.expanded !== 'false') fail(`${tag}: "Map" did not fold the map ${JSON.stringify(shut)}`)
    await shot('0-narrow-folded')
    await page.click('.maptoggle')
    await settle()
    if (!(await tg()).map) fail(`${tag}: "Map" did not unfold the map`)
  } else {
    const mi = await R('.mapwrap'), sto = await R('.story')
    if (!mi || mi.l < sto.r || mi.w < 400 || mi.h < 500) fail(`${tag}: the map is not beside the storyline at a usable size ${JSON.stringify({ mi, sto })}`)
    if (await page.$('.maptoggle')) fail(`${tag}: a "Map" toggle when wide`)
  }
  // Not walking: the whole map fits; every box is drawn (no "+n more").
  await check('start', { current: false })
  const nb = await page.evaluate(() => document.querySelectorAll('.gbox').length)
  if (nb !== journey.nodes.length) fail(`${tag}: ${nb} boxes drawn of ${journey.nodes.length}`)
  await shot('1-start')
}

/** Keyboard focus is visible on a storyline row. */
async function storylineFocus() {
  await page.focus('.story .st')
  await page.keyboard.press('Tab')
  const fv = await page.evaluate(() => { const a = document.activeElement; const cs = getComputedStyle(a); return { cls: a.className, style: cs.outlineStyle, w: parseFloat(cs.outlineWidth) } })
  if (!/\bst\b/.test(fv.cls) || fv.style === 'none' || fv.w < 2) fail(`${tag}: no visible keyboard focus on a storyline row ${JSON.stringify(fv)}`)
  await page.evaluate(() => document.activeElement.blur())
}

/** Walking: the map follows the step (the box ringed, in view, readable), its number lit, its arrows strong. */
async function walking() {
  await send({ type: 'tour', ...tour({ current: 1, prov }) })
  await settle()
  await check('step 1')
  const s1 = await page.evaluate(() => ({ cur: document.querySelector('.gbox.current')?.dataset.id, num: document.querySelector('.gnum.cur')?.textContent, on: document.querySelectorAll('path.gedge.on').length, faint: document.querySelectorAll('path.gedge.faint').length, story: document.querySelector('.story .st.cur')?.dataset.n }))
  const v1 = await view()
  if (s1.cur !== 'place' || s1.num !== '1' || !s1.on || !s1.faint || s1.story !== '1') fail(`${tag}: step 1 ${JSON.stringify(s1)}`)
  if (!v1 || v1.k < 0.79) fail(`${tag}: step 1 at zoom ${v1 && v1.k} (readable: ≥ 0.8)`)
  await shot('2-step1')
  // A step in another module: the map moves there.
  await send({ type: 'tour', ...tour({ current: 8, prov }) })
  await settle()
  await check('step 8')
  if ((await page.evaluate(() => document.querySelector('.gbox.current')?.dataset.id)) !== 'pspconf') fail(`${tag}: the map did not follow to step 8`)
  await shot('2-step8')
}

/** The splitter (0.21.1, wide only): drag resizes the map, the step's box stays put; clamped; keys; double-click resets; the width is posted for the extension to keep, and a width it sends back is used. */
async function splitter() {
  const sp = await R('.splitter')
  const cursor = await page.evaluate(() => getComputedStyle(document.querySelector('.splitter')).cursor)
  if (!sp || cursor !== 'col-resize') fail(`${tag}: splitter ${JSON.stringify(sp)} cursor ${cursor}`)
  const mw0 = (await R('.mapwrap')).w, box0 = await R('.gbox.current')
  const drag = async (dx) => { const q = await R('.splitter'); await page.mouse.move(q.l + q.w / 2, q.t + 200); await page.mouse.down(); await page.mouse.move(q.l + q.w / 2 + dx, q.t + 200, { steps: 8 }); await page.mouse.up(); await settle() }
  await posted()
  await drag(-120)
  const mw1 = (await R('.mapwrap')).w, box1 = await R('.gbox.current'), pw = (await posted()).filter((m) => m.type === 'mapWidth')
  if (Math.abs(mw1 - mw0 - 120) > 2) fail(`${tag}: dragging the splitter 120px left made the map ${mw0} -> ${mw1}`)
  if (Math.abs(box1.l - box0.l) > 1 || Math.abs(box1.t - box0.t) > 1) fail(`${tag}: the step's box jumped while resizing ${JSON.stringify([box0, box1])}`)
  if (pw.length !== 1 || Math.abs(pw[0].w - mw1) > 1) fail(`${tag}: drag end posted ${JSON.stringify(pw)} (want one mapWidth ${mw1})`)
  await check('splitter dragged')
  await shot('2-splitter')
  await drag(-2000)
  const big = await page.evaluate(() => ({ map: document.querySelector('.mapwrap').offsetWidth, story: document.querySelector('.story').offsetWidth }))
  if (big.story < 279) fail(`${tag}: the storyline squeezed to ${big.story}px (min 280)`)
  await drag(3000)
  const small = (await R('.mapwrap')).w
  if (Math.abs(small - 240) > 1) fail(`${tag}: the map at its narrowest is ${small}px (min 240)`)
  await page.focus('.splitter')
  await page.keyboard.press('ArrowLeft')
  await settle()
  if (Math.abs((await R('.mapwrap')).w - 264) > 1) fail(`${tag}: ArrowLeft on the splitter did not widen the map by 24px`)
  await posted()
  await page.dblclick('.splitter')
  await settle()
  const reset = (await R('.mapwrap')).w, pr = (await posted()).filter((m) => m.type === 'mapWidth')
  if (Math.abs(reset - mw0) > 1 || !pr.some((m) => m.w === 0)) fail(`${tag}: double-click did not reset (${reset} vs ${mw0}, ${JSON.stringify(pr)})`)
  await send({ type: 'tour', ...tour({ current: 8, prov, mapWidth: 500 }) })
  await settle()
  if (Math.abs((await R('.mapwrap')).w - 500) > 1) fail(`${tag}: a remembered width (500) from the extension is not used: ${(await R('.mapwrap')).w}`)
  const st0 = await page.evaluate(() => window.__state && window.__state.mapW)
  if (st0 !== 500) fail(`${tag}: the width is not kept in the webview state (${st0})`)
  await send({ type: 'tour', ...tour({ current: 8, prov }) })
  await settle()
}

/** Dragged away, the next step brings the map back. */
async function dragThenNextStep() {
  const mb = await R('.gmap')
  await page.mouse.move(mb.l + 40, mb.t + 60)
  await page.mouse.down()
  await page.mouse.move(mb.l + 300, mb.t + 400, { steps: 6 })
  await page.mouse.up()
  await settle()
  const v8 = await view()
  await send({ type: 'tour', ...tour({ current: 9, prov }) })
  await settle()
  await check('step 9 after a drag')
  if (JSON.stringify(await view()) === JSON.stringify(v8)) fail(`${tag}: after a drag the next step did not move the map back`)
}

/** Clicks: a step number walks there; a function box opens its code; a module zooms to it; a drag clicks nothing. */
async function clicks() {
  await clickPosts('.gnum[data-n="9"]', { type: 'step', n: 9 }, 'a step number')
  const at = journey.nodes.find((n) => n.id === 'chargestatus').at
  await clickPosts('.gbox.leaf[data-id="chargestatus"] .glbl', { type: 'openPath', path: `${at.file}:${at.start}-${at.end}` }, 'a function box opens its code')
  const vb = await view()
  await posted()
  await page.click('.gbox.group[data-id="payclient"] .gtitle')
  await settle()
  if (JSON.stringify(await view()) === JSON.stringify(vb) || (await posted()).some((m) => m.type === 'step' || m.type === 'openPath')) fail(`${tag}: a module click did not zoom to it, or acted otherwise`)
  const lb = await R('.gbox.leaf[data-id="chargestatus"]')
  await posted()
  await page.mouse.move(lb.l + 10, lb.t + 8)
  await page.mouse.down()
  await page.mouse.move(lb.l + 80, lb.t + 60, { steps: 5 })
  await page.mouse.up()
  await settle()
  if ((await posted()).some((m) => m.type === 'openPath' || m.type === 'step')) fail(`${tag}: a drag that started on a box opened it`)
}

/** Zoom: Ctrl+wheel around the cursor, the buttons, the keys (with the map focused), Fit (the far view); the plain wheel pans. */
async function zoom() {
  const mb = await R('.gmap')
  const z0 = await view()
  await page.mouse.move(mb.l + mb.w / 2, mb.t + mb.h / 2)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, 300)
  await page.keyboard.up('Control')
  await settle()
  const z1 = await view()
  if (!(z1.k < z0.k)) fail(`${tag}: Ctrl+wheel did not zoom out (${z0.k} -> ${z1.k})`)
  await page.click('.gin')
  await settle()
  if (!((await view()).k > z1.k)) fail(`${tag}: + did not zoom in`)
  await page.focus('.gmap')
  await page.keyboard.press('0')
  await settle()
  const fit = await view()
  const wb = await page.evaluate(() => { const w = document.querySelector('.gworld').getBoundingClientRect(), m = document.querySelector('.gmap').getBoundingClientRect(); return w.left >= m.left - 1 && w.right <= m.right + 1 && w.top >= m.top - 1 && w.bottom <= m.bottom + 1 })
  if (!wb) fail(`${tag}: 0 (Fit) does not show the whole map`)
  await check('fit')
  if (fit.k < 0.55 && !(await page.$('.gmap.far'))) fail(`${tag}: far out without the far view`)
  await farCheck('fit')
  await shot('3-fit')
  await page.keyboard.press('+')
  await settle()
  if (!((await view()).k > fit.k)) fail(`${tag}: the + key did not zoom in`)
  await page.keyboard.press('+')
  await page.keyboard.press('+')
  await settle()
  const p0 = await view()
  await page.mouse.move(mb.l + mb.w / 2, mb.t + mb.h / 2)
  await page.mouse.wheel(0, 120)
  await settle()
  const p1 = await view()
  if (p1.k !== p0.k || p1.y === p0.y) fail(`${tag}: the wheel did not pan (${JSON.stringify(p0)} -> ${JSON.stringify(p1)})`)
}

/** The legend on demand: it says what the ring is, never covers the current step's box; "?" again, Esc and a click elsewhere close it. */
async function legend() {
  if (await page.isVisible('.glegend')) fail(`${tag}: the legend is shown before "?"`)
  await clickPosts('.glegq', { type: 'legend', hidden: false }, 'the legend "?"')
  if (!(await page.isVisible('.glegend'))) fail(`${tag}: "?" did not show the legend`)
  await shot('3-legend')
  // The legend says what the ring is; it never covers the current step's box; Esc and a click elsewhere close it.
  const lg = await page.evaluate(() => { const l = document.querySelector('.glegend').getBoundingClientRect(), c = document.querySelector('.gbox.current')?.getBoundingClientRect(); return { text: document.querySelector('.glegend').textContent, over: !!c && l.left < c.right && c.left < l.right && l.top < c.bottom && c.top < l.bottom } })
  if (!lg.text.includes('this step · drag to move, Ctrl+wheel to zoom')) fail(`${tag}: legend says "${lg.text}"`)
  if (lg.over) fail(`${tag}: the legend covers the current step's box`)
  await clickPosts('.glegq', { type: 'legend', hidden: true }, '"?" again hides the legend')
  await clickPosts('.glegq', { type: 'legend', hidden: false }, 'the legend "?" (again)')
  await page.keyboard.press('Escape')
  await settle()
  if (await page.isVisible('.glegend')) fail(`${tag}: Esc did not close the legend`)
  await clickPosts('.glegq', { type: 'legend', hidden: false }, 'the legend "?" (third)')
  await page.mouse.click(5, 5)
  await settle()
  if (await page.isVisible('.glegend')) fail(`${tag}: a click elsewhere did not close the legend`)
}

/** How long after a step change the map is still moving (it animates for ~300 ms), and when it has surely stopped. */
const ANIMATION_PROBE_MS = 60, ANIMATION_DONE_MS = 500

/** The step change animates when motion is allowed (the only timed check: it looks at the map mid-move). */
async function stepAnimates() {
  const p1 = await view()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await send({ type: 'tour', ...tour({ current: 2 }) })
  await page.waitForTimeout(ANIMATION_PROBE_MS)
  const mid = await view()
  await page.waitForTimeout(ANIMATION_DONE_MS)
  const fin = await view()
  if (JSON.stringify(mid) === JSON.stringify(fin)) fail(`${tag}: the step change did not animate (${JSON.stringify(p1)} -> ${JSON.stringify(mid)} -> ${JSON.stringify(fin)})`)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await check('step 2 animated')
}

/** End in the header (none on the last step); after End the storyline marks where it was left; a removed last step is clamped. */
async function endAndResume() {
  await send({ type: 'tour', ...tour({ current: 13 }) })
  await settle()
  if (await page.$('.tour .end')) fail(`${tag}: End shown on the last step`)
  await send({ type: 'tour', ...tour({ current: 3, marks: { 9: 'stale' } }) })
  await settle()
  const stale = await page.evaluate(() => { const r = document.querySelector('.story .st[data-n="9"]'); return { text: r.textContent, n: getComputedStyle(r.querySelector('.n')).color, plain: getComputedStyle(document.querySelector('.story .st[data-n="8"] .n')).color } })
  if (/⚠/.test(stale.text) || stale.n === stale.plain) fail(`${tag}: stale row ${JSON.stringify(stale)} (amber number only)`)
  await clickPosts('.tour .end', { type: 'end' }, 'End')
  await send({ type: 'tour', ...tour({ resume: 8 }) })
  await settle()
  // After End nothing looks half on: no button, no row marked, no box ringed.
  const res = await page.evaluate(() => ({ b: !!document.querySelector('.tour button'), marked: [...document.querySelectorAll('.story .st')].filter((r) => r.className !== 'st').map((r) => r.className).join(), ring: !!document.querySelector('.gbox.current') }))
  if (res.b || res.marked || res.ring) fail(`${tag}: after End ${JSON.stringify(res)}`)
  await clickPosts('.story .st[data-n="8"]', { type: 'step', n: 8 }, 'the row where it was left')
  await send({ type: 'tour', ...tour({ current: 14, resume: 20 }) })
  await settle()
  if ((await page.evaluate(() => document.querySelector('.story .st.cur')?.dataset.n)) !== '13') fail(`${tag}: a removed last step is not clamped`)
}

/** A step with no code to open: its card under its storyline row; a stale card has one Ask; links, details, Next and Finish. */
async function stepCard() {
  await send({ type: 'tour', ...tour({ current: 4, card: { n: 4, lead: 'x', refs: '', stale: true, staleText: "**⚠ Code changed: can't find these lines** · [Ask](ask:update)" } }) })
  await settle()
  const stl = await page.evaluate(() => ({ text: document.querySelector('.sstale')?.textContent, asks: [...document.querySelectorAll('.scard button')].filter((x) => /Ask/.test(x.textContent)).length, under: document.querySelector('.scard')?.closest('li')?.querySelector('.st')?.dataset.n }))
  if (stl.text !== "⚠ Code changed: can't find these lines · Ask" || stl.asks !== 1 || stl.under !== '4') fail(`${tag}: stale card ${JSON.stringify(stl)}`)
  await clickPosts('.sstale .askupd', { type: 'ask', update: true }, 'Ask on a stale card')
  const card = { n: 4, lead: 'The loop polls, see [worker.go:12](ref:0).', details: '- first point\n- second, in [status.go:342-360](ref:1)', refs: '[a.go:1](ref:0) · ~~b.go:2~~ (file gone)\n\nThe 2 s poll interval is set in [main.go:371](ref:2).', stale: false, open: false, paths: ['worker/worker.go:12', 'payments/status.go:342-360', 'cmd/shop/main.go:371'] }
  await send({ type: 'tour', ...tour({ current: 4, card }) })
  await settle()
  await check('panel card')
  await clickPosts('.scard .slead .ref', { type: 'ref', i: 0 }, 'a link in the lead')
  await send({ type: 'tour', ...tour({ current: 4, card: { ...card, open: true } }) })
  await settle()
  const det = await page.evaluate(() => ({ items: document.querySelectorAll('.scard .sdetails li').length, sentence: [...document.querySelectorAll('.scard .srefs p')].map((p) => p.textContent).join('|'), hover: [...document.querySelectorAll('.scard .srefs .ref')].map((r) => r.title).join() }))
  if (det.items !== 2 || !det.sentence.includes('The 2 s poll interval is set in main.go:371.') || !det.hover.includes('cmd/shop/main.go:371')) fail(`${tag}: details ${JSON.stringify(det)}`)
  await shot('5-panel-card', true)
  await clickPosts('.scard .snext', { type: 'step', n: 5 }, 'card Next')
  await send({ type: 'tour', ...tour({ current: 13, card: { ...card, n: 13 } }) })
  await settle()
  await clickPosts('.scard .send', { type: 'finish' }, 'Finish on the last step')
}

/** A step low in a long storyline: its row in view under the sticky header. */
async function longStoryline() {
  await page.setViewportSize({ width, height: 420 })
  await send({ type: 'tour', ...tour({ current: 1 }) })
  await settle()
  await send({ type: 'tour', ...tour({ current: 12 }) })
  await settle()
  const vis = await page.evaluate(() => { const x = document.querySelector('.story .st.cur').getBoundingClientRect(), h = document.querySelector('.head').getBoundingClientRect(); return { top: x.top, bottom: x.bottom, head: h.bottom, H: window.innerHeight } })
  if (vis.top < vis.head - 1 || vis.bottom > vis.H + 1) fail(`${tag}: step 12's row not in view under the header: ${JSON.stringify(vis)}`)
  await page.setViewportSize({ width, height: 900 })
  await send({ type: 'tour', ...tour() })
  await settle()
}

/** Problems, authors, deleted. */
async function problems() {
  await send({ type: 'tour', ...tour({ problems: ["Can't read the latest version of this file; showing the last good one."], authors: 2 }) })
  await settle()
  await check('problems', { current: false })
  const pl = await page.evaluate(() => ({ line: document.querySelector('.problems .plink')?.textContent, authors: document.querySelector('.authors')?.textContent }))
  if (!/Can't read the latest version/.test(pl.line ?? '') || pl.authors !== '2 rule breaks') fail(`${tag}: problem lines ${JSON.stringify(pl)}`)
  await send({ type: 'deleted', file: 'place-order.json' })
  await settle()
  const del = await page.evaluate(() => document.querySelector('.gone')?.textContent)
  if (del !== 'Deleted · Restore') fail(`${tag}: deleted journey: ${del}`)
  await clickPosts('.gone .restore', { type: 'restore' }, 'Restore a deleted journey')
}

/**
 * 8. The tutorial: the bar, then three cards (the storyline, the card in the editor, the map; two more where a journey
 * has links and animations) next to (never over) their element; the map does not move or act under it.
 * This harness owns the webview side: the bar's text, each card's text and placement, clicks blocked under it, Done
 * posted. test/integration/suite.ts owns the extension side (Skip remembered across a reopen, the replay command,
 * the step boxed in the editor for card 2, Done walking the steps).
 */
async function tutorial() {
  await page.setViewportSize({ width, height: 720 })
  await send({ type: 'journey', journey: { ...journey, id: 'tut' }, ...tour({ tutorial: true }) })
  await settle()
  await send({ type: 'journey', journey, ...tour({ tutorial: true }) })
  await settle()
  const bar = await page.evaluate(() => document.querySelector('.tbar')?.textContent)
  if (bar !== 'New here?Show me how·Skip') fail(`${tag}: tutorial bar "${bar}"`)
  await clickPosts('.tbar .tstart', { type: 'tutorial', action: 'card', card: 1 }, 'Show me how')
  const targets = ['.story', '.story', '.mapwrap']
  const says = ['The steps, in the order things happen. Click one to see its code.', 'In the editor, the card above the code explains the step. Highlighted there now: Next, Ask and More.', 'Where each step happens; the numbers are the steps, click one to go there. Drag to move, Ctrl+wheel to zoom.']
  /** Card `c`: shown, its highlight around its element, the card beside it and inside the page, its sentence. */
  const cardShown = async (c) => {
    await settle()
    const r = await page.evaluate((sel) => {
      const spot = document.querySelector('.spot'), cd = document.querySelector('.tcard'), t = document.querySelector(sel)
      if (!spot || !cd || !t) return { missing: true }
      const Rr = (e) => { const q = e.getBoundingClientRect(); return { l: q.left, t: q.top, r: q.right, b: q.bottom } }
      const de = document.documentElement
      return { s: Rr(spot), c: Rr(cd), t: Rr(t), text: cd.querySelector('.ttext').textContent, overflow: de.scrollWidth > de.clientWidth, H: window.innerHeight, W: de.clientWidth }
    }, targets[c - 1])
    if (r.missing) { fail(`${tag}: tutorial card ${c} not shown`); return false }
    const inside = r.s.l <= r.t.l + 1 && r.s.r >= r.t.r - 1 && r.s.t <= Math.max(r.t.t, 0) + 1
    if (!inside) fail(`${tag}: tutorial ${c}: highlight ${JSON.stringify(r.s)} does not surround ${targets[c - 1]} ${JSON.stringify(r.t)}`)
    if (r.c.l < r.s.r && r.s.l < r.c.r && r.c.t < r.s.b && r.s.t < r.c.b) fail(`${tag}: tutorial ${c}: the card covers the highlighted element`)
    if (r.overflow || r.c.l < 0 || r.c.r > r.W || r.c.b > r.H + 1) fail(`${tag}: tutorial ${c}: card outside the page`)
    // Plain sentences, one thing per card.
    if (r.text !== says[c - 1]) fail(`${tag}: tutorial card ${c} says "${r.text}"`)
    await shot(`8-tutorial-${c}`)
    return true
  }
  await tutorialCards(cardShown)
  if (await page.isVisible('.tcard')) fail(`${tag}: tutorial card still shown after Done`)
  await page.setViewportSize({ width, height: 900 })
}

/** Cards 1 and 2 (a step click under them starts nothing; Next), then the last one (the map: its clicks go nowhere; Done finishes). A card not shown ends the walk. */
async function tutorialCards(cardShown) {
  for (let c = 1; c <= 2; c++) {
    if (!(await cardShown(c))) return
    await page.click('.story .st[data-n="6"]')
    await settle()
    if ((await posted()).some((x) => x.type === 'step')) fail(`${tag}: a step click started the tour under the tutorial`)
    // The card about the editor says so to the extension (it boxes the step's lines there).
    if (c === 1) await clickPosts('.tcard .tnext', { type: 'tutorial', action: 'card', card: 2, editor: 'card' }, 'Next to the editor card')
    else await page.click('.tcard .tnext')
  }
  if (!(await cardShown(3))) return
  await posted()
  const before = await view()
  await page.evaluate(() => { document.querySelector('.gbox.leaf .glbl').click(); document.querySelector('.gnum').click(); document.querySelector('.gbox.group .gtitle').click() })
  await settle()
  if ((await posted()).some((x) => x.type === 'step' || x.type === 'openPath') || JSON.stringify(await view()) !== JSON.stringify(before)) fail(`${tag}: a map click in the tutorial went through`)
  await clickPosts('.tcard .tnext', { type: 'tutorial', action: 'done' }, 'Done finishes the tutorial')
}

/** A record two parts hand over through: dashed, opens its path; every arrow drawn with its label. */
async function handoffRecord() {
  await setJ(handoff)
  await open(handoff, { current: 1 })
  await check('hand-off')
  const ho = await page.evaluate(() => ({ border: getComputedStyle(document.querySelector('.gbox[data-id="rec"]')).borderTopStyle, edges: document.querySelectorAll('.gworld path.gedge').length, labels: [...document.querySelectorAll('.glabel')].map((l) => l.textContent).sort().join(' | ') }))
  if (ho.border !== 'dashed' || ho.edges !== 3 || ho.labels !== 'marks it cancelled | marks it cancelling | polls') fail(`${tag}: hand-off ${JSON.stringify(ho)}`)
  await clickPosts('.gbox[data-id="rec"] .glbl', { type: 'openPath', path: 'api/store' }, 'a store opens its path')
}

/** Home: "‹ Journeys" lists every journey (title, a quiet "n/N" right after it where one was left); a click selects, Enter walks; the extension opens the list, a step closes it. */
async function home() {
  await setJ(journey)
  await open(journey, { current: 2 })
  await clickPosts('.homeb', { type: 'home', on: true }, '‹ Journeys')
  // Each row the title (+ "Start here" on one), where it was left right after it, the question under it (0.24: the
  // list model, journeyList.ts; its own checks are in test/journey-list/shoot.mjs). A click selects; Enter walks.
  const home = await page.evaluate(() => ({ rows: [...document.querySelectorAll('.jrow .jtop')].map((r) => r.textContent), qs: [...document.querySelectorAll('.jrow .jq')].map((r) => r.textContent), start: [...document.querySelectorAll('.jrow .jstart')].map((r) => r.closest('.jrow').querySelector('.t').textContent), gap: (() => { const r = document.querySelector('.jrow .jat'); if (!r) return -1; return r.getBoundingClientRect().left - r.previousElementSibling.getBoundingClientRect().right })(), map: !!document.querySelector('.hbody > .hlist .gmap'), h: document.querySelector('.home h1')?.textContent }))
  if (home.rows.length !== list.length || home.map || !home.rows.includes(`${list[1].title}Start here4/13`) || home.h !== 'Journeys') fail(`${tag}: home ${JSON.stringify(home)}`)
  if (home.start.join() !== list[1].title) fail(`${tag}: "Start here" on ${JSON.stringify(home.start)}, want only ${list[1].title}`)
  if (home.qs.length !== list.length || !home.qs.includes(list[1].question)) fail(`${tag}: home questions ${JSON.stringify(home.qs)}`)
  if (home.gap < 0 || home.gap > 20) fail(`${tag}: home "n/N" is ${home.gap}px from its title (want right after it)`)
  await check('home', { current: false })
  await shot('10-home')
  const second = await page.$(`.jrow[data-key="${list[1].key}"]`)
  if (!second) fail(`${tag}: no row for ${list[1].key}`)
  else { await second.click(); await settle(); if ((await posted()).some((m) => m.type === 'walk')) fail(`${tag}: a click walked (it selects)`) }
  await page.keyboard.press('Enter')
  await settle()
  if (!(await posted()).some((m) => m.type === 'walk' && m.key === list[1].key)) fail(`${tag}: Enter did not walk the selected journey`)
  if (await page.$('.home')) fail(`${tag}: home still shown after choosing a journey`)
  // The extension opens the list (a request without a question); a step opening closes it.
  await posted()
  await send({ type: 'home' })
  await settle()
  if (!(await page.$('.home')) || !(await posted()).some((m) => m.type === 'home' && m.on === true)) fail(`${tag}: the extension's "home" did not show the list (or did not say so for the tab title)`)
  await send({ type: 'tour', ...tour({ current: 3 }) })
  await settle()
  if (await page.$('.home')) fail(`${tag}: a step opened but the list stays in front`)
}

/** Finish: "Done", the summary (two sentences at most), "‹ Journeys". */
async function finished() {
  await send({ type: 'tour', ...tour({ current: 0, done: true }) })
  await settle()
  const dn = await page.evaluate(() => ({ t: document.querySelector('.done .dtitle')?.textContent, sum: document.querySelector('.done .dsum')?.textContent || '', home: document.querySelectorAll('.homeb, .done button').length }))
  if (dn.t !== 'Done' || !dn.sum || (dn.sum.match(/[.!?](\s|$)/g) || []).length > 2 || dn.home !== 1) fail(`${tag}: finished ${JSON.stringify(dn)} (Done, the summary; one "‹ Journeys", the header's)`)
  await check('done', { current: false })
  await shot('10-done')
}

/** Another journey opens at the top (the map in view), whatever the last one's scroll. */
async function anotherOpensAtTop() {
  await page.setViewportSize({ width, height: 600 })
  await open(journey, { current: 12 })
  await page.evaluate(() => window.scrollTo(0, 400))
  await settle()
  await open({ ...journey, id: 'another' }, { current: 1 })
  const y = await page.evaluate(() => window.scrollY)
  if (y !== 0) fail(`${tag}: another journey opened scrolled to ${y} (at the top)`)
  await page.setViewportSize({ width, height: 900 })
}

/** The sample journeys and those of the folder named on the command line: parsed as the extension does, the map at every step (the box ringed and in view), Fit; shots of the samples. A generated journey's shape first. */
async function samples() {
  for (const f of ['stripe-plan-change', ...real]) {
    const name = path.basename(f).replace(/\.json$/, '')
    const j = f === 'stripe-plan-change' ? stripe : await page.evaluate(([raw, n]) => window.exports.parseJourney(raw, n), [fs.readFileSync(f, 'utf8'), name])
    if (typeof j === 'string') { fail(`${tag}: ${f}: ${j}`); continue }
    await setJ(j)
    await open(j, { current: 1 })
    const pics = f === 'stripe-plan-change' || path.dirname(f) === SAMPLES
    for (let n = 1; n <= j.steps.length; n++) {
      if (n > 1) { await send({ type: 'tour', ...tour({ current: n }) }); await settle() }
      await check(`${name} step ${n}`)
      if (pics && (n === 1 || n === 6 || n === 12)) await shot(`11-${name}-step${n}`)
    }
    await page.click('.gfit')
    await settle()
    await check(`${name} fit`, { current: false })
    await farCheck(`${name} fit`)
    // A top-level external box sits next to what calls it, not in a far corner.
    for (const x of await page.evaluate((J) => {
      const out = [], R = (id) => document.querySelector(`.gbox[data-id="${id}"]`)?.getBoundingClientRect()
      const gap = (a, b) => Math.hypot(Math.max(0, a.left - b.right, b.left - a.right), Math.max(0, a.top - b.bottom, b.top - a.bottom))
      const span = document.querySelector('.gworld').getBoundingClientRect()
      for (const n of J.nodes.filter((m) => m.kind === 'external' && !m.parent)) {
        const me = R(n.id), near = J.edges.filter((e) => e.from === n.id || e.to === n.id).map((e) => R(e.from === n.id ? e.to : e.from)).filter(Boolean)
        if (me && near.length && Math.min(...near.map((r) => gap(me, r))) > 0.45 * Math.max(span.width, span.height)) out.push(`external ${n.id} far from what it talks to`)
      }
      return out
    }, j)) fail(`${tag} ${name} fit: ${x}`)
    if (pics) await shot(`11-${name}-fit`)
    // After End: no current step, the whole map.
    await send({ type: 'tour', ...tour({ current: 0 }) })
    await settle()
    await check(`${name} ended`, { current: false })
    await farCheck(`${name} ended`)
    if (pics) await shot(`11-${name}-ended`)
  }
}

/** The viewport at its new width and the map redrawn for it (the resize handler draws on the next frame). */
const resized = async () => { await page.waitForFunction(() => document.documentElement.clientWidth === window.innerWidth); await settle(); await settle() }

/** Resizing re-centres (narrow <-> wide); the narrowest panel (320 px) has the map above the storyline, nothing sideways. */
async function resize() {
  await setJ(journey)
  await open({ ...journey, id: 'again' }, { current: 7 })
  await page.setViewportSize({ width: width === 500 ? 900 : 640, height: 900 })
  await resized()
  await check('resized')
  await page.setViewportSize({ width: 320, height: 900 })
  await resized()
  await check('320')
  await shot('12-320')
}

/** No page error and nothing in the console on this page. */
async function pageErrors() {
  const errs = await page.evaluate(() => window.__errors)
  for (const e of errs) fail(`${tag}: page error ${e.message}`)
  for (const e of errors) fail(`${tag}: console ${e}`)
}

/**
 * The very first open of a fresh panel, with the tutorial offered: no error, the bar shown, the body there before
 * the scripts (VS Code's webview host reads document.body while the page loads).
 */
async function firstOpen(b, width) {
  const { page, errors } = await openHarness(b, HARNESS, { width, height: 900, theme: 'dark', warnings: true })
  const bodyFirst = await page.evaluate(() => { const b = document.body; const first = [...b.children].findIndex((c) => c.tagName === 'SCRIPT' && c.src); return first > [...b.children].findIndex((c) => c.id === 'app') && ![...document.head.querySelectorAll('script[src]')].length })
  if (!bodyFirst) failures.push(`first open ${width}: scripts load before the body`)
  await page.waitForFunction(() => window.__posted.some((m) => m.type === 'ready'))
  await page.evaluate((x) => window.postMessage(x, '*'), { type: 'journey', journey, current: 1, marks: {}, resume: 0, legendHidden: true, problems: [], key: "Ctrl+'", tutorial: true, list })
  await page.waitForFunction(() => window.__posted.some((m) => m.type === 'rendered'), null, { timeout: 15000 })
  // The bar comes with the first drawing; the console gets until then (or 2 s) to complain.
  await page.waitForSelector('.tbar', { timeout: 2000 }).catch(() => {})
  if (!(await page.$('.tbar'))) failures.push(`first open ${width}: no tutorial bar`)
  for (const e of [...errors, ...(await page.evaluate(() => window.__errors)).map((e) => e.message)]) failures.push(`first open ${width}: ${e}`)
  await page.close()
}

// ---------- main ----------

/** The splitter between the map and the storyline: wide layouts only. */
async function splitterWhenWide() {
  if (width >= 520) await splitter()
  else if (await page.$('.splitter')) fail(`${tag}: a splitter in the narrow layout`)
}

/** The checks, in the order they run on each page: each starts from what the one before left. */
const CHECKS = [
  header, mapPlacement, storylineFocus, walking, splitterWhenWide, dragThenNextStep, clicks, zoom, legend, stepAnimates,
  endAndResume, stepCard, longStoryline, problems, tutorial, handoffRecord, home, finished, anotherOpensAtTop, samples,
  resize, pageErrors,
]

console.log(OUT ? `screenshots: ${OUT}` : 'no screenshots (give a folder as the first argument for them)')
const b = await launchChromium()
for (const w of [500, 1200]) for (const th of ['light', 'dark']) {
  await newPage(b, w, th)
  for (const run of CHECKS) await run()
  await page.close()
  console.log(`${tag}: done`)
}
for (const w of [500, 1200]) await firstOpen(b, w)
for (const f of failures.filter((x) => x.startsWith('first open'))) console.log(`  ✗ ${f}`)
await b.close()
console.log(failures.length ? `${failures.length} problems` : 'all checks passed')
process.exit(failures.length ? 1 : 0)
