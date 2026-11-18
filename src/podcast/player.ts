// Podcast mode: a journey with a podcast file next to it (`<journey>.podcast.json`, docs/podcast-format.md) plays in
// the journey panel (media/journey-podcast.js has the audio and the timeline), and the walk follows the voice: at
// every time the panel reports, the view at that time (model.ts viewAt) is applied the way a reader's own move is
// (walk.goToStep; the animation's beat set in the panel). A seek applies the view at the new time directly: never
// the cues in between, and only the newest of quick seeks (LatestWins). The other way round: the reader moving the
// walk (Next, Back, the map, a beat of the animation) moves the audio to the first part about it.

import * as vscode from 'vscode'
import { gstate, journeys, log, mapPanel, state } from '../app'
import { LoadedJourney, posKey } from '../journeys/steps'
import { endJourney, openMap } from '../tour/commands'
import { tourState, walk } from '../tour/instances'
import { pickJourney } from '../tour/pick'
import { journeysTree } from '../sidebar/journeysTree'
import { clock, Episode, LatestWins, PodcastProblem, sameView, timeOf, View, viewAt } from './model'
import { podcastReports, PodcastRead, readPodcast } from './load'
import { brokenLinks, playNotice } from './validate'

/** Workspace state: where each podcast was left (posKey -> seconds); global: the speed. */
const POS_KEY = 'codeNotes.podcastPos'
const RATE_KEY = 'codeNotes.podcastRate'
/** While playing, where it is is stored this often (ms). */
const SAVE_EVERY_MS = 5000
const SKIP_S = 15
/** After the podcast asks for a seek, the panel's reports of the old time are ignored for at most this long (ms). */
const STALE_MS = 1500

/** A journey's podcast, read and checked against the journey. `notice`: one line about what is wrong with it (the
 *  panel and the row's tooltip say it); `lastGood`: the file has errors now, this is the version read before. */
interface Loaded { file: vscode.Uri; audio: vscode.Uri; audioSize: number; ep: Episode; sig: string; problems: PodcastProblem[]; notice?: string; lastGood?: boolean }
/** A podcast file next to a journey that can't be played, and why (its first error). */
interface Broken { file: vscode.Uri; reason: string }

/** What the panel says over a podcast that plays from its last good version. */
const LAST_GOOD = 'The podcast file has errors: playing the last good version'

/** What the panel sends about the audio (MapMessage podcastTime). */
export interface TimeReport { t: number; playing: boolean; rate?: number; seek?: boolean }

class Podcasts {
  /** By journey key. */
  private eps = new Map<string, Loaded>()
  /** By journey key: podcast files that can't be played. */
  private broken = new Map<string, Broken>()
  /** The audio's real length as the panel loaded it, by its path and size (a rewritten file is measured again). */
  private audioLen = new Map<string, number>()
  /** An audio file the panel failed to play, by path: what to say (it looks cut off or damaged). */
  private audioFault = new Map<string, string>()
  private item: vscode.StatusBarItem | undefined
  /** The journey whose podcast was played in the panel (its audio is there): the walk follows it. */
  private session: string | undefined
  /** The audio as last reported. */
  private t = 0
  private playing = false
  private lastSave = 0
  /** The view the podcast asked for last, and the beat it last set in the panel (undefined: none). */
  private want: View | undefined
  private beatShown: number | undefined
  /** Moves the podcast is making right now (the walk's changes meanwhile are its own). */
  private applying = 0
  private readonly mover = new LatestWins<{ lj: LoadedJourney; view: View; still: boolean }>((m, current) => this.move(m, current))
  /** Errors the panel reported, and how many moves the podcast made (tests read them). */
  lastError = ''
  private moves = 0
  /** "Show why" asked (tests). */
  private whyShown = 0
  /** When the podcast last asked the panel to seek: until the panel says it did, its older reports are stale. */
  private seekSent = 0

  init(context: vscode.ExtensionContext): void {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49.25)
    this.item.command = 'codeNotes.podcastToggle'
    context.subscriptions.push(this.item, journeys.onDidChange(() => void this.scan()))
    podcastReports.init(context, () => void this.scan())
    mapPanel.podcastFor = (lj, toUri) => this.episodeFor(lj, toUri)
    walk.onMoved = () => this.walkMoved()
  }

  has(lj: LoadedJourney): boolean { return this.eps.has(lj.key) }
  episode(lj: LoadedJourney): Episode | undefined { return this.eps.get(lj.key)?.ep }
  /** What the Journeys view says about a journey's podcast: none, playable (with a line about what is wrong with it,
   *  if anything), or unavailable and why. */
  status(lj: LoadedJourney): { state: 'ok' | 'broken'; text?: string } | undefined {
    const l = this.eps.get(lj.key)
    if (l) return { state: 'ok', text: l.notice }
    const b = this.broken.get(lj.key)
    return b && { state: 'broken', text: b.reason }
  }

  /** Every journey's podcast read again (a journey, podcast or audio file changed); the panel, the list and the status
   *  bar follow. A file that has errors now while it played fine before keeps its last good version. */
  async scan(): Promise<void> {
    const next = new Map<string, Loaded>()
    const broken = new Map<string, Broken>()
    const reads: PodcastRead[] = []
    for (const lj of journeys.all()) {
      const r = await readPodcast(lj, (u, size) => this.audioLen.get(`${u.path}:${size}`))
      if (!r) continue
      reads.push(r)
      if (r.v.playable && r.v.episode && r.audio) {
        next.set(lj.key, this.loaded(lj, r))
        continue
      }
      const reason = r.v.problems.find((p) => p.level === 'error')?.message ?? 'it has errors'
      // The file itself broke (half-written, a typo) while it plays and its audio is still there: the last good
      // version plays on (paused or not played, the file is what it is now: unavailable).
      const last = this.eps.get(lj.key)
      const audioGone = r.v.problems.some((p) => p.code === 'audio-missing' || p.code === 'audio-empty' || p.code === 'audio-outside')
      const playingIt = this.session === lj.key && (this.playing || !!last?.lastGood)
      if (last && playingIt && !audioGone && last.file.toString() === r.file.toString()) next.set(lj.key, { ...last, notice: LAST_GOOD, lastGood: true, sig: last.lastGood ? last.sig : `${last.sig}:last-good` })
      else broken.set(lj.key, { file: r.file, reason })
    }
    podcastReports.report(reads)
    const sig = (m: Map<string, Loaded>, b: Map<string, Broken>) => [...m].map(([k, l]) => `${k}=${l.sig}|${l.notice ?? ''}`).concat([...b].map(([k, x]) => `${k}!${x.reason}`)).join('\n')
    const changed = sig(next, broken) !== sig(this.eps, this.broken)
    this.eps = next
    this.broken = broken
    // The podcast played went (deleted, or it can't be played now): the panel's audio stops with it, and the status
    // item goes.
    if (this.session && !next.has(this.session)) {
      this.session = undefined
      this.playing = false
      this.want = undefined
    }
    this.renderItem()
    if (!changed) return
    mapPanel.sendPodcast()
    journeysTree?.refresh()
  }

  /** A podcast that can be played, as the player keeps it. */
  private loaded(lj: LoadedJourney, r: PodcastRead): Loaded {
    const ep = r.v.episode!
    const audio = r.audio!
    const writtenFor = r.v.podcast?.journey.id
    const forTitle = writtenFor && writtenFor !== lj.j.id ? journeys.all().find((x) => x.j.id === writtenFor)?.j.title : undefined
    const fault = this.audioFault.get(`${audio.path}:${r.audioSize}`)
    const notice = fault ?? playNotice(r.v.problems, forTitle)
    return {
      file: r.file, audio, audioSize: r.audioSize, ep, problems: r.v.problems, notice,
      sig: `${r.raw.length}:${r.audioSize}:${JSON.stringify(ep.segments.map((s) => [s.start, s.step, s.beat]))}`,
    }
  }

  /** What the panel's bar gets for `lj` (undefined: no podcast; `unavailable`: one that can't be played, and why). */
  private episodeFor(lj: LoadedJourney, toUri: (u: vscode.Uri) => string): unknown {
    const l = this.eps.get(lj.key)
    if (!l) {
      const b = this.broken.get(lj.key)
      return b && { unavailable: b.reason }
    }
    const { ep } = l
    return {
      src: toUri(l.audio),
      title: ep.title,
      duration: ep.duration,
      at: this.positions()[posKey(lj)] ?? 0,
      rate: gstate.get<number>(RATE_KEY) ?? 1,
      chapters: ep.chapters,
      segments: ep.segments.map((s) => ({ start: s.start, end: s.end, text: s.text, step: s.step })),
      ...(l.notice ? { notice: l.notice } : {}),
    }
  }

  /** The panel loaded the audio: its real length. Checked against the file (a cut-off audio, a wrong "duration"). */
  onAudioMeta(lj: LoadedJourney, duration: number): void {
    const l = this.eps.get(lj.key)
    if (!l || !(duration > 0) || !Number.isFinite(duration)) return
    const key = `${l.audio.path}:${l.audioSize}`
    if (this.audioLen.get(key) === duration) return
    this.audioLen.set(key, duration)
    void this.scan()
  }

  /** "Show why" in the panel (or on a podcast that can't be played): the Problems view, on the podcast file. */
  async showWhy(lj?: LoadedJourney): Promise<void> {
    this.whyShown++
    const j = lj ?? mapPanel.journey
    const file = j && (this.eps.get(j.key)?.file ?? this.broken.get(j.key)?.file)
    await vscode.commands.executeCommand('workbench.actions.view.problems')
    if (file && !podcastReports.of(file).length) log.show(true)
  }

  private positions(): Record<string, number> { return state.get<Record<string, number>>(POS_KEY) ?? {} }
  private savePos(lj: LoadedJourney, t: number): void {
    this.lastSave = Date.now()
    void state.update(POS_KEY, { ...this.positions(), [posKey(lj)]: Math.round(t * 10) / 10 })
  }

  // ---------- audio → journey ----------

  /** The panel says where the audio is. Playing (or seeking), the walk goes where the podcast is at that time. */
  onTime(lj: LoadedJourney, m: TimeReport): void {
    const l = this.eps.get(lj.key)
    if (!l) return
    const wasPlaying = this.playing
    this.t = m.t
    this.playing = m.playing
    if (m.rate && m.rate !== gstate.get<number>(RATE_KEY)) void gstate.update(RATE_KEY, m.rate)
    if (m.playing) this.session = lj.key
    if (this.session !== lj.key) return
    // A report from before the seek just asked for (the walk would go back there for a moment): only the time.
    if (m.seek) this.seekSent = 0
    else if (this.seekSent && Date.now() - this.seekSent < STALE_MS) { this.renderItem(); return }
    if ((wasPlaying && !m.playing) || m.seek || Date.now() - this.lastSave > SAVE_EVERY_MS) this.savePos(lj, m.t)
    this.renderItem()
    // Paused and not moved: the walk is the reader's.
    if (!m.playing && !m.seek) return
    const v = viewAt(l.ep, m.t)
    const view: View = v.beat === undefined ? { step: v.step } : { step: v.step, beat: v.beat }
    if (sameView(view, this.want) && (this.mover.busy || this.shows(lj, view))) return
    this.want = view
    this.mover.push({ lj, view, still: !!m.seek })
  }

  /** The walk shows `v` now. */
  private shows(lj: LoadedJourney, v: View): boolean {
    const onIt = walk.touring() && tourState.key === lj.key
    if (!v.step) return !onIt
    return onIt && tourState.step === v.step && this.beatShown === v.beat
  }

  /** Puts the walk where the podcast is: the beat set first (the step then opens on it), then the step opened. */
  private async move(m: { lj: LoadedJourney; view: View; still: boolean }, current: () => boolean): Promise<void> {
    const { lj, view } = m
    this.moves++
    this.applying++
    try {
      if (!view.step) {
        this.beatShown = undefined
        mapPanel.send({ type: 'podcastBeat', n: 0, i: -1 })
        if (walk.touring() && tourState.key === lj.key) await endJourney()
        return
      }
      this.beatShown = view.beat
      mapPanel.send({ type: 'podcastBeat', n: view.step, i: view.beat ?? -1, ...(m.still ? { still: true } : {}) })
      if (!(walk.touring() && tourState.isAt(lj, view.step))) await walk.goToStep(lj, view.step, { focus: false })
    } catch (e) {
      log.error(`podcast: ${e}`)
    } finally {
      this.applying--
    }
    // A move of the reader's that came in meanwhile (ignored then): the audio goes there now.
    if (current()) this.walkMoved(true)
  }

  // ---------- journey → audio ----------

  /** The walk moved (walk.updateTour). The reader's own move (not the podcast's): the audio goes to the first part
   *  about the step; a step it never talks about, or the walk ended, pauses it. */
  private walkMoved(afterMove = false): void {
    const lj = this.sessionJourney()
    if (!lj || this.applying || (this.mover.busy && !afterMove)) return
    const l = this.eps.get(lj.key)!
    const step = walk.touring() && tourState.key === lj.key ? tourState.step : 0
    if (step === (this.want?.step ?? -1)) return
    if (!step || tourState.key !== lj.key) {
      // Another journey, or the walk ended: the podcast stops; its place is kept.
      this.want = { step: 0 }
      if (tourState.key !== lj.key) this.session = undefined
      this.command('pause')
      this.renderItem()
      return
    }
    const t = timeOf(l.ep, step)
    if (t === undefined) {
      this.want = { step }
      this.command('pause')
      vscode.window.setStatusBarMessage(`$(info) The podcast doesn't cover step ${step}`, 3000)
      return
    }
    const v = viewAt(l.ep, t)
    this.want = v.beat === undefined ? { step: v.step } : { step: v.step, beat: v.beat }
    this.command('seek', { to: t })
  }

  /** A beat of the animation shown (the panel's `beat`). The reader's own (‹ › in the animation): the audio goes to
   *  the first part about that beat, when there is one. */
  onBeat(lj: LoadedJourney, n: number, i: number): void {
    if (this.session !== lj.key || this.applying || this.mover.busy || i < 0 || n !== tourState.step || tourState.key !== lj.key) return
    if (i === this.beatShown) return
    this.beatShown = i
    const t = timeOf(this.eps.get(lj.key)!.ep, n, i)
    if (t === undefined) return
    this.want = { step: n, beat: i }
    this.command('seek', { to: t })
  }

  /** The panel closed: its audio is gone. */
  onClosed(): void {
    const lj = this.sessionJourney()
    if (lj) this.savePos(lj, this.t)
    this.session = undefined
    this.playing = false
    this.want = undefined
    this.renderItem()
  }

  onError(message: string): void {
    this.lastError = message
    // Not started by a click or a key in the panel (VS Code's webviews need one, once): the panel takes the keyboard,
    // its ▶ focused, so Space starts it.
    if (message === 'NotAllowedError') {
      mapPanel.takeFocus()
      return
    }
    // A play() cut short by a pause or another source: what the reader asked for, not a failure.
    if (message === 'AbortError') {
      log.debug('podcast: a play was interrupted (paused, or another audio loaded)')
      return
    }
    const lj = mapPanel.journey
    const l = lj && this.eps.get(lj.key)
    if (l && /^audio error/.test(message)) {
      // The media pipeline's own words ("PIPELINE_ERROR_READ: FFmpegDemuxer …") mean nothing to an author: the file
      // and what it most likely is.
      const name = vscode.workspace.asRelativePath(l.audio, false)
      const text = `The audio ${name} (${kb(l.audioSize)}) can't be played at ${clock(this.t)}: the file looks cut off or damaged`
      log.warn(`podcast ${l.file.fsPath}: ${text} (${message})`)
      const key = `${l.audio.path}:${l.audioSize}`
      if (this.audioFault.get(key) !== text) {
        this.audioFault.set(key, text)
        this.eps.set(lj.key, { ...l, notice: text })
        mapPanel.sendPodcast()
        journeysTree?.refresh()
      }
      return
    }
    log.warn(`podcast: ${message}`)
  }

  private sessionJourney(): LoadedJourney | undefined {
    const lj = this.session ? journeys.list.get(this.session) : undefined
    return lj && this.eps.has(lj.key) ? lj : undefined
  }

  // ---------- commands ----------

  private command(action: string, more: Record<string, unknown> = {}): void {
    if (action === 'seek') this.seekSent = Date.now()
    mapPanel.send({ type: 'podcastCmd', action, ...more })
  }

  /** Play Journey Podcast: the journey (a row, a key; else the one walked or on the map; else picked) in the panel, playing. */
  async play(arg?: unknown): Promise<void> {
    const lj = await this.journeyFor(arg)
    if (!lj) return
    if (mapPanel.journey?.key !== lj.key) await openMap(lj)
    else if (!mapPanel.visible) walk.showMap(lj, true)
    this.session = lj.key
    this.want = undefined
    this.command('play')
  }

  private async journeyFor(arg?: unknown): Promise<LoadedJourney | undefined> {
    if (arg !== undefined) {
      const lj = await pickJourney(arg)
      if (lj && !this.has(lj)) this.cantPlay(lj)
      return lj && this.has(lj) ? lj : undefined
    }
    const here = [walk.tourJourney(), mapPanel.journey].find((x) => x && this.has(x))
    if (here) return here
    // The journey here has a podcast that can't be played: why, not another journey's.
    const broken = [walk.tourJourney(), mapPanel.journey].find((x) => x && this.broken.has(x.key))
    if (broken) { this.cantPlay(broken); return undefined }
    const all = journeys.all().filter((x) => this.has(x))
    if (all.length <= 1) {
      if (!all.length) vscode.window.setStatusBarMessage('$(info) No journey here has a podcast', 3000)
      return all[0]
    }
    const pick = await vscode.window.showQuickPick(all.map((x) => ({ label: x.j.title, description: clock(this.eps.get(x.key)!.ep.duration), lj: x })), { placeHolder: 'Play a journey podcast' })
    return pick?.lj
  }

  /** Asked to play a journey whose podcast can't be (or that has none): says why, with the way to the details. */
  private cantPlay(lj: LoadedJourney): void {
    const b = this.broken.get(lj.key)
    if (!b) { vscode.window.setStatusBarMessage(`$(info) ${lj.j.title} has no podcast`, 3000); return }
    void vscode.window.showWarningMessage(`The podcast of “${lj.j.title}” can't be played: ${b.reason}`, 'Show Why').then((a) => { if (a) void this.showWhy(lj) })
  }

  /** Space for the podcast: pause, or play (the session's journey; else as Play). */
  async toggle(): Promise<void> {
    if (this.sessionJourney() && mapPanel.journey?.key === this.session) {
      this.command(this.playing ? 'pause' : 'play')
      return
    }
    await this.play()
  }

  skip(by: number): void {
    if (!this.sessionJourney()) {
      vscode.window.setStatusBarMessage('$(info) No podcast playing', 2000)
      return
    }
    this.command('skip', { by })
  }
  back(): void { this.skip(-SKIP_S) }
  forward(): void { this.skip(SKIP_S) }

  // ---------- the status bar ----------

  /** While a podcast is in the panel: ⏸ (playing) or ▶ and the time; on the map, Intro or Recap (on a step, the walk's
   *  own item beside it says which). Click: pause / play. */
  private renderItem(): void {
    const item = this.item
    if (!item) return
    const lj = this.sessionJourney()
    if (!lj) { item.hide(); return }
    const ep = this.eps.get(lj.key)!.ep
    const v = viewAt(ep, this.t)
    const where = v.step ? `${v.step}/${lj.j.steps.length}` : mapPartName(ep, this.t)
    const onWalkItem = !!v.step && walk.touring() && tourState.key === lj.key
    const l = this.eps.get(lj.key)!
    item.text = `${this.playing ? '$(debug-pause)' : '$(play)'} ${onWalkItem ? '' : `${where} · `}${clock(this.t)}${l.lastGood ? ' $(warning)' : ''}`
    item.tooltip = `${lj.j.title}: ${this.playing ? 'pause' : 'play'} the podcast (${clock(this.t)} of ${clock(ep.duration)})${l.notice ? `\n${l.notice}` : ''}`
    item.accessibilityInformation = { label: `Podcast ${this.playing ? 'playing' : 'paused'}, ${v.step ? `step ${v.step}` : where}, ${clock(this.t)}. ${this.playing ? 'Pause' : 'Play'}.` }
    item.show()
  }

  /** For tests. */
  snapshot() {
    const lj = this.sessionJourney()
    return {
      journeys: journeys.all().filter((x) => this.has(x)).map((x) => x.j.id),
      session: lj?.j.id, t: this.t, playing: this.playing, want: this.want, beatShown: this.beatShown, applying: this.applying,
      item: this.item?.text, itemShown: !!lj, error: this.lastError, moves: this.moves, mapVisible: mapPanel.visible,
      why: this.whyShown,
      broken: Object.fromEntries([...this.broken].map(([k, b]) => [journeys.list.get(k)?.j.id ?? k, b.reason])),
      notices: Object.fromEntries([...this.eps].filter(([, l]) => l.notice).map(([k, l]) => [journeys.list.get(k)?.j.id ?? k, l.notice])),
      links: Object.fromEntries([...this.eps].map(([k, l]) => [journeys.list.get(k)?.j.id ?? k, brokenLinks(l.problems)])),
    }
  }
}

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`)

/** A part on the map (no step) by where it is: the first is the intro, the last the recap. */
function mapPartName(ep: Episode, t: number): string {
  const i = ep.chapters.findIndex((c, k) => t < c.end || k === ep.chapters.length - 1)
  if (i <= 0) return 'Intro'
  return i === ep.chapters.length - 1 ? 'Recap' : 'Map'
}

export const podcasts = new Podcasts()
