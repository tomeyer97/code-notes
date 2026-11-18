// Podcast mode: a journey with a podcast file next to it (`<journey>.podcast.json`, docs/podcast-format.md) plays in
// the journey panel (media/journey-podcast.js has the audio and the timeline), and the walk follows the voice: at
// every time the panel reports, the view at that time (model.ts viewAt) is applied the way a reader's own move is
// (walk.goToStep; the animation's beat set in the panel). A seek applies the view at the new time directly: never
// the cues in between, and only the newest of quick seeks (LatestWins). The other way round: the reader moving the
// walk (Next, Back, the map, a beat of the animation) moves the audio to the first part about it; a step the podcast
// skips pauses it, and ▶ then goes on after that step (resume.ts). Where each journey's podcast is is kept (in memory
// and in the workspace state) from every time the panel reports, so another journey, the walk ending, the panel
// closing or the podcast file being rewritten never loses it.
//
// The editor while it plays (docs/podcast-format.md, "The editor while it plays"): a view is held at least
// VIEW_HOLD_S (model.ts calmViews); the reader scrolling or clicking in the code stops it following until the next
// step (follow.ts); the step card is one line while it plays, with the player's own ⏮ ⏭ (one transport); a note or a
// question being written pauses it; the journey edited under it keeps the step (by id), not its number.

import * as vscode from 'vscode'
import { beats, gstate, journeys, KEY, log, mapPanel, state } from '../app'
import { fileOf, LoadedJourney, posKey } from '../journeys/steps'
import { closeWalkTabs, endJourney, openMap } from '../tour/commands'
import { card, tourState, walk } from '../tour/instances'
import { showBeat } from '../tour/mapMessages'
import { codeGetsMoreRoom } from '../tour/panelLayout'
import { FollowLock } from './follow'
import type { Narration } from '../tour/card'
import { pickJourney } from '../tour/pick'
import { journeysTree } from '../sidebar/journeysTree'
import { calmViews, clock, Episode, LatestWins, podcastFileOf, PodcastProblem, sameView, timeOf, View, viewAt } from './model'
import { baseName } from '../paths'
import { podcastReports, PodcastRead, readPodcast, strayPodcasts } from './load'
import { afterStep, remapTime, resumeTime } from './resume'
import { brokenLinks, playNotice } from './validate'

/** Workspace state: where each podcast was left (posKey -> seconds); global: the speed. */
const POS_KEY = 'codeNotes.podcastPos'
const RATE_KEY = 'codeNotes.podcastRate'
/** While playing, where it is is stored this often (ms). */
const SAVE_EVERY_MS = 5000
const SKIP_S = 15
/** After the podcast asks for a seek or a pause, the panel's reports from before it are ignored for at most this long (ms). */
const STALE_MS = 1500
/** A seek's move waits this long for another seek (⏭ ⏭ pressed quickly: only the last target opens, F86). */
export const SEEK_SETTLE_MS = 250
/** Global state: the one-line hint on the first play was shown. */
const HINT_KEY = 'codeNotes.listenHintShown'

/** A journey's podcast, read and checked against the journey. `notice`: one line about what is wrong with it (the
 *  panel and the row's tooltip say it); `lastGood`: the file has errors now, this is the version read before. */
interface Loaded { file: vscode.Uri; audio: vscode.Uri; audioSize: number; ep: Episode; sig: string; problems: PodcastProblem[]; notice?: string; lastGood?: boolean }
/** A podcast file next to a journey that can't be played, and why (its first error). */
interface Broken { file: vscode.Uri; reason: string }

/** What the panel says over a podcast that plays from its last good version. */
const LAST_GOOD = 'The podcast file has errors: playing the last good version'

/** What the panel sends about the audio (MapMessage podcastTime): `of`, the journey (key) whose audio it is. */
export interface TimeReport { t: number; playing: boolean; rate?: number; seek?: boolean; of?: string }

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
  /** The view the podcast asked for last (`id`: its step's id, so a journey edited under it keeps the step, not its
   *  number: F105), and the beat it last set in the panel (undefined: none). */
  private want: (View & { id?: string }) | undefined
  private beatShown: number | undefined
  /** The segment whose view was applied last: while playing, the view changes only when the segment does. */
  private lastSeg = -1
  /** A seek's move, waiting for another seek (SEEK_SETTLE_MS). */
  private seekTimer: NodeJS.Timeout | undefined
  /** Why the extension paused or stopped it last (the log says it, F121). */
  private reason: string | undefined
  /** The views a playing episode shows, per segment (model.ts calmViews), by journey as loaded. */
  private calm = new WeakMap<LoadedJourney, { sig: string; views: View[] }>()
  /** The follow lock: the reader looking around in the code stops the editor following (follow.ts). */
  follow!: FollowLock
  /** What the step card last showed of the podcast (it is drawn again only when that changes). */
  private cardSig = ''
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

  init(context: vscode.ExtensionContext): void {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49.25)
    this.item.command = 'codeNotes.podcastToggle'
    context.subscriptions.push(this.item, journeys.onDidChange(() => void this.scan()))
    podcastReports.init(context, () => void this.scan())
    mapPanel.podcastFor = (lj, toUri) => this.episodeFor(lj, toUri)
    walk.onMoved = () => this.walkMoved()
    walk.onStepRemoved = (lj) => this.stepRemoved(lj)
    walk.transport = (dir) => this.transport(dir)
    walk.podcastOn = (lj) => this.session === lj.key && !!this.sessionJourney()
    walk.onRestored = (lj) => this.restored(lj)
    card.narration = (lj, n) => this.narration(lj, n)
    this.follow = new FollowLock(() => this.drives(), (e) => this.narrated(e), () => this.followChanged())
    walk.following = () => this.follow.locked || !this.drives()
    beats.follow = walk.following
    context.subscriptions.push(this.follow, { dispose: () => clearTimeout(this.seekTimer) })
  }

  /** The podcast is playing and the walk on its journey follows it. */
  private drives(): boolean {
    const lj = this.sessionJourney()
    return !!lj && this.playing && tourState.key === lj.key
  }

  /** `e` shows the walk's code: in the walk's group, or showing the step's file or the lit beat's. */
  private narrated(e: vscode.TextEditor): boolean {
    if (e.viewColumn === undefined || e.viewColumn === mapPanel.viewColumn) return false
    const uri = e.document.uri.toString()
    return e.viewColumn === tourState.walkGroup?.viewColumn || uri === tourState.doc?.uri.toString() || uri === beats.lit?.uri
  }

  /** The lock opened (the reader looked around) or closed: the card says so; opened, the status bar says how back. */
  private followChanged(): void {
    const lj = this.sessionJourney()
    if (!this.follow.locked) {
      log.info(`podcast: not following the voice (the reader ${this.follow.lastUnlock} in the code) until the next step`)
      vscode.window.setStatusBarMessage('$(eye) Reading on your own: the code stays put until the next step (Follow along on the step card)', 5000)
    }
    if (lj) this.redrawCard(lj, true)
  }

  /** "Follow along" (the step card): the editor follows again, and shows what the voice is showing now. */
  followAlong(): void {
    const lj = this.sessionJourney()
    this.follow.relock()
    const l = lj && this.eps.get(lj.key)
    if (!lj || !l) return
    const v = viewAt(l.ep, this.posOf(lj))
    const view: View = v.beat === undefined ? { step: v.step } : { step: v.step, beat: v.beat }
    this.want = this.withId(lj, view)
    this.mover.push({ lj, view, still: true })
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
    void this.strays()
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
    if (seekTo !== undefined) this.command('seek', { to: seekTo })
    journeysTree?.refresh()
  }

  /** Podcast files in the journeys folders that no journey reads: why each is ignored, in the output (once). */
  private async strays(): Promise<void> {
    const all = journeys.all()
    const dirs = new Map(all.map((lj) => { const d = vscode.Uri.joinPath(lj.uri, '..'); return [d.toString(), d] }))
    const known = new Set(all.map((lj) => lj.uri.with({ path: podcastFileOf(lj.uri.path) }).toString()))
    const ids = new Map(all.filter((lj) => this.eps.has(lj.key) || this.broken.has(lj.key)).map((lj) => [lj.j.id, baseName(podcastFileOf(lj.uri.path))]))
    await strayPodcasts([...dirs.values()], known, ids).catch((e) => log.debug(`podcast: ${e}`))
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
    const play = this.playOnReturn.delete(lj.key)
    this.reopened(lj, ep)
    return {
      key: lj.key,
      src: toUri(l.audio),
      title: ep.title,
      duration: ep.duration,
      at: this.posOf(lj),
      ...(play ? { play: true } : {}),
      rate: gstate.get<number>(RATE_KEY) ?? 1,
      chapters: ep.chapters,
      segments: ep.segments.map((s) => ({ start: s.start, end: s.end, text: s.text, step: s.step })),
      ...(l.notice ? { notice: l.notice } : {}),
    }
  }

  /**
   * The panel shows a journey whose podcast was listened to (a place kept), with no podcast going on: it is the
   * session again, paused there (the status item says so), and the beat at that time is shown when the walk is on its
   * step (F47).
   */
  private reopened(lj: LoadedJourney, ep: Episode): void {
    const t = this.posOf(lj)
    if (this.session || !(t > 0)) return
    this.session = lj.key
    this.playing = false
    const v = viewAt(ep, t)
    this.lastSeg = v.seg
    this.want = this.withId(lj, v.beat === undefined ? { step: v.step } : { step: v.step, beat: v.beat })
    setTimeout(() => {
      this.renderItem()
      if (v.step && v.beat !== undefined && walk.touring() && tourState.isAt(lj, v.step)) {
        this.beatShown = v.beat
        mapPanel.send({ type: 'podcastBeat', n: v.step, i: v.beat, still: true })
      }
    }, 0)
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
    this.playing = m.playing
    if (wasPlaying !== m.playing) this.saidState(lj, m.t)
    this.renderItem()
    this.redrawCard(lj)
    // Paused and not moved: the walk is the reader's.
    if (!m.playing && !m.seek) return
    const v = viewAt(l.ep, m.t)
    if (m.seek) {
      // A seek shows exactly its time; of seeks in quick succession only the last moves the walk.
      const view: View = v.beat === undefined ? { step: v.step } : { step: v.step, beat: v.beat }
      this.lastSeg = v.seg
      this.want = this.withId(lj, view)
      clearTimeout(this.seekTimer)
      this.seekTimer = setTimeout(() => {
        this.seekTimer = undefined
        this.mover.push({ lj, view, still: true })
      }, SEEK_SETTLE_MS)
      return
    }
    // A seek's move is on its way: playing on from there is the same view.
    if (this.seekTimer) return
    if (m.playing) this.hintOnce()
    // Playing: the view changes only at a segment's start, and a short part in another file is held (F79).
    const view = v.seg === this.lastSeg && this.want ? { step: this.want.step, ...(this.want.beat === undefined ? {} : { beat: this.want.beat }) } : this.calmView(lj, l, v.seg)
    this.lastSeg = v.seg
    if (sameView(view, this.want) && (this.mover.busy || this.shows(lj, view))) return
    this.want = this.withId(lj, view)
    this.mover.push({ lj, view, still: false })
  }

  /** The view a playing episode shows for segment `seg` (the view hold, model.ts calmViews). */
  private calmView(lj: LoadedJourney, l: Loaded, seg: number): View {
    let c = this.calm.get(lj)
    if (!c || c.sig !== l.sig) {
      c = { sig: l.sig, views: calmViews(l.ep, (v) => viewFile(lj, v)) }
      this.calm.set(lj, c)
    }
    return c.views[seg] ?? { step: 0 }
  }

  /** A view with its step's id (from the journey as it is). */
  private withId(lj: LoadedJourney, v: View): View & { id?: string } {
    const id = v.step ? lj.j.steps[v.step - 1]?.id : undefined
    return id ? { ...v, id } : { ...v }
  }

  /** The walk shows `v` now. */
  private shows(lj: LoadedJourney, v: View): boolean {
    const onIt = walk.touring() && tourState.key === lj.key
    if (!v.step) return !onIt
    return onIt && tourState.step === v.step && this.beatShown === v.beat
  }

  /**
   * Puts the walk where the podcast is: the beat set first (the step then opens on it), then the step opened, then the
   * beat's line lit from here too (a panel too narrow for the animation, or none, still shows it: F118). A step the
   * walk is on already is not opened again; a new step (or the map) makes the editor follow again (the follow lock).
   */
  private async move(m: { lj: LoadedJourney; view: View; still: boolean }, current: () => boolean): Promise<void> {
    const { lj } = m
    const view = this.live(lj, m.view)
    this.moves++
    this.applying++
    this.follow.ourMove()
    try {
      if (!view.step) {
        this.follow.relock()
        this.beatShown = undefined
        mapPanel.send({ type: 'podcastBeat', n: 0, i: -1 })
        if (walk.touring() && tourState.key === lj.key) {
          // The map, no step: the walk ends, and the code tabs it opened go with it (the map gets the room: F24, F93).
          const doc = tourState.doc
          await endJourney()
          await closeWalkTabs(lj, doc?.column)
          await closeWalkTabs(lj, tourState.walkGroup?.viewColumn)
        }
        return
      }
      const stepId = lj.j.steps[view.step - 1]?.id
      const onStep = walk.touring() && tourState.isAt(lj, view.step) && tourState.stepId === stepId
      if (!onStep) this.follow.relock()
      this.beatShown = view.beat
      mapPanel.send({ type: 'podcastBeat', n: view.step, i: view.beat ?? -1, ...(m.still ? { still: true } : {}) })
      if (!onStep) {
        const groups = vscode.window.tabGroups.all.length
        // On a beat whose code is in another file, that file opens (the beat's), not the step's first.
        await walk.goToStep(lj, view.step, { focus: false, beat: view.beat })
        // The code group came back (the map had the editor to itself): beside the panel at the reader's width.
        if (vscode.window.tabGroups.all.length > groups) await codeGetsMoreRoom()
      }
      if (view.beat !== undefined && current()) await showBeat(lj, view.step, view.beat)
    } catch (e) {
      log.error(`podcast: ${e}`)
    } finally {
      this.applying--
      this.follow.ourMove()
    }
    // The status item says the step only while the walk isn't on it: the time report before this move rendered it
    // with the walk elsewhere.
    this.renderItem()
    this.redrawCard(lj)
    // A move of the reader's that came in meanwhile (ignored then): the audio goes there now.
    if (current()) this.walkMoved(true)
  }

  /** `v` against the journey as it is now: its step found by id (the episode may be from before the journey was
   *  edited, until it is read again). */
  private live(lj: LoadedJourney, v: View): View {
    const l = this.eps.get(lj.key)
    const id = v.step ? l?.ep.segments.find((s) => s.step === v.step)?.stepId : undefined
    const n = id ? lj.j.steps.findIndex((s) => s.id === id) + 1 : v.step
    return n > 0 && n !== v.step ? { ...v, step: n } : v
  }

  // ---------- journey → audio ----------

  /** The walk moved (walk.updateTour). The reader's own move (not the podcast's): the audio goes to the first part
   *  about the step; a step it never talks about pauses it; the walk ended, or another journey, ends the session (its
   *  place is kept, and Play says where it goes on: F119). */
  private walkMoved(afterMove = false): void {
    const lj = this.sessionJourney()
    // A seek's move is on its way (SEEK_SETTLE_MS): the walk is not where the podcast is yet, and that is not the reader.
    if (!lj || this.applying || this.seekTimer || (this.mover.busy && !afterMove)) return
    const l = this.eps.get(lj.key)!
    const step = walk.touring() && tourState.key === lj.key ? tourState.step : 0
    const id = step ? lj.j.steps[step - 1]?.id : undefined
    // The same step, maybe under another number (the journey was edited: F105).
    if (this.want && (step === this.want.step || (id !== undefined && id === this.want.id))) {
      if (this.want.step !== step) this.want = { ...this.want, step }
      return
    }
    if (!step || tourState.key !== lj.key) {
      // Another journey, or the walk ended: the podcast stops; its place is kept (stored now: the panel's pause
      // report may come once the session is over).
      const other = tourState.key !== lj.key ? journeys.list.get(tourState.key ?? '') : undefined
      this.want = { step: 0 }
      this.savePos(lj, this.posOf(lj), true)
      this.pause(other ? `opened the journey “${other.j.title}”` : 'the walk ended')
      this.endSession(lj, other ? `opened the journey “${other.j.title}”` : 'the walk ended')
      return
    }
    const t = timeOf(l.ep, step)
    if (t === undefined) {
      // A step the podcast skips: the walk stays there, the audio pauses and says so; ▶ goes on after the step.
      this.want = this.withId(lj, { step })
      this.pause(`step ${step} isn't in the podcast`, { note: `Step ${step} isn't in the podcast`, ...resumeAfter(l.ep, step) })
      return
    }
    const v = viewAt(l.ep, t)
    this.want = this.withId(lj, v.beat === undefined ? { step: v.step } : { step: v.step, beat: v.beat })
    this.lastSeg = v.seg
    this.command('seek', { to: t })
  }

  /** A beat of the animation shown (the panel's `beat`). The reader's own (‹ › in the animation): the audio goes to
   *  the first part about that beat; a beat it doesn't narrate is shown and the audio pauses, as a step it skips (F72). */
  onBeat(lj: LoadedJourney, n: number, i: number): void {
    if (this.session !== lj.key || this.applying || this.mover.busy || this.seekTimer || i < 0 || n !== tourState.step || tourState.key !== lj.key) return
    if (i === this.beatShown) return
    this.beatShown = i
    const ep = this.eps.get(lj.key)!.ep
    const t = timeOf(ep, n, i)
    this.want = this.withId(lj, { step: n, beat: i })
    if (t === undefined) {
      const next = ep.segments.find((s) => s.step === n && s.beat !== undefined && s.beat > i)?.start ?? afterStep(ep, n)
      this.pause(`beat ${i + 1} of step ${n} isn't narrated`, { note: `Beat ${i + 1} isn't narrated`, ...(next === undefined ? {} : { resumeAt: next }) })
      return
    }
    this.lastSeg = viewAt(ep, t).seg
    this.command('seek', { to: t })
  }

  /** The step on screen was removed from the journey (walk.followStep). The podcast's journey: once it is read again,
   *  the walk shows what the podcast says at its time now (the view before a part about a step that is gone: F44). */
  private stepRemoved(lj: LoadedJourney): boolean {
    if (this.session !== lj.key || !this.eps.has(lj.key)) return false
    vscode.window.setStatusBarMessage('$(info) The step on screen was removed from the journey: showing what the podcast is at now', 5000)
    void this.scan().then(() => {
      const l = this.eps.get(lj.key)
      const now = journeys.list.get(lj.key)
      if (!l || !now) return
      const v = viewAt(l.ep, this.posOf(now))
      const view: View = v.beat === undefined ? { step: v.step } : { step: v.step, beat: v.beat }
      this.lastSeg = v.seg
      this.want = this.withId(now, view)
      // The walk's number may name another step now: it is opened whatever it is on.
      tourState.stepId = undefined
      this.mover.push({ lj: now, view, still: true })
    })
    return true
  }

  /** After a reload, the walk restored on its step (commands.ts restoreTour): the beat the podcast was at, lit (F53). */
  private restored(lj: LoadedJourney): void {
    const l = this.eps.get(lj.key)
    const t = this.positions()[posKey(lj)]
    if (!l || t === undefined || !walk.touring() || tourState.key !== lj.key) return
    const v = viewAt(l.ep, t)
    if (v.step !== tourState.step || v.beat === undefined) return
    this.beatShown = v.beat
    mapPanel.send({ type: 'podcastBeat', n: v.step, i: v.beat, still: true })
    void showBeat(lj, v.step, v.beat)
  }

  /** Next / Previous while it plays (the card, Ctrl+' D / A), or on the map's parts (Intro, Recap) where the walk has no
   *  step: the player's own ⏮ ⏭, one transport (F71, F85). Paused on a step, the walk's own (the audio follows it). */
  private transport(dir: 1 | -1): boolean {
    const lj = this.sessionJourney()
    if (!lj || mapPanel.journey?.key !== lj.key) return false
    const walking = walk.touring()
    if (walking && tourState.key !== lj.key) return false
    if (!this.playing && walking) return false
    this.command('part', { dir })
    return true
  }

  /** A note or a question is being written (F52, F126): the voice stops, the code stays; ▶ on the step card, or the
   *  key, goes on. True: it was playing and is paused now. */
  hold(what: string): boolean {
    const lj = this.sessionJourney()
    if (!lj || !this.playing) return false
    this.heldFor = what
    this.pause(`${what} being written`)
    vscode.window.setStatusBarMessage(`$(debug-pause) Paused while you write: ▶ on the step card or ${KEY} Space plays on`, 6000)
    return true
  }
  /** What a hold paused it for (a note, a question), until it plays again. */
  private heldFor: string | undefined

  /** The note or question was sent or put away: if a hold paused it, a reminder that ▶ plays on. */
  released(what: string): void {
    if (this.heldFor !== what || this.playing || !this.sessionJourney()) return
    this.heldFor = undefined
    vscode.window.setStatusBarMessage(`$(play) ${KEY} Space plays the narration on (paused for your ${what})`, 6000)
  }

  /** Paused by the extension, and why (the log says it once the panel has). */
  private pause(why: string, more: Record<string, unknown> = {}): void {
    this.reason = why
    this.command('pause', more)
  }

  /** The session is over (the walk ended, another journey): the status item goes, the card is the walk's alone. */
  private endSession(lj: LoadedJourney, why: string): void {
    if (this.session !== lj.key) return
    log.info(`podcast ${lj.j.id}: stopped at ${clock(this.posOf(lj))} (${why}); ▶ goes on from there`)
    this.session = undefined
    this.playing = false
    this.renderItem()
    this.redrawCard(lj, true)
  }

  /** It started or stopped playing: one line in the output, with why when the extension did it (F121). */
  private saidState(lj: LoadedJourney, t: number): void {
    if (this.playing) {
      this.heldFor = undefined
      log.info(`podcast ${lj.j.id}: playing from ${clock(t)}`)
    } else log.info(`podcast ${lj.j.id}: paused at ${clock(t)} (${this.reason ?? 'in the player'})`)
    this.reason = undefined
  }

  /** The first time any podcast plays: one line on what will happen to the editor (F8). */
  private hintOnce(): void {
    if (gstate.get<boolean>(HINT_KEY)) return
    void gstate.update(HINT_KEY, true)
    void vscode.window.showInformationMessage('The walk follows the voice: code opens beside the map.', 'Got it')
  }

  /** What the step card shows of the podcast on step n (card.ts Narration): only on the podcast's journey. */
  private narration(lj: LoadedJourney, n: number): Narration | undefined {
    if (this.session !== lj.key || !this.sessionJourney()) return undefined
    const beats = lj.j.steps[n - 1]?.scene?.beats?.length ?? 0
    const beat = this.want?.step === n ? this.beatShown : undefined
    return { playing: this.playing, following: this.follow.locked, beats, key: lj.key, ...(beat === undefined ? {} : { beat }) }
  }

  /** The step card again when what it shows of the podcast changed (playing, following, the beat). */
  private redrawCard(lj: LoadedJourney, always = false): void {
    if (!walk.touring() || tourState.key !== lj.key) return
    const n = card.narration?.(lj, tourState.step)
    const sig = n ? `${n.playing}|${n.following}|${n.beat}` : ''
    if (!always && sig === this.cardSig) return
    this.cardSig = sig
    card.show(lj, tourState.step)
  }

  /** The panel closed: its audio is gone. */
  onClosed(): void {
    const lj = this.sessionJourney()
    if (lj) {
      this.savePos(lj, this.posOf(lj), true)
      log.info(`podcast ${lj.j.id}: stopped at ${clock(this.posOf(lj))} (the panel closed)`)
    }
    this.session = undefined
    this.playing = false
    this.want = undefined
    this.renderItem()
    if (lj) this.redrawCard(lj, true)
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
      mapPanel.takeFocus()
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
    mapPanel.send({ type: 'podcastCmd', action, ...more })
  }

  /** Play Journey Podcast: the journey (a row, a key; else the one walked or on the map; else picked) in the panel, playing. */
  async play(arg?: unknown): Promise<void> {
    const lj = await this.journeyFor(arg)
    if (!lj) return
    // Not the podcast playing in the panel: it goes on where it was left (or where the walk is: resumeTime).
    const fresh = this.session !== lj.key || mapPanel.journey?.key !== lj.key
    if (mapPanel.journey?.key !== lj.key) await openMap(lj)
    else if (!mapPanel.visible) walk.showMap(lj, true)
    const walkStep = walk.touring() && tourState.key === lj.key ? tourState.step : 0
    const ep = this.eps.get(lj.key)!.ep
    const at = fresh ? resumeTime(ep, this.posOf(lj), walkStep) : undefined
    // Going on where it was, not from 0:00 in silence: said (F119, F120).
    if (fresh && (at ?? 0) > 0) {
      const v = viewAt(ep, at!)
      vscode.window.setStatusBarMessage(`$(play) ${lj.j.title}: on from ${clock(at!)}${v.step ? ` · step ${v.step}` : ''}`, 4000)
    }
    this.session = lj.key
    // Where the walk is now (the walk telling of a move that isn't one pauses nothing).
    this.want = { step: walkStep }
    this.command('play', at === undefined || Math.abs(at - this.posOf(lj)) < 0.05 ? {} : { at })
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
    // Walking another journey: asked, never switched silently (F120).
    const walking = walk.touring() ? walk.tourJourney() : undefined
    if (all.length <= 1 && !walking) {
      if (!all.length) vscode.window.setStatusBarMessage('$(info) No journey here has a podcast', 3000)
      return all[0]
    }
    if (!all.length) { vscode.window.setStatusBarMessage('$(info) No journey here has a podcast', 3000); return undefined }
    const placeHolder = walking ? `Play a journey podcast (this ends the walk through “${walking.j.title}”)` : 'Play a journey podcast'
    const pick = await vscode.window.showQuickPick(all.map((x) => ({ label: x.j.title, description: clock(this.eps.get(x.key)!.ep.duration), lj: x })), { placeHolder })
    return pick?.lj
  }

  /** Asked to play a journey whose podcast can't be (or that has none): says why, with the way to the details. */
  private cantPlay(lj: LoadedJourney): void {
    const b = this.broken.get(lj.key)
    if (!b) { vscode.window.setStatusBarMessage(`$(info) ${lj.j.title} has no podcast`, 3000); return }
    void vscode.window.showWarningMessage(`The podcast of “${lj.j.title}” can't be played: ${b.reason}`, 'Show Why').then((a) => { if (a) void this.showWhy(lj) })
  }

  /** Space for the podcast: pause, or play (the session's journey; else as Play). In a journey without a podcast it
   *  says so: never another journey's podcast, ending this walk (F120). */
  async toggle(): Promise<void> {
    if (this.sessionJourney() && mapPanel.journey?.key === this.session) {
      if (this.playing) this.reason = 'paused by the reader'
      this.command(this.playing ? 'pause' : 'play')
      return
    }
    const here = walk.touring() ? walk.tourJourney() : mapPanel.journey
    if (here && !this.has(here) && !this.broken.has(here.key)) {
      vscode.window.setStatusBarMessage(`$(info) ${here.j.title} has no podcast`, 3000)
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

/** The pause command's `resumeAt` for a step the podcast skips (none when nothing comes after it). */
function resumeAfter(ep: Episode, step: number): { resumeAt?: number } {
  const t = afterStep(ep, step)
  return t === undefined ? {} : { resumeAt: t }
}

/** The file a view shows ('' for the map): the beat's code file, else the step's. */
function viewFile(lj: LoadedJourney, v: View): string {
  if (!v.step) return ''
  const code = v.beat === undefined ? undefined : lj.j.steps[v.step - 1]?.scene?.beats?.[v.beat]?.code
  return code && typeof code.file === 'string' ? code.file : fileOf(lj, v.step)
}

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`)

/** A part on the map (no step) by where it is: the first is the intro, the last the recap. */
function mapPartName(ep: Episode, t: number): string {
  const i = ep.chapters.findIndex((c, k) => t < c.end || k === ep.chapters.length - 1)
  if (i <= 0) return 'Intro'
  return i === ep.chapters.length - 1 ? 'Recap' : 'Map'
}

export const podcasts = new Podcasts()
