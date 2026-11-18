// Names, stored keys and timings of the understanding check, in one place.

export const SESSION = (branch: string) => `Check · ${branch}`
/** The author of the question and grade messages in a check thread. */
export const AUTHOR = 'Understanding check'
export const SKILL = 'understanding-check'
/** Files `init` writes: committed with the check when someone ran it by hand. */
export const REPO_FILES = ['.gitattributes', '.ignore']

/** The setting (under codeNotes.) that turns background questions after a push on and off (background.ts). */
export const BACKGROUND_SETTING = 'understanding.background'

// ---------- per-workspace memory (vscode.Memento keys) ----------

/** Commits whose background questions were written (never twice for the same commit). */
export const BG_KEY = 'codeNotes.understanding.backgroundHeads'
/** Per branch: files a TODO was added to from the check (offered, not committed, by Commit & push). */
export const TODO_KEY = 'codeNotes.understanding.todoFiles'
/** Per branch: per question, the file its suggested fix was applied to (offered, ticked, by Commit & push). */
export const FIX_KEY = 'codeNotes.understanding.fixFiles'
/** Unsent answers typed in the Check view's box: per check file, per question (this workspace only, never the file). */
export const DRAFT_KEY = 'codeNotes.understanding.drafts'
/** Questions being written (per workspace): a window reloaded meanwhile says so instead of offering Start again. */
export const WRITING_KEY = 'codeNotes.understanding.writing'
/** How many commits BG_KEY remembers. */
export const BG_COMMITS_KEPT = 50

// ---------- timings ----------
// Tuned against VS Code's behaviour: REFRESH_SOON_MS, REVEAL_RETRY_MS, RESTORED_OPEN_MS (see each). The others are
// plain choices.

/** A trigger (a file event, focus, a save) waits this long, so a burst of them is one refresh. */
export const REFRESH_SOON_MS = 400
/** An applied fix: refreshed soon (the editor has the change; the refresh sees it as edited). */
export const FIX_REFRESH_MS = 100
/** The busy clocks ("Writing questions · 0:42") tick once a second. */
export const TICK_MS = 1000
/** Questions being written by a window reloaded meanwhile: given up after this long (the writer is stuck or gone). */
export const ORPHAN_MAX_MS = 10 * 60_000
/**
 * After a question opens: its lines are revealed again at these delays if they are out of view (a tour's step card far
 * from them is drawn a moment later and scrolls there).
 */
export const REVEAL_RETRY_MS = [250, 800]
/** Questions put back from the cache: question 1 opens after the refresh that found them has drawn. */
export const RESTORED_OPEN_MS = 300
/** "Committed … and pushed" in the status bar, for this long. */
export const PUSHED_MESSAGE_MS = 8000
/** The model label passed to the skills' scripts when no model is set. */
export const DEFAULT_MODEL_LABEL = 'Claude Code default'
