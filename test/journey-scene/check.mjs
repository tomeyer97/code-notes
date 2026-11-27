// Steps through every beat of every animated step of a journey in the real panel (headless Chromium), at three panel
// widths (1300 px dark, 900 px light, 620 px light: there the scene column is its minimum, 400 px, beside the
// storyline), then once more at 1300 px with reduced motion asked for. Fails on console errors, text overflowing its
// box (or text no check covers: selectors.mjs), anything sticking out of an actor box, any visible text in the scene
// smaller than 11 px on screen (font-size × the world's scale), the scene column narrower than 400 px, the keyboard
// focus leaving the scene, a last beat without "Next step ›" (but on the last step), anything moving with reduced
// motion, a scene whose names are Object.prototype's keys not drawing like any other, or the beat's lines shown
// under the caption while the step's code is open beside the panel.
//   node test/journey-scene/check.mjs <journey.json> [<dir for screenshots>]
// Needs Playwright with Chromium (test/harness/page.mjs launchChromium: PLAYWRIGHT, CHROME). The panel's harness
// (test/journey-map/harness.html) loads out/vendor/elk.bundled.js and the page's bundle, out/pages/map.js: run
// `npm run build` first. Try it on the bundled sample: node test/journey-scene/check.mjs test/journey-scene/sample.json /tmp/shots
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { launchChromium, openHarness } from '../harness/page.mjs'
import { CUT, IN_ACTOR, TEXT } from './selectors.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = process.argv[3]
const HARNESS = pathToFileURL(path.join(ROOT, 'test/journey-map/harness.html')).href
const MIN_PX = 11, SCENE_MIN = 400
/** How long a beat may take to come to rest (its packets, moves and fades run well under a second). */
const STILL_TIMEOUT_MS = 10000
/** The panel's widths and themes; the last pass asks for reduced motion. */
const PASSES = [
  { w: 1300, theme: 'dark' },
  { w: 900, theme: 'light' },
  { w: 620, theme: 'light' },
  { w: 1300, theme: 'dark', reduce: true },
]

/** Every problem found: printed as it is found, the run fails at the end when there is any. */
const failures = []
/** One problem (`where`: the pass, step and beat) and what is wrong there. */
function fail(where, what) {
  failures.push(where)
  console.log(where, typeof what === 'string' ? what : JSON.stringify(what))
}
/** A problem that stops the run at once (bad arguments, nothing to check). */
function usage(text) {
  console.error(text)
  process.exit(2)
}

if (!process.argv[2]) usage('usage: node check.mjs <journey.json> [<dir for screenshots>]')
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const journey = { ...r, steps: r.steps.map((s, i) => ({ ...s, n: i + 1 })), problems: [] }
const animated = journey.steps.filter((x) => x.scene).map((x) => x.n)
if (!animated.length) usage('no step has a scene')
/** The rest of a "journey" or "tour" message (the walk's state), `x` over the defaults. */
const tour = (x = {}) => ({ current: 0, marks: {}, resume: 0, legendHidden: true, problems: [], key: "Ctrl+'", tutorial: false, list: [], moved: {}, ...x })

/**
 * What is wrong with the scene shown now (run in the page): text overflowing its box, text no check covers, anything
 * sticking out of its actor box or cut by the app window's edge, visible text under MIN_PX on screen, the scene column
 * under SCENE_MIN (wide layout), the keyboard focus outside the scene. Also the smallest text seen ({ px, text, cls }).
 */
function sceneProblems({ MIN_PX, SCENE_MIN, TEXT, CUT, IN_ACTOR }) {
  const hasText = (e) => [...e.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())
  const shown = (e) => {
    for (let x = e; x && x !== document.body; x = x.parentElement) {
      const s = getComputedStyle(x)
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.05) return false
    }
    return true
  }

  /** Text wider than its box. */
  function overflowingText() {
    const out = []
    for (const e of document.querySelectorAll(TEXT)) if (e.scrollWidth > e.clientWidth + 1) out.push(e.className + ':' + e.textContent.slice(0, 40))
    return out
  }

  /** Every shown text in an actor box is one the checks measure (it, or a box around it in the actor, is in TEXT). */
  function uncoveredText() {
    const out = []
    const covered = (e) => {
      for (let x = e; x && !x.classList.contains('scn-actor'); x = x.parentElement) if (x.matches(TEXT) || (CUT && x.matches(CUT))) return true
      return false
    }
    for (const e of document.querySelectorAll('.scn-actor *')) {
      if (hasText(e) && shown(e) && !covered(e)) out.push(`text no check covers: ${e.tagName.toLowerCase()}.${String(e.className).trim().split(/\s+/).join('.')} "${e.textContent.trim().slice(0, 30)}"`)
    }
    return out
  }

  /** Nothing sticks out of its actor box. */
  function outsideActorBoxes() {
    const out = []
    for (const a of document.querySelectorAll('.scn-actor')) {
      const A = a.getBoundingClientRect()
      for (const c of a.querySelectorAll(IN_ACTOR)) {
        const C = c.getBoundingClientRect()
        if (C.width && (C.right > A.right + 1 || C.bottom > A.bottom + 1)) out.push('outside box: ' + c.textContent.slice(0, 40))
      }
    }
    return out
  }

  /** Nothing on the app window's shown screen is cut off by its edge. */
  function cutByAppWindow() {
    const out = []
    for (const w of document.querySelectorAll('.ap-win.on')) {
      const W = w.getBoundingClientRect()
      for (const c of w.querySelectorAll('*')) {
        const C = c.getBoundingClientRect()
        const on = C.width && C.height && getComputedStyle(c).display !== 'none' && !c.closest('.scn-cursor')
        if (on && (C.right > W.right + 1 || C.bottom > W.bottom + 1)) out.push('cut by the app window: ' + c.className + ' ' + c.textContent.slice(0, 40))
      }
    }
    return out
  }

  /** Every visible text in the scene is at least MIN_PX on screen (font-size × the world's scale); the scene column is
   *  at least SCENE_MIN wide. */
  function textSizes() {
    const out = []
    let min = { px: Infinity }
    const view = document.querySelector('.scn-view'), world = document.querySelector('.scn-world')
    if (!view || !world) return { out, min }
    const V = view.getBoundingClientRect()
    const scale = world.getBoundingClientRect().width / world.offsetWidth
    for (const e of document.querySelectorAll('.scn *')) {
      if (!hasText(e)) continue
      const R = e.getBoundingClientRect()
      if (!R.width || !R.height || !shown(e)) continue
      const inWorld = world.contains(e)
      if (inWorld && (R.right < V.left || R.left > V.right || R.bottom < V.top || R.top > V.bottom)) continue
      const px = parseFloat(getComputedStyle(e).fontSize) * (inWorld ? scale : 1)
      if (px < min.px) min = { px, text: e.textContent.trim().slice(0, 30), cls: String(e.className) }
      if (px < MIN_PX - 0.05) out.push(`text ${px.toFixed(1)} px < ${MIN_PX}: ${e.className} "${e.textContent.trim().slice(0, 30)}"`)
    }
    const col = document.querySelector('.scnwrap')
    if (document.querySelector('.body.wide') && col && col.offsetWidth < SCENE_MIN) out.push(`scene column ${col.offsetWidth} px < ${SCENE_MIN}`)
    return { out, min }
  }

  /** The keys work: the focus is in the scene. */
  function focusInScene() {
    const scn = document.querySelector('.scn')
    if (scn && !scn.contains(document.activeElement)) return ['focus outside the scene: ' + (document.activeElement && document.activeElement.className)]
    return []
  }

  const sizes = textSizes()
  return { out: [...overflowingText(), ...uncoveredText(), ...outsideActorBoxes(), ...cutByAppWindow(), ...sizes.out, ...focusInScene()], min: sizes.min }
}

/** What still moves in the page (run in it, with reduced motion asked for): a running animation or transition, or any
 *  element (or its ::before / ::after) with an animation or a transition longer than 0 s. */
function motionLeft() {
  const name = (e) => (e ? `${e.tagName.toLowerCase()}.${String(e.className).trim().split(/\s+/).join('.')}` : '?')
  const out = []
  for (const a of document.getAnimations()) if (a.playState === 'running') out.push(`running: ${a.animationName || a.transitionProperty} on ${name(a.effect?.target)}`)
  for (const e of document.querySelectorAll('*')) for (const pseudo of [null, '::before', '::after']) {
    const s = getComputedStyle(e, pseudo)
    const timed = (v) => v.split(',').some((d) => parseFloat(d) > 0)
    if (s.animationName !== 'none') out.push(`animation ${s.animationName}: ${name(e)}${pseudo || ''}`)
    if (timed(s.transitionDuration) || (timed(s.transitionDelay) && s.transitionProperty !== 'none')) out.push(`transition ${s.transitionProperty} ${s.transitionDuration}: ${name(e)}${pseudo || ''}`)
  }
  return [...new Set(out)]
}

/** The scene shows beat `i` of `beats`, two frames on (a beat starts its moves on the next one). */
async function shownAt(page, i, beats) {
  await page.waitForFunction((want) => document.querySelector('.scn-pos')?.textContent === want, `${i} / ${beats}`, { timeout: STILL_TIMEOUT_MS })
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
}

/**
 * The scene at beat `i` of `beats` and at rest: its counter says so, and after two frames no finite animation is
 * running (a packet on a wire, a box moving, a fade). The pulsing marks loop for ever and are left out.
 */
async function still(page, i, beats) {
  await shownAt(page, i, beats)
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity), null, { timeout: STILL_TIMEOUT_MS })
}

/** Opens the panel on `j` at step `current` (a "journey" message as JSON text, parsed in the page). */
async function openJourney(pass, j, current) {
  const { page, errors } = await openHarness(browser, HARNESS, { width: pass.w, height: 900, theme: pass.theme, warnings: true, ready: true, context: pass.reduce ? { reducedMotion: 'reduce' } : {} })
  // As JSON text, parsed in the page: an object literal (or Playwright's argument copy) would turn "__proto__" into a prototype.
  await page.evaluate((x) => window.postMessage(JSON.parse(x), '*'), JSON.stringify({ type: 'journey', journey: j, ...tour({ current }) }))
  await page.waitForFunction(() => window.__harness.posted.some((m) => m.type === 'rendered'), null, { timeout: 15000 })
  return { page, errors }
}

/** The animation of step `n` on (its storyline row's toggle). */
async function startAnimation(page, n) {
  await page.waitForFunction((n) => !!document.querySelector(`.story .st.cur[data-n="${n}"]`), n)
  if (!(await page.locator('.scn').count())) await page.click('li:has(.st.cur) .animbtn', { timeout: 5000 })
}

let smallest = { px: Infinity }

/** What is wrong at beat `i` (1-based) of step `n`'s `beats`, at rest; `reduce`: nothing may move, even on arrival. */
async function checkBeat(page, pass, n, i, beats) {
  const problems = []
  if (pass.reduce) {
    await shownAt(page, i, beats)
    problems.push(...(await page.evaluate(motionLeft)).map((m) => `reduced motion: ${m}`))
  }
  await still(page, i, beats)
  const res = await page.evaluate(sceneProblems, { MIN_PX, SCENE_MIN, TEXT, CUT, IN_ACTOR })
  problems.push(...res.out)
  if (res.min.px < smallest.px) smallest = { ...res.min, at: `${pass.w} px, step ${n} beat ${i}` }
  if (i === beats) {
    const nx = await page.evaluate(() => { const b = document.querySelector('.scn-next'); return b && !b.hidden ? b.textContent : '' })
    const want = n < journey.steps.length ? 'Next step ›' : ''
    if (nx !== want) problems.push(`last beat: › reads "${nx}", want "${want}"`)
  }
  return problems
}

/** Every beat of every animated step, at one width. */
async function checkPass(pass) {
  const label = pass.reduce ? `${pass.w} reduced motion` : `${pass.w}`
  const before = failures.length
  const { page, errors } = await openJourney(pass, journey, animated[0])
  const send = (m) => page.evaluate((x) => window.postMessage(x, '*'), m)
  for (const n of animated) {
    await send({ type: 'tour', ...tour({ current: n }) })
    await startAnimation(page, n)
    const beats = journey.steps[n - 1].scene.beats.length
    for (let i = 1; i <= beats; i++) {
      const problems = await checkBeat(page, pass, n, i, beats)
      if (problems.length) fail(`${label} step ${n} beat ${i}`, problems)
      if (OUT && pass.w !== 900 && !pass.reduce) await page.screenshot({ path: `${OUT}/w${pass.w}-s${n}-b${i}.png` })
      if (i < beats) await page.click('.scn-next')
    }
  }
  if (errors.length) fail(`${label} page errors`, errors)
  if (failures.length === before) console.log(label, 'ok')
  await page.close()
}

/** A scene whose ids, actor type, status and screen are Object.prototype's keys. (Its data handling has unit tests:
 *  test/journeySceneModel.test.ts; this is the same scene drawn.) */
const PROTOTYPE_KEYS_SCENE = `{
  "actors": [
    { "id": "__proto__", "type": "service", "col": 0, "label": "API", "checks": ["take it"] },
    { "id": "constructor", "type": "app", "col": 1, "brand": "Shop", "screen": "__proto__",
      "detail": { "title": "Order", "status": "constructor" },
      "pages": { "account": { "title": "Account", "chip": "constructor" } } },
    { "id": "odd", "type": "toString", "col": 2 }
  ],
  "wires": [["__proto__", "constructor"], ["hasOwnProperty", "constructor"]],
  "beats": [
    { "focus": "constructor", "caption": "One.", "set": { "constructor": { "screen": "detail" }, "toString": { "x": 1 } } },
    { "focus": "valueOf", "caption": "Two.", "packet": { "from": "__proto__", "to": "constructor", "label": "go" }, "set": { "__proto__": { "done": 1 } } },
    { "focus": "__proto__", "caption": "Three.", "packet": { "from": "hasOwnProperty", "to": "constructor", "label": "go" } },
    { "focus": "constructor", "caption": "Four.", "set": { "constructor": { "screen": "account" } } }
  ]
}`

/** Names that are Object.prototype's keys draw, step and send their packets like any other: no page errors, no chip
 *  toned by a prototype function, and the unknown type left out. */
async function checkPrototypeKeyNames() {
  const scene = JSON.parse(PROTOTYPE_KEYS_SCENE)
  const odd = { ...journey, steps: [{ ...journey.steps.find((x) => x.scene), n: 1, scene }] }
  const { page, errors } = await openJourney({ w: 1300, theme: 'dark' }, odd, 1)
  const problems = []
  try {
    await startAnimation(page, 1)
    for (let i = 1; i <= scene.beats.length; i++) {
      await still(page, i, scene.beats.length)
      if (i < scene.beats.length) await page.click('.scn-next', { timeout: 5000 })
    }
  } catch (e) { problems.push(`didn't step through: ${e.message.split('\n')[0]}`) }
  const actors = await page.evaluate(() => document.querySelectorAll('.scn-actor').length)
  const chips = await page.evaluate(() => [...document.querySelectorAll('.ap-chip')].map((c) => c.className))
  problems.push(...errors)
  if (actors !== 2) problems.push(`${actors} actors drawn (want 2: the unknown type left out)`)
  const toned = (c) => /^ap-chip (neutral|active|good|bad)$/.test(c)
  if (chips.length < 2 || !chips.every(toned)) problems.push(`status chips ${JSON.stringify(chips)}`)
  if (problems.length) fail('prototype-key names', problems)
  else console.log('prototype-key names ok')
  await page.close()
}

/** The step card as the extension sends it when the step's code is gone (src/protocol/map.ts PanelCard). */
const PANEL_CARD = { n: 1, title: 'Step', lead: 'Its code was deleted.', refs: '', stale: false, staleText: '', open: true, paths: [] }

/** The beat's lines under the caption only when the step's code is not open beside the panel: hidden while it is
 *  (the editor shows and lights them), shown when the step's card lives in the panel (its code is gone). */
async function checkCodeExcerpt() {
  const n = animated[0]
  const { page, errors } = await openJourney({ w: 1300, theme: 'dark' }, journey, n)
  const send = (m) => page.evaluate((x) => window.postMessage(x, '*'), m)
  const code = { file: journey.steps[n - 1].file || 'src/a.js', line: 3, from: 1, lines: ['const a = 1', 'const b = 2', 'check(a, b)', 'done()'] }
  const excerpt = async () => {
    await send({ type: 'code', n, i: 0, code })
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
    return page.evaluate(() => { const c = document.querySelector('.scn-code'); return !!c && !c.hidden && c.getClientRects().length > 0 })
  }
  const problems = []
  try {
    await startAnimation(page, n)
    await still(page, 1, journey.steps[n - 1].scene.beats.length)
    if (await excerpt()) problems.push('the beat\'s lines are shown while the step\'s code is open beside the panel')
    await send({ type: 'tour', ...tour({ current: n, card: { ...PANEL_CARD, n } }) })
    await page.waitForSelector('.scn', { timeout: 5000 })
    if (!(await excerpt())) problems.push('the beat\'s lines are not shown when the step\'s card is in the panel (no code beside it)')
  } catch (e) { problems.push(`didn't run: ${e.message.split('\n')[0]}`) }
  problems.push(...errors)
  if (problems.length) fail('code excerpt', problems)
  else console.log('code excerpt ok')
  await page.close()
}

const browser = await launchChromium()
for (const pass of PASSES) await checkPass(pass)
await checkPrototypeKeyNames()
await checkCodeExcerpt()
await browser.close()
console.log(`smallest text: ${smallest.px.toFixed(1)} px (${smallest.cls} "${smallest.text}", ${smallest.at})`)
console.log(failures.length ? `FAILED (${failures.length})` : 'ok')
process.exit(failures.length ? 1 : 0)
