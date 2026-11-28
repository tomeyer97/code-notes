// The walk following the voice (docs/podcast-format.md, "The editor while it plays"). Follow puts the walk where the
// audio is (a seek: the view at its time; playing: the view hold's view, model.ts calmViews), and moves the audio when
// the reader moves the walk. FollowLock stops it when the reader looks around in the narrated code on their own
// ("Reading around while it plays"); the extension's own editor moves run inside `asOurs` so they never count as the
// reader's.

import * as vscode from 'vscode'
import { OWN_MOVE_MS } from '../platform/timings'
import { fireAndForget } from '../platform/run'
import { LatestWins } from '../core/serial'
import { calmViews, Episode, sameView, View, viewAt, timeOf } from '../core/format/podcast/model'
import type { Beats } from '../codeLinks/beats'
import type { Journeys } from '../journeys/journeys'
import type { MapPanel } from '../journeys/mapPanel'
import type { LoadedJourney } from '../journeys/steps'
import type { Narration, TourApi } from '../tour/api'
import { cueText, type Camera } from './camera'
import type { Loaded, PodcastLibrary } from './library'
import { afterStep } from './resume'
import type { Session } from './session'
import type { PodcastStore } from './store'
import { viewFile, viewOf, viewTarget, withId } from './views'

/** A scroll by the reader moves the first visible line at least this far (a resize or a fold moves it less). */
const SCROLL_LINES = 3
/** A seek's move waits this long for another seek (⏭ ⏭ pressed quickly: only the last target opens). */
export const SEEK_SETTLE_MS = 250
/** For this much audio after a seek (s) the code moves without a camera wait (the reader moved it). */
const NO_WAIT_AFTER_SEEK_S = 1.5
/** A time this close (s) before the last seek is still that seek's. */
const SEEK_SLACK_S = 0.05

/** How the reader last opened the lock. */
export type Unlock = 'clicked' | 'scrolled'

/**
 * The follow lock: while a podcast plays, the editor follows the voice, until the reader scrolls, clicks or types in
 * the narrated code themselves; then nothing scrolls or opens under them until the next step or "Follow along".
 */
export class FollowLock implements vscode.Disposable {
  /** The editor follows the voice. */
  locked = true
  /** How the reader last opened the lock ('' : never). */
  lastUnlock: Unlock | '' = ''
  /** The extension's own moves in progress, and until when their late editor events still arrive (ms). */
  private ownMoves = 0
  private ownTail = 0
  /** The first visible line of each editor where the extension last left it (to see a scroll: the reader's scroll
   *  is measured from there, so a slow scroll in small steps counts too). */
  private tops = new WeakMap<vscode.TextEditor, number>()
  private readonly subs: vscode.Disposable[] = []

  /**
   * `active`: a podcast plays and the walk follows it; `narrated(e)`: `e` shows the walk's code (not the panel, not
   * another group the reader works in); `changed`: the lock was opened or closed.
   */
  constructor(private readonly active: () => boolean, private readonly narrated: (e: vscode.TextEditor) => boolean, private readonly changed: () => void) {
    this.subs.push(
      vscode.window.onDidChangeTextEditorSelection((e) => {
        const byReader = e.kind === vscode.TextEditorSelectionChangeKind.Mouse || e.kind === vscode.TextEditorSelectionChangeKind.Keyboard
        if (byReader) this.readerMoved(e.textEditor, 'clicked')
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
        const top = e.visibleRanges[0]?.start.line ?? 0
        const was = this.tops.get(e.textEditor)
        // The extension's own moves (and the first sight of an editor) set where it was left; the reader's scroll is
        // measured from there.
        if (was === undefined || !this.watching(e.textEditor)) { this.tops.set(e.textEditor, top); return }
        if (Math.abs(top - was) < SCROLL_LINES) return
        this.tops.set(e.textEditor, top)
        this.readerMoved(e.textEditor, 'scrolled')
      }),
    )
  }

  /**
   * Runs `move`, an editor move of the extension's: what the editors report meanwhile, and for OWN_MOVE_MS after it
   * ends (VS Code reports a reveal's scroll a little later), is not the reader's.
   */
  asOurs<T>(move: () => T): T {
    this.ownMoves++
    const done = () => { this.ownMoves--; this.ownTail = Date.now() + OWN_MOVE_MS }
    let out: T
    try { out = move() } catch (e) { done(); throw e }
    if (out instanceof Promise) return out.finally(done) as T
    done()
    return out
  }

  private ours(): boolean { return this.ownMoves > 0 || Date.now() < this.ownTail }

  /** A change in `e` may be the reader's: it follows, the audio drives, `e` shows the narrated code, not ours. */
  private watching(e: vscode.TextEditor): boolean {
    return this.locked && !this.ours() && this.active() && this.narrated(e)
  }

  /** Follow again (a new step, the map, "Follow along"). */
  relock(): void {
    if (this.locked) return
    this.locked = true
    this.changed()
  }

  /** The reader moved in the narrated code: the editor stops following until the next step. */
  private readerMoved(e: vscode.TextEditor, how: Unlock): void {
    if (!this.watching(e)) return
    this.locked = false
    this.lastUnlock = how
    this.changed()
  }

  dispose(): void { for (const s of this.subs) s.dispose() }
}

/** What Follow reads of the features around it. */
export interface FollowPorts { journeys: () => Journeys; mapPanel: () => MapPanel; beats: () => Beats; tour: () => TourApi; log: () => vscode.LogOutputChannel }

/** What Follow asks of the player: the audio moved to where the reader went, paused, or the session over; a move
 *  made (the status item again). */
export interface FollowHost {
  seek(to: number): void
  pause(why: string, more?: { note?: string; resumeAt?: number }): void
  endSession(lj: LoadedJourney, why: string): void
  moved(lj: LoadedJourney): void
  /** The journey listened to (its podcast playable). */
  listening(): LoadedJourney | undefined
}

/** A move of the walk: to `view` of `lj`, `still` (no animation, no camera wait: a seek, a resync). */
interface Move { lj: LoadedJourney; view: View; still: boolean }

export class Follow implements vscode.Disposable {
  readonly lock: FollowLock
  /** The view the podcast asked for last (`id`: its step's id, so a journey edited under it keeps the step, not its
   *  number), and the beat it last set in the panel (undefined: none). */
  private want: (View & { id?: string }) | undefined
  private beatShown: number | undefined
  /** The segment whose view was applied last: while playing, the view changes only when the segment does. */
  private lastSeg = -1
  /** A seek's move, waiting for another seek (SEEK_SETTLE_MS), and where the walk was when it was asked for. */
  private seekTimer: NodeJS.Timeout | undefined
  private walkAtSeek: { key: string | undefined; step: number } | undefined
  /** Where the audio was last sought to (s): the code moves in the next NO_WAIT_AFTER_SEEK_S of audio are the
   *  reader's own (no camera wait). */
  private lastSeekT = -Infinity
  /** Moves being made now (the walk's changes meanwhile are the podcast's own). */
  private moving = 0
  /** Counts the walk's moves and the seeks: a mark's move under way stops when this changes (markScheduler.ts). */
  private turns = 0
  private readonly mover = new LatestWins<Move>((m, current) => this.move(m, current))
  /** The views a playing episode shows, per segment, by journey as loaded. */
  private calm = new WeakMap<LoadedJourney, { sig: string; views: View[] }>()
  /** What the step card last showed of the podcast (it is drawn again only when that changes). */
  private cardSig = ''
  private readonly moved = new vscode.EventEmitter<void>()
  /** A move of the walk was made (the integration tests count them). */
  readonly onDidMove = this.moved.event

  constructor(private readonly ports: FollowPorts, private readonly host: FollowHost, private readonly session: Session,
    private readonly library: PodcastLibrary, private readonly store: PodcastStore, private readonly camera: Camera) {
    this.lock = new FollowLock(() => this.drives(), (e) => this.narrated(e), () => this.lockChanged())
  }

  private get tour(): TourApi { return this.ports.tour() }

  /** What the walk shows of the podcast now (the test entry reads it). */
  get wanted(): (View & { id?: string }) | undefined { return this.want }
  get beat(): number | undefined { return this.beatShown }
  get applying(): number { return this.moving }
  /** A seek's move is on its way. */
  get seeking(): boolean { return !!this.seekTimer }
  /** Changes with every move of the walk and every seek. */
  get turn(): number { return this.turns }

  /** The podcast is playing and the walk on its journey follows it. */
  drives(): boolean {
    const lj = this.host.listening()
    return !!lj && this.session.playing && this.tour.state.key === lj.key
  }

  /** `e` shows the walk's code: in the walk's group, or showing the step's file or the lit beat's. */
  narrated(e: vscode.TextEditor): boolean {
    if (e.viewColumn === undefined || e.viewColumn === this.ports.mapPanel().viewColumn) return false
    const uri = e.document.uri.toString()
    return e.viewColumn === this.tour.state.walkGroup?.viewColumn || uri === this.tour.state.doc?.uri.toString() || uri === this.ports.beats().lit?.uri
  }

  /** The editor showing the narrated code. */
  narratedEditor(): vscode.TextEditor | undefined {
    return vscode.window.visibleTextEditors.find((e) => this.narrated(e))
  }

  /** The lock opened (the reader looked around) or closed: the card says so (Follow along). */
  private lockChanged(): void {
    if (!this.lock.locked) {
      // In a camera wait: it plays on at once (nothing of the reader's is moved); no heads-up over their code.
      this.camera.release()
      this.camera.clearCue()
      this.ports.log().info(`podcast: not following the voice (the reader ${this.lock.lastUnlock} in the code) until the next step`)
    }
    const lj = this.host.listening()
    if (lj) this.redrawCard(lj, true)
  }

  // ---------- audio → walk ----------

  /** The walk the way it is when a session starts (`step`: where the walk is; a new episode applies its view afresh). */
  start(step: number, fresh: boolean): void {
    if (fresh) this.lastSeg = -1
    this.want = { step }
  }

  /** Nothing listened to any more. */
  stop(): void { this.want = undefined }

  /** The session ended (it may be played again: its view is applied afresh then). */
  ended(): void { this.lastSeg = -1 }

  /** The audio was sought to `t`. */
  sought(t: number): void { this.lastSeekT = t }

  /** The reader sought a moment ago (their own move: never a camera wait). */
  justSought(): boolean {
    const lj = this.host.listening()
    const t = lj ? this.store.posOf(lj) : 0
    return t >= this.lastSeekT - SEEK_SLACK_S && t - this.lastSeekT < NO_WAIT_AFTER_SEEK_S
  }

  /** A seek reported at `t`: the view at exactly that time; of seeks in quick succession only the last moves the walk. */
  followSeek(lj: LoadedJourney, pod: Loaded, t: number): void {
    this.turns++
    const v = viewAt(pod.episode, t)
    const view = viewOf(v)
    this.lastSeg = v.seg
    this.want = withId(lj, view)
    clearTimeout(this.seekTimer)
    this.walkAtSeek = { key: this.tour.state.key, step: this.walkStep(lj) }
    this.seekTimer = setTimeout(() => {
      this.seekTimer = undefined
      this.mover.push({ lj, view, still: true })
    }, SEEK_SETTLE_MS)
  }

  /** Playing at `t`: the view changes only at a segment's start, and a short part in another file is held. */
  followPlay(lj: LoadedJourney, pod: Loaded, t: number): void {
    const v = viewAt(pod.episode, t)
    const view = v.seg === this.lastSeg && this.want ? viewOf(this.want) : this.calmView(lj, pod, v.seg)
    this.lastSeg = v.seg
    if (sameView(view, this.want) && (this.mover.busy || this.shows(lj, view))) return
    this.want = withId(lj, view)
    this.mover.push({ lj, view, still: false })
  }

  /** The walk put where the audio is at `t` at once (a camera wait dropped), as after a seek: no waits. */
  syncTo(lj: LoadedJourney, pod: Loaded, t: number): void {
    this.lastSeekT = Math.min(t, this.store.posOf(lj))
    const v = viewAt(pod.episode, t)
    const view = this.calmView(lj, pod, v.seg)
    this.lastSeg = v.seg
    // The walk there already (a mark's move dropped): nothing to move.
    if (sameView(view, this.want) && this.shows(lj, view)) return
    this.want = withId(lj, view)
    this.mover.push({ lj, view, still: true })
  }

  /** "Follow along": the editor follows again, and shows what the voice is showing now. */
  followAlong(): void {
    this.lock.relock()
    const lj = this.host.listening()
    const pod = lj && this.library.get(lj.key)
    if (!lj || !pod) return
    const view = viewOf(viewAt(pod.episode, this.store.posOf(lj)))
    this.want = withId(lj, view)
    this.mover.push({ lj, view, still: true })
  }

  /** A journey whose place was kept is the session again, paused at `t`: the view at that time is what it wants. */
  reopened(lj: LoadedJourney, ep: Episode, t: number): View {
    const v = viewAt(ep, t)
    this.lastSeg = v.seg
    this.want = withId(lj, viewOf(v))
    return v
  }

  /** The beat of view `v` set in the panel, still, when the walk is on its step. True when it was. */
  showStill(lj: LoadedJourney, v: View): boolean {
    if (!v.step || v.beat === undefined || !this.tour.touring() || !this.tour.state.isAt(lj, v.step)) return false
    this.beatShown = v.beat
    this.ports.mapPanel().send({ type: 'podcastBeat', n: v.step, i: v.beat, still: true })
    return true
  }

  /** The journey was read again after the step on screen was removed: the walk shows what the podcast says at `t`
   *  (its number may name another step now: it is opened whatever it is on). */
  afterRemoval(lj: LoadedJourney, pod: Loaded, t: number): void {
    const v = viewAt(pod.episode, t)
    const view = viewOf(v)
    this.lastSeg = v.seg
    this.want = withId(lj, view)
    this.tour.forgetStepId()
    this.mover.push({ lj, view, still: true })
  }

  /** After a reload, the walk restored on its step: the beat the podcast was at (`t`), lit. */
  restored(lj: LoadedJourney, pod: Loaded, t: number): void {
    if (!this.tour.touring() || this.tour.state.key !== lj.key) return
    const v = viewAt(pod.episode, t)
    if (v.step !== this.tour.state.step || v.beat === undefined) return
    this.beatShown = v.beat
    this.ports.mapPanel().send({ type: 'podcastBeat', n: v.step, i: v.beat, still: true })
    fireAndForget(this.tour.showBeat(lj, v.step, v.beat), 'podcast: showBeat')
  }

  /** The step the walk is on in `lj` (0: the map, or not walking it). */
  private walkStep(lj: LoadedJourney): number {
    return this.tour.touring() && this.tour.state.key === lj.key ? this.tour.state.step : 0
  }

  /** The walk shows `v` now. */
  private shows(lj: LoadedJourney, v: View): boolean {
    const onIt = this.tour.touring() && this.tour.state.key === lj.key
    if (!v.step) return !onIt
    return onIt && this.tour.state.step === v.step && this.beatShown === v.beat
  }

  /** The view a playing episode shows for segment `seg` (the view hold). */
  private calmView(lj: LoadedJourney, pod: Loaded, seg: number): View {
    return this.calmViews(lj, pod)[seg] ?? { step: 0 }
  }
  calmViews(lj: LoadedJourney, pod: Loaded): View[] {
    let c = this.calm.get(lj)
    if (!c || c.sig !== pod.sig) {
      c = { sig: pod.sig, views: calmViews(pod.episode, (v) => viewFile(lj, v)) }
      this.calm.set(lj, c)
    }
    return c.views
  }

  /** Where view `v` puts the code (file uri, 0-based line). */
  target(lj: LoadedJourney, v: View): { uri: string; line: number } | undefined {
    return viewTarget(lj, v, this.ports.journeys().renames(lj))
  }

  /** `v` against the journey as it is now: its step found by id (the episode may be from before the journey was
   *  edited, until it is read again). */
  private live(lj: LoadedJourney, v: View): View {
    const pod = this.library.get(lj.key)
    const id = v.step ? pod?.episode.segments.find((s) => s.step === v.step)?.stepId : undefined
    const n = id ? lj.j.steps.findIndex((s) => s.id === id) + 1 : v.step
    return n > 0 && n !== v.step ? { ...v, step: n } : v
  }

  /**
   * Puts the walk where the podcast is: the beat set first (the step then opens on it), then the step opened, then the
   * beat's line lit from here too (a panel too narrow for the animation, or none, still shows it). A step the walk is
   * on already is not opened again; a new step (or the map) makes the editor follow again.
   */
  private async move(m: Move, current: () => boolean): Promise<void> {
    const { lj } = m
    const view = this.live(lj, m.view)
    this.turns++
    this.moved.fire()
    this.moving++
    let onTheMap = false
    try {
      if (!view.step) {
        await this.lock.asOurs(() => this.toTheMap(lj))
        onTheMap = true
      } else await this.toView(lj, view, m.still, current)
    } catch (e) {
      this.ports.log().error(`podcast: ${e}`)
    } finally {
      this.moving--
    }
    if (onTheMap) return
    // The status item says the step only while the walk isn't on it: the report before this move drew it elsewhere.
    this.host.moved(lj)
    this.redrawCard(lj)
    // A move of the reader's that came in meanwhile (ignored then): the audio goes there now.
    if (current()) this.walkMoved(true)
  }

  /** The map, no step: the walk ends, and the code tabs it opened go with it (the map gets the room). */
  private async toTheMap(lj: LoadedJourney): Promise<void> {
    this.lock.relock()
    this.beatShown = undefined
    this.ports.mapPanel().send({ type: 'podcastBeat', n: 0, i: -1 })
    if (!this.tour.touring() || this.tour.state.key !== lj.key) return
    const doc = this.tour.state.doc
    await this.tour.endJourney()
    await this.tour.closeWalkTabs(lj, doc?.column)
    await this.tour.closeWalkTabs(lj, this.tour.state.walkGroup?.viewColumn)
  }

  /** To a step's view: through a camera move (the read time and the settle) when it plays into code out of view. */
  private async toView(lj: LoadedJourney, view: View, still: boolean, current: () => boolean): Promise<void> {
    const stepId = lj.j.steps[view.step - 1]?.id
    const onStep = this.tour.touring() && this.tour.state.isAt(lj, view.step) && this.tour.state.stepId === stepId
    const where = this.cameraMove(lj, view, still)
    if (!onStep) this.lock.relock()
    const go = () => this.lock.asOurs(() => this.applyView(lj, view, still, onStep, current))
    if (where) await this.camera.move(go, where, true)
    else { await go(); this.camera.lit() }
  }

  private async applyView(lj: LoadedJourney, view: View, still: boolean, onStep: boolean, current: () => boolean): Promise<void> {
    this.beatShown = view.beat
    this.ports.mapPanel().send({ type: 'podcastBeat', n: view.step, i: view.beat ?? -1, ...(still ? { still: true } : {}) })
    if (!onStep) {
      // On a beat whose code is in another file, that file opens (the beat's), not the step's first.
      const added = await groupsAdded(() => this.tour.goToStep(lj, view.step, { focus: false, beat: view.beat }))
      // The code group came back (the map had the editor to itself): beside the panel at the reader's width.
      if (added) await this.tour.codeGetsMoreRoom()
    }
    if (view.beat !== undefined && current()) await this.tour.showBeat(lj, view.step, view.beat)
  }

  /** Where a move of the walk to `view` goes when it is a camera move that waits ("↓ 340", "→ main.ts"); undefined:
   *  none (a seek, paused, the map, not following, its code on screen already). */
  private cameraMove(lj: LoadedJourney, view: View, still: boolean): string | undefined {
    if (still || !this.session.playing || !view.step || !this.lock.locked || this.justSought()) return undefined
    const tg = this.target(lj, view)
    const ed = this.narratedEditor()
    return tg && ed ? cueText(ed, tg.uri, tg.line)?.text : undefined
  }

  // ---------- walk → audio ----------

  /** The walk moved. The reader's own move (not the podcast's): the audio goes to the first part about the step; a
   *  step it never talks about pauses it; the walk ended, or another journey, ends the session (its place is kept). */
  walkMoved(afterMove = false): void {
    const lj = this.host.listening()
    const elsewhere = !this.tour.touring() || this.tour.state.key !== lj?.key
    // The walk left the journey while a camera wait holds a move: the move is dropped (it would reopen it).
    if (lj && this.camera.waiting && elsewhere) this.camera.cancel()
    if (!lj || this.moving || (this.mover.busy && !afterMove)) return
    const step = this.walkStep(lj)
    if (this.seekPending(lj, step)) return
    const id = step ? lj.j.steps[step - 1]?.id : undefined
    // The same step, maybe under another number (the journey was edited).
    if (this.want && (step === this.want.step || (id !== undefined && id === this.want.id))) {
      if (this.want.step !== step) this.want = { ...this.want, step }
      return
    }
    if (!step) this.walkLeft(lj)
    else this.walkWentTo(lj, step)
  }

  /** A seek's move is on its way (SEEK_SETTLE_MS): the walk is not where the podcast is yet, and that is not the
   *  reader; but the walk ended, or another journey, is, and the pending move is dropped. */
  private seekPending(lj: LoadedJourney, step: number): boolean {
    if (!this.seekTimer) return false
    const was = this.walkAtSeek
    const unchanged = !!was && was.key === this.tour.state.key && was.step === step
    if (unchanged || (step && this.tour.state.key === lj.key)) return true
    clearTimeout(this.seekTimer)
    this.seekTimer = undefined
    return false
  }

  /** Another journey, or the walk ended: the podcast stops; its place is kept (stored now: the host's pause report may
   *  come once the session is over). */
  private walkLeft(lj: LoadedJourney): void {
    const key = this.tour.state.key
    const other = key !== lj.key ? this.ports.journeys().list.get(key ?? '') : undefined
    const why = other ? `opened the journey “${other.j.title}”` : 'the walk ended'
    this.want = { step: 0 }
    this.store.save(lj, this.store.posOf(lj), true)
    this.host.pause(why)
    this.host.endSession(lj, why)
  }

  /** The reader went to step `step` of the journey listened to: the audio to its first part, or paused there when the
   *  podcast skips it (▶ goes on after the step). */
  private walkWentTo(lj: LoadedJourney, step: number): void {
    const ep = this.library.get(lj.key)!.episode
    const t = timeOf(ep, step)
    if (t === undefined) {
      this.want = withId(lj, { step })
      const after = afterStep(ep, step)
      this.host.pause(`step ${step} isn't in the podcast`, { note: `Step ${step} isn't in the podcast`, ...(after === undefined ? {} : { resumeAt: after }) })
      return
    }
    const v = viewAt(ep, t)
    this.want = withId(lj, viewOf(v))
    this.lastSeg = v.seg
    this.host.seek(t)
  }

  /** A beat of the animation shown by the reader (‹ › in the animation): the audio goes to the first part about that
   *  beat; a beat it doesn't narrate is shown and the audio pauses, as a step it skips. */
  onBeat(lj: LoadedJourney, n: number, i: number): void {
    if (!this.acceptsReaderBeat(lj, n, i)) return
    this.beatShown = i
    const ep = this.library.get(lj.key)!.episode
    const t = timeOf(ep, n, i)
    this.want = withId(lj, { step: n, beat: i })
    if (t === undefined) {
      const next = ep.segments.find((s) => s.step === n && s.beat !== undefined && s.beat > i)?.start ?? afterStep(ep, n)
      this.host.pause(`beat ${i + 1} of step ${n} isn't narrated`, { note: `Beat ${i + 1} isn't narrated`, ...(next === undefined ? {} : { resumeAt: next }) })
      return
    }
    this.lastSeg = viewAt(ep, t).seg
    this.host.seek(t)
  }

  /** Beat `i` of step `n` is the reader's pick: the journey listened to, on that step, no move of the podcast's
   *  under way, and a beat other than the one shown. */
  private acceptsReaderBeat(lj: LoadedJourney, n: number, i: number): boolean {
    if (!this.session.is(lj.key) || i < 0 || i === this.beatShown) return false
    const podcastMoving = this.moving > 0 || this.mover.busy || !!this.seekTimer
    const onTheStep = n === this.tour.state.step && this.tour.state.key === lj.key
    return !podcastMoving && onTheStep
  }

  // ---------- the step card ----------

  /** What the step card shows of the podcast on step n: only on the podcast's journey. */
  narration(lj: LoadedJourney, n: number): Narration | undefined {
    if (!this.session.is(lj.key) || !this.host.listening()) return undefined
    const beats = lj.j.steps[n - 1]?.scene?.beats?.length ?? 0
    const beat = this.want?.step === n ? this.beatShown : undefined
    return { playing: this.session.playing, following: this.lock.locked, beats, key: lj.key, ...(beat === undefined ? {} : { beat }) }
  }

  /** The step card again when what it shows of the podcast changed (playing, following, the beat). */
  redrawCard(lj: LoadedJourney, always = false): void {
    if (!this.tour.touring() || this.tour.state.key !== lj.key) return
    const n = this.narration(lj, this.tour.state.step)
    const sig = n ? `${n.playing}|${n.following}|${n.beat}` : ''
    if (!always && sig === this.cardSig) return
    this.cardSig = sig
    // The card growing or shrinking (paused: the full card) scrolls the code: the extension's, not the reader's.
    this.lock.asOurs(() => this.tour.showCard(lj, this.tour.state.step))
  }

  dispose(): void {
    clearTimeout(this.seekTimer)
    this.lock.dispose()
    this.moved.dispose()
  }
}

/** Runs `f`; true when editor groups were added meanwhile (the code group came back beside the map). */
async function groupsAdded(f: () => Promise<void>): Promise<boolean> {
  const before = vscode.window.tabGroups.all.length
  await f()
  return vscode.window.tabGroups.all.length > before
}
