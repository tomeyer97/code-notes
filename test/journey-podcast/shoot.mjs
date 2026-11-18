// The journey panel's podcast bar (media/journey-podcast.js) in Chromium, with this script playing the extension's
// part (src/podcast/player.ts, simplified: the same model, out/src/podcast/model.js): a short tone episode on the
// scene sample journey. Checks what a person would notice: the bar and its timeline at three widths (nothing cut,
// nothing outside the window, one bar per step), play advances the audio, a click anywhere on the timeline shows
// exactly the step and beat of that time (forwards and backwards, no step in between shown), a drag moves the
// journey once (where it ended), the hover tip names the step, keys skip, a step clicked moves the audio, a beat the
// step does not have shows the step only, no console errors. The audio is served over HTTP by a server that ignores
// Range (as VS Code for the web serves a webview's files): the bar loads it whole (a blob) so seeks get there. Then:
// Space and K after a beat's ‹ › clicked, a pause "not in the podcast" with ▶ going on after it, a fetch that fails
// (the plain URL, no Range: a seek reports where the audio really is, never the time asked), an audio that can't
// play (▶ stays paused, says why); what is wrong with a podcast (a notice line, "Podcast unavailable" with Show why)
// fits and keeps the audio. Exits 1 on any failure.
//
// Usage (after `npm run build`): node test/journey-podcast/shoot.mjs [screenshot-dir]
// PLAYWRIGHT / CHROME: as test/harness/page.mjs.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : ''
if (OUT) fs.mkdirSync(OUT, { recursive: true })
const HARNESS = pathToFileURL(path.join(ROOT, 'test/journey-map/harness.html')).href
const MODEL = path.join(ROOT, 'out/src/podcast/model.js')
if (!fs.existsSync(MODEL)) { console.error('out/src/podcast/model.js is missing: run `npm run build` first'); process.exit(2) }
const { parsePodcast, resolveEpisode, viewAt, timeOf } = createRequire(import.meta.url)(MODEL)

const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/journey-scene/sample.json'), 'utf8'))
const journey = { ...raw, steps: raw.steps.map((s, i) => ({ ...s, n: i + 1 })), problems: [] }
const podcastFile = path.join(ROOT, 'test/fixtures/podcast/sample.podcast.json')
const p = parsePodcast(fs.readFileSync(podcastFile, 'utf8'))
const ep = resolveEpisode(p, { steps: journey.steps.map((s) => ({ id: s.id, beats: s.scene?.beats?.length ?? 0 })) })
// The audio over HTTP, never in ranges (200, the whole file, every time). `/nofetch/…`: a fetch() of it fails (only the
// audio element gets it); `/missing/…`: 404.
const audioFile = path.join(path.dirname(podcastFile), p.audio)
const server = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*' }
  if (req.url.startsWith('/missing/')) { res.writeHead(404, cors); res.end(); return }
  if (req.url.startsWith('/nofetch/') && req.headers['sec-fetch-dest'] === 'empty') { res.writeHead(500, cors); res.end(); return }
  const body = fs.readFileSync(audioFile)
  res.writeHead(200, { ...cors, 'Content-Type': 'audio/mpeg', 'Content-Length': body.length })
  res.end(body)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const src = `${base}/${p.audio}`
const episode = { key: 'place-order', src, title: ep.title, duration: ep.duration, at: 0, rate: 1, chapters: ep.chapters, segments: ep.segments.map((s) => ({ start: s.start, end: s.end, text: s.text, step: s.step })) }

const failures = []
let tag = ''
const fail = (m) => { failures.push(`${tag}: ${m}`); console.log(`  ✗ ${tag}: ${m}`) }
const ok = (cond, m) => { if (!cond) fail(m) }

async function launch() {
  const pw = await import(process.env.PLAYWRIGHT ? pathToFileURL(path.resolve(process.env.PLAYWRIGHT)).href : 'playwright')
  const chromium = pw.chromium ?? pw.default.chromium
  return chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--autoplay-policy=no-user-gesture-required'] })
}

const tour = (current) => ({ current, marks: {}, resume: 0, legendHidden: true, problems: [], key: "Ctrl+'", tutorial: false, list: [] })

/**
 * The extension's part: what player.ts does with the panel's messages, on the same model. `log` keeps what it did
 * (every view it applied, every seek report) so a check can say "moved once", "never showed step 2".
 */
function fakeExtension(page) {
  const st = { cur: 0, want: undefined, applied: [], seeks: 0, times: 0, lastT: 0, playing: false, beats: [] }
  const send = (m) => page.evaluate((x) => window.postMessage(x, '*'), m).catch(() => {})
  const apply = async (v, still) => {
    st.want = v
    st.applied.push(v)
    await send({ type: 'podcastBeat', n: v.step, i: v.beat ?? -1, ...(still ? { still: true } : {}) })
    if (st.cur !== v.step) { st.cur = v.step; await send({ type: 'tour', ...tour(v.step) }) }
  }
  const on = async (m) => {
    if (m.type === 'podcastTime') {
      st.times++
      st.lastT = m.t
      st.playing = m.playing
      if (m.seek) st.seeks++
      if (!m.playing && !m.seek) return
      const v = viewAt(ep, m.t)
      const view = v.beat === undefined ? { step: v.step } : { step: v.step, beat: v.beat }
      if (st.want && st.want.step === view.step && st.want.beat === view.beat) return
      await apply(view, !!m.seek)
    } else if (m.type === 'step') {
      // The reader walks to a step: the walk goes there, the audio to its first part.
      st.cur = m.n
      await send({ type: 'tour', ...tour(m.n) })
      const t = timeOf(ep, m.n)
      if (t !== undefined) { st.want = viewAt(ep, t); await send({ type: 'podcastCmd', action: 'seek', to: t }) }
    } else if (m.type === 'beat') st.beats.push([m.n, m.i])
  }
  return { st, on, send }
}

/** What the panel shows: the current step's number, the animation's beat ("n / N" → n-1), the bar's state. */
const shown = (page) => page.evaluate(() => {
  const cur = document.querySelector('.story .st.cur')
  const pos = document.querySelector('#app .scnwrap .scn-pos')
  return {
    step: cur ? Number(cur.dataset.n) : 0,
    beat: pos ? Number(pos.textContent.trim().split(' / ')[0]) - 1 : undefined,
    anim: !!document.querySelector('#app .scnwrap'),
    time: document.querySelector('.pod-time')?.textContent,
    cap: document.querySelector('.pod-cap')?.textContent,
  }
})
const audioState = (page) => page.evaluate(() => { const a = document.querySelector('.pod audio'); return { t: a.currentTime, paused: a.paused, ready: a.readyState, dur: a.duration, err: a.error && a.error.code, blob: a.src.startsWith('blob:') } })
const barNote = (page) => page.evaluate(() => { const e = document.querySelector('.pod-err'); return e.hidden ? '' : e.textContent })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(what, f, ms = 4000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await f()
    if (v) return v
    if (Date.now() > end) { fail(`timed out: ${what}`); return v }
    await sleep(40)
  }
}

/** The timeline's x for time t (page px). */
async function xAt(page, t) {
  const r = await page.evaluate(() => { const b = document.querySelector('.pod-track').getBoundingClientRect(); return { x: b.left, w: b.width, y: b.top + b.height / 2 } })
  return { x: r.x + (t / ep.duration) * r.w, y: r.y }
}

async function layout(page, w) {
  const L = await page.evaluate(() => {
    const W = document.documentElement.clientWidth, H = window.innerHeight
    const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height, vis: getComputedStyle(e).display !== 'none' } }
    const bar = r('.pod'), tl = r('.pod-tl')
    const buttons = [...document.querySelectorAll('.pod button')].filter((b) => getComputedStyle(b).display !== 'none').map((b) => { const x = b.getBoundingClientRect(); return { l: x.left, r: x.right, t: x.top, b: x.bottom, c: b.className } })
    const time = document.querySelector('.pod-time')
    return {
      W, H, bar, tl, buttons,
      scrollW: document.documentElement.scrollWidth,
      timeCut: time.scrollWidth > time.clientWidth + 1,
      bars: document.querySelectorAll('.pod-bar').length,
      appPad: parseFloat(getComputedStyle(document.getElementById('app')).paddingBottom),
    }
  })
  ok(L.bar && L.bar.vis, 'the bar is shown')
  ok(L.scrollW <= L.W, `no sideways scroll (${L.scrollW} > ${L.W})`)
  ok(L.bar.l >= 0 && L.bar.r <= L.W + 0.5 && Math.abs(L.bar.b - L.H) < 1, `the bar at the window's bottom, inside it: ${JSON.stringify(L.bar)}`)
  ok(L.tl.w >= L.W - 40, `the timeline spans the bar (${L.tl.w} of ${L.W})`)
  ok(L.bars === ep.chapters.length, `one timeline bar per part: ${L.bars} vs ${ep.chapters.length}`)
  ok(!L.timeCut, 'elapsed / total not cut')
  for (const b of L.buttons) ok(b.l >= 0 && b.r <= L.W + 0.5, `button ${b.c} inside the window`)
  for (let i = 0; i < L.buttons.length; i++) for (let j = i + 1; j < L.buttons.length; j++) {
    const a = L.buttons[i], c = L.buttons[j]
    const overlap = Math.min(a.r, c.r) - Math.max(a.l, c.l) > 0.5 && Math.min(a.b, c.b) - Math.max(a.t, c.t) > 0.5
    ok(!overlap, `buttons ${a.c} and ${c.c} overlap`)
  }
  ok(L.appPad >= L.bar.h, `the page's end stays clear of the bar (padding ${L.appPad} < ${L.bar.h})`)
  if (w < 360) ok(!L.buttons.some((b) => /prev|next/.test(b.c)), 'narrow: no part buttons')
}

async function run(b, w) {
  tag = `${w}px`
  const context = await b.newContext({ viewport: { width: w, height: 760 }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
  const page = await context.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  const fx = fakeExtension(page)
  await page.exposeFunction('__onPost', (m) => fx.on(m))
  await page.goto(`${HARNESS}?theme=${w === 700 ? 'dark' : 'light'}`)
  await page.waitForFunction(() => window.__posted.some((m) => m.type === 'ready'))
  await fx.send({ type: 'journey', journey, ...tour(0) })
  await fx.send({ type: 'podcast', episode })
  await page.waitForSelector('.pod:not([hidden])')
  const canMp3 = await page.evaluate(() => document.createElement('audio').canPlayType('audio/mpeg'))
  ok(!!canMp3, `this Chromium plays mp3 (canPlayType: "${canMp3}")`)
  await until('the audio\'s length is known', async () => (await audioState(page)).ready >= 1)
  ok((await audioState(page)).blob, 'served without Range, the audio is loaded whole (a blob: URL)')
  await layout(page, w)
  if (OUT) await page.screenshot({ path: path.join(OUT, `podcast-${w}-start.png`) })

  // Play: the audio goes, the walk follows (the intro: no step).
  await page.click('.pod-b.play')
  await until('playing, time advancing', async () => (await audioState(page)).t > 0.4)
  ok(fx.st.playing, 'the panel says it is playing')
  ok((await shown(page)).step === 0, 'the intro: no step yet')
  // One clock: what the extension was last told is the second the bar shows.
  for (let k = 0; k < 6; k++) {
    await sleep(170)
    const said = Math.floor(fx.st.lastT)
    const showing = await page.evaluate(() => document.querySelector('.pod-time').textContent.split(' / ')[0])
    const [m, sec] = showing.split(':').map(Number)
    ok(Math.abs(m * 60 + sec - said) <= (k ? 0 : 1) || said === m * 60 + sec, `one clock: the bar shows ${showing}, the extension was told ${fx.st.lastT.toFixed(2)}`)
  }
  await page.click('.pod-b.play')
  await until('paused', async () => (await audioState(page)).paused)

  // Seeks by clicking the timeline, forwards and backwards, far and near: exactly the view of that time.
  const points = [16, 4, 7, 25.5, 28, 10, 13, 31, 1, 36, 19, 22]
  for (const t of points) {
    const before = fx.st.applied.length
    const { x, y } = await xAt(page, t)
    await page.mouse.click(x, y)
    const want = viewAt(ep, t)
    await until(`click at ${t}s shows step ${want.step} beat ${want.beat}`, async () => {
      const s = await shown(page)
      const animOk = want.beat === undefined ? !s.anim : s.anim && s.beat === want.beat
      return s.step === want.step && animOk
    })
    const moves = fx.st.applied.slice(before)
    ok(moves.length <= 1, `click at ${t}s: moved once, not through the steps between (${JSON.stringify(moves)})`)
    const a = await audioState(page)
    ok(Math.abs(a.t - t) < 0.6, `click at ${t}s: the audio is there (${a.t.toFixed(2)})`)
  }
  if (OUT) await page.screenshot({ path: path.join(OUT, `podcast-${w}-seeked.png`) })

  // A drag: the journey moves once, where it ended (never through the steps the pointer crossed).
  {
    const before = fx.st.applied.length
    const seeksBefore = fx.st.seeks
    const a = await xAt(page, 2), z = await xAt(page, 33)
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    for (let k = 1; k <= 12; k++) await page.mouse.move(a.x + ((z.x - a.x) * k) / 12, a.y)
    const tipText = await page.evaluate(() => { const t = document.querySelector('.pod-tip'); return t.hidden ? '' : t.textContent })
    ok(/^8 · /.test(tipText) || /Session|session/.test(tipText) || tipText.startsWith(`${viewAt(ep, 33).step} · `), `dragging: the tip names the step under the pointer ("${tipText}")`)
    ok(fx.st.seeks === seeksBefore, 'no seek while dragging')
    await page.mouse.up()
    const want = viewAt(ep, 33)
    await until('after the drag: the step where it ended', async () => (await shown(page)).step === want.step)
    ok(fx.st.applied.length - before === 1, `the drag moved the journey once (${fx.st.applied.length - before})`)
    ok(fx.st.seeks - seeksBefore === 1, `one seek for the drag (${fx.st.seeks - seeksBefore})`)
  }

  // Hover: the tip names the step at that point.
  {
    const t = 19.5
    const { x, y } = await xAt(page, t)
    await page.mouse.move(x, y)
    const tip = await page.evaluate(() => { const t = document.querySelector('.pod-tip'); return { text: t.hidden ? '' : t.textContent, r: t.getBoundingClientRect().toJSON() } })
    const n = viewAt(ep, t).step
    ok(tip.text.startsWith(`${n} · ${journey.steps[n - 1].title}`.slice(0, 12)), `hover at ${t}s: the tip says step ${n} ("${tip.text}")`)
    ok(tip.r.left >= 0 && tip.r.right <= w + 0.5, 'the tip inside the window')
    if (OUT) await page.screenshot({ path: path.join(OUT, `podcast-${w}-hover.png`) })
    await page.mouse.move(5, 5)
  }

  // A beat the step doesn't have (s10: receipt beat 9): the step only, no animation.
  {
    const { x, y } = await xAt(page, 28.5)
    await page.mouse.click(x, y)
    await until('beat 9 of receipt → the receipt step without its animation', async () => { const s = await shown(page); return s.step === 6 && !s.anim })
  }

  // Keys: the timeline focused, → is 15 s on; Shift+← the step before.
  {
    await page.focus('.pod-tl')
    const t0 = (await audioState(page)).t
    await page.keyboard.press('ArrowRight')
    await until('→: 15 s on', async () => Math.abs((await audioState(page)).t - Math.min(t0 + 15, ep.duration - 0.05)) < 0.3)
    await page.keyboard.press('Home')
    await until('Home: the start', async () => (await audioState(page)).t < 0.2)
    await until('Home: the intro shows no step', async () => (await shown(page)).step === 0)
    await page.keyboard.press(' ')
    await until('Space plays', async () => !(await audioState(page)).paused)
    await page.keyboard.press('k')
    await until('K pauses', async () => (await audioState(page)).paused)
  }

  // Space and K after a beat's › clicked with the mouse: the podcast plays and pauses (the button doesn't keep Space).
  {
    const { x, y } = await xAt(page, 4)
    await page.mouse.click(x, y)
    await until('step 1 with its animation', async () => { const s = await shown(page); return s.step === 1 && s.anim })
    const before = (await shown(page)).beat
    await page.click('#app .scn-next')
    await until('› went a beat on', async () => (await shown(page)).beat === before + 1)
    const beat = (await shown(page)).beat
    await page.keyboard.press(' ')

    await until('Space after ›: plays', async () => !(await audioState(page)).paused)
    ok((await shown(page)).beat >= beat, 'Space did not step the animation back')
    await page.keyboard.press('k')
    await until('K after ›: pauses', async () => (await audioState(page)).paused)
  }

  // A step the podcast skips (the extension pauses it with a note): ▶ goes on after it, not where it was.
  {
    await fx.send({ type: 'podcastCmd', action: 'pause', note: "Step 2 isn't in the podcast", resumeAt: 15 })
    await until('the bar says so', async () => /isn't in the podcast/.test(await barNote(page)))
    await page.click('.pod-b.play')
    await until('▶: on from 15 s, playing', async () => { const a = await audioState(page); return !a.paused && a.t >= 15 && a.t < 16.5 })
    ok(!(await barNote(page)), 'the note goes once it plays on')
    await page.click('.pod-b.play')
    await until('paused', async () => (await audioState(page)).paused)
  }

  // Journey → audio: a step clicked in the storyline moves the audio to its first part.
  {
    await page.click('.story .st[data-n="4"]')
    const t = timeOf(ep, 4)
    await until(`step 4 clicked: the audio at ${t}s`, async () => Math.abs((await audioState(page)).t - t) < 0.3)
    await until('and step 4 shown', async () => (await shown(page)).step === 4)
  }

  // Speed cycles 1× → 1.25× → 1.5× → 1×.
  {
    const rates = []
    for (let k = 0; k < 3; k++) { await page.click('.pod-rate'); rates.push(await page.evaluate(() => document.querySelector('.pod audio').playbackRate)) }
    ok(rates.join() === '1.25,1.5,1', `speeds ${rates}`)
  }

  // Play through a step boundary: the walk follows on its own.
  {
    const { x, y } = await xAt(page, 14.2)
    await page.mouse.click(x, y)
    await page.click('.pod-b.play')
    await until('playing across 15 s: step 3 (live), beat 0', async () => { const s = await shown(page); return s.step === 3 && s.anim && s.beat === 0 }, 4000)
    await page.click('.pod-b.play')
  }

  // The audio's length goes to the extension (it checks the file against it).
  ok(await page.evaluate(() => window.__posted.some((m) => m.type === 'podcastMeta' && m.duration > 30)), 'the audio\'s length reported (podcastMeta)')

  // What is wrong with the podcast (src/podcast/validate.ts): one line over the timeline, the audio kept.
  {
    const t0 = (await audioState(page)).t
    await fx.send({ type: 'podcast', episode: { ...episode, notice: "Written for “Test run” · 2 parts can't be shown" } })
    const note = await until('the notice line', () => page.evaluate(() => { const n = document.querySelector('.pod-note'); if (!n || n.hidden) return null; const r = n.getBoundingClientRect(); const t = n.querySelector('.pod-note-t'); return { l: r.left, r: r.right, h: r.height, text: t.textContent, cut: t.scrollWidth > t.clientWidth + 1, why: n.querySelector('.pod-why').getBoundingClientRect().right } }))
    ok(note && /2 parts can't be shown/.test(note.text), `the notice says it: ${note && note.text}`)
    ok(note && note.l >= 0 && note.r <= w + 0.5 && note.why <= w + 0.5, `the notice and Show why inside the window: ${JSON.stringify(note)}`)
    ok(note && note.h < 30, `one line: ${note && note.h}px`)
    ok(Math.abs((await audioState(page)).t - t0) < 0.3, 'the same audio: not reloaded')
    await layout(page, w)
    if (OUT) await page.screenshot({ path: path.join(OUT, `podcast-${w}-notice.png`) })
    await page.click('.pod-why')
    await until('Show why: asked of the extension', () => page.evaluate(() => window.__posted.some((m) => m.type === 'podcastWhy')))
  }

  // A podcast that can't be played: the one line alone, nothing that plays.
  {
    await fx.send({ type: 'podcast', episode: { unavailable: 'version 2: this player reads version 1' } })
    const u = await until('Podcast unavailable', () => page.evaluate(() => {
      const pod = document.querySelector('.pod'), n = document.querySelector('.pod-note')
      if (pod.hidden || n.hidden || !pod.classList.contains('unavail')) return null
      const vis = (s) => { const e = document.querySelector(s); return !!e && e.getClientRects().length > 0 }
      return { text: n.textContent, title: n.title, tl: vis('.pod-tl'), row: vis('.pod-row'), cap: vis('.pod-cap'), h: pod.getBoundingClientRect().height, scrollW: document.documentElement.scrollWidth }
    }))
    ok(u && /^Podcast unavailable\s*Show why$/.test(u.text.trim()), `the line: "${u && u.text}"`)
    ok(u && /version 2/.test(u.title), 'its tooltip says why')
    ok(u && !u.tl && !u.row && !u.cap, `no timeline, controls or caption: ${JSON.stringify(u)}`)
    ok(u && u.h < 40 && u.scrollW <= w, `a slim bar, no sideways scroll: ${JSON.stringify(u)}`)
    ok((await audioState(page)).paused, 'nothing plays')
    const times = fx.st.times
    await page.keyboard.press(' ')
    await sleep(200)
    ok(fx.st.times === times, 'Space does nothing')
    if (OUT) await page.screenshot({ path: path.join(OUT, `podcast-${w}-unavailable.png`) })
    // Playable again: the player back, no line.
    await fx.send({ type: 'podcast', episode })
    await until('the player back', () => page.evaluate(() => document.querySelector('.pod-tl').getClientRects().length > 0 && document.querySelector('.pod-note').hidden))
    await until('the audio loaded again', async () => (await audioState(page)).ready >= 1)
  }

  await layout(page, w)
  if (OUT) await page.screenshot({ path: path.join(OUT, `podcast-${w}-end.png`) })
  for (const e of errors) fail(e)
  const pageErrors = await page.evaluate(() => window.__errors.map((e) => e.message))
  for (const e of pageErrors) fail(`page: ${e}`)
  await context.close()
  console.log(`${tag}: done`)
}

/** An episode at another URL in a fresh page: the page, the fake extension, the console's errors. */
async function withEpisode(b, url, name) {
  tag = name
  const context = await b.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
  const page = await context.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  const fx = fakeExtension(page)
  const told = []
  await page.exposeFunction('__onPost', (m) => { if (m.type === 'podcastError') told.push(m.message); return fx.on(m) })
  await page.goto(`${HARNESS}?theme=light`)
  await page.waitForFunction(() => window.__posted.some((m) => m.type === 'ready'))
  await fx.send({ type: 'journey', journey, ...tour(0) })
  await fx.send({ type: 'podcast', episode: { ...episode, src: url } })
  await page.waitForSelector('.pod:not([hidden])')
  return { context, page, fx, told, errors }
}

/** The fetch fails: the audio plays from its URL, whose server ignores Range. A seek reports where the audio is. */
async function streamed(b) {
  const { context, page, fx, told } = await withEpisode(b, `${base}/nofetch/${p.audio}`, 'streamed, no Range')
  await until('the audio\'s length is known', async () => (await audioState(page)).ready >= 1)
  ok(!(await audioState(page)).blob, 'the fetch failed: its own URL')
  ok(told.some((m) => /could not be loaded whole/.test(m)), `the extension is told (${JSON.stringify(told)})`)
  for (const t of [20, 7, 31]) {
    const seeks = fx.st.seeks
    const { x, y } = await xAt(page, t)
    await page.mouse.click(x, y)
    await until(`seek to ${t}: said once done`, async () => fx.st.seeks > seeks, 6000)
    await sleep(300)
    const a = await audioState(page)
    ok(Math.abs(fx.st.lastT - a.t) < 0.6, `seek to ${t}: the extension is told where the audio is (${fx.st.lastT.toFixed(2)}), the audio says ${a.t.toFixed(2)}`)
    const s = await shown(page)
    ok(s.step === viewAt(ep, a.t).step, `seek to ${t}: the walk shows step ${s.step}, where the audio is (${viewAt(ep, a.t).step})`)
    if (Math.abs(a.t - t) > 0.75) {
      ok(/Can't go to/.test(await barNote(page)), `a seek that did not get there says so in the bar ("${await barNote(page)}")`)
      ok(told.some((m) => /seek to .* ended at/.test(m)), 'and the extension is told (its log)')
    }
  }
  console.log(`  (the extension was told: ${told.join(' / ')})`)
  if (OUT) await page.screenshot({ path: path.join(OUT, 'podcast-streamed.png') })
  await context.close()
  console.log(`${tag}: done`)
}

/** An audio that can't be played: ▶ stays paused and says why; the extension never hears "playing". */
async function unplayable(b) {
  const { context, page, fx, told } = await withEpisode(b, `${base}/missing/${p.audio}`, 'unplayable')
  await until('the bar says the audio can\'t play', async () => /Can't play/.test(await barNote(page)), 6000)
  await page.click('.pod-b.play')
  await sleep(800)
  const a = await audioState(page)
  ok(a.paused, '▶ on an audio that can\'t play: paused')
  ok(!fx.st.playing, 'the extension is never told it plays')
  ok(/Can't play/.test(await barNote(page)), `the bar says why ("${await barNote(page)}")`)
  ok(told.length > 0, `the extension is told (${JSON.stringify(told)})`)
  await context.close()
  console.log(`${tag}: done`)
}

const b = await launch()
for (const w of [340, 700, 1200]) await run(b, w)
await streamed(b)
await unplayable(b)
await b.close()
server.close()
console.log(failures.length ? `${failures.length} problems` : 'all checks passed')
process.exit(failures.length ? 1 : 0)
