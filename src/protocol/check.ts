// The Check view's messages, both ways: what media/check.js and media/checkAnswer.js post, and what
// src/check/view.ts sends them. The request names are src/check/viewMessages.ts's (the controller has one handler
// each). Also how a question's state looks, drawn by the Check view and by the journey panel's storyline.
import type { QState } from '../check/types'
import type { CheckView } from '../check/viewModel'
import type { CheckViewRequest } from '../check/viewMessages'

/** The requests that carry nothing but their name. */
type Bare = Exclude<CheckViewRequest, 'open' | 'select' | 'regrade' | 'answer' | 'draft' | 'link' | 'concern' | 'include'>

/** What the page posts, by type. The page is a webview: every field is checked where it is used. */
export type FromCheck =
  /** A question (`id`): opened, selected with the arrows, graded again. */
  | { type: 'open' | 'select' | 'regrade'; id?: string }
  /** An answer sent from the box, or a draft of one. */
  | { type: 'answer' | 'draft'; id?: string; text?: string }
  /** A code link of a grade: its index in the grade's links. */
  | { type: 'link'; id?: string; i?: number }
  /** A concern's action: fix, todo, flag, dismiss. */
  | { type: 'concern'; id?: string; action?: string }
  /** A file ticked or unticked for Commit & push. */
  | { type: 'include'; file?: string; on?: boolean }
  /** Whether the keyboard reached question `id`'s answer box. */
  | { type: 'focused'; id?: string; ok?: boolean }
  /** Rows drawn, layout problems, the page's height. */
  | { type: 'rendered'; rows?: number; overflow?: string[]; height?: number }
  /** The page's error. */
  | { type: 'error'; message?: string }
  | { type: Bare }

/** The message of type `T` (its member of FromCheck). */
export type FromCheckOf<T extends FromCheck['type']> =
  FromCheck extends infer M ? (M extends { type: infer U } ? (T extends U ? M : never) : never) : never

/** What the page is sent: the view to draw (null: no repository), the keyboard into a question's box, a test's click. */
export type ToCheck =
  | { type: 'check'; view: CheckView | null }
  | { type: 'focus'; id: string }
  | { type: 'test'; click?: string }

/** How a question's look is said. */
export interface QuestionLook {
  icon: string
  /** Not answered yet, as a row of the journey storyline. */
  storyIcon?: string
  /** Said so to a screen reader in the storyline. */
  answered?: boolean
  /** Said after the question in the storyline. */
  word?: string
}

/**
 * A question's states and how they look. Not answered yet it is "○" in the Check view's list (a checklist: check.js
 * `row`) but "? Why …" as a row of the journey storyline, among the numbered steps (journey-map.js `stopRow`;
 * docs/understanding-check.md, test/check-tour/shoot.mjs).
 */
export const QSTATE: Record<QState, QuestionLook> = {
  todo: { icon: '○', storyIcon: '?' },
  ungraded: { icon: '…', word: 'checking' },
  pass: { icon: '✓', answered: true },
  restated: { icon: '✓', answered: true },
  retry: { icon: '↻', word: 'try again' },
  explained: { icon: '·', word: 'explained' },
}
