// How much a note's thread shows, in one place.

export const THREAD_LIMITS = {
  /** A thread with more messages than this hides its older read replies. */
  collapseOver: 6,
  /** Replies always shown at the end of a long thread, besides the new ones. */
  lastShown: 3,
  /** Lines of code a stale note's banner shows before "… n more". */
  bannerLines: 3,
  /** A message's clock this far off (ms) is not believed. */
  skewMs: 60_000,
} as const
