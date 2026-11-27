// Which webview plays the audio. Two pages have a player (media/journey-podcast.js): the Listen view's (listenView.ts)
// and the journey panel's. One of them is the host (its <audio> plays; it reports where it is), the other a remote
// (it draws the host's state and asks for what the reader clicks). The extension relays between them:
//
//   remote --podcastAsk--> extension --podcastCmd--> host
//   host --podcastTime/State/Error/Meta--> extension --podcastState--> remote
//
// The host is the Listen view (it outlives the panel) unless only the panel's audio may play: VS Code lets a
// webview's audio play only once a click or a key in that webview started it, so the audio moves to the panel when
// only the panel is unlocked (its ▶ pressed, or a start found the Listen view's locked), and back when the panel goes.
//
//   listen --(Listen view locked, panel unlocked and showing the journey)--> panel
//   panel --(the panel closes, or shows another journey)--> listen
//
// One player at a time: while the panel has the audio the Listen view is not there (statusItem.ts), and VS Code drops
// its page then; the audio going back makes it again (paused where it was: a new page needs a click to play).
import * as vscode from 'vscode'
import type { FromListen } from '../protocol/listen'
import type { FromPlayer, PodcastAsk, PodcastEpisode, PodcastHostState, PodcastUnavailable, ToPlayer } from '../protocol/podcast'
import type { Journeys } from '../journeys/journeys'
import type { MapPanel } from '../journeys/mapPanel'
import type { LoadedJourney } from '../journeys/steps'
import type { TourApi } from '../tour/api'
import { fireAndForget } from '../platform/run'
import { ListenView } from './listenView'

type Where = 'listen' | 'panel'
/** Where the audio starts once loaded: from `at`, playing if `play`; one step if `until`. */
export interface Cue { at?: number; play?: boolean; until?: number }

/** What the host's player and the remotes tell the player (podcasts' own decisions). */
export interface AudioHostClient {
  /** The episode a player gets (`host`: with whether it plays once loaded). */
  episodeFor(lj: LoadedJourney, toUri: (u: vscode.Uri) => string | undefined, host?: boolean): PodcastEpisode | PodcastUnavailable | undefined
  posOf(lj: LoadedJourney): number
  /** Where `lj`'s audio is now. */
  nowOf(lj: LoadedJourney): number
  /** The journey listened to, and whether it plays. */
  listening(): LoadedJourney | undefined
  playing(): boolean
  /** The host's reports (`shown`: the journey its report names). */
  time(shown: LoadedJourney, m: Extract<FromPlayer, { type: 'podcastTime' }>): void
  state(m: PodcastHostState): void
  error(shown: LoadedJourney | undefined, message: string, of?: string): void
  meta(shown: LoadedJourney, duration: number, of?: string): void
  /** What a remote asks, and the Listen view's own buttons. */
  ask(lj: LoadedJourney, m: PodcastAsk): Promise<void>
  why(lj: LoadedJourney | undefined): Promise<void>
  open(): Promise<void>
  end(lj: LoadedJourney, action: 'walk' | 'next'): Promise<void>
  /** The Listen view went with the audio in it. */
  lost(): void
  /** The audio moved to the other player. */
  moved(): void
}

export class AudioHost implements vscode.Disposable {
  readonly listen: ListenView
  private where: Where = 'listen'
  /** The journey whose episode the host has loaded, and its last state. */
  private hostKey: string | undefined
  private hostState: PodcastHostState | undefined
  /** Each player's audio may play (a click or a key in it started it once). */
  private readonly unlocked = { listen: false, panel: false }
  /** Episodes on their way to the Listen view (it is being made for them). */
  private loading = 0

  constructor(extensionUri: vscode.Uri, private readonly log: () => vscode.LogOutputChannel,
    private readonly ports: { journeys: () => Journeys; mapPanel: () => MapPanel; tour: () => TourApi },
    private readonly client: AudioHostClient) {
    this.listen = new ListenView(extensionUri, log(), { message: (m) => this.fromListen(m), gone: () => this.listenGone() })
  }

  private journey(key: string | undefined): LoadedJourney | undefined { return key ? this.ports.journeys().list.get(key) : undefined }

  /** Where the audio plays. */
  get in(): Where { return this.where }
  /** The journey whose episode the host has. */
  get key(): string | undefined { return this.hostKey }
  /** Episodes are on their way to the Listen view. */
  get busy(): boolean { return this.loading > 0 }
  /** Each player's audio may play. */
  get unlocks(): { listen: boolean; panel: boolean } { return { ...this.unlocked } }

  /** The host's last state for journey `key`, when it has that journey. */
  stateOf(key: string): PodcastHostState | undefined {
    return this.hostKey === key && this.hostState?.of === key ? this.hostState : undefined
  }

  /** The host is there and takes commands. */
  alive(): boolean {
    return this.where === 'panel' ? !!this.hostKey && this.ports.mapPanel().journey?.key === this.hostKey : this.listen.alive
  }
  /** The journey panel has the audio (its player is the one on screen; the Listen view goes). */
  get panelHosts(): boolean { return this.where === 'panel' && this.alive() }
  /** The host has journey `key`'s episode and takes commands. */
  has(key: string): boolean { return this.hostKey === key && this.alive() }

  /** A message for the audio's host. */
  send(m: ToPlayer): void {
    if (this.where === 'panel') this.ports.mapPanel().send(m)
    else this.listen.send(m)
  }

  /** The audio may play in the panel and not in the Listen view, and the panel shows journey `key`. */
  panelPlays(key: string): boolean {
    return !this.unlocked.listen && this.unlocked.panel && this.ports.mapPanel().journey?.key === key
  }

  /** Journey `lj`'s episode into the host (the Listen view made first; the panel when only its audio may play, and it
   *  shows `lj`). */
  async load(lj: LoadedJourney, o: Cue = {}): Promise<boolean> {
    this.loading++
    try {
      if (!(await this.listen.ensure())) return false
    } finally { this.loading-- }
    const cue = { at: o.at ?? this.client.posOf(lj), play: !!o.play || o.until !== undefined, ...(o.until !== undefined ? { until: o.until } : {}) }
    if (this.panelPlays(lj.key)) { this.moveTo('panel', lj, cue); return true }
    if (this.where === 'panel') { this.moveTo('listen', lj, cue); return true }
    const episode = this.client.episodeFor(lj, (u) => this.listen.toUri(u), true)
    if (!episode || 'unavailable' in episode) return false
    this.hostKey = lj.key
    this.hostState = undefined
    this.listen.send({ type: 'podcast', episode: { ...episode, ...(o.at !== undefined ? { at: o.at } : {}), ...(o.play ? { play: true } : {}) } })
    if (o.until !== undefined) this.send({ type: 'podcastCmd', action: 'play', ...(o.at !== undefined ? { at: o.at } : {}), until: o.until })
    return true
  }

  /** The podcast files were read again: the Listen view's episode follows (the same audio keeps playing; one that
   *  went or can't be played now leaves the view). The panel's comes with the panel's own update. */
  refresh(): void {
    const lj = this.journey(this.hostKey)
    if (!this.hostKey || !this.listen.alive) return
    const episode = lj && this.client.episodeFor(lj, (u) => this.listen.toUri(u), true)
    if (!episode || 'unavailable' in episode) this.forget()
    this.listen.send({ type: 'podcast', episode })
  }

  /** The audio of `lj` to `to` (`cue`: where, playing or not): the other player becomes its remote, the Listen view
   *  showing the same episode. */
  moveTo(to: Where, lj: LoadedJourney, cue: Cue): void {
    if (this.where !== to) {
      if (this.where === 'listen') this.listen.send({ type: 'podcastRole', role: 'remote' })
      else if (this.ports.mapPanel().journey) this.ports.mapPanel().send({ type: 'podcastRole', role: 'remote' })
    }
    this.where = to
    this.hostKey = lj.key
    this.hostState = undefined
    this.listen.send({ type: 'podcast', episode: this.client.episodeFor(lj, (u) => this.listen.toUri(u)) })
    this.send({ type: 'podcastRole', role: 'host', ...cue })
    this.log().info(`podcast ${lj.j.id}: the audio plays in the ${to === 'panel' ? 'journey panel' : 'Listen view'}${cue.play ? '' : ' (paused)'}`)
    this.client.moved()
  }

  /** The panel's audio back to the Listen view: at once when the view is there, else once it is made again (the
   *  panel stops being the host now: it may be showing another journey already). */
  private backToListen(lj: LoadedJourney, cue: Cue): void {
    if (this.listen.alive) { this.moveTo('listen', lj, cue); return }
    if (this.ports.mapPanel().journey) this.ports.mapPanel().send({ type: 'podcastRole', role: 'remote' })
    this.where = 'listen'
    this.forget()
    this.client.moved()
    fireAndForget(this.load(lj, cue).then((ok) => { if (!ok) this.client.lost() }), 'podcast: load the host')
  }

  /** The panel is about to show `lj`: playing another journey's audio, that audio goes to the Listen view first. */
  panelShows(lj: LoadedJourney): void {
    if (this.where === 'panel' && this.hostKey && this.hostKey !== lj.key) {
      const was = this.journey(this.hostKey)
      if (was) this.backToListen(was, { at: this.client.nowOf(was), play: this.client.playing() })
      else this.where = 'listen'
    }
    this.listen.send({ type: 'panel', key: lj.key })
  }

  /** The panel closed: its audio, if it had it, goes to the Listen view (where it is, playing on if it played). */
  panelClosed(): void {
    this.listen.send({ type: 'panel' })
    this.unlocked.panel = false
    if (this.where !== 'panel') return
    const lj = this.journey(this.hostKey)
    if (lj) this.backToListen(lj, { at: this.client.nowOf(lj), play: this.client.playing() })
    else this.where = 'listen'
  }

  /**
   * The host's audio may not play (no click or key in it yet). Started in the Listen view, with the panel showing the
   * journey: the audio goes to the panel, playing when the panel's audio may, else paused there with its ▶ taking the
   * keyboard, so Space or one click there plays it.
   */
  notAllowed(): void {
    const lj = this.journey(this.hostKey)
    if (!lj || this.ports.mapPanel().journey?.key !== lj.key) return
    if (this.where === 'listen') this.moveTo('panel', lj, { at: this.client.nowOf(lj), play: this.unlocked.panel })
    if (this.unlocked.panel) return
    this.ports.tour().showMap(lj, false)
    this.ports.mapPanel().send({ type: 'podcastCmd', action: 'focus' })
  }

  /** The host's state of its episode: kept (a reopened panel draws it) and passed on to the remote (the panel, when it
   *  shows that journey; or the Listen view). False: not the host's episode. */
  relayState(m: PodcastHostState): boolean {
    if (!m || m.of !== this.hostKey) return false
    this.hostState = m
    if (this.where === 'panel') this.listen.send({ type: 'podcastState', ...m })
    else if (this.ports.mapPanel().journey?.key === m.of) this.ports.mapPanel().send({ type: 'podcastState', ...m })
    return true
  }

  /** What the panel's player says of the audio: unlocked (a click or key there), and, while it is the host, where the
   *  audio is (a remote's or an older page's reports are not the audio's). */
  fromPanel(m: FromPlayer): void {
    if (m.type === 'podcastUnlocked') { this.unlocked.panel = true; return }
    if (this.where === 'panel') this.fromHost(m)
  }

  /** What the Listen view says. */
  private fromListen(m: FromListen): void {
    const shown = 'of' in m ? this.journey(m.of) : undefined
    switch (m.type) {
      case 'podcastTime': case 'podcastState': case 'podcastError': case 'podcastMeta':
        if (this.where === 'listen') this.fromHost(m)
        break
      case 'podcastUnlocked': this.unlocked.listen = true; break
      case 'podcastAsk': {
        const lj = this.journey(m.of) ?? this.journey(this.hostKey)
        if (lj) fireAndForget(this.client.ask(lj, m), 'podcast: ask')
        break
      }
      case 'podcastWhy': fireAndForget(this.client.why(shown ?? this.journey(this.hostKey)), 'podcast: showWhy'); break
      case 'podcastOpen': fireAndForget(this.client.open(), 'podcast: openSessionMap'); break
      case 'podcastEnd': { const lj = this.journey(m.of) ?? this.client.listening(); if (lj) fireAndForget(this.client.end(lj, m.action), 'podcast: end') } break
      case 'ready': this.listenReady(); break
    }
  }

  /** A new Listen page (the view was made again): its audio locked, no episode until it is sent one. While the panel
   *  plays the audio, it is the panel's remote. */
  private listenReady(): void {
    this.unlocked.listen = false
    this.listen.send({ type: 'panel', key: this.ports.mapPanel().journey?.key })
    if (this.where === 'panel') {
      const lj = this.journey(this.hostKey)
      this.listen.send({ type: 'podcastRole', role: 'remote' })
      if (lj) this.listen.send({ type: 'podcast', episode: this.client.episodeFor(lj, (u) => this.listen.toUri(u)) })
      return
    }
    this.forget()
    // The view made again while a journey is listened to (paused), not for an episode on its way: that episode.
    const lj = this.client.listening()
    if (lj && !this.loading) fireAndForget(this.load(lj), 'podcast: load the host')
  }

  /** What the host says. */
  private fromHost(m: FromPlayer): void {
    const shown = 'of' in m ? this.journey(m.of) : undefined
    switch (m.type) {
      case 'podcastTime': if (shown) this.client.time(shown, m); break
      case 'podcastState': this.client.state(m); break
      case 'podcastError': this.client.error(shown, m.message, m.of); break
      case 'podcastMeta': if (shown) this.client.meta(shown, m.duration, m.of); break
    }
  }

  /** The Listen view went for good (its view closed): the audio with it, unless the panel has it or an episode is on
   *  its way to a new view. */
  private listenGone(): void {
    this.unlocked.listen = false
    if (this.where === 'panel' || this.loading) return
    this.forget()
    this.client.lost()
  }

  private forget(): void {
    this.hostKey = undefined
    this.hostState = undefined
  }

  dispose(): void { this.listen.dispose() }
}
