// Steps through every beat of every animated step of a journey in the real panel (headless Chromium), at three panel
// widths (1300 px dark, 900 px light, 620 px light: there the scene column is its minimum, 400 px, beside the
// storyline), then once more at 1300 px with reduced motion asked for: fails on console errors, text overflowing its box, anything sticking out of an actor box, any visible
// text in the scene smaller than 11 px on screen (font-size × the world's scale), the scene column narrower than
// 400 px, the keyboard focus leaving the scene, or a last beat without "Next step ›" (but on the last step).
//   node test/journey-scene/check.mjs <journey.json> [<dir for screenshots>]
// Needs Playwright with Chromium: `playwright` is imported from node_modules unless PLAYWRIGHT is set to another
// install's playwright/index.mjs; CHROME, when set, is the Chromium or Chrome binary to launch (else Playwright's own).
// The panel's harness (test/journey-map/harness.html) loads out/vendor/elk.bundled.js: run `npm run build` first.
// Try it on the bundled sample: node test/journey-scene/check.mjs test/journey-scene/sample.json /tmp/shots
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { launchChromium, openHarness } from '../harness/page.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = process.argv[3]
const HARNESS = pathToFileURL(path.join(ROOT, 'test/journey-map/harness.html')).href
if (!process.argv[2]) { console.error('usage: node check.mjs <journey.json> [<dir for screenshots>]'); process.exit(2) }
const MIN_PX = 11, SCENE_MIN = 400
/** How long a beat may take to come to rest (its packets, moves and fades run well under a second). */
const STILL_TIMEOUT_MS = 10000
let bad = 0
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const journey = { ...r, steps: r.steps.map((s, i) => ({ ...s, n: i + 1 })), problems: [] }
/** The rest of a "journey" or "tour" message (the walk's state), `x` over the defaults. */
const tour = (x = {}) => ({ current: 0, marks: {}, resume: 0, legendHidden: true, problems: [], key: "Ctrl+'", tutorial: false, list: [], moved: {}, ...x })
const b = await launchChromium()
/**
 * What is wrong with the scene shown now (run in the page): text overflowing its box, anything sticking out of its
 * actor box or cut by the app window's edge, visible text under MIN_PX on screen, the scene column under SCENE_MIN
 * (wide layout), the keyboard focus outside the scene. Also the smallest text seen ({ px, text, cls }).
 */
function sceneProblems({ MIN_PX, SCENE_MIN }) {
  const TEXT = '.scn-check, .scn-row, .tm-line, .scn-inner-label, .fl-line, .ch-msg.on, .ap-msg.on, .ap-box, .ap-row.on span, .ap-banner.on, .qu-note, .br-addr, .ga-note, .ap-dialog *, .ap-top *, .ap-title, .ap-title > b, .ap-ctitle, .scn-pod, .scn-label, .scn-fn, .ap-ev, .ap-ev span, .ap-card, .ap-signin, .ap-stitle, .ap-notice, .ap-tr, .ap-picnote, .br-name, .br-btn, .br-top > b, .br-cart, .br-url'
  const IN_ACTOR = '.scn-check, .scn-row, .tm-line, .scn-inner, .scn-pod, .scn-label, .scn-fn, .ap-card, .ap-ev, .ap-dialog, .ap-signwrap, .ap-tabs, .br-card, .br-cartw'

  /** Text wider than its box. */
  function overflowingText() {
    const out = []
    for (const e of document.querySelectorAll(TEXT)) if (e.scrollWidth > e.clientWidth + 1) out.push(e.className + ':' + e.textContent.slice(0, 40))
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
        const shown = C.width && C.height && getComputedStyle(c).display !== 'none' && !c.closest('.scn-cursor')
        if (shown && (C.right > W.right + 1 || C.bottom > W.bottom + 1)) out.push('cut by the app window: ' + c.className + ' ' + c.textContent.slice(0, 40))
      }
    }
    return out
  }

  /** Every visible text in the scene is at least MIN_PX on screen (font-size × the world's scale); the scene column is at least SCENE_MIN wide. */
  function textSizes() {
    const out = []
    let min = { px: Infinity }
    const view = document.querySelector('.scn-view'), world = document.querySelector('.scn-world')
    if (!view || !world) return { out, min }
    const V = view.getBoundingClientRect()
    const scale = world.getBoundingClientRect().width / world.offsetWidth
    const shown = (e) => {
      for (let x = e; x && x !== document.body; x = x.parentElement) {
        const s = getComputedStyle(x)
        if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.05) return false
      }
      return true
    }
    for (const e of document.querySelectorAll('.scn *')) {
      if (![...e.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) continue
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
  return { out: [...overflowingText(), ...outsideActorBoxes(), ...cutByAppWindow(), ...sizes.out, ...focusInScene()], min: sizes.min }
}

/** The scene shows beat `i` of `beats`, two frames on (a beat starts its moves on the next one). */
async function shown(i, beats) {
  await page.waitForFunction((want) => document.querySelector('.scn-pos')?.textContent === want, `${i} / ${beats}`, { timeout: STILL_TIMEOUT_MS })
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
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

let smallest = { px: Infinity }
let page
/**
 * The scene at beat `i` of `beats` and at rest: its counter says so, and after two frames (a beat starts its moves on
 * the next one) no finite animation is running (a packet on a wire, a box moving, a fade). The pulsing marks loop for
 * ever and are left out.
 */
async function still(i, beats) {
  await shown(i, beats)
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity), null, { timeout: STILL_TIMEOUT_MS })
}
// The last pass asks for reduced motion: then nothing in the page moves, on any beat.
for (const [w, theme, reduce] of [[1300, 'dark'], [900, 'light'], [620, 'light'], [1300, 'dark', true]]) {
  let errors
  ;({ page, errors } = await openHarness(b, HARNESS, { width: w, height: 900, theme, warnings: true, ready: true, context: reduce ? { reducedMotion: 'reduce' } : {} }))
  const send = (m) => page.evaluate((x) => window.postMessage(x, '*'), m)
  const animated = journey.steps.filter((x) => x.scene).map((x) => x.n)
  if (!animated.length) { console.error('no step has a scene'); process.exit(2) }
  await send({ type: 'journey', journey, ...tour({ current: animated[0] }) })
  await page.waitForFunction(() => window.__posted.some((m) => m.type === 'rendered'), null, { timeout: 15000 })
  for (const n of animated) {
    await send({ type: 'tour', ...tour({ current: n }) })
    // The storyline on step n (its "Show animation" is that row's).
    await page.waitForFunction((n) => !!document.querySelector(`.story .st.cur[data-n="${n}"]`), n)
    if (!(await page.locator('.scn').count())) await page.click('li:has(.st.cur) .animbtn')
    const beats = journey.steps[n - 1].scene.beats.length
    for (let i = 1; i <= beats; i++) {
      if (reduce) {
        await shown(i, beats)
        const moving = await page.evaluate(motionLeft)
        if (moving.length) { bad++; console.log('reduced motion: step', n, 'beat', i, JSON.stringify(moving)) }
      }
      await still(i, beats)
      const res = await page.evaluate(sceneProblems, { MIN_PX, SCENE_MIN })
      const over = res.out
      if (res.min.px < smallest.px) smallest = { ...res.min, at: `${w} px, step ${n} beat ${i}` }
      if (i === beats) {
        const nx = await page.evaluate(() => { const b = document.querySelector('.scn-next'); return b && !b.hidden ? b.textContent : '' })
        const want = n < journey.steps.length ? 'Next step ›' : ''
        if (nx !== want) over.push(`last beat: › reads "${nx}", want "${want}"`)
      }
      if (over.length) { bad++; console.log(w, 'step', n, 'beat', i, JSON.stringify(over)) }
      if (OUT && w !== 900 && !reduce) await page.screenshot({ path: `${OUT}/w${w}-s${n}-b${i}.png` })
      if (i < beats) await page.click('.scn-next')
    }
  }
  if (errors.length) bad++
  console.log(reduce ? `${w} reduced motion` : w, 'errors', JSON.stringify(errors))
}

// ---------- names that are Object.prototype's keys ----------

/** A scene whose ids, actor type, status and screen are Object.prototype's keys: it draws, steps and sends its
 *  packets like any other (no page errors, no chip toned by a prototype function), and the unknown type is left out. */
const ODD_SCENE = {
  actors: [
    { id: '__proto__', type: 'service', col: 0, label: 'API', checks: ['take it'] },
    { id: 'constructor', type: 'app', col: 1, brand: 'Shop', screen: '__proto__', detail: { title: 'Order', status: 'constructor' }, pages: { account: { title: 'Account', chip: 'constructor' } } },
    { id: 'odd', type: 'toString', col: 2 },
  ],
  wires: [['__proto__', 'constructor'], ['hasOwnProperty', 'constructor']],
  beats: [
    { focus: 'constructor', caption: 'One.', set: { constructor: { screen: 'detail' }, toString: { x: 1 } } },
    { focus: 'valueOf', caption: 'Two.', packet: { from: '__proto__', to: 'constructor', label: 'go' }, set: { __proto__: { done: 1 } } },
    { focus: '__proto__', caption: 'Three.', packet: { from: 'hasOwnProperty', to: 'constructor', label: 'go' } },
    { focus: 'constructor', caption: 'Four.', set: { constructor: { screen: 'account' } } },
  ],
}
{
  // As JSON text, parsed in the page: an object literal (or Playwright's argument copy) would turn "__proto__" into a prototype.
  const odd = { ...journey, steps: [{ ...journey.steps.find((x) => x.scene), n: 1, scene: ODD_SCENE }] }
  const errors = []
  ;({ page } = await openHarness(b, HARNESS, { width: 1300, height: 900, theme: 'dark', ready: true }))
  page.on('pageerror', (e) => errors.push(e.message))
  const sendJson = (m) => page.evaluate((x) => window.postMessage(JSON.parse(x), '*'), JSON.stringify(m))
  await sendJson({ type: 'journey', journey: odd, ...tour({ current: 1 }) })
  await page.waitForFunction(() => window.__posted.some((m) => m.type === 'rendered'), null, { timeout: 15000 })
  const out = []
  try {
    if (!(await page.locator('.scn').count())) await page.click('li:has(.st.cur) .animbtn', { timeout: 5000 })
    for (let i = 1; i <= ODD_SCENE.beats.length; i++) {
      await still(i, ODD_SCENE.beats.length)
      if (i < ODD_SCENE.beats.length) await page.click('.scn-next', { timeout: 5000 })
    }
  } catch (e) { out.push(`didn't step through: ${e.message.split('\n')[0]}`) }
  const actors = await page.evaluate(() => document.querySelectorAll('.scn-actor').length)
  const chips = await page.evaluate(() => [...document.querySelectorAll('.ap-chip')].map((c) => c.className))
  out.push(...errors)
  if (actors !== 2) out.push(`${actors} actors drawn (want 2: the unknown type left out)`)
  const toned = (c) => /^ap-chip (neutral|active|good|bad)$/.test(c)
  if (chips.length < 2 || !chips.every(toned)) out.push(`status chips ${JSON.stringify(chips)}`)
  if (out.length) { bad++; console.log('prototype-key names', JSON.stringify(out)) }
  await page.close()
}
await b.close()
console.log(`smallest text: ${smallest.px.toFixed(1)} px (${smallest.cls} "${smallest.text}", ${smallest.at})`)
console.log(bad ? 'FAILED' : 'ok')
process.exit(bad ? 1 : 0)
