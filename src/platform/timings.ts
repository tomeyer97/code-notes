// The delays several parts of the extension share, by what they wait for. A delay only one module uses stays there,
// next to the code it tunes. No vscode here.

/**
 * After the extension moves the caret, the selection, an editor or the layout itself, the changes VS Code reports for
 * this long are its own, not the reader's: a step opening settles (its file, then its card brought into view) in about
 * a second, a little more over a remote link.
 */
export const OWN_MOVE_MS = 1500

/**
 * A comment thread made just now, or an editor just shown, takes no change for this long: VS Code's comment widget
 * lays itself out in that time, and a change meanwhile can make it loop (threads/settle.ts).
 */
export const THREAD_SETTLE_MS = 160

// Typing pauses: lines remembered by text are found again once the typing stops. Three costs, three delays.

/** A few remembered lines (a beat, a code link, value hints: followEdits.ts): cheap, so soon. */
export const REFIND_LINES_MS = 150
/** Every step of every journey in the edited file: the anchor search per step (journeys/tracker.ts). */
export const REFIND_STEPS_MS = 250
/** Notes: re-anchored (moved code, stale) and saved when the file is not dirty, so later (watch.ts). */
export const REANCHOR_NOTES_MS = 400
