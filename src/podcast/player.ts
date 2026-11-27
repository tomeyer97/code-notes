// Listening to a journey (docs/podcast-format.md): a podcast file next to a journey plays in the Listen view, and the
// walk follows the voice. Podcasts wires the parts and makes the session's decisions:
//   library.ts     the podcasts read and checked          store.ts       positions, rate, muting
//   session.ts     what plays                             audioHost.ts   which webview plays it, the relay
//   follow.ts      the walk ← the audio, the follow lock  camera.ts      waits around a move, the heads-up
//   markScheduler  marks lit on time                      statusItem.ts  the Listen status item
// It reaches the walk only through TourApi (it registers itself there: TourApi.usePodcast) and the panel through
// MapPanel.setPodcast.

import * as vscode from 'vscode'
import { clock, Episode } from '../core/format/podcast/model'
import { Coalesced } from '../core/serial'
import type { LoadedJourney } from '../journeys/steps'
import { chordKey } from '../platform/chordKey'
import { log, stored } from '../platform/host'
import { fireAndForget } from '../platform/run'
import type { PodcastStatus, TourPodcast } from '../tour/api'
import type { PodcastAsk, PodcastEpisode, PodcastHostState, PodcastUnavailable, ToPlayer } from '../protocol/podcast'
import { AudioHost, AudioHostClient } from './audioHost'
import { Camera } from './camera'
import { Follow } from './follow'
import { Loaded, PodcastLibrary } from './library'
import { podcastReports } from './load'
import { MarkScheduler } from './markScheduler'
import type { PodcastPorts } from './ports'
import { ReportClock, ReportQueue, TimeReport } from './reportClock'
import { remapTime, resumeTime } from './resume'
import { Session } from './session'
import { ListenStatusItem } from './statusItem'
import { PodcastStore } from './store'

export type { TimeReport } from './reportClock'
export { SEEK_SETTLE_MS } from './follow'

const SKIP_S = 15
/** A remapped position this close (s) to where it was is the same moment. */
const SAME_MOMENT_S = 0.05

const NO_PODCAST_HERE = '$(info) No journey here has a podcast to listen to'
const NOTHING_LISTENED = '$(info) Nothing is being listened to'

/** A podcastCmd for the host, without its type and action. */
type HostCommand = Omit<Extract<ToPlayer, { type: 'podcastCmd' }>, 'type' | 'action'>

/** What an error the host reports is: a play cut short (a pause, another source), a play not started by a click or a
 *  key in its webview, an audio that can't be decoded, or anything else. The page says them in these words. */
type HostError = 'abort' | 'not-allowed' | 'decode' | 'other'
function hostErrorKind(message: string): HostError {
  if (message === 'AbortError') return 'abort'
  if (message === 'NotAllowedError') return 'not-allowed'
  return /^audio error/.test(message) ? 'decode' : 'other'
}

const fileSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`)

export class Podcasts implements vscode.Disposable {
  readonly library: PodcastLibrary
  readonly store = new PodcastStore(stored)
  readonly session = new Session()
  readonly camera: Camera
  readonly follow: Follow
  readonly marks: MarkScheduler
  readonly host: AudioHost
  readonly statusItem: ListenStatusItem
  private readonly clock = new ReportClock()
  private readonly reports = new ReportQueue<LoadedJourney>((shown, m, at) => this.onTime(shown, m, at))
  /** Scans one at a time (a scan asked for meanwhile runs once after it). */
  private readonly scans = new Coalesced(() => this.scanOnce())
  /** Journeys whose podcast was playing when its file stopped being playable: it plays on once it is back. */
  private playOnReturn = new Set<string>()
  /** The journey the panel's player was last given (undefined: the panel closed). */
  private panelKey: string | undefined
  /** Listen to Journey is opening the journey's panel (its width is the listening one). */
  private starting = false
  /** The journey the rows last showed as listened to. */
  private rowSession: string | undefined
  private readonly failed = new vscode.EventEmitter<string>()
  private readonly whyAsked = new vscode.EventEmitter<void>()
  /** The host reported an error (not a play cut short): its message. */
  readonly onDidFail = this.failed.event
  /** "Show why" was asked. */
  readonly onDidShowWhy = this.whyAsked.event
  private readonly subs: vscode.Disposable[] = []

  constructor(context: vscode.ExtensionContext, private readonly ports: PodcastPorts) {
    const get = { journeys: () => ports.journeys, mapPanel: () => ports.mapPanel, tour: () => ports.tour, beats: () => ports.beats, log }
    this.library = new PodcastLibrary(get.journeys, log)
    this.camera = new Camera({
      hold: () => this.host.send({ type: 'podcastCmd', action: 'pause', hold: true }),
      resume: () => this.host.send({ type: 'podcastCmd', action: 'unhold' }),
      audio: () => ({ t: this.audioNow(), playing: this.session.audible }),
      resync: () => this.resync(),
      log: (line) => log().info(line),
    })
    this.follow = new Follow(get, {
      seek: (to) => this.command('seek', { to }),
      pause: (why, more) => this.pause(why, more),
      endSession: (lj, why) => this.endSession(lj, why),
      moved: () => this.renderItem(),
      listening: () => this.listening(),
    }, this.session, this.library, this.store, this.camera)
    this.marks = new MarkScheduler(log(), get, this.session, this.library, this.follow, this.camera)
    this.host = new AudioHost(context.extensionUri, log, get, this.hostClient())
    this.statusItem = new ListenStatusItem(() => !this.listening() && !this.host.busy && !this.starting, () => {
      ports.tour.statusChanged()
      setTimeout(() => ports.refreshJourneyList(), 0)
    })
    const scan = () => fireAndForget(this.scan(), 'podcast: scan')
    podcastReports.init(context, scan)
    this.subs.push(
      this.statusItem, this.host, this.host.listen.register(), this.camera, this.follow, this.marks, this.failed, this.whyAsked,
      ports.journeys.onDidChange(scan),
      ports.mapPanel.setPodcast({
        episodeFor: (lj, toUri) => { this.host.panelShows(lj); return this.episodeFor(lj, toUri) },
        stateFor: (lj) => this.stateFor(lj),
        // The status item is there only while the panel (its player) is not on screen.
        viewChanged: () => this.renderItem(),
      }),
      ports.tour.onDidMove(() => this.follow.walkMoved()),
      ports.tour.onDidRestore((lj) => this.restored(lj)),
      ports.tour.usePodcast(this.tourPodcast()),
    )
    context.subscriptions.push(this)
  }

  private get tour() { return this.ports.tour }
  private get mapPanel() { return this.ports.mapPanel }
  private journey(key: string | undefined): LoadedJourney | undefined { return key ? this.ports.journeys.list.get(key) : undefined }

  /** What the walk, the card, the lists and the panel's player ask of the podcast (TourApi.usePodcast). */
  private tourPodcast(): TourPodcast {
    return {
      transport: (dir) => this.transport(dir),
      stepRemoved: (lj) => this.stepRemoved(lj),
      listening: (lj) => this.session.is(lj.key) && !!this.listening(),
      narration: (lj, n) => this.follow.narration(lj, n),
      following: () => this.follow.lock.locked || !this.follow.drives(),
      // An episode on: the panel beside the code at the listening width, from its start (the panel opened for it).
      episodeOn: () => !!this.listening() || this.starting,
      status: (lj) => this.status(lj),
      hold: (what) => this.hold(what),
      released: (what) => this.released(what),
      play: (arg) => this.play(arg),
      fromPanel: (m) => this.host.fromPanel(m),
      onBeat: (lj, n, i) => this.follow.onBeat(lj, n, i),
      onClosed: () => this.onClosed(),
      showWhy: (lj) => this.showWhy(lj),
      onAsk: (lj, m) => this.onAsk(lj, m),
      endAction: (lj, action, of) => this.onEnd(this.journey(of) ?? lj, action),
    }
  }

  /** What the audio's host and the remotes tell the player (audioHost.ts). */
  private hostClient(): AudioHostClient {
    return {
      episodeFor: (lj, toUri, host) => this.episodeFor(lj, toUri, host),
      posOf: (lj) => this.store.posOf(lj),
      nowOf: (lj) => this.nowOf(lj),
      listening: () => this.listening(),
      playing: () => this.session.playing,
      time: (shown, m) => { const at = Date.now(); this.reports.push(shown, this.clock.correct(m, at), at) },
      state: (m) => this.onState(m),
      error: (shown, message, of) => this.onError(shown, message, of),
      meta: (shown, duration, of) => this.onAudioMeta(shown, duration, of),
      ask: (lj, m) => this.onAsk(lj, m),
      why: (lj) => this.showWhy(lj),
      open: () => this.openSessionMap(),
      end: (lj, action) => this.onEnd(lj, action),
      lost: () => this.hostLost(),
    }
  }

  /** The journey listened to, while its podcast can be played. */
  listening(): LoadedJourney | undefined {
    const lj = this.journey(this.session.key)
    return lj && this.library.has(lj.key) ? lj : undefined
  }

  has(lj: LoadedJourney): boolean { return this.library.has(lj.key) }
  episode(lj: LoadedJourney): Episode | undefined { return this.library.get(lj.key)?.episode }

  /** What the Journeys view says about a journey's podcast: none, playable (with a line about what is wrong with it,
   *  if anything), or unavailable and why. */
  status(lj: LoadedJourney): PodcastStatus | undefined {
    const pod = this.library.get(lj.key)
    if (pod) {
      const session = this.session.is(lj.key) && !!this.listening()
      return { state: 'ok', text: pod.notice, duration: pod.episode.duration, session, playing: session && this.session.playing, t: this.store.knows(lj) ? this.store.posOf(lj) : undefined }
    }
    const b = this.library.brokenOf(lj.key)
    return b && { state: 'broken', text: b.reason }
  }

  /** Where the session's audio is (s), as last said (the status bar's). */
  get sessionTime(): number {
    const lj = this.listening()
    return lj ? this.store.posOf(lj) : 0
  }

  /** Where the audio is now (s): its last report, moved on by the time since. */
  audioNow(): number { return this.session.audioNow(this.sessionTime) }

  /** Where `lj`'s audio is now: playing, its time; else where it was left. */
  private nowOf(lj: LoadedJourney): number {
    return this.session.is(lj.key) && this.host.key === lj.key ? this.audioNow() : this.store.posOf(lj)
  }

  // ---------- the podcasts read ----------

  /** Every journey's podcast read again (a journey, podcast or audio file changed); the panel, the list and the status
   *  bar follow. */
  scan(): Promise<void> { return this.scans.run(false) }

  private async scanOnce(): Promise<void> {
    const { before, changed } = await this.library.scan((key, last) => this.session.is(key) && (this.session.playing || !!last.lastGood))
    this.sessionGoneWithFile()
    this.renderItem()
    if (!changed) return
    const seekTo = this.remapPositions(before)
    this.mapPanel.sendPodcast()
    this.host.refresh()
    if (seekTo !== undefined) this.command('seek', { to: seekTo })
    this.ports.refreshJourneyList()
  }

  /** The podcast played went (deleted, or it can't be played now): its marks and the status item go. Playing then, it
   *  plays on once it is back. */
  private sessionGoneWithFile(): void {
    const key = this.session.key
    if (!key || this.library.has(key)) return
    if (this.session.playing) this.playOnReturn.add(key)
    this.session.stop()
    this.marks.clear()
    this.follow.stop()
  }

  /** The same moment again where a rewritten file moved it (a segment's times changed). Returns where the panel's
   *  audio goes (the same audio, playing on if it was). */
  private remapPositions(before: Map<string, Loaded>): number | undefined {
    let seekTo: number | undefined
    for (const [key, was] of before) {
      const now = this.library.get(key)
      const t = this.store.reported(key)
      if (!now || now.sig === was.sig || t === undefined) continue
      const t2 = remapTime(was.episode, now.episode, t)
      if (Math.abs(t2 - t) < SAME_MOMENT_S) continue
      const lj = this.journey(key)
      if (lj) this.store.save(lj, t2, true)
      if (key === this.mapPanel.journey?.key && now.audio.toString() === was.audio.toString()) seekTo = t2
    }
    return seekTo
  }

  /** What a player gets for `lj` (undefined: no podcast; `unavailable`: one that can't be played, and why): the
   *  panel's (a remote: what to draw) or the Listen view's (`host`: the audio too, and whether it plays once loaded). */
  private episodeFor(lj: LoadedJourney, toUri: (u: vscode.Uri) => string | undefined, host = false): PodcastEpisode | PodcastUnavailable | undefined {
    const pod = this.library.get(lj.key)
    if (!pod) {
      const b = this.library.brokenOf(lj.key)
      return b && { unavailable: b.reason }
    }
    const ep = pod.episode
    const play = host && this.playOnReturn.delete(lj.key)
    const next = this.nextOf(lj)
    return {
      key: lj.key,
      src: toUri(pod.audio) ?? '',
      title: ep.title,
      journey: lj.j.title,
      duration: ep.duration,
      at: this.store.posOf(lj),
      ...(play ? { play: true } : {}),
      rate: this.store.rate,
      muted: this.store.muted,
      keyPrefix: chordKey(),
      chapters: ep.chapters,
      segments: ep.segments.map((s) => ({ start: s.start, end: s.end, text: s.text, step: s.step, speaker: s.speaker, ...(s.sentences ? { sentences: s.sentences } : {}) })),
      steps: lj.j.steps.map((s, i) => ({ n: i + 1, title: s.title })),
      ...(next ? { next: { key: next.key, title: next.j.title } } : {}),
      ...(pod.notice ? { notice: pod.notice } : {}),
    }
  }

  /** The journey after `lj` (in the Journeys view's order) with a podcast that plays: the end's "Next journey". */
  private nextOf(lj: LoadedJourney): LoadedJourney | undefined {
    const all = this.ports.journeys.all()
    const i = all.findIndex((x) => x.key === lj.key)
    return all.slice(i + 1).find((x) => this.has(x))
  }

  /** What the panel's remote draws for `lj` right after its episode: the audio's own state when the host has it, else
   *  where it was left, paused. */
  private stateFor(lj: LoadedJourney): PodcastHostState | undefined {
    const pod = this.library.get(lj.key)
    if (!pod) return undefined
    const st = this.host.stateOf(lj.key)
    if (st) return st
    // Not in the host yet: loaded there now (its length is checked, ▶ starts at once), unless another journey's
    // episode is in it.
    if (!this.listening() && this.host.listen.alive && this.host.in === 'listen') fireAndForget(this.host.load(lj), 'podcast: load the host')
    // The panel newly showing a journey whose place was kept, nothing listened to: the session again, paused there
    // (a podcast file read again sends this too: that is no reopening).
    if (this.panelKey !== lj.key) this.reopened(lj, pod.episode)
    this.panelKey = lj.key
    return { of: lj.key, t: this.store.posOf(lj), playing: false }
  }

  /**
   * The panel shows a journey whose podcast was listened to (a place kept), with no podcast going on: it is the
   * session again, paused there (the status item says so), and the beat at that time is shown when the walk is on its
   * step.
   */
  private reopened(lj: LoadedJourney, ep: Episode): void {
    const t = this.store.posOf(lj)
    if (this.session.key || !(t > 0)) return
    this.session.key = lj.key
    this.session.playing = false
    const v = this.follow.reopened(lj, ep, t)
    // Once the panel has taken in the episode it is being sent now.
    setTimeout(() => {
      this.renderItem()
      this.follow.showStill(lj, v)
    }, 0)
  }

  /** After a reload, the walk restored on its step: the beat the podcast was at, lit. */
  private restored(lj: LoadedJourney): void {
    const pod = this.library.get(lj.key)
    const t = this.store.stored(lj)
    if (pod && t !== undefined) this.follow.restored(lj, pod, t)
  }

  /** The step on screen was removed from the journey. The podcast's journey: once it is read again, the walk shows
   *  what the podcast says at its time now (the view before a part about a step that is gone). */
  private stepRemoved(lj: LoadedJourney): boolean {
    if (!this.session.is(lj.key) || !this.library.has(lj.key)) return false
    log().info(`podcast ${lj.j.id}: the step on screen was removed from the journey; showing what the podcast is at now`)
    fireAndForget(this.scan().then(() => {
      const pod = this.library.get(lj.key)
      const now = this.journey(lj.key)
      if (pod && now) this.follow.afterRemoval(now, pod, this.store.posOf(now))
    }), 'podcast: scan')
    return true
  }

  // ---------- what the host says ----------

  /** The host says where the audio is. Playing (or seeking), the walk goes where the podcast is at that time. */
  private onTime(shown: LoadedJourney, m: TimeReport, at = Date.now()): void {
    // The journey the audio is of (the panel may have moved on to another one since it said it).
    const lj = this.journey(m.of) ?? shown
    const pod = this.library.get(lj.key)
    if (!pod || this.session.stale(lj.key, m)) return
    const on = m.playing || !!m.held
    const wasPlaying = this.session.is(lj.key) && this.session.playing
    const wasAudible = this.session.is(lj.key) && this.session.audible
    this.cameraHears(m, on, wasAudible)
    if (m.rate) this.store.rate = m.rate
    this.store.save(lj, m.t, (wasPlaying && !on) || !!m.seek)
    if (on) this.session.key = lj.key
    if (!this.session.is(lj.key)) return
    this.trackPlaying(lj, m, on, wasPlaying, at)
    // In a hold the marks stand where they are (the audio stands still).
    this.marks.show(lj, pod, m.t, !!m.seek, m.playing, m.rate)
    // Paused (or held) and not moved: the walk is the reader's (or the camera's).
    if (!m.playing && !m.seek) return
    if (m.seek) { this.follow.followSeek(lj, pod, m.t); return }
    // A seek's move is on its way: playing on from there is the same view.
    if (this.follow.seeking) return
    this.hintOnce()
    this.follow.followPlay(lj, pod, m.t)
  }

  /** A seek drops a camera wait (the reader went elsewhere); the reader's pause too; the audio playing again by itself
   *  during one (the reader played on) ends it. */
  private cameraHears(m: TimeReport, on: boolean, wasAudible: boolean): void {
    if (m.seek) {
      this.follow.sought(m.t)
      this.camera.cancel()
      this.camera.reset()
    } else if (!on) this.camera.cancel()
    else if (m.playing && !wasAudible) this.camera.played()
  }

  /** The session's report taken: playing or not (the rows, the log, the status item and the card say it). */
  private trackPlaying(lj: LoadedJourney, m: TimeReport, on: boolean, wasPlaying: boolean, at: number): void {
    this.session.reported(lj.key, m, at)
    if (this.session.playing !== on || this.rowSession !== lj.key) {
      this.rowSession = lj.key
      setTimeout(() => this.ports.refreshJourneyList(), 0)
    }
    this.session.playing = on
    if (wasPlaying !== on) this.saidState(lj, m.t)
    this.renderItem()
    this.follow.redrawCard(lj)
  }

  /**
   * The walk put where the audio is now (a camera wait dropped: the audio did not hold, or the reader played on or
   * looked around): its view and its marks at that time, at once and without waits, never the moves that waited.
   */
  private resync(): void {
    const lj = this.listening()
    const pod = lj && this.library.get(lj.key)
    if (!lj || !pod) return
    this.session.forgetAsked()
    const t = this.audioNow()
    this.follow.syncTo(lj, pod, t)
    this.marks.again()
    this.marks.show(lj, pod, t, false, this.session.playing, this.session.rate)
  }

  /** The audio's state: the muting remembered; the episode's end said on the row and the status item. */
  private onState(m: PodcastHostState): void {
    if (!this.host.relayState(m)) return
    if (typeof m.muted === 'boolean') this.store.muted = m.muted
    if (m.ended !== this.session.ended) {
      this.session.ended = !!m.ended
      this.renderItem()
      this.ports.refreshJourneyList()
    }
  }

  /** The host loaded the audio of journey `of` (else the one shown): its real length, checked against the file (a
   *  cut-off audio, a wrong "duration"). */
  private onAudioMeta(shown: LoadedJourney, duration: number, of?: string): void {
    const pod = this.library.get((this.journey(of) ?? shown).key)
    if (!pod || !(duration > 0) || !Number.isFinite(duration)) return
    if (this.library.measured(pod, duration)) fireAndForget(this.scan(), 'podcast: scan')
  }

  /** Something went wrong in the host's audio (of journey `of`, else the one shown): logged; an audio that can't be
   *  decoded is said in the panel and on the row, with its file. */
  private onError(shown: LoadedJourney | undefined, message: string, of?: string): void {
    const kind = hostErrorKind(message)
    if (kind === 'abort') {
      log().debug('podcast: a play was interrupted (paused, or another audio loaded)')
      return
    }
    this.failed.fire(message)
    if (kind === 'not-allowed') {
      log().info('podcast: the audio may not play here without a click in it')
      this.host.notAllowed()
      return
    }
    const lj = this.journey(of) ?? shown
    const pod = lj && this.library.get(lj.key)
    if (kind === 'decode' && lj && pod) this.audioDamaged(lj, pod, message)
    else log().warn(`podcast: ${message}`)
  }

  /** The media pipeline's own words ("PIPELINE_ERROR_READ: FFmpegDemuxer …") mean nothing to an author: the file and
   *  what it most likely is. */
  private audioDamaged(lj: LoadedJourney, pod: Loaded, message: string): void {
    const name = vscode.workspace.asRelativePath(pod.audio, false)
    const text = `The audio ${name} (${fileSize(pod.audioSize)}) can't be played at ${clock(this.store.posOf(lj))}: the file looks cut off or damaged`
    log().warn(`podcast ${pod.file.fsPath}: ${text} (${message})`)
    if (!this.library.fault(lj.key, pod, text)) return
    this.mapPanel.sendPodcast()
    this.ports.refreshJourneyList()
  }

  /** The Listen view went with the audio in it: its place is kept. */
  private hostLost(): void {
    const lj = this.listening()
    if (lj) this.store.save(lj, this.store.posOf(lj), true)
    this.session.stop()
    this.follow.stop()
    this.marks.clear()
    this.renderItem()
  }

  /** The panel closed: the audio is in the Listen view and plays on; the status item and the card are drawn again. */
  private onClosed(): void {
    this.panelKey = undefined
    this.host.panelClosed()
    const lj = this.listening()
    this.renderItem()
    if (lj) this.follow.redrawCard(lj, true)
  }

  // ---------- what a reader asks ----------

  /** What a remote player asks: the panel's (the audio in the Listen view), or the Listen view's (the audio in the
   *  panel). */
  private async onAsk(lj: LoadedJourney, m: PodcastAsk): Promise<void> {
    const key = m.of && this.journey(m.of) ? m.of : lj.key
    const j = this.journey(key)!
    if (!this.library.has(key)) return
    const loaded = this.host.has(key)
    const { action } = m
    if (action === 'play' || action === 'toggle') {
      // A ▶ in the panel while only the panel's audio may play: play() moves it there.
      if (loaded && this.session.is(key) && !(this.host.in === 'listen' && this.host.panelPlays(key))) {
        this.command(action, { ...(typeof m.at === 'number' ? { at: m.at } : {}), ...(typeof m.until === 'number' ? { until: m.until } : {}) })
        return
      }
      await this.play(key, { at: m.at, until: m.until })
      return
    }
    if (!loaded) {
      // Not in the host: a seek is where ▶ starts next.
      if (action === 'seek' && typeof m.to === 'number') {
        this.store.save(j, m.to, true)
        this.mapPanel.send({ type: 'podcastState', of: key, t: m.to, playing: false })
      }
      return
    }
    const more: HostCommand = {}
    for (const k of ['to', 'by', 'dir', 'rate', 'muted'] as const) if (m[k] !== undefined) Object.assign(more, { [k]: m[k] })
    if (action === 'seek') more.reader = true
    this.command(action, more)
  }

  /** The end's buttons: walk the journey yourself (from its first step), or listen to the next one. */
  private async onEnd(lj: LoadedJourney, action: 'walk' | 'next'): Promise<void> {
    if (action === 'walk') { await this.tour.goToStep(lj, 1, { focus: false }); return }
    const next = this.nextOf(lj)
    if (next) await this.play(next.key)
  }

  /** The status item's click, the Listen view's title: the listened journey's map (its player shows where it is). */
  async openSessionMap(): Promise<void> {
    const lj = this.listening() ?? this.journey(this.host.key)
    if (!lj) { await this.play(); return }
    if (this.mapPanel.journey?.key !== lj.key) await this.tour.openMap(lj)
    else this.tour.showMap(lj, true)
  }

  /** "Show why" in the panel (or on a podcast that can't be played): the Problems view, on the podcast file. */
  async showWhy(lj?: LoadedJourney): Promise<void> {
    this.whyAsked.fire()
    const j = lj ?? this.mapPanel.journey
    const file = j && this.library.fileOf(j.key)
    await vscode.commands.executeCommand('workbench.actions.view.problems')
    if (file && !podcastReports.of(file).length) log().show(true)
  }

  /** "Follow along" (the step card): the editor follows again, and shows what the voice is showing now. */
  followAlong(): void { this.follow.followAlong() }

  /** Next / Previous while it plays (the card, the keys), or on the map's parts (Intro, Recap) where the walk has no
   *  step: the player's own ⏮ ⏭, one transport. Paused on a step, the walk's own (the audio follows it). */
  private transport(dir: 1 | -1): boolean {
    const lj = this.listening()
    // The audio is in the Listen view (the panel may be closed): the transport is the player's once it has the episode.
    if (!lj || !this.host.has(lj.key)) return false
    const walking = this.tour.touring()
    if (walking && this.tour.state.key !== lj.key) return false
    if (!this.session.playing && walking) return false
    this.command('part', { dir })
    return true
  }

  /** A note or a question is being written: the voice stops, the code stays; ▶ on the step card, or the key, goes
   *  on. True: it was playing and is paused now. */
  hold(what: string): boolean {
    if (!this.listening() || !this.session.playing) return false
    this.session.heldFor = what
    this.pause(`${what} being written`)
    return true
  }

  /** The note or question was sent or put away: the hold is over (it stays paused; ▶ plays on). */
  released(what: string): void {
    if (this.session.heldFor !== what || this.session.playing || !this.listening()) return
    this.session.heldFor = undefined
  }

  /** Listen to Journey: the journey (a row, a key; else the one walked or on the map; else picked) in the Listen view,
   *  playing, its map open. `o.at`: from there (else where it was left, or where the walk is); `o.until`: it stops
   *  there (one step). */
  async play(arg?: unknown, o: { at?: number; until?: number } = {}): Promise<void> {
    const lj = await this.journeyFor(arg)
    if (!lj) return
    // Not the episode in the host: it goes on where it was left (or where the walk is: resumeTime).
    const fresh = !this.session.is(lj.key) || !this.host.has(lj.key)
    this.starting = true
    try {
      if (this.mapPanel.journey?.key !== lj.key) await this.tour.openMap(lj)
      else if (!this.mapPanel.visible) this.tour.showMap(lj, true)
    } finally { this.starting = false }
    const walkStep = this.tour.touring() && this.tour.state.key === lj.key ? this.tour.state.step : 0
    const ep = this.library.get(lj.key)!.episode
    const at = typeof o.at === 'number' ? o.at : fresh ? resumeTime(ep, this.store.posOf(lj), walkStep) : undefined
    // Going on where it was, not from 0:00: the output says so (the player's clock shows it).
    if (fresh && (at ?? 0) > 0) log().info(`podcast ${lj.j.id}: on from ${clock(at!)}`)
    this.session.key = lj.key
    if (fresh) this.camera.reset()
    // Where the walk is now (the walk telling of a move that isn't one pauses nothing).
    this.follow.start(walkStep, fresh)
    const until = typeof o.until === 'number' ? { until: o.until } : {}
    // Loaded in the Listen view, whose audio may not play, and the panel's may: it plays in the panel.
    if (this.host.key === lj.key && this.host.in === 'listen' && this.host.panelPlays(lj.key) && this.host.listen.alive) {
      this.host.moveTo('panel', lj, { at: at ?? this.nowOf(lj), play: true, ...until })
      return
    }
    if (!this.host.has(lj.key)) {
      if (!(await this.host.load(lj, { play: o.until === undefined, at: at ?? this.store.posOf(lj), until: o.until }))) {
        fireAndForget(vscode.window.showWarningMessage('The Listen view could not be opened, so the audio has nowhere to play.'), 'podcast: window.showWarningMessage')
      }
      return
    }
    const sameAt = at === undefined || (Math.abs(at - this.store.posOf(lj)) < SAME_MOMENT_S && o.at === undefined)
    this.command('play', { ...(sameAt ? {} : { at }), ...until })
  }

  private async journeyFor(arg?: unknown): Promise<LoadedJourney | undefined> {
    if (arg !== undefined) {
      const lj = await this.tour.pickJourney(arg)
      if (lj && !this.has(lj)) this.cantPlay(lj)
      return lj && this.has(lj) ? lj : undefined
    }
    const candidates = [this.tour.tourJourney(), this.mapPanel.journey]
    const here = candidates.find((x) => x && this.has(x))
    if (here) return here
    // The journey here has a podcast that can't be played: why, not another journey's.
    const broken = candidates.find((x) => x && this.library.brokenOf(x.key))
    if (broken) { this.cantPlay(broken); return undefined }
    const all = this.ports.journeys.all().filter((x) => this.has(x))
    if (!all.length) { vscode.window.setStatusBarMessage(NO_PODCAST_HERE, 3000); return undefined }
    // Walking another journey: asked, never switched silently.
    const walking = this.tour.touring() ? this.tour.tourJourney() : undefined
    if (all.length === 1 && !walking) return all[0]
    const placeHolder = walking ? `Listen to a journey (this ends the walk through “${walking.j.title}”)` : 'Listen to a journey'
    const pick = await vscode.window.showQuickPick(all.map((x) => ({ label: x.j.title, description: clock(this.library.get(x.key)!.episode.duration), lj: x })), { placeHolder })
    return pick?.lj
  }

  /** Asked to play a journey whose podcast can't be (or that has none): says why, with the way to the details. */
  private cantPlay(lj: LoadedJourney): void {
    const b = this.library.brokenOf(lj.key)
    if (!b) { vscode.window.setStatusBarMessage(`$(info) ${lj.j.title} has no podcast`, 3000); return }
    const asked = vscode.window.showWarningMessage(`The podcast of “${lj.j.title}” can't be played: ${b.reason}`, 'Show Why')
    fireAndForget(asked.then((a) => { if (a) fireAndForget(this.showWhy(lj), 'podcast: showWhy') }), 'podcast: window.showWarningMessage')
  }

  /** Space for listening: pause, or play (the journey in the Listen view; else as Listen to Journey). In a journey
   *  without a podcast it says so: never another journey's podcast, ending this walk. */
  async toggle(): Promise<void> {
    const lj = this.listening()
    if (lj && this.host.has(lj.key)) {
      if (this.session.playing) this.session.reason = 'paused by the reader'
      this.command(this.session.playing ? 'pause' : 'play')
      return
    }
    const here = this.tour.touring() ? this.tour.tourJourney() : this.mapPanel.journey
    if (here && !this.has(here) && !this.library.brokenOf(here.key)) {
      vscode.window.setStatusBarMessage(`$(info) ${here.j.title} has no podcast`, 3000)
      return
    }
    await this.play()
  }

  /** A journey is listened to; else the status bar says nothing is. */
  private requireSession(): boolean {
    if (this.listening()) return true
    vscode.window.setStatusBarMessage(NOTHING_LISTENED, 2000)
    return false
  }

  /** Previous / next step of the episode (⏮ ⏭). */
  part(dir: 1 | -1): void { if (this.requireSession()) this.command('part', { dir }) }
  back(): void { if (this.requireSession()) this.command('skip', { by: -SKIP_S }) }
  forward(): void { if (this.requireSession()) this.command('skip', { by: SKIP_S }) }

  // ---------- the session's own ----------

  /** A command for the host; a seek or a pause makes its older reports stale until it answers. */
  private command(action: string, more: HostCommand = {}): void {
    if (action === 'seek' || action === 'pause') this.session.asking(action)
    this.host.send({ type: 'podcastCmd', action, ...more })
  }

  /** Paused by the extension, and why (the log says it once the host has). */
  private pause(why: string, more: HostCommand = {}): void {
    this.session.reason = why
    this.command('pause', more)
  }

  /** The session is over (the walk ended, another journey): the status item goes, the card is the walk's alone. */
  private endSession(lj: LoadedJourney, why: string): void {
    if (!this.session.is(lj.key)) return
    log().info(`podcast ${lj.j.id}: stopped at ${clock(this.store.posOf(lj))} (${why}); ▶ goes on from there`)
    this.session.stop()
    this.marks.clear()
    this.follow.ended()
    this.renderItem()
    this.follow.redrawCard(lj, true)
  }

  /** It started or stopped playing: one line in the output, with why when the extension did it. */
  private saidState(lj: LoadedJourney, t: number): void {
    if (this.session.playing) {
      this.session.heldFor = undefined
      log().info(`podcast ${lj.j.id}: playing from ${clock(t)}`)
    } else log().info(`podcast ${lj.j.id}: paused at ${clock(t)} (${this.session.reason ?? 'in the player'})`)
    this.session.reason = undefined
  }

  /** The first time any podcast plays: one line on what will happen to the editor. */
  private hintOnce(): void {
    if (!this.store.firstListen()) return
    fireAndForget(vscode.window.showInformationMessage('The walk follows the voice: code opens beside the map.', 'Got it'), 'podcast: window.showInformationMessage')
  }

  /** The status item drawn for the session as it is. */
  private renderItem(): void {
    this.statusItem.render({ journey: this.listening(), playing: this.session.playing, ended: this.session.ended, t: this.sessionTime, panelOnScreen: this.mapPanel.visible })
  }

  dispose(): void { for (const d of this.subs) d.dispose() }
}
