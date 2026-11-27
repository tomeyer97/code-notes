// The listening player's messages (media/journey-podcast.js). Two players carry them: the Listen view's (usually the
// audio's host) and the journey panel's (usually a remote); src/podcast/player.ts relays between them. The page
// protocols (listen.ts, map.ts) include these unions.
import type { Chapter, Segment } from '../core/format/podcast/model'

/** What a player plays and draws (player.ts episodeFor). */
export interface PodcastEpisode {
  /** The journey's key. */
  key: string
  /** The audio as the page loads it ('' : not reachable). */
  src: string
  title: string
  /** The journey's title. */
  journey: string
  duration: number
  /** Where it starts (s). */
  at: number
  /** The host plays it once loaded. */
  play?: boolean
  rate?: number
  muted: boolean
  /** The chord prefix for the keys' hints. */
  keyPrefix: string
  chapters: Chapter[]
  segments: Pick<Segment, 'start' | 'end' | 'text' | 'step' | 'speaker' | 'sentences'>[]
  steps: { n: number; title: string }[]
  /** The end's "Next journey". */
  next?: { key: string; title: string }
  /** One line over the player (it plays the last good version). */
  notice?: string
}

/** A podcast that can't be played: one line says why. */
export interface PodcastUnavailable { unavailable: string }

/** What the audio's host shows (journey-podcast.js S()), as the remotes draw it. */
export interface PodcastHostState {
  /** The journey (key) whose audio it is. */
  of: string
  t: number
  playing: boolean
  held?: boolean
  rate?: number
  muted?: boolean
  ready?: boolean
  loading?: boolean
  ended?: boolean
  dur?: number
  reach?: number
  err?: string
  note?: boolean
  until?: number
  /** Moved by a seek. */
  seek?: boolean
  /** Date.now() when said. */
  sent?: number
}

/** The actions a remote asks of the host and the extension commands it. */
export interface PodcastActionFields {
  action: string
  at?: number
  until?: number
  to?: number
  by?: number
  dir?: number
  rate?: number
  muted?: boolean
}

/** What a player posts. Host: where the audio is (podcastTime), everything it shows (podcastState), its errors and the
 *  audio's length. Remote: podcastAsk. Both: "Show why", the end's buttons, a click or key that unlocks its audio. */
export type FromPlayer =
  | { type: 'podcastTime'; t: number; playing: boolean; held?: boolean; rate?: number; seek?: boolean; of?: string; sent?: number }
  | ({ type: 'podcastState' } & PodcastHostState)
  | { type: 'podcastError'; message: string; of?: string }
  | { type: 'podcastMeta'; duration: number; of?: string }
  | ({ type: 'podcastAsk'; of?: string } & PodcastActionFields)
  | { type: 'podcastWhy' }
  | { type: 'podcastEnd'; of?: string; action: 'walk' | 'next' }
  | { type: 'podcastUnlocked' }

/** A remote's ask of the host, as the extension relays it. */
export type PodcastAsk = Extract<FromPlayer, { type: 'podcastAsk' }>
/** Where the host's audio is. */
export type PodcastTime = Extract<FromPlayer, { type: 'podcastTime' }>

/**
 * What a player is sent: the episode (none: the player goes), the extension's command to the host (a pause with `hold`
 * is the extension's own short wait; `note` a quiet line; `focus` either way), the host's state (to a remote), and the
 * player's role.
 */
export type ToPlayer =
  | { type: 'podcast'; episode?: PodcastEpisode | PodcastUnavailable }
  | ({ type: 'podcastCmd' } & Partial<PodcastActionFields> & { action: string; note?: string; resumeAt?: number; hold?: boolean; text?: string; reader?: boolean })
  | ({ type: 'podcastState' } & PodcastHostState)
  | { type: 'podcastRole'; role: 'host' | 'remote'; at?: number; play?: boolean; until?: number }
