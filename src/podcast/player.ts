// Podcast mode: a journey with a podcast file next to it (`<journey>.podcast.json`, docs/podcast-format.md) plays in
// the journey panel (media/journey-podcast.js has the audio and the timeline), and the walk follows the voice: at
// every time the panel reports, the view at that time (model.ts viewAt) is applied the way a reader's own move is
// (walk.goToStep; the animation's beat set in the panel). A seek applies the view at the new time directly: never
// the cues in between, and only the newest of quick seeks (LatestWins). The other way round: the reader moving the
// walk (Next, Back, the map, a beat of the animation) moves the audio to the first part about it.

import * as vscode from 'vscode'
import { gstate, journeys, log, mapPanel, state } from '../app'
import { LoadedJourney, posKey } from '../journeys/steps'
import { readText } from '../jsonFolder'
import { endJourney, openMap } from '../tour/commands'
import { tourState, walk } from '../tour/instances'
import { pickJourney } from '../tour/pick'
import { wfs } from '../workspaceFs'
import { journeysTree } from '../sidebar/journeysTree'
import { clock, Episode, LatestWins, parsePodcast, podcastFileOf, resolveEpisode, sameView, timeOf, View, viewAt } from './model'

/** Workspace state: where each podcast was left (posKey -> seconds); global: the speed. */
const POS_KEY = 'codeNotes.podcastPos'
const RATE_KEY = 'codeNotes.podcastRate'
/** While playing, where it is is stored this often (ms). */
const SAVE_EVERY_MS = 5000
const SKIP_S = 15
/** After the podcast asks for a seek, the panel's reports of the old time are ignored for at most this long (ms). */
const STALE_MS = 1500

/** A journey's podcast, read and checked against the journey. */
interface Loaded { file: vscode.Uri; audio: vscode.Uri; ep: Episode; sig: string }

/** What the panel sends about the audio (MapMessage podcastTime). */
export interface TimeReport { t: number; playing: boolean; rate?: number; seek?: boolean }

class Podcasts {
  /** By journey key. */
  private eps = new Map<string, Loaded>()
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
  /** When the podcast last asked the panel to seek: until the panel says it did, its older reports are stale. */
  private seekSent = 0

  init(context: vscode.ExtensionContext): void {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49.25)
    this.item.command = 'codeNotes.podcastToggle'
    context.subscriptions.push(this.item, journeys.onDidChange(() => void this.scan()))
    mapPanel.podcastFor = (lj, toUri) => this.episodeFor(lj, toUri)
    walk.onMoved = () => this.walkMoved()
  }

  has(lj: LoadedJourney): boolean { return this.eps.has(lj.key) }
  episode(lj: LoadedJourney): Episode | undefined { return this.eps.get(lj.key)?.ep }

  /** Every journey's podcast read again (a journey or podcast file changed); the panel and the list follow. */
  async scan(): Promise<void> {
    const next = new Map<string, Loaded>()
    for (const lj of journeys.all()) {
      const l = await this.read(lj)
      if (l) next.set(lj.key, l)
    }
    const sig = (m: Map<string, Loaded>) => [...m].map(([k, l]) => `${k}=${l.sig}`).join('\n')
    const changed = sig(next) !== sig(this.eps)
    this.eps = next
    if (!changed) return
    mapPanel.sendPodcast()
    journeysTree?.refresh()
  }

  /** The podcast next to `lj`'s file, when there is one and its audio is there. */
  private async read(lj: LoadedJourney): Promise<Loaded | undefined> {
    const file = lj.uri.with({ path: podcastFileOf(lj.uri.path) })
    const raw = await readText(file)
    if (raw === undefined) return undefined
    const p = parsePodcast(raw)
    if (typeof p === 'string') {
      log.warn(`podcast ${file.fsPath}: not played: ${p}`)
      return undefined
    }
    const audio = vscode.Uri.joinPath(file, '..', p.audio)
    let size = 0
    try { size = (await wfs.stat(audio)).size } catch {
      log.warn(`podcast ${file.fsPath}: its audio ${p.audio} isn't there`)
      return undefined
    }
    if (p.journey.id && p.journey.id !== lj.j.id) log.info(`podcast ${file.fsPath}: written for journey "${p.journey.id}", played with "${lj.j.id}" (the file next to it)`)
    const ep = resolveEpisode(p, { steps: lj.j.steps.map((s) => ({ id: s.id, beats: s.scene?.beats?.length ?? 0 })) })
    for (const w of ep.warnings) log.info(`podcast ${file.fsPath}: ${w}`)
    return { file, audio, ep, sig: `${raw.length}:${size}:${JSON.stringify(ep.segments.map((s) => [s.start, s.step, s.beat]))}` }
  }

  /** What the panel's bar gets for `lj` (undefined: no podcast). */
  private episodeFor(lj: LoadedJourney, toUri: (u: vscode.Uri) => string): unknown {
    const l = this.eps.get(lj.key)
    if (!l) return undefined
    const { ep } = l
    return {
      src: toUri(l.audio),
      title: ep.title,
      duration: ep.duration,
      at: this.positions()[posKey(lj)] ?? 0,
      rate: gstate.get<number>(RATE_KEY) ?? 1,
      chapters: ep.chapters,
      segments: ep.segments.map((s) => ({ start: s.start, end: s.end, text: s.text, step: s.step })),
    }
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
      if (lj && !this.has(lj)) vscode.window.setStatusBarMessage(`$(info) ${lj.j.title} has no podcast`, 3000)
      return lj && this.has(lj) ? lj : undefined
    }
    const here = [walk.tourJourney(), mapPanel.journey].find((x) => x && this.has(x))
    if (here) return here
    const all = journeys.all().filter((x) => this.has(x))
    if (all.length <= 1) {
      if (!all.length) vscode.window.setStatusBarMessage('$(info) No journey here has a podcast', 3000)
      return all[0]
    }
    const pick = await vscode.window.showQuickPick(all.map((x) => ({ label: x.j.title, description: clock(this.eps.get(x.key)!.ep.duration), lj: x })), { placeHolder: 'Play a journey podcast' })
    return pick?.lj
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
    item.text = `${this.playing ? '$(debug-pause)' : '$(play)'} ${onWalkItem ? '' : `${where} · `}${clock(this.t)}`
    item.tooltip = `${lj.j.title}: ${this.playing ? 'pause' : 'play'} the podcast (${clock(this.t)} of ${clock(ep.duration)})`
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
    }
  }
}

/** A part on the map (no step) by where it is: the first is the intro, the last the recap. */
function mapPartName(ep: Episode, t: number): string {
  const i = ep.chapters.findIndex((c, k) => t < c.end || k === ep.chapters.length - 1)
  if (i <= 0) return 'Intro'
  return i === ep.chapters.length - 1 ? 'Recap' : 'Map'
}

export const podcasts = new Podcasts()
