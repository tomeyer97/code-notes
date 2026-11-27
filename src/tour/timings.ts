// How long the walk waits, and why: each number absorbs a piece of VS Code behaviour. Shared delays (OWN_MOVE_MS, the
// thread settle time) are in platform/timings.ts. No vscode here.

/** After the walk puts the caret on a step's first line, cursor moves for this long are its own, not the reader's:
 *  the editor reports the selection it was given once or twice right after showing the file. */
export const STEP_CURSOR_MS = 600

/** The card above a step is brought into view again this long after the step opened: a comment thread lays itself out
 *  after the editor scrolled, which can push the card above the view (a jump from the map did). Twice: a slow window
 *  takes the second. */
export const CARD_IN_VIEW_AGAIN_MS = [120, 400] as const

/** How long after VS Code restored a map panel it is closed or resized: closed while VS Code still put it in place,
 *  it left an empty editor group ("OverlayWebview has been disposed"). */
export const AFTER_RESTORE_MS = 1500

/** A check's tour is read with its check, a moment after the journeys: a restored panel waits this long for it. */
export const CHECK_TOUR_READ_MS = 5000

/** How long a status bar message stays, by what it says: a hint about the key just pressed, a walk that finished or a
 *  journey that is gone, a change made under the reader (worth the time to read it). */
export const SAY_MS = { hint: 2000, done: 3000, change: 5000 } as const
export type SayKind = keyof typeof SAY_MS
