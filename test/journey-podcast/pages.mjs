// The two pages with a player and the extension between them, for shoot.mjs.
//
// The Listen view is the page src/podcast/listenView.ts makes (its HTML, written to out/test/journey-podcast/), and
// the messages between the pages go through the extension's real relay: src/podcast/audioHost.ts (which page plays,
// what goes where), the Listen view and its webview channel, compiled to out/ and run on a fake VS Code
// (fakeVscode.ts). What src/podcast/player.ts decides needs the whole extension (the walk, the store), so a small
// stand-in here does that part, on the extension's own model (viewAt, timeOf): the walk follows the host's time, a
// remote's ask becomes the host's command, a step walked to moves the audio.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const out = (f) => {
  const p = path.join(ROOT, 'out', f)
  if (!fs.existsSync(p)) { console.error(`out/${f} is missing: run \`npm run build\` first`); process.exit(2) }
  return p
}
// The fake VS Code first: the relay's modules require 'vscode'.
const { vscode, fakeWebviewView } = require(out('test/journey-podcast/fakeVscode.js'))
const { AudioHost } = require(out('src/podcast/audioHost.js'))
export const model = require(out('src/core/format/podcast/model.js'))
out('pages/listen.js')
out('pages/map.js')

const MAP = pathToFileURL(path.join(ROOT, 'test/journey-map/harness.html')).href
const THEMES = path.join(ROOT, 'test/harness/themes.js')
/** The Listen view's page as the view makes it (a new nonce each time). */
const LISTEN_HTML = path.join(ROOT, 'out/test/journey-podcast/listen.html')
/** The theme variables the Listen view's page leaves unset (as the panel's harness page does). */
const UNSET = ['editor-foreground', 'editorWidget-background', 'testing-iconPassed', 'toolbar-hoverBackground', 'input-background', 'input-foreground', 'input-border', 'input-placeholderForeground']

/** Chromium from Playwright (PLAYWRIGHT, CHROME: as test/harness/page.mjs), letting audio play without a click (VS
 *  Code's own rule about clicks is the relay's business: audioHost.ts) and silent. */
export async function launch() {
  const pw = await import(process.env.PLAYWRIGHT ? pathToFileURL(path.resolve(process.env.PLAYWRIGHT)).href : 'playwright')
  const chromium = pw.chromium ?? pw.default.chromium
  return chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] })
}

/** The pages' "now": a tour message as the extension sends it (src/protocol/map.ts). */
export const tour = (current) => ({ current, marks: {}, resume: 0, legendHidden: true, problems: [], key: "Ctrl+'", tutorial: false, list: [] })

/**
 * The extension's part. `fixture`: the journey, the model's episode (`ep`) and the episode as the pages get it.
 * `st` keeps what happened: the views the walk was put on (`applied`), the host's reports (`times`, `seeks`,
 * `lastT`, `playing`), the speeds they said (`rates`), its log lines (`told`), the end's buttons (`ends`), the remotes' asks (`asks`).
 */
export class Extension {
  constructor(fixture, episode, toListen, toMap) {
    this.fixture = fixture
    this.episode = episode
    this.toMap = toMap
    this.st = { cur: 0, want: undefined, applied: [], seeks: 0, times: 0, lastT: 0, playing: false, told: [], ends: [], asks: [], rates: [] }
    this.lj = { key: episode.key, j: { id: episode.key, title: episode.journey } }
    /** The journey the panel shows (undefined: closed). */
    this.panelJourney = undefined
    this.log = { info: () => {}, warn: (m) => this.st.told.push(`warn: ${m}`), error: (m) => this.st.told.push(`error: ${m}`), debug: () => {} }
    const ports = {
      journeys: () => ({ list: new Map([[this.lj.key, this.lj]]) }),
      mapPanel: () => ({ journey: this.panelJourney, send: (m) => this.toMap(m) }),
      tour: () => ({ showMap: () => {} }),
    }
    this.host = new AudioHost(vscode.Uri.file(ROOT), () => this.log, ports, this.client())
    this.listenView = fakeWebviewView(toListen, `file: http://127.0.0.1:*`)
    this.host.listen.resolveWebviewView(this.listenView.view)
  }

  /** The page the Listen view made. */
  get listenHtml() { return this.listenView.view.webview.html }

  /** What src/podcast/player.ts does with the relay's calls (AudioHostClient), simplified. */
  client() {
    const st = this.st
    return {
      episodeFor: () => this.episode,
      posOf: () => 0,
      nowOf: () => st.lastT,
      listening: () => (this.host.key ? this.lj : undefined),
      playing: () => st.playing,
      time: (_lj, m) => { st.rates.push(m.rate); this.followTime(m) },
      state: (m) => { st.rates.push(m.rate); this.host.relayState(m) },
      error: (_lj, message) => { st.told.push(message) },
      meta: () => {},
      ask: async (_lj, m) => this.ask(m),
      why: async () => {},
      open: async () => {},
      end: async (_lj, action) => { st.ends.push(action) },
      lost: () => {},
      moved: () => {},
    }
  }

  /** The walk follows the host's time while it plays, and after a seek. */
  followTime(m) {
    const st = this.st
    st.times++
    st.lastT = m.t
    st.playing = m.playing
    if (m.seek) st.seeks++
    if (!m.playing && !m.seek) return
    const v = this.fixture.model.viewAt(this.fixture.ep, m.t)
    const view = v.beat === undefined ? { step: v.step } : { step: v.step, beat: v.beat }
    if (st.want && st.want.step === view.step && st.want.beat === view.beat) return
    this.walkTo(view, !!m.seek)
  }
  walkTo(v, still) {
    const st = this.st
    st.want = v
    st.applied.push(v)
    this.toMap({ type: 'podcastBeat', n: v.step, i: v.beat ?? -1, ...(still ? { still: true } : {}) })
    if (st.cur !== v.step) { st.cur = v.step; this.toMap({ type: 'tour', ...tour(v.step) }) }
  }

  /** A remote's ask: the host's command (player.ts onAsk, with the episode loaded in the host). */
  ask(m) {
    this.st.asks.push(m)
    const { action } = m
    if (action === 'play' || action === 'toggle') {
      this.command(action, { ...(typeof m.at === 'number' ? { at: m.at } : {}), ...(typeof m.until === 'number' ? { until: m.until } : {}) })
      return
    }
    const more = {}
    for (const k of ['to', 'by', 'dir', 'rate', 'muted']) if (m[k] !== undefined) more[k] = m[k]
    if (action === 'seek') more.reader = true
    this.command(action, more)
  }
  /** The extension's command to the audio's host. */
  command(action, more = {}) { this.host.send({ type: 'podcastCmd', action, ...more }) }

  /** What the panel's page posts (src/journeys/panel/features/podcast.ts routes the podcast's). */
  fromMap(m) {
    const st = this.st
    if (m.type === 'podcastAsk') this.ask(m)
    else if (m.type === 'podcastEnd') st.ends.push(m.action)
    else if (m.type === 'step') this.walkToStep(m.n)
    else if (m.type.startsWith('podcast')) this.host.fromPanel(m)
  }
  /** The reader walks to step `n`: the walk goes there, the audio to its first part (a step it skips: paused). */
  walkToStep(n) {
    const { model, ep } = this.fixture
    this.st.cur = n
    this.toMap({ type: 'tour', ...tour(n) })
    const t = model.timeOf(ep, n)
    if (t !== undefined) { this.st.want = model.viewAt(ep, t); this.command('seek', { to: t }) }
    else { this.st.want = { step: n }; this.command('pause', { note: `Step ${n} isn't in the podcast` }) }
  }

  /** The panel shows the journey (it is the Listen view's business: it goes to one line). */
  panelOpens() {
    this.panelJourney = this.lj
    this.host.panelShows(this.lj)
  }
  /** The panel closes. */
  panelCloses() {
    this.panelJourney = undefined
    this.host.panelClosed()
  }
}

/**
 * The Listen view's page and the journey panel's harness page, `width` wide (the Listen view `listenW`), in `theme`,
 * with the extension between them and the episode loaded in the Listen view. `panel`: the panel shows the journey
 * (else it is closed: the Listen view shows the whole player); `more`: the episode's fields changed.
 */
export async function openPages(browser, fixture, { width, theme, listenW = 300, src, more = {}, panel = true }) {
  const context = await browser.newContext({ viewport: { width, height: 760 }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
  const listen = await context.newPage()
  await listen.setViewportSize({ width: listenW, height: 360 })
  const map = await context.newPage()
  const errors = []
  for (const [name, pg] of [['listen', listen], ['panel', map]]) {
    pg.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${name} ${m.type()}: ${m.text()}`) })
    pg.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`))
  }
  const post = (pg) => (m) => { pg.evaluate((x) => window.postMessage(x, '*'), m).catch(() => { /* the page closed */ }) }
  const episode = { ...fixture.episode, src, ...more }
  const ext = new Extension(fixture, episode, post(listen), post(map))
  fs.mkdirSync(path.dirname(LISTEN_HTML), { recursive: true })
  fs.writeFileSync(LISTEN_HTML, ext.listenHtml)
  // What each page posts goes to the extension (themes.js's stub hands it to __harness.onPost).
  await listen.exposeFunction('__onPost', (m) => ext.listenView.fromPage(m))
  await map.exposeFunction('__onPost', (m) => ext.fromMap(m))
  for (const pg of [listen, map]) await pg.addInitScript(() => { window.__harness = Object.assign(window.__harness || {}, { onPost: (m) => window.__onPost(m) }) })
  await listen.addInitScript({ path: THEMES })
  await listen.addInitScript((unset) => {
    window.__harness.stubVsCodeApi({ keepState: true })
    document.addEventListener('DOMContentLoaded', () => {
      window.__harness.applyTheme({}, { without: unset })
      document.body.className = `vscode-${window.__harness.themeName()}`
    })
  }, UNSET)
  await listen.goto(`${pathToFileURL(LISTEN_HTML).href}?theme=${theme}`)
  await map.goto(`${MAP}?theme=${theme}`)
  for (const pg of [listen, map]) await pg.waitForFunction(() => window.__harness.posted.some((m) => m.type === 'ready'))
  ext.toMap({ type: 'journey', journey: fixture.journey, ...tour(0) })
  ext.toMap({ type: 'podcast', episode })
  if (panel) ext.panelOpens()
  if (!(await ext.host.load(ext.lj, { at: 0 }))) throw new Error('the Listen view did not take the episode')
  await playerOf(map).region.waitFor()
  return {
    context, listen, map, ext, st: ext.st, errors,
    async close() { await context.close() },
    /** The pages' errors since they opened. */
    async pageErrors() {
      const all = [...errors]
      for (const pg of [listen, map]) for (const e of await pg.evaluate(() => window.__harness.errors.map((x) => x.message))) all.push(`page: ${e}`)
      return all
    },
  }
}

// ---------- reading what a person sees ----------

/** The player of a page, by its roles and labels (media/podcast/dom.js). */
export function playerOf(pg) {
  const region = pg.getByRole('region', { name: 'Listen' })
  return {
    region,
    /** ▶ / ⏸ (its tooltip names the key: "Play (Space)"). */
    play: region.getByTitle(/ \(Space\)$/),
    prev: region.getByRole('button', { name: 'Previous step' }),
    next: region.getByRole('button', { name: 'Next step' }),
    rate: region.getByRole('button', { name: /^Speed/ }),
    slider: region.getByRole('slider', { name: 'Position' }),
    status: region.getByRole('status'),
    marks: region.getByRole('button', { name: /^Go to / }),
    caption: region.getByTestId('caption'),
    tip: region.getByTestId('tip'),
    end: region.getByTestId('end'),
  }
}

/** The journey panel's own names (media/journey-map.js and journey-scene.js own them; no role says these). */
export const PANEL = {
  currentRow: '.story .st.cur',
  /** Playing, the header is one line: "Step 3 of 7 · …", "Intro". */
  listeningTitle: 'header.listening h1.q',
  /** The step's animation and its beat counter ("2 / 4"). */
  animation: '#app .scnwrap',
  beatCounter: '#app .scnwrap .scn-pos',
  story: '.story',
  /** Playing, the step's animation or the map alone in one box. */
  playingAnimation: '.pbox .scnwrap',
  playingMap: '.pbox .gmap',
  storyTimes: '.story .pt',
  storyTitles: '.story .st .t',
  listeningHeader: 'header.listening',
}

/** What the panel shows: the step (its storyline row, or while playing the header's "Step n of"), the animation's
 *  beat, and the player's second (the slider's value), caption and whether it plays (▶'s name is "Pause"). */
export function shown(map) {
  return map.evaluate((P) => {
    const region = document.querySelector('[role="region"][aria-label="Listen"]')
    const cur = document.querySelector(P.currentRow)
    const head = /^Step (\d+) of/.exec(document.querySelector(P.listeningTitle)?.textContent || '')
    const pos = document.querySelector(P.beatCounter)
    const play = region?.querySelector('button[aria-label="Play"], button[aria-label="Pause"], button[aria-label="Replay"]')
    return {
      step: cur ? Number(cur.dataset.n) : head ? Number(head[1]) : 0,
      beat: pos ? Number(pos.textContent.trim().split(' / ')[0]) - 1 : undefined,
      anim: !!document.querySelector(P.animation),
      sec: Number(region?.querySelector('[role="slider"]')?.getAttribute('aria-valuenow') ?? -1),
      cap: region?.querySelector('[data-testid="caption"]')?.textContent,
      playing: play?.getAttribute('aria-label') === 'Pause',
    }
  }, PANEL)
}

/** The Listen view's audio element, as the browser has it. */
export function audioOf(pg) {
  return pg.evaluate(() => {
    const a = document.querySelector('audio')
    return { t: a.currentTime, paused: a.paused, ready: a.readyState, dur: a.duration, err: a.error && a.error.code, src: a.getAttribute('src') || '', blob: a.src.startsWith('blob:'), muted: a.muted, rate: a.playbackRate }
  })
}

/** The error or note line under the controls ('' : none). */
export function statusLine(pg) {
  return pg.evaluate(() => { const e = document.querySelector('[role="region"][aria-label="Listen"] [role="status"]'); return !e || e.hidden ? '' : e.textContent })
}

/** The timeline's x for second `t` (page px), at its middle. */
export async function xAt(pg, t, duration) {
  const b = await playerOf(pg).slider.boundingBox()
  return { x: b.x + (t / duration) * b.width, y: b.y + b.height / 2 }
}

// ---------- waiting ----------

/** Waits until `f()` (in Node) is true; fails with `what` after `ms`. */
export async function eventually(what, f, ms = 4000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await f()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 40))
  }
}

/** Waits until `f(arg)` is true in page `pg`; fails with `what`. */
export async function inPage(pg, what, f, arg, ms = 4000) {
  try {
    return await (await pg.waitForFunction(f, arg, { timeout: ms })).jsonValue()
  } catch (e) {
    throw new Error(`timed out: ${what} (${e instanceof Error ? e.message.split('\n')[0] : e})`, { cause: e })
  }
}
