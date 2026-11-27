// The understanding check's names, ids, setting keys, stored keys and timings: the literals it shares between files.
// (Command ids are platform/commands.ts's; a code link key is platform/keys.ts's checkLinkKey.)
import { STATE } from '../platform/state'

export const SESSION = (branch: string) => `Check · ${branch}`
/** The author of the question and grade messages in a check thread. */
export const AUTHOR = 'Understanding check'
export const SKILL = 'understanding-check'
/** Files `init` writes: committed with the check when someone ran it by hand. */
export const REPO_FILES = ['.gitattributes', '.ignore']

/** The Check view (package.json views) and the status bar item. */
export const VIEW_ID = 'codeNotes.check'
export const STATUS_ITEM_ID = 'codeNotes.understanding'
/** The context key that is true while there is a check (package.json: an empty Code Notes view steps aside). */
export const CHECK_OPEN_CONTEXT = 'codeNotes.checkOpen'
/** The context key that is true on a default branch with no check file (package.json: the Check view is hidden there). */
export const CHECK_ON_BASE_CONTEXT = 'codeNotes.checkOnBase'
/** Where the view's Install sends someone without Claude Code. */
export const INSTALL_URL = 'https://claude.com/claude-code'

/**
 * The check's settings, under `codeNotes.` (package.json declares them; their names never change: a renamed setting
 * loses what people set). `model`: the check's own model (read by platform/agent/runner.ts); `claudePath`: Claude
 * Code's path; `background`: questions written after a push (background.ts).
 */
export const SETTINGS = { model: 'understanding.model', claudePath: 'claude.path', background: 'understanding.background' } as const
/** A setting's full id, for the Settings editor. */
export const settingId = (key: (typeof SETTINGS)[keyof typeof SETTINGS]) => `codeNotes.${key}`

// ---------- per-workspace memory (declared in platform/state.ts; their key strings are named here too) ----------

export const BG_KEY = STATE.checkBackgroundHeads.key
export const TODO_KEY = STATE.checkTodos.key
export const FIX_KEY = STATE.checkFixes.key
export const DRAFT_KEY = STATE.checkDrafts.key
export const WRITING_KEY = STATE.checkWriting.key
/** How many commits STATE.checkBackgroundHeads remembers. */
export const BG_COMMITS_KEPT = 50

// ---------- timings ----------
// Two debounces, two clocks, and one delay around VS Code's drawing that the check has no event for (REVEAL_RETRY_MS).

/** A trigger (a file event, focus, a save) waits this long, so a burst of them is one refresh. */
export const REFRESH_SOON_MS = 400
/** An applied fix: refreshed soon (the editor has the change; the refresh sees it as edited). */
export const FIX_REFRESH_MS = 100
/** The busy clocks ("Writing questions · 0:42") tick once a second. */
export const TICK_MS = 1000
/** Questions being written by a window reloaded meanwhile: given up after this long (the writer is stuck or gone). */
export const ORPHAN_MAX_MS = 10 * 60_000
/**
 * After a question opens: its lines are revealed again at these delays if they are out of view. What it waits for is a
 * tour's step card far from them, drawn a moment later by the tour (it scrolls there); the tour says nothing when it
 * has drawn, so the check looks twice.
 */
export const REVEAL_RETRY_MS = [250, 800]
/** "Committed … and pushed" in the status bar, for this long. */
export const PUSHED_MESSAGE_MS = 8000
/** The model label passed to the skills' scripts when no model is set. */
export const DEFAULT_MODEL_LABEL = 'Claude Code default'
