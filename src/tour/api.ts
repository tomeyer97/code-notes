// What the rest of the extension may ask of the tour (createTour in tour/index.ts makes it). Other features get a
// TourApi (or the part they need) as a port and never import walk.ts, card.ts or state.ts. Types only: importing this
// file pulls in no tour module.
import type * as vscode from 'vscode'
import type { LoadedJourney } from '../journeys/steps'
import type { JourneyPos } from '../platform/state'
import type { Check } from '../check/types'

/** What the step card shows of a podcast on its journey: playing or paused, following the voice or not (the follow
 *  lock), the beat being narrated (0-based, of `beats`). */
export interface Narration { playing: boolean; following: boolean; beat?: number; beats: number; key: string }

/** Where the walk is, as others may read it (only the tour moves it). */
export interface TourView {
  /** The journey whose map is open (its key), and the step shown (1-based; 0: browsing the map, no tour running). */
  readonly key: string | undefined
  readonly step: number
  /** The current step's id. */
  readonly stepId: string | undefined
  /** On a check's tour: the question the walk is at, else undefined. */
  readonly checkpointId: string | undefined
  /** The file the tour last opened, in the code group. */
  readonly doc: { uri: vscode.Uri; column: vscode.ViewColumn } | undefined
  /** The editor group the walk shows code in. */
  readonly walkGroup: vscode.TabGroup | undefined
  /** Until then, cursor moves are the journey's, not the reader's. */
  readonly cursorUntil: number
  /** Where a code link's Back goes (the step walked when it was clicked). */
  readonly linkBack: { journey: string; step: number } | undefined
  /** The tour is on step n of this journey (whether or not a step is shown). */
  isAt(lj: { key: string }, n: number): boolean
}

/**
 * Where a podcast must decide for the walk (the one podcast player registers it: TourApi.usePodcast). Without one,
 * the walk decides alone.
 */
export interface WalkController {
  /** Next / Previous (the card, the keys) while it drives the walk: true when its own ⏮ ⏭ did it. */
  transport(dir: 1 | -1): boolean
  /** The step on screen was removed from the journey: true when it puts the walk where its time is now. */
  stepRemoved(lj: LoadedJourney): boolean
  /** It is playing or paused on this journey (its row, Open Journey… on it: focus, never reopen). */
  listening(lj: LoadedJourney): boolean
  /** What the step card shows of it on step n of `lj`. */
  narration(lj: LoadedJourney, n: number): Narration | undefined
  /** The editor follows the walk (false while the reader looks around on their own while it plays). */
  following(): boolean
  /** An episode is on: the panel opens at the listening width. */
  episodeOn(): boolean
}

/** A podcast's status as the lists and the map show it. */
export interface PodcastStatus { state: 'ok' | 'broken'; text?: string; duration?: number; session?: boolean; playing?: boolean; t?: number }

/** What the tour asks of the podcast player besides the walk's decisions: the panel's player's messages, its status
 *  in lists, holding it while a box asks something. */
export interface TourPodcast extends WalkController {
  status(lj: LoadedJourney): PodcastStatus | undefined
  /** Paused while `what` (a note, a question) is being written; `released` plays on. */
  hold(what: string): boolean
  released(what: string): void
  play(arg?: unknown): Promise<void>
  /** The panel's own messages about its player (journey-podcast.js). */
  fromPanel(m: { type: string; of?: string; [k: string]: unknown }): void
  onBeat(lj: LoadedJourney, n: number, i: number): void
  onClosed(): void
  showWhy(lj?: LoadedJourney): Promise<void>
  onAsk(lj: LoadedJourney, m: { of?: string; action: string; [k: string]: unknown }): Promise<void>
  endAction(lj: LoadedJourney, action: 'walk' | 'next', of?: string): Promise<void>
}

/** The tour as the other features see it. */
export interface TourApi {
  /** Where the walk is (read-only). */
  readonly state: TourView
  /** A tour is running (not just a map open). */
  touring(): boolean
  /** The journey the tour is on (its map open), if any. */
  tourJourney(): LoadedJourney | undefined
  /** Where each journey's walk was left; where this one was (0: never started). */
  positions(): Record<string, JourneyPos>
  resumeAt(lj: LoadedJourney): number
  /** The editor group code opens in (never the map's). */
  codeColumn(): vscode.ViewColumn | undefined
  /** The editor that already shows `uri` (outside the map's group), else the code group. */
  columnFor(uri: vscode.Uri): vscode.ViewColumn | undefined

  /** Next or previous step (or stop of a check's tour); no tour: start or resume. */
  stepBy(dir: 1 | -1): Promise<void>
  goToStep(lj: LoadedJourney, n: number, opts?: { focus?: boolean; beat?: number }): Promise<void>
  /** Opens a journey: its map, and the walk where it was left (`fromStart`: step 1). */
  walkJourney(lj: LoadedJourney, opts?: { fromStart?: boolean; keepFocus?: 'sidebar' | 'panel' }): Promise<void>
  /** Shows a journey's map (another journey's walk ends first, keeping its place). */
  openMap(lj: LoadedJourney, show?: boolean): Promise<void>
  showMap(lj: LoadedJourney, preserveFocus?: boolean): void
  endJourney(): Promise<void>
  /** The walk's own preview tabs in `column` closed. */
  closeWalkTabs(lj: LoadedJourney, column: vscode.ViewColumn | undefined): Promise<void>
  /** The journey picker (an argument: that journey). */
  pickJourney(arg?: unknown): Promise<LoadedJourney | undefined>
  /** Beat i of step n's animation: its code lit. */
  showBeat(lj: LoadedJourney, n: number, i: number): Promise<void>
  /** The code group gets the room the panel doesn't need. */
  codeGetsMoreRoom(): Promise<void>
  /** A step's reference opened under the step card. */
  openRef(lj: LoadedJourney, file: string, line: number, end: number, step: number): Promise<void>
  /** After the journeys changed: the walk's lists, keys, lenses, map and status item follow. */
  updateTour(): void
  /** A journey started or stopped being listened to: the status item again. */
  statusChanged(): void
  /** Steps followed their code into other files (or went stale) after a change on disk: the map and the card follow. */
  stepsFollowed(changed: LoadedJourney[]): Promise<void>

  /** The step card lives in the map for step n (no code to sit on). */
  inMap(lj: LoadedJourney, n: number): boolean
  /** The editor shows the code the podcast's voice tells now. */
  narrates(editor: vscode.TextEditor): boolean
  /** The step card's bars drawn again. */
  refreshCard(): void
  /** The step card made again for step n. */
  showCard(lj: LoadedJourney, n: number): void
  /** The step lenses asked again. */
  lensesChanged(): void
  /** A code link was clicked on this step: its Back goes there (undefined: no way back). */
  linkClicked(back: { journey: string; step: number } | undefined): void
  /** Cursor moves for `ms` are the extension's, not the reader's. */
  ownCursorFor(ms: number): void
  /** The walk's step number may name another step now (the podcast moves it by number). */
  forgetStepId(): void

  /** The check's tour follows the check (or goes with it). */
  checkTourChanged(check: Check | undefined, file: string | undefined, branch: string | undefined): Promise<void>
  /** The check's tour on this branch, if any. */
  checkTour(): LoadedJourney | undefined
  /** Question `id`'s stop of a check's tour opened; false when it has no step. */
  openCheckpoint(lj: LoadedJourney, id: string): Promise<boolean>
  /** "See also" for a check's question: a journey of the repo walking that code (a link), if any. */
  seeAlsoLink(files: string[], span?: { start: number; end: number }): string | undefined

  /** The podcast player: decides for the walk and receives its panel's messages, until disposed. */
  usePodcast(p: TourPodcast): vscode.Disposable
  /** The podcast registered, if any. */
  podcast(): TourPodcast | undefined
  /** The walk moved, or the journeys changed under it. */
  readonly onDidMove: vscode.Event<void>
  /** The walk was restored after a reload. */
  readonly onDidRestore: vscode.Event<LoadedJourney>
}
