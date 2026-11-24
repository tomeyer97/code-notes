// The listening player's numbers: times in seconds (_S) or milliseconds (_MS), sizes in pixels (_PX).

/** Back / forward (s): the keys (← →) and the commands; no buttons (the units of a walk are steps). */
export const SKIP_S = 15
/** The speeds (< > step through them); the speed button cycles through the usual ones. */
export const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2]
export const CYCLE = [1, 1.25, 1.5, 2]
/** A seek that lands further than this from where it was asked to go (s) did not get there. */
export const MISS_S = 0.75
/** Playing, the clock not moving for this long (ms): it is not playing (a broken or cut file); it pauses and says so. */
export const FROZEN_MS = 3000
/** A step's mark on the timeline is at least this wide (px): a target a pointer can hit. */
export const MARK_MIN_PX = 8
/** Remote: after asking for a seek, the host's reports of the time before it are ignored this long (ms). */
export const ASK_STALE_MS = 700
/** The audio is shorter than the episode by more than this (s): the rest of the timeline can't be reached. */
export const CUT_S = 1

// The audio's ends. Chromium's timeupdate comes about every 250 ms and a seek to the very end ends the audio, so
// each edge has a margin.

/** A seek goes at most this close to the end of the timeline or of the audio (s); a time past the audio's end by more
 *  than this is out of its reach. */
export const END_GUARD_S = 0.05
/** One step played stops once the audio is this close to the step's end (s). */
export const UNTIL_GUARD_S = 0.06
/** ▶ with the audio this close to its end (s) plays it again from the start. */
export const REPLAY_GUARD_S = 0.1
/** The next segment starts more than this after now (s): the one starting now is under way. */
export const NEXT_SEGMENT_S = 0.01
/** The timer for the next segment fires this much after it starts (ms), so the audio is past the boundary. */
export const BOUNDARY_LATE_MS = 20
