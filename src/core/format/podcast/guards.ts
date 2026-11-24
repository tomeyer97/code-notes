// The small checks every podcast reader uses on parsed JSON, and the one rounding tolerance for times.

/** A JSON object (not null, not a list). */
export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A finite number, else undefined. */
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** Times this close (s) count as the same time: generators round, so a start 0.01 s before the previous end is fine.
 *  Sentence times, mark times, segment ends and the player's "not past the end" all use it. */
export const TIME_SLACK_S = 0.05

/** Where in the file (JSON keys and indexes). */
export type Path = (string | number)[]
