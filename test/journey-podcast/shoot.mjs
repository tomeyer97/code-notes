// The listening player in Chromium: the Listen view (media/listen.js, the audio's host) and the journey panel
// (media/journey-map.js, whose player is a remote of it), with this script playing the extension's part between them
// (src/podcast/player.ts, simplified: the same model, out/src/core/format/podcast/model.js) on the scene sample journey and a
// short tone. The audio is served over HTTP by a server that ignores Range (as VS Code for the web serves a webview's
// files): the host loads it whole (a blob) so seeks get there.
//
// What a person would notice, asserted (not only screenshotted):
// - Layout, at 190, 340, 700 and 1200 px, light and dark, in each state (paused, playing, ended, notice,
//   unavailable): every control inside the window and not cut (its text fits), no two overlapping, nothing scrolling
//   sideways; the timeline the player's whole width; every step mark at least 8 px wide; the controls by priority
//   (▶ always, then ⏮ ⏭, the time, the speed); the caption two lines at most, never cut; the page's end clear of the
//   player; the storyline's times not cut. Then every control shown is clicked, and the page still works.
// - Behaviour: play advances the audio, one clock; a click anywhere on the timeline shows exactly that step and beat
//   (forwards and backwards); a drag moves the walk once; the hover tip names the time and the step, inside the
//   window, and goes when the pointer leaves; keys (Space, K by its place, M, ← →, ↑ ↓ on the slider, Home, Page
//   Down); a step clicked moves the audio; ▶ on a storyline row plays that step and stops at its end; the Transcript
//   switch shows the row being said's, a sentence clicked seeks; the speed button cycles; M mutes; a step the podcast
//   skips; the end (Replay · Walk it yourself · Next journey and nothing else; a seek after the end plays);
//   while playing the panel is the one-line header and the step's animation (or the map) alone, the chapter list on
//   pause; the Listen view one line while the panel shows the episode; the caption shows the sentence being said, the speaker when the voice changes; Media Session; a fetch
//   that fails (seeks report where the audio really is); an audio that can't play; a cut-off audio greys the part
//   it can't reach. No console errors from either page.
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
const MAP = pathToFileURL(path.join(ROOT, 'test/journey-map/harness.html')).href
const LISTEN = pathToFileURL(path.join(ROOT, 'test/journey-podcast/listen.html')).href
const MODEL = path.join(ROOT, 'out/src/core/format/podcast/model.js')
if (!fs.existsSync(MODEL)) { console.error('out/src/core/format/podcast/model.js is missing: run `npm run build` first'); process.exit(2) }
const { parsePodcast, resolveEpisode, viewAt, timeOf } = createRequire(import.meta.url)(MODEL)

const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/journey-scene/sample.json'), 'utf8'))
const journey = { ...raw, steps: raw.steps.map((s, i) => ({ ...s, n: i + 1 })), problems: [] }
const podcastFile = path.join(ROOT, 'test/fixtures/podcast/sample.podcast.json')
const p = parsePodcast(fs.readFileSync(podcastFile, 'utf8')).value
// The fixture, with: a long segment (the caption in parts of two lines), one with its own sentence times, and the
// "deploy" step left out (a step the podcast doesn't talk about).
const LONG = 'The page goes live, and it keeps going while the order is packed. Every box that is filled is shown as it happens, with the name of the person packing it and the time it took, so nobody has to refresh anything at all. When the last box is closed, the page says the order is on its way.'
p.segments = p.segments.filter((s) => !(s.at && s.at.step === 'deploy')).map((s) => {
  if (s.at && s.at.step === 'live') return { ...s, text: LONG }
  if (s.at && s.at.step === 'add' && s.at.beat === 1) return { ...s, text: 'Ana adds a lamp. It goes in the cart.', sentences: [{ start: s.start, text: 'Ana adds a lamp.' }, { start: s.start + 1.5, text: 'It goes in the cart.' }] }
  return s
})
const ep = resolveEpisode(p, { steps: journey.steps.map((s) => ({ id: s.id, beats: s.scene?.beats?.length ?? 0 })) })
const DEPLOY = journey.steps.findIndex((s) => s.id === 'deploy') + 1
// The audio over HTTP, never in ranges (200, the whole file, every time). `/nofetch/…`: a fetch() of it fails (only the
// audio element gets it); `/missing/…`: 404; `/cut/…`: the first quarter of the file.
const audioFile = path.join(path.dirname(podcastFile), p.audio)
const server = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*' }
  if (req.url.startsWith('/missing/')) { res.writeHead(404, cors); res.end(); return }
  if (req.url.startsWith('/nofetch/') && req.headers['sec-fetch-dest'] === 'empty') { res.writeHead(500, cors); res.end(); return }
  let body = fs.readFileSync(audioFile)
  if (req.url.startsWith('/cut/')) body = body.subarray(0, Math.floor(body.length / 4))
  res.writeHead(200, { ...cors, 'Content-Type': 'audio/mpeg', 'Content-Length': body.length })
  res.end(body)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const src = `${base}/${p.audio}`
const episode = {
  key: 'place-order', src, title: ep.title, journey: journey.title, duration: ep.duration, at: 0, rate: 1, muted: false,
  chapters: ep.chapters, steps: journey.steps.map((s) => ({ n: s.n, title: s.title })), next: { key: 'other', title: 'Another journey' },
  segments: ep.segments.map((s) => ({ start: s.start, end: s.end, text: s.text, step: s.step, speaker: s.speaker, ...(s.sentences ? { sentences: s.sentences } : {}) })),
}

const failures = []
let tag = ''
/** The console errors of the pages open now (said with the first failure after them). */
let liveErrors = []
let errorsSaid = 0
const fail = (m) => {
  failures.push(`${tag}: ${m}`)
  console.log(`  ✗ ${tag}: ${m}`)
  for (const e of liveErrors.slice(errorsSaid)) console.log(`      (console) ${e}`)
  errorsSaid = liveErrors.length
}
const ok = (cond, m) => { if (!cond) fail(m) }
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

async function launch() {
  const pw = await import(process.env.PLAYWRIGHT ? pathToFileURL(path.resolve(process.env.PLAYWRIGHT)).href : 'playwright')
  const chromium = pw.chromium ?? pw.default.chromium
  return chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] })
}

const tour = (current) => ({ current, marks: {}, resume: 0, legendHidden: true, problems: [], key: "Ctrl+'", tutorial: false, list: [] })

/**
 * The two pages and the extension's part between them: what player.ts does with their messages, on the same model.
 * `st.applied`: every view it applied (a check can say "moved once", "never showed step 2").
 */
async function pages(b, w, theme, { listenW = 300, srcUrl = src, more = {} } = {}) {
  const context = await b.newContext({ viewport: { width: w, height: 760 }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
  const host = await context.newPage()
  await host.setViewportSize({ width: listenW, height: 360 })
  const map = await context.newPage()
  const errors = []
  liveErrors = errors
  errorsSaid = 0
  for (const [name, pg] of [['listen', host], ['panel', map]]) {
    pg.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${name} ${m.type()}: ${m.text()}`) })
    pg.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`))
  }
  const st = { cur: 0, want: undefined, applied: [], seeks: 0, times: 0, lastT: 0, playing: false, beats: [], told: [], ends: [], asks: [] }
  const toMap = (m) => map.evaluate((x) => window.postMessage(x, '*'), m).catch(() => {})
  const toHost = (m) => host.evaluate((x) => window.postMessage(x, '*'), m).catch(() => {})
  const apply = async (v, still) => {
    st.want = v
    st.applied.push(v)
    await toMap({ type: 'podcastBeat', n: v.step, i: v.beat ?? -1, ...(still ? { still: true } : {}) })
    if (st.cur !== v.step) { st.cur = v.step; await toMap({ type: 'tour', ...tour(v.step) }) }
  }
  const fromHost = async (m) => {
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
    } else if (m.type === 'podcastState') await toMap({ ...m, type: 'podcastState' })
    else if (m.type === 'podcastError') st.told.push(m.message)
  }
  const fromMap = async (m) => {
    if (m.type === 'podcastAsk') {
      st.asks.push(m)
      const { type, of, action, ...more } = m
      await toHost({ type: 'podcastCmd', action, ...more, ...(action === 'seek' ? { reader: true } : {}) })
    } else if (m.type === 'step') {
      // The reader walks to a step: the walk goes there, the audio to its first part (a step it skips: paused).
      st.cur = m.n
      await toMap({ type: 'tour', ...tour(m.n) })
      const t = timeOf(ep, m.n)
      if (t !== undefined) { st.want = viewAt(ep, t); await toHost({ type: 'podcastCmd', action: 'seek', to: t }) }
      else { st.want = { step: m.n }; await toHost({ type: 'podcastCmd', action: 'pause', note: `Step ${m.n} isn't in the podcast` }) }
    } else if (m.type === 'beat') st.beats.push([m.n, m.i])
    else if (m.type === 'podcastEnd') st.ends.push(m.action)
  }
  await host.exposeFunction('__onPost', (m) => fromHost(m))
  await map.exposeFunction('__onPost', (m) => fromMap(m))
  await host.goto(`${LISTEN}?theme=${theme}`)
  await map.goto(`${MAP}?theme=${theme}`)
  await host.waitForFunction(() => window.__posted.some((m) => m.type === 'ready'))
  await map.waitForFunction(() => window.__posted.some((m) => m.type === 'ready'))
  await toMap({ type: 'journey', journey, ...tour(0) })
  const e = { ...episode, src: srcUrl, ...more }
  await toMap({ type: 'podcast', episode: e })
  await toHost({ type: 'podcast', episode: e })
  await map.waitForSelector('.pod:not([hidden])')
  return { context, host, map, st, errors, toMap, toHost }
}

/** What the panel shows: the current step's number, the animation's beat, the player's time and caption. */
const shown = (map) => map.evaluate(() => {
  const cur = document.querySelector('.story .st.cur')
  // Playing, the chapter list gives way to the animation: the step is the header's ("Step 3 of 7 · …").
  const head = /^Step (\d+) of/.exec(document.querySelector('header.listening h1.q')?.textContent || '')
  const pos = document.querySelector('#app .scnwrap .scn-pos')
  return {
    step: cur ? Number(cur.dataset.n) : head ? Number(head[1]) : 0,
    beat: pos ? Number(pos.textContent.trim().split(' / ')[0]) - 1 : undefined,
    anim: !!document.querySelector('#app .scnwrap'),
    time: document.querySelector('.pod-now')?.textContent,
    cap: document.querySelector('.pod-cap-t')?.textContent,
    playing: document.querySelector('.pod-b.play')?.dataset.on === 'true',
  }
})
const audioState = (host) => host.evaluate(() => { const a = document.querySelector('.pod audio'); return { t: a.currentTime, paused: a.paused, ready: a.readyState, dur: a.duration, err: a.error && a.error.code, blob: a.src.startsWith('blob:'), muted: a.muted, rate: a.playbackRate } })
const barNote = (pg) => pg.evaluate(() => { const e = document.querySelector('.pod-err'); return e.hidden ? '' : e.textContent })

/** The timeline's x for time t (page px). */
async function xAt(pg, t) {
  const r = await pg.evaluate(() => { const b = document.querySelector('.pod-track').getBoundingClientRect(); return { x: b.left, w: b.width, y: b.top + b.height / 2 } })
  return { x: r.x + (t / ep.duration) * r.w, y: r.y }
}

/** The player's layout as a person would see it (asserted): `where` names the page in the messages. */
async function assertLayout(pg, where, { panel = true } = {}) {
  const L = await pg.evaluate(() => {
    const W = document.documentElement.clientWidth, H = window.innerHeight
    const vis = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'
    const box = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height } }
    const pod = document.querySelector('.pod')
    const controls = [...pod.querySelectorAll('button, .pod-time, .pod-where, .pod-note-t, .pod-err')].filter((e) => vis(e) && !e.closest('.pod-menu') && !e.closest('.pod-marks'))
      .map((e) => ({ c: `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`, ...box(e), cut: e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).textOverflow !== 'ellipsis', text: e.textContent.trim().slice(0, 30) }))
    const marks = [...pod.querySelectorAll('.pod-mark')].map((e) => ({ ...box(e), step: e.dataset.step }))
    const track = box(pod.querySelector('.pod-track'))
    const capEl = pod.querySelector('.pod-cap-t')
    const lineH = parseFloat(getComputedStyle(capEl).lineHeight)
    const cap = vis(capEl) ? { h: capEl.scrollHeight, client: capEl.clientHeight, lineH, text: capEl.textContent } : null
    const shownCls = (s) => vis(pod.querySelector(s))
    const story = [...document.querySelectorAll('.story .pt')].filter(vis).map((e) => ({ r: e.getBoundingClientRect().right, cut: e.scrollWidth > e.clientWidth + 1, text: e.textContent }))
    const storyW = document.querySelector('.story') ? document.querySelector('.story').getBoundingClientRect().width : 0
    const titles = [...document.querySelectorAll('.story .st .t')].filter(vis).map((e) => ({ w: e.getBoundingClientRect().width, wraps: e.getBoundingClientRect().height > parseFloat(getComputedStyle(e).lineHeight) * 1.5, text: e.textContent.slice(0, 20) }))
    const head = document.querySelector('header')
    const app = document.getElementById('app')
    return {
      W, H, pod: box(pod), podVis: vis(pod), controls, marks, track, cap, story, storyW, titles,
      shown: { prev: shownCls('.pod-b.prev'), play: shownCls('.pod-b.play'), next: shownCls('.pod-b.next'), time: shownCls('.pod-time'), total: shownCls('.pod-total'), rate: shownCls('.pod-rate'), mute: shownCls('.pod-mute') },
      unavail: pod.classList.contains('unavail'), ended: pod.classList.contains('ended'),
      scrollW: document.documentElement.scrollWidth,
      appPad: app ? parseFloat(getComputedStyle(app).paddingBottom) : 0,
      headH: head ? head.getBoundingClientRect().height : 0, listening: !!(head && head.classList.contains('listening')),
    }
  })
  const say = (m) => `${where}: ${m}`
  ok(L.podVis, say('the player is shown'))
  ok(L.scrollW <= L.W + 0.5, say(`no sideways scroll (${L.scrollW} > ${L.W})`))
  if (panel) ok(L.pod.l >= 0 && L.pod.r <= L.W + 0.5 && Math.abs(L.pod.b - L.H) < 1, say(`the player at the window's bottom, inside it: ${JSON.stringify(L.pod)}`))
  for (const c of L.controls) {
    ok(c.l >= -0.5 && c.r <= L.W + 0.5 && c.t >= -0.5 && c.b <= L.H + 0.5, say(`${c.c} "${c.text}" inside the window (${c.l.toFixed(0)}–${c.r.toFixed(0)} of ${L.W})`))
    ok(c.l >= L.pod.l - 0.5 && c.r <= L.pod.r + 0.5, say(`${c.c} inside the player`))
    ok(!c.cut, say(`${c.c} "${c.text}" not cut`))
  }
  const btns = L.controls.filter((c) => c.c.startsWith('button'))
  for (let i = 0; i < btns.length; i++) for (let j = i + 1; j < btns.length; j++) {
    const a = btns[i], c = btns[j]
    const overlap = Math.min(a.r, c.r) - Math.max(a.l, c.l) > 0.5 && Math.min(a.b, c.b) - Math.max(a.t, c.t) > 0.5
    ok(!overlap, say(`${a.c} and ${c.c} overlap`))
  }
  if (L.unavail) return L
  if (L.ended) {
    ok(!L.shown.play && !L.shown.rate, say(`the end: no transport, no speed: ${JSON.stringify(L.shown)}`))
    return L
  }
  ok(L.track.w >= L.pod.w - 40, say(`the timeline is the player's width (${L.track.w.toFixed(0)} of ${L.pod.w.toFixed(0)})`))
  ok(L.marks.length === ep.chapters.filter((c) => c.step).length, say(`a mark per step part: ${L.marks.length}`))
  for (const m of L.marks) {
    ok(m.w >= 7.9, say(`step ${m.step}'s mark is a target (${m.w.toFixed(1)} px ≥ 8)`))
    ok(m.l >= L.track.l - 0.5 && m.r <= L.track.r + 0.5, say(`step ${m.step}'s mark on the timeline`))
  }
  for (let i = 1; i < L.marks.length; i++) ok(L.marks[i].l >= L.marks[i - 1].r - 0.5, say(`marks ${L.marks[i - 1].step} and ${L.marks[i].step} don't overlap`))
  // By priority: ▶ always; ⏮ ⏭ before the time; the time before the speed; the speed before mute.
  const s = L.shown
  ok(s.play && s.prev && s.next, say(`▶ ⏮ ⏭ always there: ${JSON.stringify(s)}`))
  ok(!s.rate || s.time, say('the speed only with the time'))
  ok(!s.mute || s.rate, say('mute only with the speed'))
  ok(!s.total || s.rate, say('the total only with the speed'))
  if (L.cap) {
    ok(L.cap.h <= L.cap.lineH * 2 + 2, say(`the caption is two lines at most (${L.cap.h}px, line ${L.cap.lineH}): "${L.cap.text}"`))
    ok(L.cap.h <= L.cap.client + 1, say(`the caption is not cut: "${L.cap.text}"`))
    ok(!/…$/.test(L.cap.text), say('no ellipsis in the caption'))
  }
  if (panel) {
    ok(L.appPad >= L.pod.h, say(`the page's end stays clear of the player (padding ${L.appPad} < ${L.pod.h})`))
    for (const x of L.story) ok(!x.cut && x.r <= L.W + 0.5, say(`the storyline's "${x.text}" not cut`))
    // A row's title that wraps keeps most of the row (the time and the buttons never squeeze it to a column of letters).
    for (const t of L.titles) ok(!t.wraps || t.w >= Math.min(120, L.storyW * 0.5), say(`the storyline title "${t.text}" has room (${t.w.toFixed(0)} px of ${L.storyW.toFixed(0)})`))
  }
  return L
}

/** Every control the player shows, clicked once (then Escape, the pointer away); the page still works, no errors. */
async function clickEverything(pg, where, restore) {
  const sels = await pg.evaluate(() => {
    const pod = document.querySelector('.pod')
    for (const e of pod.querySelectorAll('[data-ck]')) delete e.dataset.ck
    const all = [...pod.querySelectorAll('button')].filter((e) => e.getClientRects().length)
    return all.map((e, i) => { e.dataset.ck = String(i); return { sel: `.pod [data-ck="${i}"]`, c: e.className, text: e.textContent.trim() } })
  })
  for (const s of sels) {
    const before = await pg.evaluate(() => window.__errors.length)
    try { await pg.click(s.sel, { timeout: 2000 }) } catch (e) {
      const over = await pg.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return 'gone'; const r = e.getBoundingClientRect(); const x = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); let a = e, hid = ""; while (a) { if (getComputedStyle(a).display === "none" || a.hidden) hid += ` ${a.className}`; a = a.parentElement } return `${JSON.stringify(r.toJSON())} under ${x && x.className} connected ${e.isConnected} hidden:${hid}` }, s.sel)
      fail(`${where}: can't click ${s.c} "${s.text}": ${e.message.split('\n')[0]} (${over})`)
      continue
    }
    await sleep(120)
    ok((await pg.evaluate(() => window.__errors.length)) === before, `${where}: clicking ${s.c} raised an error`)
    if (restore) await restore(s)
  }
  await pg.mouse.move(2, 2)
}

/** The layout matrix: each width and theme, in each state. */
async function matrix(b) {
  const widths = process.env.WIDTHS ? process.env.WIDTHS.split(',').map(Number) : [190, 340, 700, 1200]
  for (const w of widths) {
    for (const theme of ['light', 'dark']) {
      tag = `layout ${w}px ${theme}`
      const P = await pages(b, w, theme, { listenW: Math.min(w, 300) })
      const { host, map, toMap, toHost } = P
      await until('the audio loaded', async () => (await audioState(host)).ready >= 1)
      const shot = async (name) => { if (OUT) { await map.screenshot({ path: path.join(OUT, `${w}-${theme}-${name}.png`) }); if (w === 190 || w === 340) await host.screenshot({ path: path.join(OUT, `listen-${Math.min(w, 300)}-${theme}-${name}.png`) }) } }
      const reset = async () => { await toHost({ type: 'podcastCmd', action: 'pause' }); await toHost({ type: 'podcastCmd', action: 'rate', rate: 1 }); await toHost({ type: 'podcastCmd', action: 'mute', muted: false }) }
      // Paused, mid-step.
      await toHost({ type: 'podcastCmd', action: 'seek', to: 16 })
      await until('paused at 16 s, the panel shows it', async () => (await shown(map)).time === '0:16')
      await assertLayout(map, `${tag} paused`)
      await assertLayout(host, `${tag} Listen view paused`, { panel: false })
      await shot('paused')
      await clickEverything(map, `${tag} paused`, reset)
      // Playing: the header one line, the beat's sentence and snippet hidden.
      await toHost({ type: 'podcastCmd', action: 'play', at: 15.2 })
      await until('playing, the panel shows it', async () => (await shown(map)).playing)
      await sleep(300)
      const L = await assertLayout(map, `${tag} playing`)
      ok(L.listening, `${tag}: the header is one line while listening`)
      ok(L.headH < 44, `${tag}: one line: ${L.headH}px`)
      const hidden = await map.evaluate(() => [...document.querySelectorAll('.scn-cap, .scn-code, .scn-bar')].every((e) => !e.getClientRects().length))
      ok(hidden, `${tag}: while listening the animation's sentence, its bar and the code snippet give way to the caption`)
      const box = await map.evaluate(() => ({ story: !!document.querySelector('.story'), anim: !!document.querySelector('.pbox .scnwrap'), back: !!document.querySelector('header .homeb, header .end') }))
      // Too narrow for the map's boxes (< 240 px): no box, the chapter list stays.
      const roomy = w >= 240
      ok(roomy ? !box.story && box.anim && !box.back : box.story && !box.anim && !box.back, `${tag}: playing, ${roomy ? 'the step\'s animation alone' : 'the chapter list (no room for a box)'}, no ‹ or End: ${JSON.stringify(box)}`)
      await assertLayout(host, `${tag} Listen view playing`, { panel: false })
      await shot('playing')
      await clickEverything(map, `${tag} playing`, async () => { await toHost({ type: 'podcastCmd', action: 'rate', rate: 1 }); await toHost({ type: 'podcastCmd', action: 'mute', muted: false }) })
      await reset()
      await until('paused again: the chapter list back, the header still one line', () => map.evaluate(() => !!document.querySelector('.story') && !!document.querySelector('header.listening')))
      await sleep(150)
      await shot('paused-episode')
      // The intro, playing: the whole map, its names only.
      await toHost({ type: 'podcastCmd', action: 'play', at: 0.5 })
      await until('the intro, playing: the header says "Intro", the map alone (no room for it: the chapter list)', () => map.evaluate((roomy) => document.querySelector('header.listening h1.q')?.textContent === 'Intro' && (roomy ? !!document.querySelector('.pbox .gmap') && document.body.classList.contains('pod-map') : !!document.querySelector('.story') && !document.querySelector('.pbox')), w >= 240))
      await sleep(300)
      await shot('intro')
      await reset()
      // The Listen view while the panel shows the episode: one line (the journey, ▶, the time).
      await toHost({ type: 'panel', key: episode.key })
      await sleep(100)
      const one = await host.evaluate(() => { const vis = (s) => [...document.querySelectorAll(s)].some((e) => e.getClientRects().length > 0); const inside = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return r.left >= 0 && r.right <= document.documentElement.clientWidth + 0.5 }; return { h: document.getElementById('app').getBoundingClientRect().height, play: vis('.pod-b.play') && inside('.pod-b.play'), time: vis('.pod-now') && inside('.pod-now'), tl: vis('.pod-tl'), cap: vis('.pod-cap'), rate: vis('.pod-rate') } })
      ok(one.play && one.time && !one.tl && !one.cap && !one.rate && one.h < 40, `${tag}: the Listen view is one line while the panel has the player: ${JSON.stringify(one)}`)
      if (OUT && (w === 190 || w === 340)) await host.screenshot({ path: path.join(OUT, `listen-${Math.min(w, 300)}-${theme}-panel-open.png`) })
      await toHost({ type: 'panel' })
      // Ended.
      await toHost({ type: 'podcastCmd', action: 'play', at: ep.duration - 0.4 })
      await until('the end', () => map.evaluate(() => document.querySelector('.pod').classList.contains('ended') && !!document.querySelector('.pod-replay')?.getClientRects().length), 6000)
      await sleep(150) // the player's new height, given to the page a frame later
      await assertLayout(map, `${tag} ended`)
      await shot('ended')
      await clickEverything(map, `${tag} ended`, async () => { await sleep(150); await reset(); await toHost({ type: 'podcastCmd', action: 'play', at: ep.duration - 0.1 }); await sleep(500) })
      await reset()
      // A notice.
      await toMap({ type: 'podcast', episode: { ...episode, notice: "Written for “Test run” · 2 parts can't be shown" } })
      await sleep(100)
      await assertLayout(map, `${tag} notice`)
      await shot('notice')
      await clickEverything(map, `${tag} notice`, reset)
      // Unavailable.
      await toMap({ type: 'podcast', episode: { unavailable: 'version 2: this player reads version 1' } })
      await sleep(100)
      await assertLayout(map, `${tag} unavailable`)
      await shot('unavailable')
      await clickEverything(map, `${tag} unavailable`)
      for (const e of P.errors) fail(e)
      for (const pg of [host, map]) for (const e of await pg.evaluate(() => window.__errors.map((x) => x.message))) fail(`page: ${e}`)
      await P.context.close()
      console.log(`${tag}: done`)
    }
  }
}

/** What the player does, at one width. */
async function behaviour(b, w) {
  tag = `${w}px`
  const theme = w === 700 ? 'dark' : 'light'
  const { context, host, map, st, errors, toHost } = await pages(b, w, theme)
  const canMp3 = await host.evaluate(() => document.createElement('audio').canPlayType('audio/mpeg'))
  ok(!!canMp3, `this Chromium plays mp3 (canPlayType: "${canMp3}")`)
  await until('the audio\'s length is known', async () => (await audioState(host)).ready >= 1)
  ok((await audioState(host)).blob, 'served without Range, the audio is loaded whole (a blob: URL)')
  ok(await map.evaluate(() => { const a = document.querySelector('.pod audio'); return !!a && !a.getAttribute('src') }), 'the panel plays no audio of its own (a remote: its <audio> has no source)')

  // Play from the panel: the host plays, the walk follows (the intro: no step).
  await map.click('.pod-b.play')
  await until('playing, time advancing', async () => (await audioState(host)).t > 0.4)
  ok(st.playing, 'the host says it is playing')
  ok((await shown(map)).step === 0, 'the intro: no step yet')
  await until('the panel shows playing', async () => (await shown(map)).playing)
  // One clock: what the extension was last told is the second the panel shows (within one).
  for (let k = 0; k < 4; k++) {
    await sleep(230)
    const showing = (await shown(map)).time
    const [m, sec] = showing.split(':').map(Number)
    ok(Math.abs(m * 60 + sec - Math.floor(st.lastT)) <= 1, `one clock: the panel shows ${showing}, the extension was told ${st.lastT.toFixed(2)}`)
  }
  ok(await host.evaluate(() => !!(navigator.mediaSession && navigator.mediaSession.metadata && navigator.mediaSession.metadata.album === 'Code Notes')), 'the system\'s "now playing" names it (Media Session)')
  await map.click('.pod-b.play')
  await until('paused', async () => (await audioState(host)).paused)

  // Seeks by clicking the panel's timeline, forwards and backwards: exactly the view of that time.
  for (const t of [16, 4, 7, 25.5, 28, 10, 13, 31, 1, 36, 19, 22]) {
    const before = st.applied.length
    const { x, y } = await xAt(map, t)
    await map.mouse.click(x, y)
    const want = viewAt(ep, t)
    await until(`click at ${t}s shows step ${want.step} beat ${want.beat}`, async () => {
      const s = await shown(map)
      const animOk = want.beat === undefined ? !s.anim : s.anim && s.beat === want.beat
      return s.step === want.step && animOk
    })
    ok(st.applied.length - before <= 1, `click at ${t}s: moved once (${JSON.stringify(st.applied.slice(before))})`)
    const a = await audioState(host)
    ok(Math.abs(a.t - t) < 0.6, `click at ${t}s: the audio is there (${a.t.toFixed(2)})`)
  }
  if (OUT) await map.screenshot({ path: path.join(OUT, `behaviour-${w}-seeked.png`) })

  // A drag: the walk moves once, where it ended.
  {
    const before = st.applied.length
    const seeksBefore = st.seeks
    const a = await xAt(map, 2), z = await xAt(map, 33)
    await map.mouse.move(a.x, a.y)
    await map.mouse.down()
    for (let k = 1; k <= 12; k++) await map.mouse.move(a.x + ((z.x - a.x) * k) / 12, a.y)
    ok(st.seeks === seeksBefore, 'no seek while dragging')
    await map.mouse.up()
    const want = viewAt(ep, 33)
    await until('after the drag: the step where it ended', async () => (await shown(map)).step === want.step)
    ok(st.applied.length - before === 1, `the drag moved the walk once (${st.applied.length - before})`)
    ok(st.seeks - seeksBefore === 1, `one seek for the drag (${st.seeks - seeksBefore})`)
  }

  // Hover: the time, then the step, wrapped inside the window; gone when the pointer leaves.
  {
    const t = 19.5
    const { x, y } = await xAt(map, t)
    await map.mouse.move(x, y)
    const tip = await map.evaluate(() => { const t = document.querySelector('.pod-tip'); return { part: t.querySelector('.pod-tip-part')?.textContent, r: t.getBoundingClientRect().toJSON(), cut: t.scrollWidth > t.clientWidth + 1, hidden: t.hidden } })
    const n = viewAt(ep, t).step
    ok(!tip.hidden && tip.part === `Step ${n} · ${journey.steps[n - 1].title} · 0:19`, `hover at ${t}s: the tip says "Step ${n} · title · 0:19" ("${tip.part}")`)
    ok(tip.r.left >= 0 && tip.r.right <= w + 0.5 && !tip.cut, `the tip inside the window, not cut: ${JSON.stringify(tip.r)}`)
    if (OUT) await map.screenshot({ path: path.join(OUT, `behaviour-${w}-hover.png`) })
    await map.mouse.move(x, y - 120)
    ok(await map.evaluate(() => document.querySelector('.pod-tip').hidden), 'the tip goes when the pointer leaves the timeline')
    await map.mouse.move(x, y)
    await map.evaluate(() => document.dispatchEvent(new PointerEvent('pointerleave')))
    ok(await map.evaluate(() => document.querySelector('.pod-tip').hidden), 'and when the pointer leaves the page')
    await map.mouse.move(5, 5)
  }

  // A step mark: a click goes to its step's start.
  {
    const m = await map.evaluate(() => { const e = document.querySelectorAll('.pod-mark')[2]; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, step: Number(e.dataset.step) } })
    await map.mouse.click(m.x, m.y)
    const t = ep.chapters.find((c) => c.step === m.step).start
    await until(`the mark of step ${m.step}: the audio at ${t}`, async () => Math.abs((await audioState(host)).t - t) < 0.3)
  }

  // A beat the step doesn't have (receipt beat 9): the step only, no animation.
  {
    const { x, y } = await xAt(map, 28.5)
    await map.mouse.click(x, y)
    const n = journey.steps.findIndex((s) => s.id === 'receipt') + 1
    await until('beat 9 of receipt → the receipt step without its animation', async () => { const s = await shown(map); return s.step === n && !s.anim })
  }

  // Keys on the timeline (the slider pattern): ↑ 15 s on, ↓ back, Home, Page Down a step; Space, K, M, < >.
  {
    await map.focus('.pod-tl')
    const t0 = (await audioState(host)).t
    const up = Math.min(t0 + 15, ep.duration - 0.05)
    await map.keyboard.press('ArrowUp')
    await until('↑: 15 s on', async () => Math.abs((await audioState(host)).t - up) < 0.4)
    await map.keyboard.press('ArrowDown')
    await until('↓: 15 s back', async () => Math.abs((await audioState(host)).t - (up - 15)) < 0.6)
    await map.keyboard.press('Home')
    await until('Home: the start', async () => (await audioState(host)).t < 0.2)
    await until('Home: the intro shows no step', async () => (await shown(map)).step === 0)
    await map.keyboard.press('PageDown')
    await until('Page Down: the next part', async () => Math.abs((await audioState(host)).t - ep.chapters[1].start) < 0.3)
    await sleep(200)
    const vt = await map.evaluate(() => document.querySelector('.pod-tl').getAttribute('aria-valuetext'))
    ok(/seconds? of .*seconds?, Step 1 of 7/.test(vt), `the slider's value text has the total and the step: "${vt}"`)
    await map.keyboard.press(' ')
    await until('Space plays', async () => !(await audioState(host)).paused)
    await map.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', code: 'KeyK', bubbles: true })))
    await until('K (Caps Lock: "K") pauses, by the key\'s place', async () => (await audioState(host)).paused)
    await map.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'л', code: 'KeyK', bubbles: true })))
    await until('K on another layout ("л") plays', async () => !(await audioState(host)).paused)
    await map.keyboard.press('KeyM')
    await until('M mutes', async () => (await audioState(host)).muted)
    ok(await map.evaluate(() => !document.querySelector('.pod-mute')), 'no mute button (M is the key)')
    await map.keyboard.press('KeyM')
    await until('M again: sound', async () => !(await audioState(host)).muted)
    await map.keyboard.press('k')
    await until('K pauses', async () => (await audioState(host)).paused)
    await map.keyboard.press('>')
    await until('> faster', async () => (await audioState(host)).rate === 1.25)
    await map.keyboard.press('<')
    await until('< slower', async () => (await audioState(host)).rate === 1)
  }

  // The speed button: 1 → 1.25 → 1.5 → 2 → 1, the button says so.
  {
    await map.mouse.move(5, 5)
    if (await map.evaluate(() => !!document.querySelector('.pod-rate').getClientRects().length)) {
      for (const r of [1.25, 1.5, 2, 1]) {
        await map.click('.pod-rate')
        await until(`${r}×`, async () => (await audioState(host)).rate === r)
        await until(`the button says ${r}×`, () => map.evaluate((x) => document.querySelector('.pod-rate').textContent === x, `${r}×`))
      }
    }
  }

  // Space and K after a beat's › clicked with the mouse: the podcast plays and pauses.
  {
    const { x, y } = await xAt(map, 4)
    await map.mouse.click(x, y)
    await until('step 1 with its animation', async () => { const s = await shown(map); return s.step === 1 && s.anim })
    const before = (await shown(map)).beat
    await map.click('#app .scn-next')
    await until('› went a beat on', async () => (await shown(map)).beat === before + 1)
    const beat = (await shown(map)).beat
    await map.keyboard.press(' ')
    await until('Space after ›: plays', async () => !(await audioState(host)).paused)
    ok((await shown(map)).beat >= beat, 'Space did not step the animation back')
    await map.keyboard.press('k')
    await until('K after ›: pauses', async () => (await audioState(host)).paused)
  }

  // The caption: the sentence being said (the file's own times), the speaker when the voice changes, a long one in
  // parts of two lines.
  {
    await toHost({ type: 'podcastCmd', action: 'seek', to: 3.2 })
    await until('3.2 s: "Ana adds a lamp."', async () => (await shown(map)).cap === 'Ana adds a lamp.')
    await toHost({ type: 'podcastCmd', action: 'seek', to: 4.8 })
    await until('4.8 s: its second sentence (sentences: from the file)', async () => (await shown(map)).cap === 'It goes in the cart.')
    await toHost({ type: 'podcastCmd', action: 'seek', to: 9.5 })
    await until('the guest speaks: named', async () => /^Guest: And then she confirms\?$/.test((await shown(map)).cap))
    await toHost({ type: 'podcastCmd', action: 'seek', to: 12.5 })
    await until('the host again: named', async () => /^Host: /.test((await shown(map)).cap))
    const live = ep.segments.find((s) => s.text === LONG)
    const seen = new Set()
    for (let t = live.start + 0.05; t < live.end; t += 0.25) {
      await toHost({ type: 'podcastCmd', action: 'seek', to: t })
      await sleep(60)
      seen.add((await shown(map)).cap)
    }
    const parts = [...seen].filter(Boolean)
    ok(parts.length >= 3, `the long segment is said in parts (${parts.length})`)
    const joined = parts.join(' ').replace(/\s+/g, ' ')
    ok(LONG.split(/\s+/).every((word) => joined.includes(word)), 'every word of it is shown at some time')
    if (OUT) await map.screenshot({ path: path.join(OUT, `behaviour-${w}-caption.png`) })
  }

  // The storyline as the chapter list: number and title only, the step it skips muted, the row being said bold.
  {
    const rows = await map.evaluate(() => [...document.querySelectorAll('.story li[data-pstep]')].map((li) => ({ n: Number(li.dataset.pstep), text: li.querySelector('.st').textContent, skip: li.classList.contains('unnarrated'), now: li.classList.contains('pnow'), plisten: [...li.querySelectorAll('.plisten')].some((b) => getComputedStyle(b).visibility !== 'hidden') })))
    ok(rows.length === journey.steps.length, `a row per step (${rows.length})`)
    ok(rows.every((r) => r.text === `${r.n}${journey.steps[r.n - 1].title}`), `number and title only: ${JSON.stringify(rows.map((r) => r.text))}`)
    ok(rows.find((r) => r.n === DEPLOY)?.skip, `the step it skips is marked: ${JSON.stringify(rows.find((r) => r.n === DEPLOY))}`)
    ok(rows.every((r) => !r.plisten), 'no ▶ on a row until the pointer is on it')
    ok(await map.evaluate(() => document.querySelectorAll('.trb').length === 0 && document.querySelectorAll('.trtoggle').length === 1), 'one Transcript switch, no ≡ per row')
    const at = viewAt(ep, (await audioState(host)).t).step
    ok(rows.find((r) => r.now)?.n === at, `the row being said (${at}) marked: ${JSON.stringify(rows.find((r) => r.now))}`)
    ok(await map.evaluate(() => !!document.querySelector('.story li[data-ppart="intro"]') && !!document.querySelector('.story li[data-ppart="recap"]')), 'the intro and the recap have rows')
  }

  // ▶ on a row: that step alone, stopping at its end.
  {
    const n = 2
    const c = ep.chapters.filter((x) => x.step === n)
    const end = c[c.length - 1].end
    await map.hover(`.story li[data-pstep="${n}"] .st`)
    await map.click(`.story li[data-pstep="${n}"] .plisten`)
    await until(`step ${n} playing from its start`, async () => { const a = await audioState(host); return !a.paused && a.t >= c[0].start && a.t < c[0].start + 1.5 })
    await until(`it stops at the step's end (${end}s)`, async () => { const a = await audioState(host); return a.paused && Math.abs(a.t - end) < 0.5 }, (end - c[0].start + 3) * 1000)
  }

  // The transcript: the switch on, the row being said's shows, the sentence being said marked; a sentence clicked goes
  // there.
  {
    await toHost({ type: 'podcastCmd', action: 'seek', to: timeOf(ep, 3) + 0.3 })
    await until('step 3', async () => (await shown(map)).step === 3)
    await map.click('.trtoggle')
    const s = await until('the transcript of step 3', () => map.evaluate(() => { const t = document.querySelector('.trx[data-tr="s3"]'); return t && !t.hidden && t.querySelectorAll('.trs').length }))
    ok(s >= 3, `its sentences (${s})`)
    await map.click('.trx[data-tr="s3"] .trs:nth-of-type(2)')
    const t2 = await map.evaluate(() => Number(document.querySelector('.trx[data-tr="s3"] .trs:nth-of-type(2)').dataset.t))
    await until('the sentence clicked: the audio there', async () => Math.abs((await audioState(host)).t - t2) < 0.3)
    await until('and marked', () => map.evaluate(() => document.querySelector('.trx[data-tr="s3"] .trs:nth-of-type(2)').classList.contains('cur')))
    ok(await map.evaluate(() => document.querySelector('.trx[data-tr="s1"]').getAttribute('hidden') === 'until-found'), 'a shut transcript is still found by Ctrl+F (hidden="until-found")')
    ok(await map.evaluate(() => [...document.querySelectorAll('.trs')].every((x) => !x.title)), 'no time tooltip on the sentences')
    if (OUT) await map.screenshot({ path: path.join(OUT, `behaviour-${w}-transcript.png`) })
    await map.click('.trtoggle')
  }

  // A step the podcast skips, clicked: the walk stays, the audio pauses and says so; the panel shows the note.
  {
    await map.click(`.story li[data-pstep="${DEPLOY}"] .st`)
    await until('the panel says the step isn\'t in the podcast', async () => /isn't in the podcast/.test(await barNote(map)))
    ok((await audioState(host)).paused, 'paused')
  }

  // Journey → audio: a step clicked in the storyline moves the audio to its first part.
  {
    await map.click('.story .st[data-n="4"]')
    const t = timeOf(ep, 4)
    await until(`step 4 clicked: the audio at ${t}s`, async () => Math.abs((await audioState(host)).t - t) < 0.3)
    await until('and step 4 shown', async () => (await shown(map)).step === 4)
  }

  // Play through a step boundary: the walk follows on its own. The panel's player goes (the panel closed) and comes
  // back: the audio never stopped, and the new one shows where it is.
  {
    await toHost({ type: 'podcastCmd', action: 'seek', to: 14.2 })
    await map.click('.pod-b.play')
    await until('playing across 15 s: step 3, beat 0', async () => { const s = await shown(map); return s.step === 3 && s.anim && s.beat === 0 }, 4000)
    await map.evaluate(() => window.postMessage({ type: 'podcast' }, '*'))
    const t0 = (await audioState(host)).t
    await sleep(700)
    ok((await audioState(host)).t > t0 + 0.4, 'the audio plays on without the panel\'s player')
    await map.evaluate((e) => window.postMessage({ type: 'podcast', episode: e }, '*'), episode)
    await until('the panel\'s player is back, playing, at the audio\'s time', async () => { const s = await shown(map); const a = await audioState(host); const [m, sec] = (s.time || '0:0').split(':').map(Number); return s.playing && Math.abs(m * 60 + sec - a.t) <= 1.2 }, 3000)
    await map.click('.pod-b.play')
    await until('paused', async () => (await audioState(host)).paused)
  }

  // The end: what next; a seek after the end plays on (the reader didn't pause it).
  {
    await toHost({ type: 'podcastCmd', action: 'play', at: ep.duration - 0.3 })
    await until('the end', () => map.evaluate(() => document.querySelector('.pod').classList.contains('ended')), 5000)
    ok(await map.evaluate(() => document.querySelector('.pod-end').textContent === 'ReplayWalk it yourselfNext journey'), 'Replay · Walk it yourself · Next journey, and no "End of episode"')
    ok(await map.evaluate(() => !document.querySelector('.pod-tl').getClientRects().length && !document.querySelector('.pod-b.play').getClientRects().length), 'no timeline, no transport at the end')
    await map.click('.pod-walk')
    await until('Walk it yourself: asked of the extension', () => st.ends.includes('walk'))
    // A seek after the end (← with nothing focused: 15 s back) plays on from there.
    await map.evaluate(() => document.activeElement && document.activeElement.blur())
    await map.keyboard.press('ArrowLeft')
    const back = ep.duration - 15
    await until('a seek after the end plays from there', async () => { const a = await audioState(host); return !a.paused && a.t >= back - 0.5 && a.t < back + 2 })
    await map.click('.pod-b.play')
    await until('paused', async () => (await audioState(host)).paused)
  }

  // The audio's length goes to the extension (it checks the file against it).
  ok(await host.evaluate(() => window.__posted.some((m) => m.type === 'podcastMeta' && m.duration > 30)), 'the audio\'s length reported (podcastMeta)')

  for (const e of errors) fail(e)
  for (const pg of [host, map]) for (const e of await pg.evaluate(() => window.__errors.map((x) => x.message))) fail(`page: ${e}`)
  await context.close()
  console.log(`${tag}: done`)
}

/** The fetch fails: the audio plays from its URL, whose server ignores Range. A seek reports where the audio is. */
async function streamed(b) {
  tag = 'streamed, no Range'
  const { context, host, map, st } = await pages(b, 900, 'light', { srcUrl: `${base}/nofetch/${p.audio}` })
  await until('the audio\'s length is known', async () => (await audioState(host)).ready >= 1)
  ok(!(await audioState(host)).blob, 'the fetch failed: its own URL')
  ok(st.told.some((m) => /could not be loaded whole/.test(m)), `the extension is told (${JSON.stringify(st.told)})`)
  for (const t of [20, 7, 31]) {
    const seeks = st.seeks
    const { x, y } = await xAt(map, t)
    await map.mouse.click(x, y)
    await until(`seek to ${t}: said once done`, async () => st.seeks > seeks, 6000)
    await sleep(300)
    const a = await audioState(host)
    ok(Math.abs(st.lastT - a.t) < 0.6, `seek to ${t}: the extension is told where the audio is (${st.lastT.toFixed(2)}), the audio says ${a.t.toFixed(2)}`)
    const s = await shown(map)
    ok(s.step === viewAt(ep, a.t).step, `seek to ${t}: the walk shows step ${s.step}, where the audio is (${viewAt(ep, a.t).step})`)
    if (Math.abs(a.t - t) > 0.75) {
      ok(/Can't go to/.test(await barNote(map)), `a seek that did not get there says so in the panel ("${await barNote(map)}")`)
      ok(st.told.some((m) => /seek to .* ended at/.test(m)), 'and the extension is told (its log)')
    }
  }
  if (OUT) await map.screenshot({ path: path.join(OUT, 'streamed.png') })
  await context.close()
  console.log(`${tag}: done`)
}

/** An audio that can't be played: ▶ stays paused and says why; the extension never hears "playing". */
async function unplayable(b) {
  tag = 'unplayable'
  const { context, host, map, st } = await pages(b, 900, 'light', { srcUrl: `${base}/missing/${p.audio}` })
  await until('the panel says the audio can\'t play', async () => /Can't play/.test(await barNote(map)), 6000)
  await map.click('.pod-b.play')
  await sleep(800)
  ok((await audioState(host)).paused, '▶ on an audio that can\'t play: paused')
  ok(!st.playing, 'the extension is never told it plays')
  ok(/Can't play/.test(await barNote(map)), `the panel says why ("${await barNote(map)}")`)
  ok(st.told.length > 0, `the extension is told (${JSON.stringify(st.told)})`)
  await context.close()
  console.log(`${tag}: done`)
}

/** An audio shorter than the episode (a cut-off file: here the episode says 80 s, the audio is 40 s): the part it can't
 *  reach is greyed, and the tip there says so. (A truncated mp3 whose header still says its full length can't be told
 *  apart in the player: the validator's length checks cover that.) */
async function cut(b) {
  tag = 'cut-off audio'
  const { context, host, map } = await pages(b, 700, 'light', { more: { duration: 80 } })
  await until('the audio loaded', async () => (await audioState(host)).ready >= 1)
  const r = await until('the unreachable part greyed', () => map.evaluate(() => { const e = document.querySelector('.pod-reach'); return e && !e.hidden ? e.getBoundingClientRect().toJSON() : null }))
  const track = await map.evaluate(() => document.querySelector('.pod-track').getBoundingClientRect().toJSON())
  ok(r && r.right <= track.right + 1 && r.left > track.left + track.width * 0.1, `from where the audio ends to the end: ${JSON.stringify(r)}`)
  const { x, y } = await xAt(map, 70 * ep.duration / 80)
  await map.mouse.move(x, y)
  ok(/the audio ends before this/.test(await map.evaluate(() => document.querySelector('.pod-tip').textContent)), 'the tip there says the audio ends before it')
  if (OUT) await map.screenshot({ path: path.join(OUT, 'cut.png') })
  await context.close()
  console.log(`${tag}: done`)
}

const b = await launch()
const only = process.env.ONLY || ''
if (!only || only === 'matrix') await matrix(b)
if (!only || only === 'behaviour') for (const w of [340, 700, 1200]) await behaviour(b, w)
if (!only || only === 'edge') { await streamed(b); await unplayable(b); await cut(b) }
await b.close()
server.close()
console.log(failures.length ? `${failures.length} problems` : 'all checks passed')
process.exit(failures.length ? 1 : 0)
