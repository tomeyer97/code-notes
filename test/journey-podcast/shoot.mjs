// The listening player in Chromium: the Listen view (media/listen.js, the audio's host) and the journey panel
// (media/journey-map.js, whose player is a remote of it), with the extension's relay between them (pages.mjs) on the
// scene sample journey and a short tone. The audio is served over HTTP by a server that ignores Range (as VS Code for
// the web serves a webview's files): the host loads it whole (a blob) so seeks get there.
//
// What a person would notice, asserted (not only screenshotted), each scenario on fresh pages:
// - Layout, at 190, 340, 700 and 1200 px, light and dark, in each state (paused, playing, the intro, ended, notice,
//   unavailable; the Listen view alone, and one line while the panel shows the episode): every control inside the
//   window and not cut, no two overlapping, nothing scrolling sideways; the timeline the player's whole width; every
//   step mark at least 8 px wide; the controls by priority; the caption two lines at most, never cut; the page's end
//   clear of the player; the storyline's times not cut. Then every control shown is clicked, and the page still works.
// - Behaviour: play advances the audio, one clock; a click on the timeline shows exactly that step and beat; a drag
//   moves the walk once; the hover tip; the keys; a step clicked moves the audio; ▶ on a storyline row plays that step
//   and stops at its end; the transcript; the speed; a step the podcast skips; the end; the panel's player going and
//   coming back; the audio moving to the panel and back; the caption, the speaker when the voice changes; Media
//   Session; a fetch that fails; an audio that can't play; a cut-off audio. No console errors from either page.
//
// Usage (after `npm run build`): node test/journey-podcast/shoot.mjs [screenshot-dir]
// One scenario or group: node --test-name-pattern="drag" test/journey-podcast/shoot.mjs. WIDTHS=340,700: the layout
// widths. PLAYWRIGHT / CHROME: as test/harness/page.mjs.
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { assertLayout, clickEverything } from './layout.mjs'
import { audioOf, eventually, inPage, launch, model, openPages, PANEL, playerOf, ROOT, shown, statusLine, xAt } from './pages.mjs'

const OUT = process.argv[2] ? path.resolve(process.argv[2]) : ''
if (OUT) fs.mkdirSync(OUT, { recursive: true })
const { parsePodcast, resolveEpisode, viewAt, timeOf } = model

// ---------- the fixture: the scene sample journey and its podcast ----------

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
const episode = {
  key: 'place-order', src: '', title: ep.title, journey: journey.title, duration: ep.duration, at: 0, rate: 1, muted: false,
  chapters: ep.chapters, steps: journey.steps.map((s) => ({ n: s.n, title: s.title })), next: { key: 'other', title: 'Another journey' },
  segments: ep.segments.map((s) => ({ start: s.start, end: s.end, text: s.text, step: s.step, speaker: s.speaker, ...(s.sentences ? { sentences: s.sentences } : {}) })),
}
const fixture = { journey, ep, episode, model }

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

let browser
let base = ''
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
  browser = await launch()
})
after(async () => {
  await browser?.close()
  server.close()
})

// ---------- one scenario: fresh pages, closed after it, no page errors ----------

/**
 * Scenario `name` on fresh pages (`o`: openPages' options; `loaded`: waits until the audio's length is known).
 * @param {string} name
 * @param {{ width: number, theme?: string, listenW?: number, srcPath?: string, more?: object, panel?: boolean, loaded?: boolean }} o
 *   `srcPath`: the audio's path on the server (the server above: nofetch/, missing/, cut/)
 * @param {(P: Awaited<ReturnType<typeof openPages>>) => Promise<void>} run
 */
function scenario(name, o, run) {
  /** The audio's server refuses it on purpose here: the browser's own line about that is no page error. */
  const expected = (e) => o.srcPath && /Failed to load resource: the server responded with a status of (404|500)/.test(e)
  it(name, { timeout: 90_000 }, async () => {
    const P = await openPages(browser, fixture, { theme: 'light', ...o, src: `${base}/${o.srcPath ?? ''}${p.audio}` })
    try {
      if (o.loaded !== false) await eventually('the audio\'s length is known', async () => (await audioOf(P.listen)).ready >= 1)
      await run(P)
      assert.deepEqual((await P.pageErrors()).filter((e) => !expected(e)), [], 'no console or page errors')
    } finally {
      await P.close()
    }
  })
}

const shot = async (pg, name) => { if (OUT) await pg.screenshot({ path: path.join(OUT, `${name}.png`) }) }
/** The host back to paused at 1×, with sound. */
const reset = (P) => { P.ext.command('pause'); P.ext.command('rate', { rate: 1 }); P.ext.command('mute', { muted: false }) }
/** Two animation frames in `pg`: what it was just sent or clicked is handled and drawn. */
const frames = (pg) => pg.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(undefined)))))
const playing = (P) => eventually('the panel shows playing', async () => (await shown(P.map)).playing)
const paused = (P) => eventually('the audio paused', async () => (await audioOf(P.listen)).paused)
const audioAt = (P, t, within, what) => eventually(what, async () => Math.abs((await audioOf(P.listen)).t - t) < within)
/** The player's own height given to the page (a frame after it changes): `--podH` is the player's height. */
const heightSettled = (pg) => inPage(pg, 'the player\'s height given to the page', () => {
  const pod = document.querySelector('[role="region"][aria-label="Listen"]')
  return getComputedStyle(document.documentElement).getPropertyValue('--podH').trim() === `${pod.offsetHeight}px`
})
const ended = (P) => inPage(P.map, 'the end', () => !!document.querySelector('[data-testid="end"]:not([hidden]) button')?.getClientRects().length, undefined, 6000)

// ---------- layout ----------

const WIDTHS = process.env.WIDTHS ? process.env.WIDTHS.split(',').map(Number) : [190, 340, 700, 1200]
for (const w of WIDTHS) for (const theme of ['light', 'dark']) {
  describe(`layout ${w}px ${theme}`, () => {
    const o = { width: w, theme, listenW: Math.min(w, 300) }
    const name = (state) => `${w}-${theme}-${state}`
    const listenShot = async (P, state) => { if (w === 190 || w === 340) await shot(P.listen, `listen-${Math.min(w, 300)}-${theme}-${state}`) }

    scenario('paused mid-step', o, async (P) => {
      P.ext.command('seek', { to: 16 })
      await eventually('paused at 16 s, the panel shows it', async () => (await shown(P.map)).sec === 16)
      await assertLayout(P.map, 'paused', ep)
      await shot(P.map, name('paused'))
      await clickEverything(P.map, 'paused', () => reset(P))
    })

    scenario('playing: the header one line, the step\'s animation (or the map) alone', o, async (P) => {
      P.ext.command('play', { at: 15.2 })
      await playing(P)
      // Too narrow for the map's boxes (< 240 px): no box, the chapter list stays.
      const roomy = w >= 240
      await inPage(P.map, 'the panel laid out for listening', ({ S, roomy }) => !!document.querySelector(S.listeningHeader) && !!document.querySelector(roomy ? S.playingAnimation : S.story), { S: PANEL, roomy })
      const L = await assertLayout(P.map, 'playing', ep)
      assert.ok(L.listening, 'the header is one line while listening')
      assert.ok(L.headH < 44, `one line: ${L.headH}px`)
      const hidden = await P.map.evaluate(() => [...document.querySelectorAll('.scn-cap, .scn-code, .scn-bar')].every((e) => !e.getClientRects().length))
      assert.ok(hidden, 'while listening the animation\'s sentence, its bar and the code snippet give way to the caption')
      const box = await P.map.evaluate((S) => ({ story: !!document.querySelector(S.story), anim: !!document.querySelector(S.playingAnimation), back: !!document.querySelector('header .homeb, header .end') }), PANEL)
      assert.deepEqual(box, roomy ? { story: false, anim: true, back: false } : { story: true, anim: false, back: false }, `playing, ${roomy ? 'the step\'s animation alone' : 'the chapter list (no room for a box)'}, no ‹ or End`)
      await shot(P.map, name('playing'))
      await clickEverything(P.map, 'playing', () => { P.ext.command('rate', { rate: 1 }); P.ext.command('mute', { muted: false }) })
    })

    scenario('paused after playing: the chapter list back, the header still one line', o, async (P) => {
      P.ext.command('play', { at: 15.2 })
      await playing(P)
      reset(P)
      await inPage(P.map, 'the chapter list back, the header still one line', (S) => !!document.querySelector(S.story) && !!document.querySelector(S.listeningHeader), PANEL)
      await shot(P.map, name('paused-episode'))
    })

    scenario('the intro, playing: the whole map, its names only', o, async (P) => {
      P.ext.command('play', { at: 0.5 })
      await inPage(P.map, 'the header says "Intro", the map alone (no room for it: the chapter list)', ({ S, roomy }) =>
        document.querySelector(S.listeningTitle)?.textContent === 'Intro' && (roomy ? !!document.querySelector(S.playingMap) && document.body.classList.contains('pod-map') : !!document.querySelector(S.story) && !document.querySelector('.pbox')), { S: PANEL, roomy: w >= 240 })
      await shot(P.map, name('intro'))
    })

    scenario('the Listen view while the panel shows the episode: one line', o, async (P) => {
      const one = await inPage(P.listen, 'the Listen view one line', () => {
        const pod = document.querySelector('[role="region"][aria-label="Listen"]')
        const vis = (s) => [...pod.querySelectorAll(s)].some((e) => e.getClientRects().length > 0)
        const inside = (s) => { const r = pod.querySelector(s).getBoundingClientRect(); return r.left >= 0 && r.right <= document.documentElement.clientWidth + 0.5 }
        const h = document.getElementById('app').getBoundingClientRect().height
        const play = vis('button[aria-label="Play"]') && inside('button[aria-label="Play"]')
        const time = vis('[data-testid="time"]') && inside('[data-testid="time"]')
        const r = { h, play, time, slider: vis('[role="slider"]'), cap: vis('[data-testid="caption"]'), rate: vis('button[aria-label^="Speed"]') }
        return r.play && r.time && !r.slider && !r.cap && !r.rate && r.h < 40 ? r : null
      })
      assert.ok(one)
      await listenShot(P, 'panel-open')
    })

    scenario('the Listen view alone (the panel closed): paused and playing', { ...o, panel: false }, async (P) => {
      P.ext.command('seek', { to: 16 })
      await eventually('paused at 16 s', async () => Math.abs((await audioOf(P.listen)).t - 16) < 0.3)
      await frames(P.listen)
      await assertLayout(P.listen, 'Listen view paused', ep, { panel: false })
      await listenShot(P, 'paused')
      P.ext.command('play', { at: 15.2 })
      await inPage(P.listen, 'the Listen view shows playing', () => !!document.querySelector('[role="region"][aria-label="Listen"] button[aria-label="Pause"]'))
      await assertLayout(P.listen, 'Listen view playing', ep, { panel: false })
      await listenShot(P, 'playing')
    })

    scenario('ended: Replay · Walk it yourself · Next journey', o, async (P) => {
      const toEnd = async () => { P.ext.command('play', { at: ep.duration - 0.4 }); await ended(P); await heightSettled(P.map) }
      await toEnd()
      await assertLayout(P.map, 'ended', ep)
      await shot(P.map, name('ended'))
      await clickEverything(P.map, 'ended', async () => { reset(P); await toEnd() })
    })

    scenario('a notice over the player', o, async (P) => {
      P.ext.toMap({ type: 'podcast', episode: { ...P.ext.episode, notice: "Written for “Test run” · 2 parts can't be shown" } })
      await playerOf(P.map).region.getByTestId('note').getByText('Written for').waitFor()
      await heightSettled(P.map)
      await assertLayout(P.map, 'notice', ep)
      await shot(P.map, name('notice'))
      await clickEverything(P.map, 'notice', () => reset(P))
    })

    scenario('unavailable', o, async (P) => {
      P.ext.toMap({ type: 'podcast', episode: { unavailable: 'version 2: this player reads version 1' } })
      await playerOf(P.map).region.getByTestId('note').getByText('Podcast unavailable').waitFor()
      await heightSettled(P.map)
      await assertLayout(P.map, 'unavailable', ep)
      await shot(P.map, name('unavailable'))
      await clickEverything(P.map, 'unavailable')
    })
  })
}

// ---------- behaviour ----------

for (const w of [340, 700, 1200]) {
  describe(`behaviour ${w}px`, () => {
    const o = { width: w, theme: w === 700 ? 'dark' : 'light' }

    scenario('the audio is loaded whole, in the Listen view only', o, async (P) => {
      const canMp3 = await P.listen.evaluate(() => document.createElement('audio').canPlayType('audio/mpeg'))
      assert.ok(canMp3, `this Chromium plays mp3 (canPlayType: "${canMp3}")`)
      assert.ok((await audioOf(P.listen)).blob, 'served without Range, the audio is loaded whole (a blob: URL)')
      assert.equal((await audioOf(P.map)).src, '', 'the panel plays no audio of its own (a remote: its <audio> has no source)')
      assert.ok(await P.listen.evaluate(() => window.__harness.posted.some((m) => m.type === 'podcastMeta' && m.duration > 30)), 'the audio\'s length reported (podcastMeta)')
    })

    scenario('▶ in the panel: the host plays, the walk follows, one clock', o, async (P) => {
      await playerOf(P.map).play.click()
      await eventually('playing, time advancing', async () => (await audioOf(P.listen)).t > 0.4)
      assert.ok(P.st.playing, 'the host says it is playing')
      assert.equal((await shown(P.map)).step, 0, 'the intro: no step yet')
      await playing(P)
      // One clock: what the extension was last told is the second the panel shows (within one), sampled a quarter
      // second apart while it plays.
      for (let k = 0; k < 4; k++) {
        await new Promise((r) => setTimeout(r, 230))
        const s = await shown(P.map)
        assert.ok(Math.abs(s.sec - Math.floor(P.st.lastT)) <= 1, `one clock: the panel shows ${s.sec} s, the extension was told ${P.st.lastT.toFixed(2)}`)
      }
      assert.ok(await P.listen.evaluate(() => navigator.mediaSession?.metadata?.album === 'Code Notes'), 'the system\'s "now playing" names it (Media Session)')
      await playerOf(P.map).play.click()
      await paused(P)
    })

    scenario('a click on the timeline shows exactly that step and beat, forwards and backwards', o, async (P) => {
      for (const t of [16, 4, 7, 25.5, 28, 10, 13, 31, 1, 36, 19, 22]) {
        const before = P.st.applied.length
        const { x, y } = await xAt(P.map, t, ep.duration)
        await P.map.mouse.click(x, y)
        const want = viewAt(ep, t)
        await eventually(`click at ${t}s shows step ${want.step} beat ${want.beat}`, async () => {
          const s = await shown(P.map)
          return s.step === want.step && (want.beat === undefined ? !s.anim : s.anim && s.beat === want.beat)
        })
        assert.ok(P.st.applied.length - before <= 1, `click at ${t}s: moved once (${JSON.stringify(P.st.applied.slice(before))})`)
        await audioAt(P, t, 0.6, `click at ${t}s: the audio is there`)
      }
      await shot(P.map, `behaviour-${w}-seeked`)
    })

    scenario('a drag moves the walk once, where it ended', o, async (P) => {
      const before = P.st.applied.length
      const seeksBefore = P.st.seeks
      const a = await xAt(P.map, 2, ep.duration), z = await xAt(P.map, 33, ep.duration)
      await P.map.mouse.move(a.x, a.y)
      await P.map.mouse.down()
      for (let k = 1; k <= 12; k++) await P.map.mouse.move(a.x + ((z.x - a.x) * k) / 12, a.y)
      assert.equal(P.st.seeks, seeksBefore, 'no seek while dragging')
      await P.map.mouse.up()
      const want = viewAt(ep, 33)
      await eventually('after the drag: the step where it ended', async () => (await shown(P.map)).step === want.step)
      assert.equal(P.st.applied.length - before, 1, 'the drag moved the walk once')
      assert.equal(P.st.seeks - seeksBefore, 1, 'one seek for the drag')
    })

    scenario('the hover tip names the time and the step, inside the window; it goes with the pointer', o, async (P) => {
      const t = 19.5
      const { x, y } = await xAt(P.map, t, ep.duration)
      const tip = playerOf(P.map).tip
      await P.map.mouse.move(x, y)
      await tip.waitFor()
      const n = viewAt(ep, t).step
      assert.equal(await tip.locator('span').first().textContent(), `Step ${n} · ${journey.steps[n - 1].title} · 0:19`)
      const r = await tip.evaluate((e) => ({ ...e.getBoundingClientRect().toJSON(), cut: e.scrollWidth > e.clientWidth + 1 }))
      assert.ok(r.left >= 0 && r.right <= w + 0.5 && !r.cut, `the tip inside the window, not cut: ${JSON.stringify(r)}`)
      await shot(P.map, `behaviour-${w}-hover`)
      await P.map.mouse.move(x, y - 120)
      await tip.waitFor({ state: 'hidden' })
      await P.map.mouse.move(x, y)
      await tip.waitFor()
      await P.map.evaluate(() => document.dispatchEvent(new PointerEvent('pointerleave')))
      await tip.waitFor({ state: 'hidden' })
    })

    scenario('a step mark goes to its step\'s start', o, async (P) => {
      const mark = playerOf(P.map).marks.nth(2)
      const step = Number(await mark.getAttribute('data-step'))
      await mark.click()
      await audioAt(P, ep.chapters.find((c) => c.step === step).start, 0.3, `the mark of step ${step}: the audio at its start`)
    })

    scenario('a beat the step doesn\'t have: the step only, no animation', o, async (P) => {
      const { x, y } = await xAt(P.map, 28.5, ep.duration)
      await P.map.mouse.click(x, y)
      const n = journey.steps.findIndex((s) => s.id === 'receipt') + 1
      await eventually('beat 9 of receipt → the receipt step without its animation', async () => { const s = await shown(P.map); return s.step === n && !s.anim })
    })

    scenario('keys: the slider\'s (↑ ↓ Home Page Down), Space, K by its place, M, < >', o, async (P) => {
      const { slider } = playerOf(P.map)
      await slider.focus()
      const up = Math.min((await audioOf(P.listen)).t + 15, ep.duration - 0.05)
      await P.map.keyboard.press('ArrowUp')
      await audioAt(P, up, 0.4, '↑: 15 s on')
      await P.map.keyboard.press('ArrowDown')
      await audioAt(P, up - 15, 0.6, '↓: 15 s back')
      await P.map.keyboard.press('Home')
      await eventually('Home: the start', async () => (await audioOf(P.listen)).t < 0.2)
      await eventually('Home: the intro shows no step', async () => (await shown(P.map)).step === 0)
      await P.map.keyboard.press('PageDown')
      await audioAt(P, ep.chapters[1].start, 0.3, 'Page Down: the next part')
      const vt = await inPage(P.map, 'the slider says the step', () => {
        const v = document.querySelector('[role="slider"][aria-label="Position"]').getAttribute('aria-valuetext')
        return /, Step 1 of/.test(v) && v
      })
      assert.match(vt, /seconds? of .*seconds?, Step 1 of 7/, 'the slider\'s value text has the total and the step')
      const audio = () => audioOf(P.listen)
      await P.map.keyboard.press(' ')
      await eventually('Space plays', async () => !(await audio()).paused)
      await P.map.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', code: 'KeyK', bubbles: true })))
      await eventually('K (Caps Lock: "K") pauses, by the key\'s place', async () => (await audio()).paused)
      await P.map.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'л', code: 'KeyK', bubbles: true })))
      await eventually('K on another layout ("л") plays', async () => !(await audio()).paused)
      await P.map.keyboard.press('KeyM')
      await eventually('M mutes', async () => (await audio()).muted)
      assert.equal(await playerOf(P.map).region.getByRole('button', { name: /^Mute/ }).count(), 0, 'no mute button (M is the key)')
      await P.map.keyboard.press('KeyM')
      await eventually('M again: sound', async () => !(await audio()).muted)
      await P.map.keyboard.press('k')
      await eventually('K pauses', async () => (await audio()).paused)
      await P.map.keyboard.press('>')
      await eventually('> faster', async () => (await audio()).rate === 1.25)
      await P.map.keyboard.press('<')
      await eventually('< slower', async () => (await audio()).rate === 1)
    })

    scenario('the speed button: 1 → 1.25 → 1.5 → 2 → 1, and it says so', o, async (P) => {
      const { rate } = playerOf(P.map)
      if (!(await rate.isVisible())) return // too narrow for it
      for (const r of [1.25, 1.5, 2, 1]) {
        await rate.click()
        await eventually(`${r}×`, async () => (await audioOf(P.listen)).rate === r)
        await playerOf(P.map).region.getByRole('button', { name: `Speed, ${r}×` }).waitFor()
      }
    })

    scenario('Space and K after a beat\'s › clicked with the mouse: the podcast plays and pauses', o, async (P) => {
      const { x, y } = await xAt(P.map, 4, ep.duration)
      await P.map.mouse.click(x, y)
      await eventually('step 1 with its animation', async () => { const s = await shown(P.map); return s.step === 1 && s.anim })
      const before = (await shown(P.map)).beat
      await P.map.click('#app .scn-next')
      await eventually('› went a beat on', async () => (await shown(P.map)).beat === before + 1)
      const beat = (await shown(P.map)).beat
      await P.map.keyboard.press(' ')
      await eventually('Space after ›: plays', async () => !(await audioOf(P.listen)).paused)
      assert.ok((await shown(P.map)).beat >= beat, 'Space did not step the animation back')
      await P.map.keyboard.press('k')
      await paused(P)
    })

    scenario('the caption: the sentence being said, the speaker when the voice changes, a long one in parts', o, async (P) => {
      const captionAt = async (t, want, what) => {
        P.ext.command('seek', { to: t })
        await eventually(what, async () => want.test((await shown(P.map)).cap || ''))
      }
      await captionAt(3.2, /^Ana adds a lamp\.$/, '3.2 s: "Ana adds a lamp."')
      await captionAt(4.8, /^It goes in the cart\.$/, '4.8 s: its second sentence (sentences: from the file)')
      await captionAt(9.5, /^Guest: And then she confirms\?$/, 'the guest speaks: named')
      await captionAt(12.5, /^Host: /, 'the host again: named')
      const live = ep.segments.find((s) => s.text === LONG)
      const seen = new Set()
      for (let t = live.start + 0.05; t < live.end; t += 0.25) {
        P.ext.command('seek', { to: t })
        // Told where the audio is, then the panel drawn with it.
        await eventually(`the host at ${t.toFixed(2)} s`, () => Math.abs(P.st.lastT - t) < 0.06)
        await frames(P.map)
        seen.add((await shown(P.map)).cap)
      }
      const parts = [...seen].filter(Boolean)
      assert.ok(parts.length >= 3, `the long segment is said in parts (${parts.length})`)
      const joined = parts.join(' ').replace(/\s+/g, ' ')
      for (const word of LONG.split(/\s+/)) assert.ok(joined.includes(word), `"${word}" is shown at some time`)
      await shot(P.map, `behaviour-${w}-caption`)
    })

    scenario('the storyline as the chapter list: number and title, the step it skips muted, the row being said', o, async (P) => {
      P.ext.command('seek', { to: timeOf(ep, 3) + 0.3 })
      await inPage(P.map, 'step 3, its row the one being said', () => document.querySelector('.story li.pnow')?.getAttribute('data-pstep') === '3')
      const rows = await P.map.evaluate(() => [...document.querySelectorAll('.story li[data-pstep]')].map((li) => ({ n: Number(li.dataset.pstep), text: li.querySelector('.st').textContent, skip: li.classList.contains('unnarrated'), now: li.classList.contains('pnow'), plisten: [...li.querySelectorAll('.plisten')].some((b) => getComputedStyle(b).visibility !== 'hidden') })))
      assert.equal(rows.length, journey.steps.length, 'a row per step')
      assert.deepEqual(rows.map((r) => r.text), rows.map((r) => `${r.n}${journey.steps[r.n - 1].title}`), 'number and title only')
      assert.ok(rows.find((r) => r.n === DEPLOY)?.skip, 'the step it skips is marked')
      assert.ok(rows.every((r) => !r.plisten), 'no ▶ on a row until the pointer is on it')
      assert.ok(await P.map.evaluate(() => document.querySelectorAll('.trb').length === 0 && document.querySelectorAll('.trtoggle').length === 1), 'one Transcript switch, no ≡ per row')
      assert.equal(rows.find((r) => r.now)?.n, 3, 'the row being said marked')
      assert.ok(await P.map.evaluate(() => !!document.querySelector('.story li[data-ppart="intro"]') && !!document.querySelector('.story li[data-ppart="recap"]')), 'the intro and the recap have rows')
    })

    scenario('▶ on a row plays that step alone, stopping at its end', o, async (P) => {
      const n = 2
      const c = ep.chapters.filter((x) => x.step === n)
      const end = c[c.length - 1].end
      await P.map.hover(`.story li[data-pstep="${n}"] .st`)
      await P.map.click(`.story li[data-pstep="${n}"] .plisten`)
      await eventually(`step ${n} playing from its start`, async () => { const a = await audioOf(P.listen); return !a.paused && a.t >= c[0].start && a.t < c[0].start + 1.5 })
      await eventually(`it stops at the step's end (${end}s)`, async () => { const a = await audioOf(P.listen); return a.paused && Math.abs(a.t - end) < 0.5 }, (end - c[0].start + 3) * 1000)
    })

    scenario('the transcript: the row being said\'s, the sentence being said marked; a sentence clicked goes there', o, async (P) => {
      P.ext.command('seek', { to: timeOf(ep, 3) + 0.3 })
      await eventually('step 3', async () => (await shown(P.map)).step === 3)
      await P.map.click('.trtoggle')
      const s = await inPage(P.map, 'the transcript of step 3', () => { const t = document.querySelector('.trx[data-tr="s3"]'); return t && !t.hidden && t.querySelectorAll('.trs').length })
      assert.ok(s >= 3, `its sentences (${s})`)
      await P.map.click('.trx[data-tr="s3"] .trs:nth-of-type(2)')
      const t2 = await P.map.evaluate(() => Number(document.querySelector('.trx[data-tr="s3"] .trs:nth-of-type(2)').dataset.t))
      await audioAt(P, t2, 0.3, 'the sentence clicked: the audio there')
      await inPage(P.map, 'and marked', () => document.querySelector('.trx[data-tr="s3"] .trs:nth-of-type(2)').classList.contains('cur'))
      assert.ok(await P.map.evaluate(() => document.querySelector('.trx[data-tr="s1"]').getAttribute('hidden') === 'until-found'), 'a shut transcript is still found by Ctrl+F (hidden="until-found")')
      assert.ok(await P.map.evaluate(() => [...document.querySelectorAll('.trs')].every((x) => !x.title)), 'no time tooltip on the sentences')
      await shot(P.map, `behaviour-${w}-transcript`)
      await P.map.click('.trtoggle')
    })

    scenario('a step the podcast skips, clicked: the audio pauses and the panel says so', o, async (P) => {
      await P.map.click(`.story li[data-pstep="${DEPLOY}"] .st`)
      await eventually('the panel says the step isn\'t in the podcast', async () => /isn't in the podcast/.test(await statusLine(P.map)))
      assert.ok((await audioOf(P.listen)).paused, 'paused')
    })

    scenario('a step clicked in the storyline moves the audio to its first part', o, async (P) => {
      await P.map.click('.story .st[data-n="4"]')
      await audioAt(P, timeOf(ep, 4), 0.3, 'step 4 clicked: the audio at its start')
      await eventually('and step 4 shown', async () => (await shown(P.map)).step === 4)
    })

    scenario('playing through a step boundary; the panel\'s player goes and comes back while the audio plays on', o, async (P) => {
      P.ext.command('seek', { to: 14.2 })
      await audioAt(P, 14.2, 0.3, 'at 14.2 s')
      await playerOf(P.map).play.click()
      await eventually('playing across 15 s: step 3, beat 0', async () => { const s = await shown(P.map); return s.step === 3 && s.anim && s.beat === 0 })
      P.ext.toMap({ type: 'podcast' })
      await playerOf(P.map).region.waitFor({ state: 'hidden' })
      const t0 = (await audioOf(P.listen)).t
      await eventually('the audio plays on without the panel\'s player', async () => (await audioOf(P.listen)).t > t0 + 0.4)
      P.ext.toMap({ type: 'podcast', episode: P.ext.episode })
      await playerOf(P.map).region.waitFor()
      await eventually('the panel\'s player is back, playing, at the audio\'s time', async () => { const s = await shown(P.map); const a = await audioOf(P.listen); return s.playing && Math.abs(s.sec - a.t) <= 1.2 }, 3000)
      await playerOf(P.map).play.click()
      await paused(P)
    })

    scenario('the audio moves to the panel and back (the roles swap)', o, async (P) => {
      P.ext.command('play', { at: 5 })
      await eventually('playing in the Listen view', async () => !(await audioOf(P.listen)).paused)
      // Only the panel's audio may play (src/podcast/audioHost.ts): the extension moves it there, playing on.
      P.ext.host.moveTo('panel', P.ext.lj, { at: P.st.lastT, play: true })
      await eventually('the panel plays the audio', async () => { const a = await audioOf(P.map); return !!a.src && !a.paused && a.t > 5 })
      assert.equal((await audioOf(P.listen)).src, '', 'the Listen view\'s audio unloaded')
      await inPage(P.listen, 'the Listen view shows it playing (a remote now)', () => !!document.querySelector('[role="region"][aria-label="Listen"] button[aria-label="Pause"]'))
      // A ▶ in the Listen view now asks the panel.
      await playerOf(P.listen).play.click()
      await eventually('the Listen view\'s ⏸ paused the panel\'s audio', async () => (await audioOf(P.map)).paused)
      const at = (await audioOf(P.map)).t
      // The panel closes: the audio goes back to the Listen view, where it was.
      P.ext.toMap({ type: 'podcast' })
      P.ext.panelCloses()
      await eventually('the Listen view has the audio again, where the panel left it', async () => { const a = await audioOf(P.listen); return a.ready >= 1 && Math.abs(a.t - at) < 0.6 })
      await inPage(P.listen, 'the whole player back in the Listen view', () => !document.body.classList.contains('compact'))
    })
  })
}

// ---------- the edges ----------

describe('edges', () => {
  scenario('the fetch fails: the audio plays from its URL, and a seek reports where the audio is', { width: 900, srcPath: 'nofetch/' }, async (P) => {
    assert.ok(!(await audioOf(P.listen)).blob, 'the fetch failed: its own URL')
    assert.ok(P.st.told.some((m) => /could not be loaded whole/.test(m)), `the extension is told (${JSON.stringify(P.st.told)})`)
    for (const t of [20, 7, 31]) {
      const seeks = P.st.seeks
      const { x, y } = await xAt(P.map, t, ep.duration)
      await P.map.mouse.click(x, y)
      await eventually(`seek to ${t}: said once done`, () => P.st.seeks > seeks, 6000)
      const a = await eventually(`seek to ${t}: the extension is told where the audio is`, async () => { const a = await audioOf(P.listen); return Math.abs(P.st.lastT - a.t) < 0.6 && a })
      await eventually(`seek to ${t}: the walk shows the step where the audio is (${viewAt(ep, a.t).step})`, async () => (await shown(P.map)).step === viewAt(ep, a.t).step)
      if (Math.abs(a.t - t) > 0.75) {
        assert.match(await statusLine(P.map), /Can't go to/, 'a seek that did not get there says so in the panel')
        assert.ok(P.st.told.some((m) => /seek to .* ended at/.test(m)), 'and the extension is told (its log)')
      }
    }
    await shot(P.map, 'streamed')
  })

  scenario('an audio that can\'t be played: ▶ stays paused and says why', { width: 900, srcPath: 'missing/', loaded: false }, async (P) => {
    await eventually('the panel says the audio can\'t play', async () => /Can't play/.test(await statusLine(P.map)), 6000)
    const told = P.st.told.length
    await playerOf(P.map).play.click()
    await eventually('the extension is told the play failed', () => P.st.told.length > told)
    assert.ok((await audioOf(P.listen)).paused, '▶ on an audio that can\'t play: paused')
    assert.ok(!P.st.playing, 'the extension is never told it plays')
    assert.match(await statusLine(P.map), /Can't play/, 'the panel says why')
  })

  // A truncated mp3 whose header still says its full length can't be told apart in the player: the validator's length
  // checks cover that. Here the episode says 80 s and the audio is 40 s.
  scenario('a cut-off audio: the part it can\'t reach greyed, the tip there says so', { width: 700, more: { duration: 80 } }, async (P) => {
    const reach = P.map.getByTitle(/^The audio ends at /)
    await reach.waitFor()
    const r = await reach.boundingBox()
    const track = await playerOf(P.map).slider.boundingBox()
    assert.ok(r.x + r.width <= track.x + track.width + 1 && r.x > track.x + track.width * 0.1, `from where the audio ends to the end: ${JSON.stringify(r)}`)
    const { x, y } = await xAt(P.map, 70, 80)
    await P.map.mouse.move(x, y)
    await playerOf(P.map).tip.getByText('the audio ends before this').waitFor()
    await shot(P.map, 'cut')
  })
})
