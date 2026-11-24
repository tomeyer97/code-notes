// The journey panel's messages, both ways: what media/journey-map.js (and the modules it imports: journey-home.js,
// journey-tutorial.js, journey-scene.js, journey-podcast.js) posts, and what src/journeys/mapPanel.ts sends it.
// Each feature of the panel registers handlers for its messages (src/journeys/panel/) and gives its part of TourInfo.
import type { Journey } from '../core/format/journeyModel'
import type { ListKind, ListModel, ListRow, Sort } from '../core/list/journeyList'
import type { FromPlayer, ToPlayer } from './podcast'

/**
 * What the page posts. Handled in src/journeys/mapPanel.ts (ready, rendered, story, error, legend, view, and home with
 * `on`); the rest by the feature that registered it on the panel's controller (src/journeys/panel/features/). `closed`
 * is the panel's own, when it is disposed.
 */
export type FromMap =
  // The page itself: drawn, its errors, what it shows (tests read these).
  | { type: 'ready' }
  | { type: 'rendered'; boxes: number }
  | { type: 'story'; steps: number; stops: string[]; cur?: string; overflow: string[]; width: number }
  | { type: 'view'; node: string }
  | { type: 'error'; message?: string; text?: string }
  | { type: 'closed' }

  // Walking a journey: steps, their links and refs, the end; the animation's beat (i = -1: the scene is gone; user:
  // the reader moved it).
  | { type: 'step'; n: number }
  | { type: 'end' }
  | { type: 'finish' }
  | { type: 'openPath'; path: string }
  | { type: 'openFile' }
  | { type: 'ref'; i: number }
  | { type: 'details'; open: boolean }
  | { type: 'beat'; n: number; i: number; user?: boolean }
  | { type: 'ask'; update?: boolean }
  | { type: 'restore' }
  | { type: 'authors' }

  // The panel's listening player (a remote of the Listen view's audio, or the host itself after a ▶ here).
  | FromPlayer

  // A check's tour: its questions on the storyline.
  | { type: 'question'; id: string }
  | { type: 'checkpoint'; id: string }
  | { type: 'nextStop' }

  // The tutorial.
  | { type: 'tutorial'; action: 'bar' | 'card' | 'skip' | 'done'; card?: number; inside?: boolean; editor?: false | 'card' | 'links' }

  // The Journeys list (the panel's home).
  | { type: 'home'; on?: boolean }
  | { type: 'walk'; key: string }
  | { type: 'list'; query?: string; kind?: ListKind | 'all'; area?: string; sort?: Sort; searchSort?: Sort | 'best' }
  | { type: 'preview'; key: string }
  | { type: 'refresh'; key: string }
  | { type: 'hereAll' }

  // Layout: the legend, the panel's and the map's widths.
  | { type: 'legend'; hidden: boolean }
  | { type: 'panelWidth'; w: number }
  | { type: 'mapWidth'; w: number }

/** A row of the panel's own short journey list (TourInfo.list). */
export interface PanelListRow { key: string; title: string; question: string; steps: number; resume: number; here?: boolean; start?: boolean }

/** The step card as the map shows it (tour/card.ts panelCard), when the step has no code to sit on. */
export interface PanelCard {
  n: number; lead: string; details?: string; refs: string; stale: boolean; staleText: string; open: boolean
  notice?: string; title: string
  /** Where each of its links goes (`src/a.ts:40-42`). */
  paths: string[]
}

/** The walk as the map draws it: the step shown (0: none), stale steps, where it was left (to resume), the card. */
export interface WalkInfo {
  current: number; marks: Record<number, string>; resume: number
  /** The chord prefix to show in hints. */
  key: string
  /** Files the steps followed through a rename (old -> new path): box paths say where the code went. */
  moved: Record<string, string>
  /** The step card, when it lives in the map ("panel"). */
  card?: PanelCard
  /** The walk was just finished: the panel says Done, the summary, and offers the list. */
  done?: boolean
  /** One muted line under the question: "Written by AI · 2 days ago · 3 commits behind"; `changed` stale steps. */
  prov?: { text: string; tip: string; changed: number }
  /** Steps someone asked about: the step's latest question (`count` in all, `answered` of them; `update`: one asks for
   *  the step's update). */
  asked?: Record<number, { id: string; state: 'q' | 'a'; unread: boolean; count: number; answered: number; update: boolean }>
}

/** The panel itself: the legend, the map column's width, the tutorial's bar. */
export interface PanelViewInfo {
  legendHidden: boolean
  /** The map column's width in a wide panel, dragged by the reader (0.21.1); unset: the default. */
  mapWidth?: number
  /** Offer the tutorial bar. */
  tutorial: boolean
}

/** What is wrong with the journey: for readers (why it can't be read) and for its author. */
export interface ProblemsInfo {
  problems: string[]
  /** Rule breaks only an author can fix (author mode): a count and a link to the Output channel. */
  authors?: number
}

/** A check's tour: its questions, each a row after the step that shows its answer; `cur`: the walk is at it. */
export interface CheckInfo {
  stops?: { id: string; n: number; step: number; text: string; state: string; cur?: boolean }[]
}

/** A home row's podcast (journey-home.js marks the row): its length; listening, or where it was paused. */
export interface RowPodcast { duration: number; playing: boolean; at?: number }

/** The home's list model, its rows with their podcast. */
export interface HomeListModel extends ListModel {
  rows: Record<string, ListRow & { podcast?: RowPodcast }>
}

/** The Journeys list (the panel's home). Sent only when it changed: the page keeps the last one it was sent. */
export interface HomeInfo {
  /** Every journey, for the panel's home list (0.21): title, steps, where it was left. */
  list?: PanelListRow[]
  /** The home's list model (journeyList.ts): sections, rows, chips, with the home's own search. */
  home?: HomeListModel
}

/** What the map needs besides the journey: each feature's part. */
export type TourInfo = WalkInfo & PanelViewInfo & ProblemsInfo & CheckInfo & HomeInfo

/** The lines of a beat's code, under its animation's caption. */
export interface BeatCode { file: string; line: number; from: number; lines: string[] }

/** What the page is sent. */
export type ToMap =
  /** A journey to show, and where its walk is. */
  | ({ type: 'journey'; journey: Journey } & TourInfo)
  /** Where the walk is now. */
  | ({ type: 'tour' } & TourInfo)
  /** The journey list in front. */
  | { type: 'home' }
  /** A journey for the home's preview, and which of its steps are stale since when. */
  | { type: 'preview'; key: string; journey: Journey; stale: { n: number; when: string }[] }
  /** The journey's file is gone. */
  | { type: 'deleted'; file: string }
  /** Replay the tutorial. */
  | { type: 'tutorial' }
  /** Ctrl+' P: the current step's animation on or off. */
  | { type: 'anim'; action: 'toggle' | 'off' }
  /** The lines of beat `i` of step `n`'s animation (none: no lines to show). */
  | { type: 'code'; n: number; i: number; code?: BeatCode }
  /** Answered with ready (the extension may have missed it). */
  | { type: 'hello' }
  /** Integration tests drive the real handlers: a click on a selector, a key. */
  | { type: 'test'; click?: string; key?: string }
  /** The podcast is on step `n`'s beat `i` (-1: the step without its animation); still: no flight, it was a jump. */
  | { type: 'podcastBeat'; n: number; i: number; still?: boolean }
  | ToPlayer
