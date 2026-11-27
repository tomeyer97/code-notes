// The Listen view's messages, both ways: what media/listen.js (with its player, journey-podcast.js) posts, and what
// src/podcast/listenView.ts sends it.
import type { FromPlayer, ToPlayer } from './podcast'

/** What the page posts: its player's messages, and the journey's map asked for. */
export type FromListen =
  | { type: 'ready' }
  | { type: 'error'; message?: string }
  | { type: 'podcastOpen' }
  | FromPlayer

/** What the page is sent: its player's messages, the journey the panel shows (none: closed), a test's click. */
export type ToListen =
  | ToPlayer
  | { type: 'panel'; key?: string }
  | { type: 'hello' }
  | { type: 'test'; click?: string }
