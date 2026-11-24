// Listening: a journey with a podcast file next to it (`<journey>.podcast.json`, docs/podcast-format.md) plays in the
// Listen view (listenView.ts: the audio lives there, so it outlives the journey panel; media/journey-podcast.js), the
// panel's player is a remote of it (its asks come here and go on to the view; the view's state goes back to it), and
// the status item, there only while the panel is not on screen, is one too (click: the journey's map). The walk
// follows the voice: at every time the panel reports, the view at that time (model.ts viewAt) is applied the way a reader's own move is
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
// question being written pauses it; the journey edited under it keeps the step (by id), not its number. Marks
// (marks.ts) light parts of the code as the words are said.

import * as vscode from 'vscode'
import { beats, journeys, KEY, log, mapPanel, stored } from '../app'
import { fileOf, LoadedJourney, posKey } from '../journeys/steps'
import { closeWalkTabs, endJourney, openMap } from '../tour/commands'
import { card, tourState, walk } from '../tour/instances'
import { showBeat } from '../tour/mapMessages'
import { codeGetsMoreRoom, panelLayout } from '../tour/panelLayout'
import { FollowLock } from './follow'
import type { Narration } from '../tour/card'
import { pickJourney } from '../tour/pick'
import { journeysTree } from '../sidebar/journeysTree'
import { calmViews, clock, Episode, markTimes, planMarks, podcastFileOf, PodcastProblem, sameView, segmentAt, timeOf, View, viewAt } from '../core/format/podcast/model'
import { MarkLights, PlannedMark } from './marks'
import { Camera, CUE_LEAD_S, cueText } from './camera'
import { showInCodeGroup, stepFileUri } from '../journeys/codeGroup'
import { baseName } from '../core/paths'
import { podcastReports, PodcastRead, readPodcast, strayPodcasts } from './load'
import { afterStep, remapTime, resumeTime } from './resume'
import { brokenLinks, playNotice } from '../core/format/podcast/validate'
import { LISTENING_CTX, ListenMessage, ListenView } from './listenView'
import { setCtx } from '../app'
import { fireAndForget } from '../platform/run'
import { LatestWins } from '../core/serial'
import { STATE } from '../platform/state'
import { Cmd } from '../platform/commands'

/** While playing, where it is is stored this often (ms). */
const SAVE_EVERY_MS = 5000
const SKIP_S = 15
/** After the podcast asks for a seek or a pause, the panel's reports from before it are ignored for at most this long (ms). */
const STALE_MS = 1500
/** A seek's move waits this long for another seek (⏭ ⏭ pressed quickly: only the last target opens, F86). */
export const SEEK_SETTLE_MS = 250
/** For this much audio after a seek (s) the code moves without a camera wait (the reader moved it). */
const NO_WAIT_AFTER_SEEK_S = 1.5
/** The Listen view goes this long (ms) after the last journey stopped being listened to (another may start). */
const LISTENING_OFF_MS = 3000

/** A journey's podcast, read and checked against the journey. `notice`: one line about what is wrong with it (the
 *  panel and the row's tooltip say it); `lastGood`: the file has errors now, this is the version read before. */
interface Loaded { file: vscode.Uri; audio: vscode.Uri; audioSize: number; ep: Episode; sig: string; problems: PodcastProblem[]; notice?: string; lastGood?: boolean }
/** A podcast file next to a journey that can't be played, and why (its first error). */
interface Broken { file: vscode.Uri; reason: string }

/** What the panel says over a podcast that plays from its last good version. */
const LAST_GOOD = 'The podcast file has errors: playing the last good version'

/** What the panel sends about the audio (MapMessage podcastTime): `of`, the journey (key) whose audio it is. */
export interface TimeReport { t: number; playing: boolean; held?: boolean; rate?: number; seek?: boolean; of?: string; sent?: number }
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
  /** The view the podcast asked for last (`id`: its step's id, so a journey edited under it keeps the step, not its
   *  number: F105), and the beat it last set in the panel (undefined: none). */
  private want: (View & { id?: string }) | undefined
  private beatShown: number | undefined
  /** The segment whose view was applied last: while playing, the view changes only when the segment does. */
  private lastSeg = -1
  /** A seek's move, waiting for another seek (SEEK_SETTLE_MS), and where the walk was when it was asked for. */
  private seekTimer: NodeJS.Timeout | undefined
  private walkAtSeek: { key: string | undefined; step: number } | undefined
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
  private asked: { kind: 'seek' | 'pause'; at: number; key?: string } | undefined
  /** "Show why" asked (tests). */
  private whyShown = 0
  /** The Listen view, where the audio mostly plays; the journey whose episode the host has loaded, and its last state. */
  listen!: ListenView
  private hostKey: string | undefined
  private hostState: HostState | undefined
  /**
   * Where the audio plays: the Listen view, or the journey panel. VS Code's window lets a webview's audio play only
   * once a click or a key in that webview started it (an element unlocked once stays unlocked; a click in the
   * workbench or in another webview does not count). Each player says when it is unlocked; the audio goes to the
   * panel when only the panel's is (its ▶ was pressed, or a start found the Listen view's locked: then the panel's ▶
   * takes the keyboard), and back to the Listen view when the panel goes.
   */
  private hostIn: 'listen' | 'panel' = 'listen'
  private unlocked = { listen: false, panel: false }
  /** The marks lit (marks.ts); the segment they are of and how it was reached (played into: the view hold's view;
   *  sought: its own view); the timer that lights the next one on time while playing; each segment's plan. */
  lights!: MarkLights
  private markSeg = -1
  private markMode: 'calm' | 'exact' = 'calm'
  private markTimer: NodeJS.Timeout | undefined
  private plans = new Map<string, PlannedMark[]>()
  /** Camera moves (camera.ts): the read time before the code moves, the settle after, the heads-up. */
  camera!: Camera
  /** Where the audio was last sought to (s): the code moves in the next NO_WAIT_AFTER_SEEK_S of audio are the
   *  reader's own (no camera wait). */
  private lastSeekT = -Infinity
  /** The audio itself is playing (not in a camera hold), as last reported; that report and when it came (ms). */
  private audible = false
  private lastReport: { key: string; t: number; playing: boolean; rate: number; at: number } | undefined
  /** The quickest report's (arrival − sent) (ms), and when it was measured: what a report is late by is beyond it. */
  private clockCur = Infinity
  private clockPrev = Infinity
  private clockOffAt = 0
  /** A time report waiting for the others that came with it (only the newest of a run is applied). */
  private queued: { shown: LoadedJourney; m: TimeReport; at: number } | undefined

  init(context: vscode.ExtensionContext): void {
    this.item = vscode.window.createStatusBarItem('codeNotes.listen', vscode.StatusBarAlignment.Left, 49.25)
    this.item.name = 'Listen'
    this.item.command = Cmd.podcastOpen
    this.listen = new ListenView(context.extensionUri, log, (m) => this.onHost(m))
    this.listen.onGone = () => this.hostGone()
    context.subscriptions.push(this.item, this.listen, this.listen.register(), journeys.onDidChange(() => fireAndForget(this.scan(), 'player: scan')))
    podcastReports.init(context, () => fireAndForget(this.scan(), 'player: scan'))
    mapPanel.podcastFor = (lj, toUri) => { this.panelShows(lj); this.listen.send({ type: 'panel', key: lj.key }); return this.episodeFor(lj, toUri) }
    // An episode on: the panel beside the code at the listening width (Q15), from its start (the panel opened for it).
    panelLayout.episodeOn = () => !!this.sessionJourney() || this.starting
    mapPanel.podcastStateFor = (lj) => this.stateFor(lj)
    // The status item is there only while the panel (its player) is not on screen.
    mapPanel.viewChanged = () => this.renderItem()
    walk.onMoved = () => this.walkMoved()
    walk.onStepRemoved = (lj) => this.stepRemoved(lj)
    walk.transport = (dir) => this.transport(dir)
    walk.podcastOn = (lj) => this.session === lj.key && !!this.sessionJourney()
    walk.onRestored = (lj) => this.restored(lj)
    card.narration = (lj, n) => this.narration(lj, n)
    this.follow = new FollowLock(() => this.drives(), (e) => this.narrated(e), () => this.followChanged())
    walk.following = () => this.follow.locked || !this.drives()
    beats.follow = walk.following
    this.lights = new MarkLights(log)
    this.camera = new Camera({
      hold: () => this.toHost({ type: 'podcastCmd', action: 'pause', hold: true }),
      resume: () => this.toHost({ type: 'podcastCmd', action: 'unhold' }),
      audio: () => ({ t: this.audioNow(), playing: this.audible }),
      resync: () => this.resync(),
      log: (line) => log.info(line),
    })
    context.subscriptions.push(this.camera, this.follow, this.lights, { dispose: () => { clearTimeout(this.seekTimer); clearTimeout(this.markTimer); clearTimeout(this.listeningOff) } })
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

  /** The lock opened (the reader looked around) or closed: the card says so (Follow along). */
  private followChanged(): void {
    const lj = this.sessionJourney()
    if (!this.follow.locked) {
      // In a camera wait: it plays on at once (nothing of the reader's is moved).
      this.camera.release()
      log.info(`podcast: not following the voice (the reader ${this.follow.lastUnlock} in the code) until the next step`)
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
    fireAndForget(this.strays(), 'player: strays')
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
      this.clearMarks()
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
    const fault = this.audioFault.get(`${audio.path}:${r.audioSize}`)
    const notice = fault ?? playNotice(r.v.problems)
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
      rate: stored.get(STATE.podcastRate),
      muted: !!stored.get(STATE.podcastMuted),
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
  /** The journey the panel's player was last given (undefined: the panel closed). */
  private panelKey: string | undefined
  /** Listen to Journey is opening the journey's panel (its width is the listening one). */
  private starting = false
  /** Episodes on their way to the Listen view (it is being made for them). */
  private hostLoading = 0
  private stateFor(lj: LoadedJourney): HostState | undefined {
    if (!this.eps.has(lj.key)) return undefined
    if (this.hostKey === lj.key && this.hostState?.of === lj.key) return this.hostState
    // Not in the host yet: loaded there now (its length is checked, ▶ starts at once), unless another journey's
    // episode is in it.
    if (!this.sessionJourney() && this.listen.alive && this.hostIn === 'listen') fireAndForget(this.loadHost(lj), 'player: loadHost')
    // The panel newly showing a journey whose place was kept, nothing listened to: the session again, paused there
    // (a podcast file read again sends this too: that is no reopening).
    if (this.panelKey !== lj.key) this.reopened(lj, this.eps.get(lj.key)!.ep)
    this.panelKey = lj.key
    return { of: lj.key, t: this.posOf(lj), playing: false }
  }

  // ---------- the Listen view: the audio ----------

  /** Journey `lj`'s episode into the host (the Listen view made first; the panel when only its audio may play, and it
   *  shows `lj`); `play`: it plays once loaded, from `at`. */
  private async loadHost(lj: LoadedJourney, o: { play?: boolean; at?: number; until?: number } = {}): Promise<boolean> {
    this.hostLoading++
    try {
      if (!(await this.listen.ensure())) return false
    } finally { this.hostLoading-- }
    const play = { at: o.at ?? this.posOf(lj), play: !!o.play || o.until !== undefined, ...(o.until !== undefined ? { until: o.until } : {}) }
    if (this.panelPlays(lj.key)) { this.moveHost('panel', lj, play); return true }
    if (this.hostIn === 'panel') { this.moveHost('listen', lj, play); return true }
    const episode = this.episodeFor(lj, (u) => this.listen.toUri(u), true) as Record<string, unknown> | undefined
    if (!episode || episode.unavailable) return false
    this.hostKey = lj.key
    this.hostState = undefined
    this.listen.send({ type: 'podcast', episode: { ...episode, ...(o.at !== undefined ? { at: o.at } : {}), ...(o.play ? { play: true } : {}) } })
    if (o.until !== undefined) this.command('play', { ...(o.at !== undefined ? { at: o.at } : {}), until: o.until })
    return true
  }

  /** The podcast files were read again: the Listen view's episode follows (the same audio keeps playing; one that
   *  went or can't be played now leaves the view). The panel's comes with the panel's own update. */
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
      case 'podcastTime': case 'podcastState': case 'podcastError': case 'podcastMeta':
        if (this.hostIn === 'listen') this.hostSays(m)
        break
      case 'podcastUnlocked': this.unlocked.listen = true; break
      case 'podcastAsk': {
        const lj = (m.of && journeys.list.get(m.of)) || (this.hostKey ? journeys.list.get(this.hostKey) : undefined)
        if (lj) fireAndForget(this.onAsk(lj, m), 'player: onAsk')
        break
      }
      case 'podcastWhy': fireAndForget(this.showWhy(shown ?? (this.hostKey ? journeys.list.get(this.hostKey) : undefined)), 'player: showWhy'); break
      case 'podcastOpen': fireAndForget(this.openSessionMap(), 'player: openSessionMap'); break
      case 'podcastEnd': { const lj = (m.of && journeys.list.get(m.of)) || this.sessionJourney(); if (lj) fireAndForget(this.onEnd(lj, m.action), 'player: onEnd') } break
      case 'ready':
        // A new page (the view was made again): its audio locked, no episode until it is sent one. While the panel
        // plays the audio, it is the panel's remote. The journey the panel shows (it has the player then).
        this.unlocked.listen = false
        this.listen.send({ type: 'panel', key: mapPanel.journey?.key })
        if (this.hostIn === 'panel') {
          const lj = this.hostKey ? journeys.list.get(this.hostKey) : undefined
          this.listen.send({ type: 'podcastRole', role: 'remote' })
          if (lj) this.listen.send({ type: 'podcast', episode: this.episodeFor(lj, (u) => this.listen.toUri(u)) })
          break
        }
        this.hostKey = undefined
        this.hostState = undefined
        // The view made again while a journey is listened to (paused), not for an episode on its way: that episode.
        if (this.sessionJourney() && !this.hostLoading) fireAndForget(this.loadHost(this.sessionJourney()!), 'player: loadHost')
        break
    }
  }

  /** What the host says (the Listen view, or the panel playing the audio). */
  private hostSays(m: { type: string; of?: string; [k: string]: unknown }): void {
    const shown = m.of ? journeys.list.get(m.of) : undefined
    switch (m.type) {
      case 'podcastTime': if (shown) this.timeReport(shown, m as unknown as TimeReport); break
      case 'podcastState': this.onState(m as unknown as HostState); break
      case 'podcastError': this.onError(shown, String(m.message), m.of); break
      case 'podcastMeta': if (shown) this.onAudioMeta(shown, Number(m.duration), m.of); break
    }
  }

  /** What the panel's player says of the audio: unlocked (a click or key there), and, while it is the host, where the
   *  audio is (a remote's or an older page's reports are not the audio's). */
  fromPanel(m: { type: string; of?: string; [k: string]: unknown }): void {
    if (m.type === 'podcastUnlocked') { this.unlocked.panel = true; return }
    if (this.hostIn === 'panel') this.hostSays(m)
  }

  /** The audio may play in the panel and not in the Listen view, and the panel shows journey `key`. */
  private panelPlays(key: string): boolean {
    return !this.unlocked.listen && this.unlocked.panel && mapPanel.journey?.key === key
  }

  /** Where `lj`'s audio is now: playing, its time; else where it was left. */
  private nowOf(lj: LoadedJourney): number {
    return this.session === lj.key && this.hostKey === lj.key ? this.audioNow() : this.posOf(lj)
  }

  /** A message for the audio's host. */
  private toHost(m: unknown): void {
    if (this.hostIn === 'panel') mapPanel.send(m)
    else this.listen.send(m)
  }

  /** The host is there and takes commands. */
  private hostAlive(): boolean {
    return this.hostIn === 'panel' ? !!this.hostKey && mapPanel.journey?.key === this.hostKey : this.listen.alive
  }

  /** The audio of `lj` to `to` (at `o.at`, playing if `o.play`; one step if `o.until`): the other player becomes its
   *  remote, the Listen view showing the same episode. */
  private moveHost(to: 'listen' | 'panel', lj: LoadedJourney, o: { at?: number; play?: boolean; until?: number }): void {
    const from = this.hostIn
    if (from !== to) {
      if (from === 'listen') this.listen.send({ type: 'podcastRole', role: 'remote' })
      else if (mapPanel.journey) mapPanel.send({ type: 'podcastRole', role: 'remote' })
    }
    this.hostIn = to
    this.hostKey = lj.key
    this.hostState = undefined
    this.listen.send({ type: 'podcast', episode: this.episodeFor(lj, (u) => this.listen.toUri(u)) })
    this.toHost({ type: 'podcastRole', role: 'host', ...o })
    log.info(`podcast ${lj.j.id}: the audio plays in the ${to === 'panel' ? 'journey panel' : 'Listen view'}${o.play ? '' : ' (paused)'}`)
  }

  /** The panel is about to show `lj`: playing another journey's audio, that audio goes to the Listen view first. */
  private panelShows(lj: LoadedJourney): void {
    if (this.hostIn !== 'panel' || !this.hostKey || this.hostKey === lj.key) return
    const was = journeys.list.get(this.hostKey)
    if (was) this.moveHost('listen', was, { at: this.nowOf(was), play: this.playing })
    else this.hostIn = 'listen'
  }

  /**
   * The host's audio may not play (no click or key in it yet). Started in the Listen view, with the panel showing the
   * journey: the audio goes to the panel, playing when the panel's audio may, else paused there with its ▶ taking the
   * keyboard, so Space or one click there plays it.
   */
  private notAllowed(): void {
    const lj = this.hostKey ? journeys.list.get(this.hostKey) : undefined
    if (!lj || mapPanel.journey?.key !== lj.key) return
    if (this.hostIn === 'listen') this.moveHost('panel', lj, { at: this.nowOf(lj), play: this.unlocked.panel })
    if (this.unlocked.panel) return
    walk.showMap(lj, false)
    mapPanel.send({ type: 'podcastCmd', action: 'focus' })
  }

  /**
   * A time report from the audio. Reports come four or five times a second; when the extension is slow to take them
   * (a busy extension host, a remote window) they pile up, and taking each in turn would keep the walk behind the
   * voice. So a run of reports that only say "playing on, here" is applied once, its newest; a seek, or a change of
   * playing, is applied as it comes (after the run before it).
   */
  private timeReport(shown: LoadedJourney, m: TimeReport): void {
    const at = Date.now()
    // How long it took to come: its age beyond the quickest report's (the two clocks may differ: a remote window).
    // Playing, the audio is that much further on now.
    if (typeof m.sent === 'number' && m.playing && !m.seek) {
      // The quickest of the last 30 to 60 s: a clock that jumped is followed within a minute.
      const off = at - m.sent
      if (at - this.clockOffAt > 30000) { this.clockPrev = this.clockCur; this.clockCur = off; this.clockOffAt = at }
      this.clockCur = Math.min(this.clockCur, off)
      const late = Math.min(10000, off - Math.min(this.clockCur, this.clockPrev))
      if (late > 20) m = { ...m, t: m.t + (late / 1000) * (m.rate || 1) }
    }
    const q = this.queued
    const plain = (x: TimeReport) => !x.seek
    if (q && (!plain(m) || q.m.playing !== m.playing || !!q.m.held !== !!m.held || q.m.of !== m.of)) this.flushTime()
    if (!plain(m)) { this.onTime(shown, m, at); return }
    const first = !this.queued
    this.queued = { shown, m, at }
    if (first) setImmediate(() => this.flushTime())
  }
  private flushTime(): void {
    const q = this.queued
    this.queued = undefined
    if (q) this.onTime(q.shown, q.m, q.at)
  }

  /** Where the audio is now (s): its last report, moved on by the time since when it is playing. */
  private audioNow(): number {
    const r = this.lastReport
    if (!r || r.key !== this.session) return this.t
    return r.playing ? r.t + ((Date.now() - r.at) / 1000) * (r.rate || 1) : r.t
  }

  /**
   * The walk put where the audio is now (a camera wait dropped: the audio did not hold, or the reader played on or
   * looked around): its view and its marks at that time, at once and without waits (as after a seek), never the
   * moves that waited.
   */
  private resync(): void {
    const lj = this.sessionJourney()
    const l = lj && this.eps.get(lj.key)
    if (!lj || !l) return
    this.asked = undefined
    const t = this.audioNow()
    // The next moments of audio are as after a seek: the code goes there without waits.
    this.lastSeekT = Math.min(t, this.posOf(lj))
    const v = viewAt(l.ep, t)
    const view = this.calmView(lj, l, v.seg)
    this.lastSeg = v.seg
    // The walk there already (a mark's move dropped): only the marks again.
    if (!(sameView(view, this.want) && this.shows(lj, view))) {
      this.want = this.withId(lj, view)
      this.mover.push({ lj, view, still: true })
    }
    this.lights.again()
    this.showMarks(lj, l, t, false, this.playing, this.lastReport?.rate)
  }

  /** The audio's state: kept (a reopened panel draws it), the muting remembered, and passed on to the panel. */
  private onState(m: HostState): void {
    if (!m || m.of !== this.hostKey) return
    this.hostState = m
    if (typeof m.muted === 'boolean' && m.muted !== !!stored.get(STATE.podcastMuted)) fireAndForget(stored.set(STATE.podcastMuted, m.muted), 'player: store podcastMuted')
    // To the remote: the panel (when it shows that journey), or the Listen view.
    if (this.hostIn === 'panel') this.listen.send({ type: 'podcastState', ...m })
    else if (mapPanel.journey?.key === m.of) mapPanel.send({ type: 'podcastState', ...m })
    // The end of the episode: the row and the status item say so.
    if (m.ended !== this.ended) { this.ended = !!m.ended; this.renderItem(); journeysTree?.refresh() }
  }
  private ended = false
  /** The journey the rows last showed as listened to. */
  private rowSession: string | undefined

  /** What a remote player asks: the panel's (the audio in the Listen view), or the Listen view's (the audio in the
   *  panel). */
  async onAsk(lj: LoadedJourney, m: AskMessage): Promise<void> {
    const key = m.of && journeys.list.get(m.of) ? m.of : lj.key
    const j = journeys.list.get(key)!
    if (!this.eps.has(key)) return
    const loaded = this.hostKey === key && this.hostAlive()
    const { action } = m
    if (action === 'play' || action === 'toggle') {
      // A ▶ in the panel while only the panel's audio may play: play() moves it there.
      if (loaded && this.session === key && !(this.hostIn === 'listen' && this.panelPlays(key))) {
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
    this.unlocked.listen = false
    // The panel has the audio, or an episode is on its way to a new view: nothing went with it.
    if (this.hostIn === 'panel' || this.hostLoading) return
    const lj = this.sessionJourney()
    if (lj) this.savePos(lj, this.posOf(lj), true)
    this.hostKey = undefined
    this.hostState = undefined
    this.session = undefined
    this.playing = false
    this.want = undefined
    this.clearMarks()
    this.renderItem()
  }

  /** The status item's click, the Listen view's title: the listened journey's map (its player shows where it is). */
  async openSessionMap(): Promise<void> {
    const lj = this.sessionJourney() ?? (this.hostKey ? journeys.list.get(this.hostKey) : undefined)
    if (!lj) { await this.play(); return }
    if (mapPanel.journey?.key !== lj.key) await openMap(lj)
    else walk.showMap(lj, true)
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
    fireAndForget(this.scan(), 'player: scan')
  }

  /** "Show why" in the panel (or on a podcast that can't be played): the Problems view, on the podcast file. */
  async showWhy(lj?: LoadedJourney): Promise<void> {
    this.whyShown++
    const j = lj ?? mapPanel.journey
    const file = j && (this.eps.get(j.key)?.file ?? this.broken.get(j.key)?.file)
    await vscode.commands.executeCommand('workbench.actions.view.problems')
    if (file && !podcastReports.of(file).length) log.show(true)
  }

  private positions(): Record<string, number> { return stored.get(STATE.podcastPos) }
  /** Where `lj`'s podcast is: as last reported, else as stored, else the start. */
  posOf(lj: LoadedJourney): number { return this.pos.get(lj.key) ?? this.positions()[posKey(lj)] ?? 0 }
  /** Kept in memory at once; stored when `store` (a pause, a seek, leaving) or every SAVE_EVERY_MS. */
  private savePos(lj: LoadedJourney, t: number, store = false): void {
    this.pos.set(lj.key, t)
    if (!store && Date.now() - this.lastSave < SAVE_EVERY_MS) return
    this.lastSave = Date.now()
    fireAndForget(stored.set(STATE.podcastPos, { ...this.positions(), [posKey(lj)]: Math.round(t * 10) / 10 }), 'player: store podcastPos')
  }
  /** The session's time (the status bar's). */
  private get t(): number {
    const lj = this.sessionJourney()
    return lj ? this.posOf(lj) : 0
  }

  // ---------- audio → journey ----------

  /** The panel says where the audio is. Playing (or seeking), the walk goes where the podcast is at that time. */
  onTime(shown: LoadedJourney, m: TimeReport, at = Date.now()): void {
    // The journey the audio is of (the panel may have moved on to another one since it said it).
    const lj = (m.of && journeys.list.get(m.of)) || shown
    const l = this.eps.get(lj.key)
    if (!l) return
    // A report from before the seek or pause just asked for (the walk would go back there for a moment): ignored.
    const asked = this.asked
    // (Also once the session is over: a playing report from before an End Journey must not start it again.)
    if (asked && (lj.key === this.session || lj.key === asked.key)) {
      const answers = asked.kind === 'seek' ? !!m.seek : !m.playing
      if (!answers && Date.now() - asked.at < STALE_MS) return
      this.asked = undefined
    }
    // Listening: the audio plays, or it is held for a camera wait (camera.ts: that is no pause, and nothing says one).
    const on = m.playing || !!m.held
    const wasPlaying = lj.key === this.session && this.playing
    const wasAudible = lj.key === this.session && this.audible
    // A seek drops a camera wait (the reader went elsewhere); the reader's pause too; the audio playing again by
    // itself during one (the reader played on) ends it; a pause takes the heads-up away.
    if (m.seek) { this.lastSeekT = m.t; this.camera.cancel(); this.camera.reset() }
    else if (!on) this.camera.cancel()
    else if (m.playing && !wasAudible) this.camera.played()
    if (m.rate && m.rate !== stored.get(STATE.podcastRate)) fireAndForget(stored.set(STATE.podcastRate, m.rate), 'player: store podcastRate')
    this.savePos(lj, m.t, (wasPlaying && !on) || !!m.seek)
    if (on) this.session = lj.key
    if (this.session !== lj.key) return
    this.lastReport = { key: lj.key, t: m.t, playing: m.playing, rate: m.rate || 1, at }
    this.audible = m.playing
    // The Journeys row says listening or paused.
    if (this.playing !== on || this.rowSession !== lj.key) { this.rowSession = lj.key; setTimeout(() => journeysTree?.refresh(), 0) }
    this.playing = on
    if (wasPlaying !== on) this.saidState(lj, m.t)
    this.renderItem()
    this.redrawCard(lj)
    // In a hold the marks stand where they are (the audio stands still).
    this.showMarks(lj, l, m.t, !!m.seek, m.playing, m.rate)
    // Paused (or held) and not moved: the walk is the reader's (or the camera's).
    if (!m.playing && !m.seek) return
    const v = viewAt(l.ep, m.t)
    if (m.seek) {
      // A seek shows exactly its time; of seeks in quick succession only the last moves the walk.
      const view: View = v.beat === undefined ? { step: v.step } : { step: v.step, beat: v.beat }
      this.lastSeg = v.seg
      this.want = this.withId(lj, view)
      clearTimeout(this.seekTimer)
      this.walkAtSeek = { key: tourState.key, step: walk.touring() && tourState.key === lj.key ? tourState.step : 0 }
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

  // ---------- marks ----------

  /**
   * The marks at second `t` (marks.ts): exactly those lit by then in the segment playing then. A segment reached by
   * a seek shows its own view, one played into the view the hold kept (that decides which file a mark may open).
   * Playing, the next mark is lit on time by a timer (reports come about four times a second).
   */
  private showMarks(lj: LoadedJourney, l: Loaded, t: number, seek: boolean, playing: boolean, rate?: number): void {
    clearTimeout(this.markTimer)
    this.markTimer = undefined
    const k = segmentAt(l.ep.segments, t)
    if (seek) this.markMode = 'exact'
    else if (k !== this.markSeg) this.markMode = 'calm'
    if (k !== this.markSeg && !this.camera.waiting) this.camera.clearCue()
    this.markSeg = k
    const seg = l.ep.segments[k]
    const plan = seg?.marks && t >= seg.start ? this.planOf(lj, l, k, this.markMode) : []
    if (playing) this.headsUp(lj, l, k, plan, t, rate)
    if (!seg?.marks || t < seg.start) { this.lights.clear(); return }
    fireAndForget(this.lights.show(`${lj.key}|${l.sig}|${k}|${this.markMode}`, plan, t, (p, r, doc) => this.bringMark(p, r, doc)), 'player: lights.show')
    const next = plan.find((p) => !p.skip && p.time > t)
    if (!playing || !next || next.time >= seg.end) return
    const ms = ((next.time - t) / (rate || 1)) * 1000
    this.markTimer = setTimeout(() => {
      this.markTimer = undefined
      if (this.session === lj.key && this.playing && this.eps.get(lj.key) === l) this.showMarks(lj, l, next.time, false, true, rate)
    }, Math.max(0, ms))
  }

  /** No marks lit, none waiting. */
  private clearMarks(): void {
    clearTimeout(this.markTimer)
    this.markTimer = undefined
    this.markSeg = -1
    this.lights?.clear()
    this.camera?.cancel()
  }

  /** Segment `k`'s marks as played (`mode`: how the segment was reached): each one's file, time, and whether the view
   *  hold skips it or lets it open its file (model.ts planMarks). */
  private planOf(lj: LoadedJourney, l: Loaded, k: number, mode: 'calm' | 'exact'): PlannedMark[] {
    const key = `${lj.key}|${l.sig}|${k}|${mode}`
    let plan = this.plans.get(key)
    if (plan) return plan
    const segs = l.ep.segments
    const s = segs[k]
    const own = viewFile(lj, s.beat === undefined ? { step: s.step } : { step: s.step, beat: s.beat })
    let shown = own, since = s.start
    if (mode === 'calm') {
      const views = this.calmViewsOf(lj, l)
      shown = viewFile(lj, views[k] ?? { step: 0 })
      let j = k
      while (j > 0 && viewFile(lj, views[j - 1] ?? { step: 0 }) === shown) j--
      since = segs[j].start
    }
    const marks = s.marks ?? []
    const times = markTimes(s)
    const renames = journeys.renames(lj)
    plan = planMarks(marks, times, own, shown, since).map((x, i) => ({ mark: marks[i], file: x.file, uri: stepFileUri(lj.folder.uri, renames, x.file), time: times[i], skip: x.skip, opens: x.opens }))
    if (this.plans.size > 200) this.plans.clear()
    this.plans.set(key, plan)
    return plan
  }

  /**
   * A mark that just lit while it plays: on screen if it isn't (centred), never under a reader looking around (the
   * follow lock); in another file, that file opens only when the plan lets it (the view hold). Leaving the view on
   * screen is a camera move (camera.ts): the read time first, then the settle, unless the reader just sought.
   */
  private async bringMark(p: PlannedMark, r: vscode.Range, doc: vscode.TextDocument): Promise<void> {
    if (!this.follow.locked || !this.drives()) { this.camera.lit(); return }
    const uri = doc.uri.toString()
    const shown = () => vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri && e.viewColumn !== mapPanel.viewColumn)
    const ed = shown()
    if (ed ? ed.visibleRanges.some((v) => v.contains(r.start) && v.contains(r.end)) : !p.opens) { this.camera.lit(); return }
    const from = ed ?? this.narratedEditor()
    const where = (from && cueText(from, uri, r.start.line)?.text) ?? `→ ${p.file.split('/').pop()}`
    const onMap = (this.sessionJourney() && this.eps.get(this.session!)?.ep.segments[this.markSeg]?.step === 0) ?? false
    await this.camera.move(async () => {
      if (!this.follow.locked) return
      this.follow.ourMove()
      const e = shown() ?? await showInCodeGroup(doc, walk.codeColumn, { keepFocus: true })
      this.follow.ourMove()
      await revealKeepingIndent(e, r, () => this.follow.locked)
    }, where, !onMap && !this.justSought())
  }

  /** The reader sought a moment ago (their own move: never a camera wait). */
  private justSought(): boolean {
    const lj = this.sessionJourney()
    const t = lj ? this.posOf(lj) : 0
    return t >= this.lastSeekT - 0.05 && t - this.lastSeekT < NO_WAIT_AFTER_SEEK_S
  }

  /** The editor showing the narrated code (the walk's group, the step's file, the lit beat's). */
  private narratedEditor(): vscode.TextEditor | undefined {
    return vscode.window.visibleTextEditors.find((e) => this.narrated(e))
  }

  /** Where view `v` puts the code: its beat's line, else its step's first line (file uri, 0-based line). */
  private viewTarget(lj: LoadedJourney, v: View): { uri: string; line: number } | undefined {
    const st = lj.j.steps[v.step - 1]
    if (!v.step || !st) return undefined
    const code = v.beat === undefined ? undefined : st.scene?.beats?.[v.beat]?.code
    const file = code && typeof code.file === 'string' ? code.file : fileOf(lj, v.step)
    const line = (code && Number.isInteger(code.line) ? code.line : st.range?.start ?? 1) - 1
    return { uri: stepFileUri(lj.folder.uri, journeys.renames(lj), file).toString(), line: Math.max(0, line) }
  }

  /**
   * The heads-up (camera.ts): CUE_LEAD_S before the next mark of this segment, or the next segment's view, whichever
   * comes first, a cue at the editor's edge if its code is out of view then.
   */
  private headsUp(lj: LoadedJourney, l: Loaded, k: number, plan: PlannedMark[], t: number, rate?: number): void {
    const segs = l.ep.segments
    const mark = plan.find((p) => !p.skip && p.time > t)
    let at: number | undefined, target: { uri: string; line: number } | undefined
    if (mark && mark.time < (segs[k]?.end ?? Infinity)) {
      at = mark.time
      target = { uri: mark.uri.toString(), line: mark.mark.lines[0] - 1 }
    } else if (k + 1 < segs.length && segs[k + 1].start > t) {
      const v = this.calmViewsOf(lj, l)[k + 1]
      if (v && v.step && !sameView(v, this.want)) { at = segs[k + 1].start; target = this.viewTarget(lj, v) }
    }
    if (at === undefined || !target) return
    const ms = ((at - CUE_LEAD_S - t) / (rate || 1)) * 1000
    if (ms > 5000) return
    const tg = target
    this.camera.scheduleCue(ms, () => this.narratedEditor(), tg.uri, tg.line, () => this.follow.locked && this.drives() && !this.justSought())
  }

  /** The view a playing episode shows for segment `seg` (the view hold, model.ts calmViews). */
  private calmView(lj: LoadedJourney, l: Loaded, seg: number): View {
    return this.calmViewsOf(lj, l)[seg] ?? { step: 0 }
  }
  private calmViewsOf(lj: LoadedJourney, l: Loaded): View[] {
    let c = this.calm.get(lj)
    if (!c || c.sig !== l.sig) {
      c = { sig: l.sig, views: calmViews(l.ep, (v) => viewFile(lj, v)) }
      this.calm.set(lj, c)
    }
    return c.views
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
      // Playing into a view whose code is out of view: a camera move (camera.ts), the read time and the settle.
      const where = this.cameraMove(lj, view, m.still)
      if (!onStep) this.follow.relock()
      const go = async () => {
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
        this.follow.ourMove()
      }
      if (where) await this.camera.move(go, where, true)
      else { await go(); this.camera.lit() }
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

  /** Where a move of the walk to `view` goes when it is a camera move that waits ("↓ 340", "→ main.ts"); undefined:
   *  none (a seek, paused, the map, from the map, not following, its code on screen already). */
  private cameraMove(lj: LoadedJourney, view: View, still: boolean): string | undefined {
    if (still || !this.playing || !view.step || !this.follow.locked || this.justSought()) return undefined
    const tg = this.viewTarget(lj, view)
    const ed = this.narratedEditor()
    return tg && ed ? cueText(ed, tg.uri, tg.line)?.text : undefined
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
    // The walk ended, or another journey, while a camera wait holds a move: the move is dropped (it would reopen it).
    if (lj && this.camera.waiting && (!walk.touring() || tourState.key !== lj.key)) this.camera.cancel()
    if (!lj || this.applying || (this.mover.busy && !afterMove)) return
    const l = this.eps.get(lj.key)!
    const step = walk.touring() && tourState.key === lj.key ? tourState.step : 0
    // A seek's move is on its way (SEEK_SETTLE_MS): the walk is not where the podcast is yet, and that is not the
    // reader; but the walk ended, or another journey, is, and the pending move is dropped.
    if (this.seekTimer) {
      const was = this.walkAtSeek
      const unchanged = !!was && was.key === tourState.key && was.step === step
      if (unchanged || (step && tourState.key === lj.key)) return
      clearTimeout(this.seekTimer)
      this.seekTimer = undefined
    }
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
    log.info(`podcast ${lj.j.id}: the step on screen was removed from the journey; showing what the podcast is at now`)
    fireAndForget(this.scan().then(() => {
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
    }), 'player: scan')
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
    fireAndForget(showBeat(lj, v.step, v.beat), 'player: showBeat')
  }

  /** Next / Previous while it plays (the card, Ctrl+' D / A), or on the map's parts (Intro, Recap) where the walk has no
   *  step: the player's own ⏮ ⏭, one transport (F71, F85). Paused on a step, the walk's own (the audio follows it). */
  private transport(dir: 1 | -1): boolean {
    const lj = this.sessionJourney()
    // The audio is in the Listen view (the panel may be closed): the transport is the player's once it has the episode.
    if (!lj || this.hostKey !== lj.key || !this.hostAlive()) return false
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
    return true
  }
  /** What a hold paused it for (a note, a question), until it plays again. */
  private heldFor: string | undefined

  /** The note or question was sent or put away: the hold is over (it stays paused; ▶ plays on). */
  released(what: string): void {
    if (this.heldFor !== what || this.playing || !this.sessionJourney()) return
    this.heldFor = undefined
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
    this.clearMarks()
    // Played again, the view at its time is applied afresh (not "the same segment, the same view").
    this.lastSeg = -1
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
    if (stored.get(STATE.listenHintShown)) return
    fireAndForget(stored.set(STATE.listenHintShown, true), 'player: store listenHintShown')
    fireAndForget(vscode.window.showInformationMessage('The walk follows the voice: code opens beside the map.', 'Got it'), 'player: window.showInformationMessage')
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
    // The card growing or shrinking (paused: the full card) scrolls the code: the extension's, not the reader's.
    this.follow.ourMove()
    card.show(lj, tourState.step)
  }

  /** The panel closed: the audio is in the Listen view and plays on (playing in the panel, it goes there; if the
   *  Listen view's audio may not play yet, it waits there, paused); the status item and the card are drawn again. */
  onClosed(): void {
    this.panelKey = undefined
    this.listen.send({ type: 'panel' })
    this.unlocked.panel = false
    if (this.hostIn === 'panel') {
      const lj = this.hostKey ? journeys.list.get(this.hostKey) : undefined
      this.hostIn = 'listen'
      if (lj) this.moveHost('listen', lj, { at: this.nowOf(lj), play: this.playing })
    }
    const lj = this.sessionJourney()
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
    // Not started by a click or a key in the host's own webview (VS Code's webviews need one, once).
    if (message === 'NotAllowedError') {
      log.info('podcast: the audio may not play here without a click in it')
      this.notAllowed()
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
    if (action === 'seek' || action === 'pause') this.asked = { kind: action, at: Date.now(), key: this.session }
    this.toHost({ type: 'podcastCmd', action, ...more })
  }

  /** Listen to Journey: the journey (a row, a key; else the one walked or on the map; else picked) in the Listen view,
   *  playing, its map open. `o.at`: from there (else where it was left, or where the walk is); `o.until`: it stops
   *  there (one step). */
  async play(arg?: unknown, o: { at?: number; until?: number } = {}): Promise<void> {
    const lj = await this.journeyFor(arg)
    if (!lj) return
    // Not the episode in the Listen view: it goes on where it was left (or where the walk is: resumeTime).
    const fresh = this.session !== lj.key || this.hostKey !== lj.key || !this.hostAlive()
    this.starting = true
    try {
      if (mapPanel.journey?.key !== lj.key) await openMap(lj)
      else if (!mapPanel.visible) walk.showMap(lj, true)
    } finally { this.starting = false }
    const walkStep = walk.touring() && tourState.key === lj.key ? tourState.step : 0
    const ep = this.eps.get(lj.key)!.ep
    const at = typeof o.at === 'number' ? o.at : fresh ? resumeTime(ep, this.posOf(lj), walkStep) : undefined
    // Going on where it was, not from 0:00: the output says so (the player's clock shows it).
    if (fresh && (at ?? 0) > 0) log.info(`podcast ${lj.j.id}: on from ${clock(at!)}`)
    this.session = lj.key
    if (fresh) { this.lastSeg = -1; this.camera.reset() }
    // Where the walk is now (the walk telling of a move that isn't one pauses nothing).
    this.want = { step: walkStep }
    const until = typeof o.until === 'number' ? { until: o.until } : {}
    // Loaded in the Listen view, whose audio may not play, and the panel's may: it plays in the panel.
    if (this.hostKey === lj.key && this.hostIn === 'listen' && this.panelPlays(lj.key) && this.listen.alive) {
      this.moveHost('panel', lj, { at: at ?? this.nowOf(lj), play: true, ...until })
      return
    }
    if (this.hostKey !== lj.key || !this.hostAlive()) {
      if (!(await this.loadHost(lj, { play: o.until === undefined, at: at ?? this.posOf(lj), until: o.until }))) {
        fireAndForget(vscode.window.showWarningMessage('The Listen view could not be opened, so the audio has nowhere to play.'), 'player: window.showWarningMessage')
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
    // Walking another journey: asked, never switched silently (F120).
    const walking = walk.touring() ? walk.tourJourney() : undefined
    if (all.length <= 1 && !walking) {
      if (!all.length) vscode.window.setStatusBarMessage('$(info) No journey here has a podcast to listen to', 3000)
      return all[0]
    }
    if (!all.length) { vscode.window.setStatusBarMessage('$(info) No journey here has a podcast to listen to', 3000); return undefined }
    const placeHolder = walking ? `Listen to a journey (this ends the walk through “${walking.j.title}”)` : 'Listen to a journey'
    const pick = await vscode.window.showQuickPick(all.map((x) => ({ label: x.j.title, description: clock(this.eps.get(x.key)!.ep.duration), lj: x })), { placeHolder })
    return pick?.lj
  }

  /** Asked to play a journey whose podcast can't be (or that has none): says why, with the way to the details. */
  private cantPlay(lj: LoadedJourney): void {
    const b = this.broken.get(lj.key)
    if (!b) { vscode.window.setStatusBarMessage(`$(info) ${lj.j.title} has no podcast`, 3000); return }
    fireAndForget(vscode.window.showWarningMessage(`The podcast of “${lj.j.title}” can't be played: ${b.reason}`, 'Show Why').then((a) => { if (a) fireAndForget(this.showWhy(lj), 'player: showWhy') }), 'player: window.showWarningMessage')
  }

  /** Space for listening: pause, or play (the journey in the Listen view; else as Listen to Journey). In a journey
   *  without a podcast it says so: never another journey's podcast, ending this walk (F120). */
  async toggle(): Promise<void> {
    if (this.sessionJourney() && this.hostKey === this.session && this.hostAlive()) {
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

  /**
   * While a journey is listened to and its panel (the player) is not on screen: "Listening · 6:58" or "Paused · 6:58",
   * a one-line tooltip, click: the journey's map. Gone once the episode ended. The walk's own item steps aside while a
   * journey is listened to (one item); the Listen view is there only then (`codeNotes.listening`).
   */
  private renderItem(): void {
    const item = this.item
    if (!item) return
    const lj = this.sessionJourney()
    this.listeningView(!!lj)
    if (!!lj !== this.itemSession) { this.itemSession = !!lj; walk.statusChanged(); setTimeout(() => journeysTree?.refresh(), 0) }
    const ended = this.ended && !this.playing
    this.itemOn = !!lj && !ended && !mapPanel.visible
    if (!lj) { item.hide(); return }
    const state = this.playing ? 'Listening' : 'Paused'
    item.text = `${state} · ${clock(this.t)}`
    item.tooltip = `${this.playing ? 'Pause' : 'Play'} (${KEY} Space) · click: the map`
    item.accessibilityInformation = { label: `${state}: ${lj.j.title}, ${clock(this.t)}. Opens the journey's map.` }
    if (this.itemOn) item.show()
    else item.hide()
  }
  /**
   * The Listen view in (a journey listened to) or out. Out only once nothing has been listened to for a moment: going
   * from one journey to another ends one session before the next starts, and the view going would take the audio's
   * unlocking with it (a new view needs a click again).
   */
  private listeningView(on: boolean): void {
    if (on) {
      clearTimeout(this.listeningOff)
      this.listeningOff = undefined
      fireAndForget(setCtx(LISTENING_CTX, true), 'player: setCtx LISTENING_CTX')
      return
    }
    if (this.listeningOff) return
    this.listeningOff = setTimeout(() => {
      this.listeningOff = undefined
      if (!this.sessionJourney() && !this.hostLoading && !this.starting) fireAndForget(setCtx(LISTENING_CTX, false), 'player: setCtx LISTENING_CTX')
    }, LISTENING_OFF_MS)
  }
  private listeningOff: NodeJS.Timeout | undefined
  /** A journey was listened to when the walk's status item was last told. */
  private itemSession = false
  /** The status item is shown. */
  private itemOn = false
  private itemShown(): boolean { return this.itemOn }

  /** For tests. */
  snapshot() {
    const lj = this.sessionJourney()
    return {
      journeys: journeys.all().filter((x) => this.has(x)).map((x) => x.j.id),
      session: lj?.j.id, t: this.t, playing: this.playing, want: this.want, beatShown: this.beatShown, applying: this.applying,
      item: this.item?.text, itemShown: this.itemShown(), listening: !!lj, hostKey: this.hostKey, hostIn: this.hostIn, unlocked: { ...this.unlocked }, hostAlive: this.hostAlive(), hostVisible: this.listen.visible, ended: this.ended, error: this.lastError, moves: this.moves, mapVisible: mapPanel.visible,
      why: this.whyShown, follow: this.follow.locked, unlock: this.follow.lastUnlock, held: this.heldFor, marks: this.lights.lit(),
      camera: { waiting: this.camera.waiting, cue: this.camera.cue, waits: [...this.camera.waits] }, audible: this.audible, audioNow: this.audioNow(),
      broken: Object.fromEntries([...this.broken].map(([k, b]) => [journeys.list.get(k)?.j.id ?? k, b.reason])),
      notices: Object.fromEntries([...this.eps].filter(([, l]) => l.notice).map(([k, l]) => [journeys.list.get(k)?.j.id ?? k, l.notice])),
      links: Object.fromEntries([...this.eps].map(([k, l]) => [journeys.list.get(k)?.j.id ?? k, brokenLinks(l.problems)])),
    }
  }
}

/**
 * A mark brought on screen without scrolling the code sideways: its line is shown with column 1 (the indentation, the
 * keywords) in view; only when the mark's start is beyond the editor's right edge does it scroll right, just enough
 * to show it. The reader taking over meanwhile (`following()` false), or the code moved elsewhere, stops it.
 */
async function revealKeepingIndent(e: vscode.TextEditor, r: vscode.Range, following: () => boolean): Promise<void> {
  const line = r.start.line
  const drawn = (ms: number) => new Promise((res) => setTimeout(res, ms))
  // Moved elsewhere meanwhile (a seek, the next step), or the reader took over: the rest is not done.
  const still = () => following() && e.visibleRanges.some((v) => v.start.line <= line && line <= v.end.line)
  // VS Code scrolls sideways only to a line it has drawn, and an extension's reveal scrolls smoothly (a few frames):
  // first the line on screen, then column 1 with the mark's first character (both, if they fit), then that character
  // alone (if it didn't: the least scroll right that shows it; nothing when it is shown already).
  e.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  await drawn(200)
  if (!still()) return
  e.revealRange(new vscode.Range(line, 0, line, r.start.character + 1), vscode.TextEditorRevealType.Default)
  if (r.start.character === 0) return
  await drawn(350)
  if (!still()) return
  e.revealRange(new vscode.Range(line, r.start.character, line, r.start.character + 1), vscode.TextEditorRevealType.Default)
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

export const podcasts = new Podcasts()
