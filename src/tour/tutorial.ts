// The map's tutorial: which card it shows, and the step card it points at in the editor. One Tutorial per window
// (createTour makes it); the map's messages reach it through onTutorial.
import * as vscode from 'vscode'
import type { MapPanel } from '../journeys/mapPanel'
import type { Journeys } from '../journeys/journeys'
import { stored } from '../platform/host'
import { portsSlot } from '../platform/ports'
import type { FromMap as MapMessage } from '../protocol/map'
import { atOf, fileOf, LoadedJourney } from '../journeys/steps'
import { openMapIfRoom } from './commands'
import { panelLayout } from './panelLayout'
import { pickJourney } from './pick'
import { fireAndForget } from '../platform/run'
import { STATE } from '../platform/state'
import type { StepCard, TutorialMark } from './card'
import type { TourState } from './state'
import type { TutorialSpot } from './tutorialSpot'
import type { Walk } from './walk'


/** What the tutorial has shown: how often the bar, its card now (0: none), a card about the inside, done and skip. */
export interface TutorialSeen { bar: number; card: number; done: number; skip: number; inside: number }
const NOT_SEEN: TutorialSeen = { bar: 0, card: 0, done: 0, skip: 0, inside: 0 }

type TutorialMessage = Extract<MapMessage, { type: 'tutorial' }>

export interface TutorialParts { state: TourState; card: StepCard; walk: Walk; spot: TutorialSpot; journeys: Journeys; mapPanel: MapPanel }

export class Tutorial implements vscode.Disposable {
  private markNow: TutorialMark = ''
  private readonly seenNow: TutorialSeen = { ...NOT_SEEN }
  private readonly changed = new vscode.EventEmitter<void>()
  /** What it points at, or what it has shown, changed. */
  readonly onDidChange = this.changed.event

  constructor(private readonly p: TutorialParts) {}

  /** What it points at in the step card now (the card puts that on the search-match colour). */
  get mark(): TutorialMark { return this.markNow }
  /** What it has shown (the integration tests read it). */
  get seen(): Readonly<TutorialSeen> { return this.seenNow }

  dispose(): void { this.changed.dispose() }

  /** Code Notes: Journey Tutorial: the map (the tour's, the last one, or picked) with the tutorial from card 1. With
   *  no room for the panel beside 80 columns of code: the step card alone, as any walk (the status bar says so). */
  async start(): Promise<void> {
    const { walk, journeys, mapPanel } = this.p
    const lj = walk.tourJourney() ?? journeys.byPos(stored().get(STATE.mapJourney)) ?? (await pickJourney())
    if (!lj) return
    // A panel already open may squeeze the code: it gets its room first (or the panel goes).
    if (await openMapIfRoom(lj)) await panelLayout().keepCodeRoom()
    if (mapPanel.journey) mapPanel.send({ type: 'tutorial' })
    else await walk.goToStep(lj, walk.startStep(lj))
  }

  /** A message from the map's tutorial: a card shown (and what it points at in the editor), skipped or done. */
  onMessage(lj: LoadedJourney, m: TutorialMessage): void {
    const seen = this.seenNow
    switch (m.action) {
      case 'bar':
        seen.bar++
        break
      case 'card':
        seen.card = m.card ?? 0
        seen.inside = m.inside ? 1 : 0
        if (m.editor) fireAndForget(this.inEditor(lj, m.editor), 'tutorial: inEditor')
        else this.outOfEditor()
        break
      case 'skip':
        seen.skip++
        this.over()
        break
      case 'done':
        seen.done++
        this.over()
        // Finish walks the steps: from where the tour is, else where the map's button would start.
        fireAndForget(this.p.walk.goToStep(lj, this.p.walk.startStep(lj), { focus: false }), 'tutorial: walk.goToStep')
        break
    }
    this.changed.fire()
  }

  /** The tutorial as never seen (the integration tests start it over). */
  async reset(): Promise<void> {
    await stored().set(STATE.tutorialSeen, undefined)
    Object.assign(this.seenNow, NOT_SEEN)
    this.changed.fire()
  }

  /** Skipped or done: no card, nothing pointed at, and it is not offered again. */
  private over(): void {
    this.seenNow.card = 0
    this.outOfEditor()
    fireAndForget(stored().set(STATE.tutorialSeen, true).then(() => this.p.mapPanel.update()), 'tutorial: store tutorialSeen')
  }

  /** The tutorial's card about the step card: a step open in the editor (where the walk is, else where it would
   *  start), its lines boxed, so the card above them is found at a glance. */
  private async inEditor(lj: LoadedJourney, what: 'card' | 'links'): Promise<void> {
    const { walk, card, spot } = this.p
    // The card itself shows it: its buttons, or its linked phrases, on the search-match colour while the tutorial says so.
    this.markNow = what
    const n = walk.startStep(lj)
    await walk.goToStep(lj, n, { focus: false })
    const at = atOf(lj, n)
    // The card moved on while the file opened: nothing.
    if (!at || !this.seenNow.card) return
    card.show(lj, n)
    spot.show(vscode.Uri.joinPath(lj.folder.uri, fileOf(lj, n)), at.start - 1, at.end - 1)
  }

  /** The tutorial left the editor: no box, and the card as it normally looks. */
  private outOfEditor(): void {
    const { walk, card, spot, state } = this.p
    spot.clear()
    if (!this.markNow) return
    this.markNow = ''
    const lj = walk.tourJourney()
    if (lj && state.step) card.show(lj, state.step)
  }
}

const slot = portsSlot<Tutorial>('the tutorial')

/** createTour only. */
export const useTutorial = slot.set

/** The tour's command (Journey Tutorial). */
export const tutorial = (): Promise<void> => slot.get().start()
/** The map's tutorial messages (mapMessages.ts). */
export const onTutorial = (lj: LoadedJourney, m: TutorialMessage): void => slot.get().onMessage(lj, m)
/** The tutorial as never seen (for the integration test). */
export const resetTutorial = (): Promise<void> => slot.get().reset()
