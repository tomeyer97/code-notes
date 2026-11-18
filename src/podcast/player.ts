// Listening: a journey with a podcast file next to it (`<journey>.podcast.json`, docs/podcast-format.md) plays in the
// Listen view (listenView.ts: the audio lives there, so it outlives the journey panel; media/journey-podcast.js), the
// panel's player is a remote of it (its asks come here and go on to the view; the view's state goes back to it), and
// the status item is one too (click: the journey's map). The walk follows the voice: at
// every time the panel reports, the view at that time (model.ts viewAt) is applied the way a reader's own move is
// (walk.goToStep; the animation's beat set in the panel). A seek applies the view at the new time directly: never
// the cues in between, and only the newest of quick seeks (LatestWins). The other way round: the reader moving the
// walk (Next, Back, the map, a beat of the animation) moves the audio to the first part about it; a step the podcast
// skips pauses it, and ▶ then goes on after that step (resume.ts). Where each journey's podcast is is kept (in memory
// and in the workspace state) from every time the panel reports, so another journey, the walk ending, the panel
// closing or the podcast file being rewritten never loses it.

import * as vscode from 'vscode'
import { gstate, journeys, log, mapPanel, state } from '../app'
import { LoadedJourney, posKey } from '../journeys/steps'
import { closeWalkTabs, endJourney, openMap } from '../tour/commands'
import { tourState, walk } from '../tour/instances'
import { pickJourney } from '../tour/pick'
import { journeysTree } from '../sidebar/journeysTree'
import { clock, Episode, LatestWins, PodcastProblem, sameView, timeOf, View, viewAt } from './model'
import { podcastReports, PodcastRead, readPodcast } from './load'
import { afterStep, remapTime, resumeTime } from './resume'
import { brokenLinks, playNotice } from './validate'
import { ListenMessage, ListenView } from './listenView'
import { KEY, setCtx } from '../app'

/** Workspace state: where each podcast was left (posKey -> seconds); global: the speed. */
const POS_KEY = 'codeNotes.podcastPos'
const RATE_KEY = 'codeNotes.podcastRate'
const MUTE_KEY = 'codeNotes.podcastMuted'
/** While playing, where it is is stored this often (ms). */
const SAVE_EVERY_MS = 5000
const SKIP_S = 15
/** After the podcast asks for a seek or a pause, the panel's reports from before it are ignored for at most this long (ms). */
const STALE_MS = 1500

/** A journey's podcast, read and checked against the journey. `notice`: one line about what is wrong with it (the
 *  panel and the row's tooltip say it); `lastGood`: the file has errors now, this is the version read before. */
interface Loaded { file: vscode.Uri; audio: vscode.Uri; audioSize: number; ep: Episode; sig: string; problems: PodcastProblem[]; notice?: string; lastGood?: boolean }
/** A podcast file next to a journey that can't be played, and why (its first error). */
interface Broken { file: vscode.Uri; reason: string }

/** What the panel says over a podcast that plays from its last good version. */
const LAST_GOOD = 'The podcast file has errors: playing the last good version'

/** What the panel sends about the audio (MapMessage podcastTime): `of`, the journey (key) whose audio it is. */
export interface TimeReport { t: number; playing: boolean; rate?: number; seek?: boolean; of?: string }
/** What the audio's player shows (journey-podcast.js S()), as the Listen view says it; relayed to the panel's remote. */
export interface HostState { of: string; t: number; playing: boolean; rate?: number; muted?: boolean; ready?: boolean; ended?: boolean; dur?: number; reach?: number; err?: string; note?: boolean; seek?: boolean }
/** What the panel's player (a remote) asks of the audio. */
export interface AskMessage { of?: string; action: string; at?: number; until?: number; to?: number; by?: number; dir?: number; rate?: number; muted?: boolean }

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
  /** Where each journey's podcast is (key -> seconds), as the panel last said (or as stored, until it says). */
  private pos = new Map<string, number>()
  /** The session's audio is playing, as last reported. */
  private playing = false
  private lastSave = 0
  /** Journeys whose podcast was playing when its file stopped being playable: it plays on once it is back. */
  private playOnReturn = new Set<string>()
  /** The view the podcast asked for last, and the beat it last set in the panel (undefined: none). */
  private want: View | undefined
  private beatShown: number | undefined
  /** Moves the podcast is making right now (the walk's changes meanwhile are its own). */
  private applying = 0
  private readonly mover = new LatestWins<{ lj: LoadedJourney; view: View; still: boolean }>((m, current) => this.move(m, current))
  /** Errors the panel reported, and how many moves the podcast made (tests read them). */
  lastError = ''
  private moves = 0
  /** What the podcast last asked the panel for, and when: until the panel says it did (a seek report; a report not
   *  playing), its older reports are stale. */
  private asked: { kind: 'seek' | 'pause'; at: number } | undefined
  /** "Show why" asked (tests). */
  private whyShown = 0
  /** The Listen view, where the audio plays; the journey whose episode it has loaded, and its last state. */
  listen!: ListenView
  private hostKey: string | undefined
  private hostState: HostState | undefined

  init(context: vscode.ExtensionContext): void {
    this.item = vscode.window.createStatusBarItem('codeNotes.listen', vscode.StatusBarAlignment.Left, 49.25)
    this.item.name = 'Listen'
    this.item.command = 'codeNotes.podcastOpen'
    this.listen = new ListenView(context.extensionUri, log, (m) => this.onHost(m))
    this.listen.onGone = () => this.hostGone()
    context.subscriptions.push(this.item, this.listen, this.listen.register(), journeys.onDidChange(() => void this.scan()))
    podcastReports.init(context, () => void this.scan())
    mapPanel.podcastFor = (lj, toUri) => this.episodeFor(lj, toUri)
    mapPanel.podcastStateFor = (lj) => this.stateFor(lj)
    walk.onMoved = () => this.walkMoved()
  }

  has(lj: LoadedJourney): boolean { return this.eps.has(lj.key) }
  episode(lj: LoadedJourney): Episode | undefined { return this.eps.get(lj.key)?.ep }
  /** What the Journeys view says about a journey's podcast: none, playable (with a line about what is wrong with it,
   *  if anything), or unavailable and why. */
  status(lj: LoadedJourney): { state: 'ok' | 'broken'; text?: string; duration?: number; session?: boolean; playing?: boolean; t?: number } | undefined {
    const l = this.eps.get(lj.key)
    if (l) {
      const session = this.session === lj.key && !!this.sessionJourney()
      return { state: 'ok', text: l.notice, duration: l.ep.duration, session, playing: session && this.playing, t: this.pos.has(lj.key) || this.positions()[posKey(lj)] ? this.posOf(lj) : undefined }
    }
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
    void setCtx('codeNotes.hasPodcasts', reads.length > 0)
    const sig = (m: Map<string, Loaded>, b: Map<string, Broken>) => [...m].map(([k, l]) => `${k}=${l.sig}|${l.notice ?? ''}`).concat([...b].map(([k, x]) => `${k}!${x.reason}`)).join('\n')
    const changed = sig(next, broken) !== sig(this.eps, this.broken)
    const before = this.eps
    this.eps = next
    this.broken = broken
    // The podcast played went (deleted, or it can't be played now): the panel's audio stops with it, and the status
    // item goes. Playing then, it plays on once it is back.
    if (this.session && !next.has(this.session)) {
      if (this.playing) this.playOnReturn.add(this.session)
      this.session = undefined
      this.playing = false
      this.want = undefined
    }
    this.renderItem()
    if (!changed) return
    // The same moment again where the file moved it (a segment's times changed); playing on if it was.
    let seekTo: number | undefined
    for (const [key, was] of before) {
      const now = next.get(key)
      if (!now || now.sig === was.sig || !this.pos.has(key)) continue
      const t = this.pos.get(key)!
      const t2 = remapTime(was.ep, now.ep, t)
      if (Math.abs(t2 - t) < 0.05) continue
      const lj = journeys.list.get(key)
      if (lj) this.savePos(lj, t2, true)
      if (key === mapPanel.journey?.key && now.audio.toString() === was.audio.toString()) seekTo = t2
    }
    mapPanel.sendPodcast()
    this.refreshHost()
    if (seekTo !== undefined) this.command('seek', { to: seekTo })
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

  /** What a player gets for `lj` (undefined: no podcast; `unavailable`: one that can't be played, and why): the
   *  panel's (a remote: what to draw) or the Listen view's (`host`: the audio too, and whether it plays once loaded). */
  private episodeFor(lj: LoadedJourney, toUri: (u: vscode.Uri) => string | undefined, host = false): unknown {
    const l = this.eps.get(lj.key)
    if (!l) {
      const b = this.broken.get(lj.key)
      return b && { unavailable: b.reason }
    }
    const { ep } = l
    const play = host && this.playOnReturn.delete(lj.key)
    const next = this.nextOf(lj)
    return {
      key: lj.key,
      src: toUri(l.audio) ?? '',
      title: ep.title,
      journey: lj.j.title,
      duration: ep.duration,
      at: this.posOf(lj),
      ...(play ? { play: true } : {}),
      rate: gstate.get<number>(RATE_KEY) ?? 1,
      muted: !!gstate.get<boolean>(MUTE_KEY),
      keyPrefix: KEY,
      chapters: ep.chapters,
      segments: ep.segments.map((s) => ({ start: s.start, end: s.end, text: s.text, step: s.step, speaker: s.speaker, ...(s.sentences ? { sentences: s.sentences } : {}) })),
      steps: lj.j.steps.map((s, i) => ({ n: i + 1, title: s.title })),
      ...(next ? { next: { key: next.key, title: next.j.title } } : {}),
      ...(l.notice ? { notice: l.notice } : {}),
    }
  }

  /** The journey after `lj` (in the Journeys view's order) with a podcast that plays: the end's "Next journey". */
  private nextOf(lj: LoadedJourney): LoadedJourney | undefined {
    const all = journeys.all()
    const i = all.findIndex((x) => x.key === lj.key)
    return all.slice(i + 1).find((x) => this.has(x))
  }

  /** What the panel's remote draws for `lj` right after its episode: the audio's own state when the Listen view has
   *  it, else where it was left, paused. */
  private stateFor(lj: LoadedJourney): HostState | undefined {
    if (!this.eps.has(lj.key)) return undefined
    if (this.hostKey === lj.key && this.hostState?.of === lj.key) return this.hostState
    // Not in the Listen view yet: loaded there now (its length is checked, ▶ starts at once), unless another
    // journey's episode is in it.
    if (!this.sessionJourney() && this.listen.alive) this.loadHost(lj)
    return { of: lj.key, t: this.posOf(lj), playing: false }
  }

  // ---------- the Listen view: the audio ----------

  /** Journey `lj`'s episode into the Listen view (the view made first); `play`: it plays once loaded, from `at`. */
  private async loadHost(lj: LoadedJourney, o: { play?: boolean; at?: number; until?: number } = {}): Promise<boolean> {
    if (!(await this.listen.ensure())) return false
    const episode = this.episodeFor(lj, (u) => this.listen.toUri(u), true) as Record<string, unknown> | undefined
    if (!episode || episode.unavailable) return false
    this.hostKey = lj.key
    this.hostState = undefined
    this.listen.send({ type: 'podcast', episode: { ...episode, ...(o.at !== undefined ? { at: o.at } : {}), ...(o.play ? { play: true } : {}) } })
    if (o.until !== undefined) this.command('play', { ...(o.at !== undefined ? { at: o.at } : {}), until: o.until })
    return true
  }

  /** The podcast files were read again: the Listen view's episode follows (the same audio keeps playing; one that
   *  went or can't be played now leaves the view). */
  private refreshHost(): void {
    const key = this.hostKey
    if (!key || !this.listen.alive) return
    const lj = journeys.list.get(key)
    const episode = lj && this.episodeFor(lj, (u) => this.listen.toUri(u), true)
    if (!episode || (episode as { unavailable?: string }).unavailable) {
      this.hostKey = undefined
      this.hostState = undefined
    }
    this.listen.send({ type: 'podcast', episode })
  }

  /** What the Listen view says. */
  private onHost(m: ListenMessage): void {
    const shown = (m as { of?: string }).of ? journeys.list.get((m as { of: string }).of) : undefined
    switch (m.type) {
      case 'podcastTime': if (shown) this.onTime(shown, m); break
      case 'podcastState': this.onState(m as unknown as HostState); break
      case 'podcastError': this.onError(shown, String(m.message), m.of); break
      case 'podcastMeta': if (shown) this.onAudioMeta(shown, Number(m.duration), m.of); break
      case 'podcastWhy': void this.showWhy(shown ?? (this.hostKey ? journeys.list.get(this.hostKey) : undefined)); break
      case 'podcastOpen': void this.openSessionMap(); break
      case 'podcastEnd': { const lj = (m.of && journeys.list.get(m.of)) || this.sessionJourney(); if (lj) void this.onEnd(lj, m.action) } break
      case 'ready':
        // A new page (the view was made again): it has no episode until it is sent one.
        this.hostKey = undefined
        this.hostState = undefined
        break
    }
  }

  /** The audio's state: kept (a reopened panel draws it), the muting remembered, and passed on to the panel. */
  private onState(m: HostState): void {
    if (!m || m.of !== this.hostKey) return
    this.hostState = m
    if (typeof m.muted === 'boolean' && m.muted !== !!gstate.get<boolean>(MUTE_KEY)) void gstate.update(MUTE_KEY, m.muted)
    if (mapPanel.journey?.key === m.of) mapPanel.send({ type: 'podcastState', ...m })
    // The end of the episode: the row and the status item say so.
    if (m.ended !== this.ended) { this.ended = !!m.ended; this.renderItem(); journeysTree?.refresh() }
  }
  private ended = false
  /** The journey the rows last showed as listened to. */
  private rowSession: string | undefined

  /** What the panel's player asks (it is a remote: the audio is in the Listen view). */
  async onAsk(lj: LoadedJourney, m: AskMessage): Promise<void> {
    const key = m.of && journeys.list.get(m.of) ? m.of : lj.key
    const j = journeys.list.get(key)!
    if (!this.eps.has(key)) return
    const loaded = this.hostKey === key && this.listen.alive
    const { action } = m
    if (action === 'play' || action === 'toggle') {
      if (loaded && this.session === key) {
        this.command(action, { ...(typeof m.at === 'number' ? { at: m.at } : {}), ...(typeof m.until === 'number' ? { until: m.until } : {}) })
        return
      }
      await this.play(key, { at: m.at, until: m.until })
      return
    }
    if (!loaded) {
      // Not in the Listen view: a seek is where ▶ starts next.
      if (action === 'seek' && typeof m.to === 'number') { this.savePos(j, m.to, true); mapPanel.send({ type: 'podcastState', of: key, t: m.to, playing: false }) }
      return
    }
    const more: Record<string, unknown> = {}
    for (const k of ['to', 'by', 'dir', 'rate', 'muted'] as const) if (m[k] !== undefined) more[k] = m[k]
    if (action === 'seek') more.reader = true
    this.command(action, more)
  }

  /** The end's buttons, from the panel (`of`: the journey the episode is of). */
  endAction(lj: LoadedJourney, action: 'walk' | 'next', of?: string): Promise<void> {
    return this.onEnd((of && journeys.list.get(of)) || lj, action)
  }

  /** The end's buttons: walk the journey yourself (from its first step), or listen to the next one. */
  private async onEnd(lj: LoadedJourney, action: 'walk' | 'next'): Promise<void> {
    if (action === 'walk') { await walk.goToStep(lj, 1, { focus: false }); return }
    const next = this.nextOf(lj)
    if (next) await this.play(next.key)
  }

  /** The Listen view went for good (its view closed): the audio with it; its place is kept. */
  private hostGone(): void {
    const lj = this.sessionJourney()
    if (lj) this.savePos(lj, this.posOf(lj), true)
    this.hostKey = undefined
    this.hostState = undefined
    this.session = undefined
    this.playing = false
    this.want = undefined
    this.renderItem()
  }

  /** The status item's click, the Listen view's title: the listened journey's map (its player shows where it is). */
  async openSessionMap(): Promise<void> {
    const lj = this.sessionJourney() ?? (this.hostKey ? journeys.list.get(this.hostKey) : undefined)
    if (!lj) { await this.play(); return }
    if (mapPanel.journey?.key !== lj.key) await openMap(lj)
    else walk.showMap(lj, true)
  }

  /** The panel loaded the audio of journey `of` (else the one shown): its real length. Checked against the file (a
   *  cut-off audio, a wrong "duration"). */
  onAudioMeta(shown: LoadedJourney, duration: number, of?: string): void {
    const lj = (of && journeys.list.get(of)) || shown
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
  /** Where `lj`'s podcast is: as last reported, else as stored, else the start. */
  posOf(lj: LoadedJourney): number { return this.pos.get(lj.key) ?? this.positions()[posKey(lj)] ?? 0 }
  /** Kept in memory at once; stored when `store` (a pause, a seek, leaving) or every SAVE_EVERY_MS. */
  private savePos(lj: LoadedJourney, t: number, store = false): void {
    this.pos.set(lj.key, t)
    if (!store && Date.now() - this.lastSave < SAVE_EVERY_MS) return
    this.lastSave = Date.now()
    void state.update(POS_KEY, { ...this.positions(), [posKey(lj)]: Math.round(t * 10) / 10 })
  }
  /** The session's time (the status bar's). */
  private get t(): number {
    const lj = this.sessionJourney()
    return lj ? this.posOf(lj) : 0
  }

  // ---------- audio → journey ----------

  /** The panel says where the audio is. Playing (or seeking), the walk goes where the podcast is at that time. */
  onTime(shown: LoadedJourney, m: TimeReport): void {
    // The journey the audio is of (the panel may have moved on to another one since it said it).
    const lj = (m.of && journeys.list.get(m.of)) || shown
    const l = this.eps.get(lj.key)
    if (!l) return
    // A report from before the seek or pause just asked for (the walk would go back there for a moment): ignored.
    const asked = this.asked
    if (asked && lj.key === this.session) {
      const answers = asked.kind === 'seek' ? !!m.seek : !m.playing
      if (!answers && Date.now() - asked.at < STALE_MS) return
      this.asked = undefined
    }
    const wasPlaying = lj.key === this.session && this.playing
    if (m.rate && m.rate !== gstate.get<number>(RATE_KEY)) void gstate.update(RATE_KEY, m.rate)
    this.savePos(lj, m.t, (wasPlaying && !m.playing) || !!m.seek)
    if (m.playing) this.session = lj.key
    if (this.session !== lj.key) return
    // The Journeys row says listening or paused.
    if (this.playing !== m.playing || this.rowSession !== lj.key) { this.rowSession = lj.key; setTimeout(() => journeysTree?.refresh(), 0) }
    this.playing = m.playing
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
        if (walk.touring() && tourState.key === lj.key) {
          // The map, no step: the walk ends, and the code tab it opened goes with it.
          const doc = tourState.doc
          await endJourney()
          await closeWalkTabs(lj, doc?.column)
        }
        return
      }
      this.beatShown = view.beat
      mapPanel.send({ type: 'podcastBeat', n: view.step, i: view.beat ?? -1, ...(m.still ? { still: true } : {}) })
      // On a beat whose code is in another file, that file opens (the beat's), not the step's first.
      if (!(walk.touring() && tourState.isAt(lj, view.step))) await walk.goToStep(lj, view.step, { focus: false, beat: view.beat })
    } catch (e) {
      log.error(`podcast: ${e}`)
    } finally {
      this.applying--
    }
    // The status item says the step only while the walk isn't on it: the time report before this move rendered it
    // with the walk elsewhere.
    this.renderItem()
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
      // Another journey, or the walk ended: the podcast stops; its place is kept (stored now: the panel's pause
      // report may come once the session is over).
      this.want = { step: 0 }
      this.savePos(lj, this.posOf(lj), true)
      this.command('pause')
      if (tourState.key !== lj.key) { this.session = undefined; this.playing = false }
      this.renderItem()
      return
    }
    const t = timeOf(l.ep, step)
    if (t === undefined) {
      // A step the podcast skips: the walk stays there, the audio pauses and says so; ▶ goes on after the step.
      this.want = { step }
      this.command('pause', { note: `Step ${step} isn't in the podcast`, ...resumeAfter(l.ep, step) })
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

  /** The panel closed: the audio is in the Listen view and plays on; only the status item is drawn again. */
  onClosed(): void {
    this.renderItem()
  }

  /** Something went wrong in the panel's audio (of journey `of`, else the one shown): logged; an audio that can't be
   *  decoded is said in the panel and on the row, with its file. */
  onError(shown: LoadedJourney | undefined, message: string, of?: string): void {
    // A play() cut short by a pause or another source: what the reader asked for, not a failure.
    if (message === 'AbortError') {
      log.debug('podcast: a play was interrupted (paused, or another audio loaded)')
      return
    }
    this.lastError = message
    // Not started by a click or a key in the panel (VS Code's webviews need one, once): the panel takes the keyboard,
    // its ▶ focused, so Space starts it.
    if (message === 'NotAllowedError') {
      void this.listen.focus()
      return
    }
    const lj = (of && journeys.list.get(of)) || shown
    const l = lj && this.eps.get(lj.key)
    if (l && /^audio error/.test(message)) {
      // The media pipeline's own words ("PIPELINE_ERROR_READ: FFmpegDemuxer …") mean nothing to an author: the file
      // and what it most likely is.
      const name = vscode.workspace.asRelativePath(l.audio, false)
      const text = `The audio ${name} (${kb(l.audioSize)}) can't be played at ${clock(this.posOf(lj))}: the file looks cut off or damaged`
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
    if (action === 'seek' || action === 'pause') this.asked = { kind: action, at: Date.now() }
    this.listen.send({ type: 'podcastCmd', action, ...more })
  }

  /** Listen to Journey: the journey (a row, a key; else the one walked or on the map; else picked) in the Listen view,
   *  playing, its map open. `o.at`: from there (else where it was left, or where the walk is); `o.until`: it stops
   *  there (one step). */
  async play(arg?: unknown, o: { at?: number; until?: number } = {}): Promise<void> {
    const lj = await this.journeyFor(arg)
    if (!lj) return
    // Not the episode in the Listen view: it goes on where it was left (or where the walk is: resumeTime).
    const fresh = this.session !== lj.key || this.hostKey !== lj.key || !this.listen.alive
    if (mapPanel.journey?.key !== lj.key) await openMap(lj)
    else if (!mapPanel.visible) walk.showMap(lj, true)
    const walkStep = walk.touring() && tourState.key === lj.key ? tourState.step : 0
    const at = typeof o.at === 'number' ? o.at : fresh ? resumeTime(this.eps.get(lj.key)!.ep, this.posOf(lj), walkStep) : undefined
    this.session = lj.key
    // Where the walk is now (the walk telling of a move that isn't one pauses nothing).
    this.want = { step: walkStep }
    const until = typeof o.until === 'number' ? { until: o.until } : {}
    if (this.hostKey !== lj.key || !this.listen.alive) {
      if (!(await this.loadHost(lj, { play: o.until === undefined, at: at ?? this.posOf(lj), until: o.until }))) {
        void vscode.window.showWarningMessage('The Listen view could not be opened, so the audio has nowhere to play.')
      }
      return
    }
    this.command('play', { ...(at === undefined || (Math.abs(at - this.posOf(lj)) < 0.05 && o.at === undefined) ? {} : { at }), ...until })
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
      if (!all.length) vscode.window.setStatusBarMessage('$(info) No journey here has a podcast to listen to', 3000)
      return all[0]
    }
    const pick = await vscode.window.showQuickPick(all.map((x) => ({ label: x.j.title, description: clock(this.eps.get(x.key)!.ep.duration), lj: x })), { placeHolder: 'Listen to a journey' })
    return pick?.lj
  }

  /** Asked to play a journey whose podcast can't be (or that has none): says why, with the way to the details. */
  private cantPlay(lj: LoadedJourney): void {
    const b = this.broken.get(lj.key)
    if (!b) { vscode.window.setStatusBarMessage(`$(info) ${lj.j.title} has no podcast`, 3000); return }
    void vscode.window.showWarningMessage(`The podcast of “${lj.j.title}” can't be played: ${b.reason}`, 'Show Why').then((a) => { if (a) void this.showWhy(lj) })
  }

  /** Space for listening: pause, or play (the journey in the Listen view; else as Listen to Journey). */
  async toggle(): Promise<void> {
    if (this.sessionJourney() && this.hostKey === this.session && this.listen.alive) {
      this.command(this.playing ? 'pause' : 'play')
      return
    }
    await this.play()
  }

  /** The row's ⏸ / ▶ (Resume): that journey paused, or played on where it was left. */
  async toggleRow(arg?: unknown): Promise<void> {
    const lj = await this.journeyFor(arg)
    if (!lj) return
    if (this.session === lj.key && this.playing) { this.command('pause'); return }
    await this.play(lj.key)
  }

  /** Previous / next step of the episode (⏮ ⏭, Ctrl+' Shift+← →). */
  part(dir: 1 | -1): void {
    if (!this.sessionJourney()) {
      vscode.window.setStatusBarMessage('$(info) Nothing is being listened to', 2000)
      return
    }
    this.command('part', { dir })
  }

  skip(by: number): void {
    if (!this.sessionJourney()) {
      vscode.window.setStatusBarMessage('$(info) Nothing is being listened to', 2000)
      return
    }
    this.command('skip', { by })
  }
  back(): void { this.skip(-SKIP_S) }
  forward(): void { this.skip(SKIP_S) }

  // ---------- the status bar ----------

  /** While a journey is listened to: what it does (Listening / Paused / Ended: a word and a glyph for the state, never
   *  the action), the time, and Intro or Recap on the map (on a step, the walk's own item beside it says which). The
   *  tooltip is the remote: its actions with their keys. Click: the journey's map. */
  private renderItem(): void {
    const item = this.item
    if (!item) return
    const lj = this.sessionJourney()
    if (!lj) { item.hide(); return }
    const l = this.eps.get(lj.key)!
    const ep = l.ep
    const v = viewAt(ep, this.t)
    const where = v.step ? `${v.step}/${lj.j.steps.length}` : mapPartName(ep, this.t)
    const onWalkItem = !!v.step && walk.touring() && tourState.key === lj.key
    const ended = this.ended && !this.playing
    const state = this.playing ? 'Listening' : ended ? 'Ended' : 'Paused'
    const glyph = this.playing ? '$(unmute)' : ended ? '$(check)' : '$(debug-pause)'
    item.text = `${glyph} ${state} · ${onWalkItem ? '' : `${where} · `}${clock(this.t)}${l.lastGood ? ' $(warning)' : ''}`
    const k = KEY
    const cmd = (id: string, text: string, keys: string) => `[${text}](command:${id} "${text} (${keys})") ${keys}`
    const step = v.step ? `Step ${v.step} of ${lj.j.steps.length}${lj.j.steps[v.step - 1] ? ` · ${md(lj.j.steps[v.step - 1].title)}` : ''}` : where
    const tip = new vscode.MarkdownString([
      `**${md(lj.j.title)}** · ${state.toLowerCase()} · ${clock(this.t)} of ${clock(ep.duration)}`,
      step,
      [cmd('codeNotes.podcastToggle', this.playing ? 'Pause' : 'Play', `${k} Space`), cmd('codeNotes.podcastBack', 'Back 15 s', `${k} ←`), cmd('codeNotes.podcastForward', 'Forward 15 s', `${k} →`)].join(' · '),
      [cmd('codeNotes.podcastPrevStep', 'Previous step', `${k} Shift+←`), cmd('codeNotes.podcastNextStep', 'Next step', `${k} Shift+→`)].join(' · '),
      ...(l.notice ? [`$(warning) ${md(l.notice)}`] : []),
      'Click: the journey\'s map',
    ].join('\n\n'), true)
    tip.isTrusted = { enabledCommands: ['codeNotes.podcastToggle', 'codeNotes.podcastBack', 'codeNotes.podcastForward', 'codeNotes.podcastPrevStep', 'codeNotes.podcastNextStep'] }
    item.tooltip = tip
    item.accessibilityInformation = { label: `${state}: ${lj.j.title}, ${v.step ? `step ${v.step} of ${lj.j.steps.length}` : where}, ${clock(this.t)}. Opens the journey's map; ${k} Space to ${this.playing ? 'pause' : 'play'}.` }
    item.show()
  }

  /** For tests. */
  snapshot() {
    const lj = this.sessionJourney()
    return {
      journeys: journeys.all().filter((x) => this.has(x)).map((x) => x.j.id),
      session: lj?.j.id, t: this.t, playing: this.playing, want: this.want, beatShown: this.beatShown, applying: this.applying,
      item: this.item?.text, itemShown: !!lj, hostKey: this.hostKey, hostAlive: this.listen.alive, hostVisible: this.listen.visible, ended: this.ended, error: this.lastError, moves: this.moves, mapVisible: mapPanel.visible,
      why: this.whyShown,
      broken: Object.fromEntries([...this.broken].map(([k, b]) => [journeys.list.get(k)?.j.id ?? k, b.reason])),
      notices: Object.fromEntries([...this.eps].filter(([, l]) => l.notice).map(([k, l]) => [journeys.list.get(k)?.j.id ?? k, l.notice])),
      links: Object.fromEntries([...this.eps].map(([k, l]) => [journeys.list.get(k)?.j.id ?? k, brokenLinks(l.problems)])),
    }
  }
}

/** The pause command's `resumeAt` for a step the podcast skips (none when nothing comes after it). */
function resumeAfter(ep: Episode, step: number): { resumeAt?: number } {
  const t = afterStep(ep, step)
  return t === undefined ? {} : { resumeAt: t }
}

/** Text as Markdown, its marks escaped. */
const md = (t: string) => t.replace(/[\\`*_[\]<>#|]/g, '\\$&')

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`)

/** A part on the map (no step) by where it is: the first is the intro, the last the recap. */
function mapPartName(ep: Episode, t: number): string {
  const i = ep.chapters.findIndex((c, k) => t < c.end || k === ep.chapters.length - 1)
  if (i <= 0) return 'Intro'
  return i === ep.chapters.length - 1 ? 'Recap' : 'Map'
}

export const podcasts = new Podcasts()
