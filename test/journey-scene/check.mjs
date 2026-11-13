// Steps through every beat of every animated step of a journey in the real panel (headless Chromium), at three panel
// widths (1300 px dark, 900 px light, 620 px light: there the scene column is its minimum, 400 px, beside the
// storyline): fails on console errors, text overflowing its box, anything sticking out of an actor box, any visible
// text in the scene smaller than 11 px on screen (font-size × the world's scale), the scene column narrower than
// 400 px, the keyboard focus leaving the scene, or a last beat without "Next step ›" (but on the last step).
//   node test/journey-scene/check.mjs <journey.json> [<dir for screenshots>]
// Needs Playwright with Chromium: `playwright` is imported from node_modules unless PLAYWRIGHT is set to another
// install's playwright/index.mjs; CHROME, when set, is the Chromium or Chrome binary to launch (else Playwright's own).
// The panel's harness (test/journey-map/harness.html) loads out/vendor/elk.bundled.js: run `npm run vendor` first.
// Try it on the bundled sample: node test/journey-scene/check.mjs test/journey-scene/sample.json /tmp/shots
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright')
import fs from 'node:fs'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), OUT = process.argv[3]
if (!process.argv[2]) { console.error('usage: node check.mjs <journey.json> [<dir for screenshots>]'); process.exit(2) }
const MIN_PX = 11, SCENE_MIN = 400
let bad = 0
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const journey = { ...r, steps: r.steps.map((s, i) => ({ ...s, n: i + 1 })), problems: [] }
const tour = (x = {}) => ({ current: 0, marks: {}, resume: 0, legendHidden: true, problems: [], key: "Ctrl+'", tutorial: false, list: [], moved: {}, ...x })
const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {})
let smallest = { px: Infinity }
for (const [w, theme] of [[1300, 'dark'], [900, 'light'], [620, 'light']]) {
  const page = await (await b.newContext({ viewport: { width: w, height: 900 } })).newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push('pageerror ' + e.message))
  await page.goto(`file://${ROOT}/test/journey-map/harness.html?theme=${theme}`)
  await page.waitForFunction(() => window.__posted.some((m) => m.type === 'ready'))
  const send = (m) => page.evaluate((x) => window.postMessage(x, '*'), m)
  const animated = journey.steps.filter((x) => x.scene).map((x) => x.n)
  if (!animated.length) { console.error('no step has a scene'); process.exit(2) }
  await send({ type: 'journey', journey, ...tour({ current: animated[0] }) })
  await page.waitForFunction(() => window.__posted.some((m) => m.type === 'rendered'), null, { timeout: 15000 })
  for (const n of animated) {
    await send({ type: 'tour', ...tour({ current: n }) }); await page.waitForTimeout(300)
    if (!(await page.locator('.scn').count())) await page.click('li:has(.st.cur) .animbtn')
    await page.waitForTimeout(900)
    const beats = journey.steps[n - 1].scene.beats.length
    for (let i = 1; i <= beats; i++) {
      await page.waitForTimeout(1250)
      const res = await page.evaluate(({ MIN_PX, SCENE_MIN }) => {
        const out = []
        for (const e of document.querySelectorAll('.scn-check, .scn-row, .tm-line, .scn-inner-label, .fl-line, .ch-msg.on, .ap-msg.on, .ap-box, .ap-row.on span, .ap-banner.on, .qu-note, .br-addr, .ga-note, .ap-dialog *, .ap-top *, .ap-title, .ap-title > b, .ap-ctitle, .scn-pod, .scn-label, .scn-fn, .ap-ev, .ap-ev span, .ap-card, .ap-signin, .ap-stitle, .ap-notice, .ap-tr, .ap-picnote, .br-name, .br-btn, .br-top > b, .br-cart, .br-url')) if (e.scrollWidth > e.clientWidth + 1) out.push(e.className + ':' + e.textContent.slice(0, 40))
        // nothing sticks out of its actor box
        for (const a of document.querySelectorAll('.scn-actor')) { const A = a.getBoundingClientRect(); for (const c of a.querySelectorAll('.scn-check, .scn-row, .tm-line, .scn-inner, .scn-pod, .scn-label, .scn-fn, .ap-card, .ap-ev, .ap-dialog, .ap-signwrap, .ap-tabs, .br-card, .br-cartw')) { const C = c.getBoundingClientRect(); if (C.width && (C.right > A.right + 1 || C.bottom > A.bottom + 1)) out.push('outside box: ' + c.textContent.slice(0, 40)) } }
        // nothing on the app window's shown screen is cut off by its edge
        for (const w of document.querySelectorAll('.ap-win.on')) { const W = w.getBoundingClientRect(); for (const c of w.querySelectorAll('*')) { const C = c.getBoundingClientRect(); if (C.width && C.height && getComputedStyle(c).display !== 'none' && !c.closest('.scn-cursor') && (C.right > W.right + 1 || C.bottom > W.bottom + 1)) out.push('cut by the app window: ' + c.className + ' ' + c.textContent.slice(0, 40)) } }
        // every visible text in the scene is at least MIN_PX on screen: font-size × the world's scale
        const view = document.querySelector('.scn-view'), world = document.querySelector('.scn-world')
        let min = { px: Infinity }
        if (view && world) {
          const V = view.getBoundingClientRect()
          const scale = world.getBoundingClientRect().width / world.offsetWidth
          const shown = (e) => { for (let x = e; x && x !== document.body; x = x.parentElement) { const s = getComputedStyle(x); if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.05) return false } return true }
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
        }
        // the keys work: the focus is in the scene
        const scn = document.querySelector('.scn')
        if (scn && !scn.contains(document.activeElement)) out.push('focus outside the scene: ' + (document.activeElement && document.activeElement.className))
        return { out, min }
      }, { MIN_PX, SCENE_MIN })
      const over = res.out
      if (res.min.px < smallest.px) smallest = { ...res.min, at: `${w} px, step ${n} beat ${i}` }
      if (i === beats) {
        const nx = await page.evaluate(() => { const b = document.querySelector('.scn-next'); return b && !b.hidden ? b.textContent : '' })
        const want = n < journey.steps.length ? 'Next step ›' : ''
        if (nx !== want) over.push(`last beat: › reads "${nx}", want "${want}"`)
      }
      if (over.length) { bad++; console.log(w, 'step', n, 'beat', i, JSON.stringify(over)) }
      if (OUT && w !== 900) await page.screenshot({ path: `${OUT}/w${w}-s${n}-b${i}.png` })
      if (i < beats) await page.click('.scn-next')
    }
  }
  if (errors.length) bad++
  console.log(w, 'errors', JSON.stringify(errors))
}
await b.close()
console.log(`smallest text: ${smallest.px.toFixed(1)} px (${smallest.cls} "${smallest.text}", ${smallest.at})`)
console.log(bad ? 'FAILED' : 'ok')
process.exit(bad ? 1 : 0)
