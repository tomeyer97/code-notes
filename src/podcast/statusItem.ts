// The Listen status item: while a journey is listened to and its panel (the player) is not on screen, "Listening ·
// 6:58" or "Paused · 6:58", click: the journey's map. Gone once the episode ended. The walk's own item steps aside
// while a journey is listened to (one item), and the Listen view is there only then (`codeNotes.listening`).
import * as vscode from 'vscode'
import { clock } from '../core/format/podcast/model'
import type { LoadedJourney } from '../journeys/steps'
import { chordKey } from '../platform/chordKey'
import { Cmd } from '../platform/commands'
import { setCtx } from '../platform/context'
import { fireAndForget } from '../platform/run'
import { LISTENING_CTX } from './listenView'

/** The Listen view goes this long (ms) after the last journey stopped being listened to (another may start). */
const LISTENING_OFF_MS = 3000

/** What the item shows. */
export interface ItemState { journey: LoadedJourney | undefined; playing: boolean; ended: boolean; t: number; panelOnScreen: boolean }

export class ListenStatusItem implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('codeNotes.listen', vscode.StatusBarAlignment.Left, 49.25)
  /** A journey is listened to (as last told). */
  private listening = false
  private listeningOff: NodeJS.Timeout | undefined
  private on = false

  /**
   * `idle()`: nothing is listened to nor on its way (the Listen view may go); `listeningChanged`: a journey started or
   * stopped being listened to (the walk's item and the Journeys rows follow).
   */
  constructor(private readonly idle: () => boolean, private readonly listeningChanged: () => void) {
    this.item.name = 'Listen'
    this.item.command = Cmd.podcastOpen
  }

  /** The item is on screen. */
  get shown(): boolean { return this.on }
  get text(): string { return this.item.text }

  /** Draws the item (no side effects beyond it); a change of whether a journey is listened to is passed on first. */
  render(s: ItemState): void {
    if (!!s.journey !== this.listening) this.sessionChanged(!!s.journey)
    const lj = s.journey
    this.on = !!lj && !(s.ended && !s.playing) && !s.panelOnScreen
    if (!lj) { this.item.hide(); return }
    const state = s.playing ? 'Listening' : 'Paused'
    this.item.text = `${state} · ${clock(s.t)}`
    this.item.tooltip = `${s.playing ? 'Pause' : 'Play'} (${chordKey()} Space) · click: the map`
    this.item.accessibilityInformation = { label: `${state}: ${lj.j.title}, ${clock(s.t)}. Opens the journey's map.` }
    if (this.on) this.item.show()
    else this.item.hide()
  }

  /** A journey started or stopped being listened to: the Listen view in (at once) or out (a moment later), and the
   *  others told. */
  private sessionChanged(on: boolean): void {
    this.listening = on
    if (on) {
      clearTimeout(this.listeningOff)
      this.listeningOff = undefined
      fireAndForget(setCtx(LISTENING_CTX, true), 'podcast: setCtx LISTENING_CTX')
    } else this.viewOffLater()
    this.listeningChanged()
  }

  /**
   * The Listen view out once nothing has been listened to for a moment: going from one journey to another ends one
   * session before the next starts, and the view going would take the audio's unlocking with it (a new view needs a
   * click again).
   */
  private viewOffLater(): void {
    if (this.listeningOff) return
    this.listeningOff = setTimeout(() => {
      this.listeningOff = undefined
      if (this.listening) return
      if (this.idle()) fireAndForget(setCtx(LISTENING_CTX, false), 'podcast: setCtx LISTENING_CTX')
      else this.viewOffLater()
    }, LISTENING_OFF_MS)
  }

  dispose(): void {
    clearTimeout(this.listeningOff)
    this.item.dispose()
  }
}
