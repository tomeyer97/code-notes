// What a banner says when the code under a step or a note changed: one vocabulary for both, so the step card and a
// note's thread say it the same way. No vscode here.

/** A step's own file is gone. */
export const STEP_FILE_GONE = 'File moved or deleted'
/** A step's lines can't be found any more (removed, or no copy of them to compare). */
export const STEP_LINES_LOST = "Code changed: can't find these lines"
/** A step's code was edited (found again, its old text known). */
export const STEP_CODE_CHANGED = 'Code changed'
/** A note's code changed (its thread's banner, threads/comments.ts). */
export const NOTE_CODE_CHANGED = 'The code changed since this note'
