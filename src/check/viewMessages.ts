// The messages the Check view's page (media/check.js, media/checkAnswer.js) sends: their names and fields. No vscode
// here: test/checkViewMessages.test.ts checks the pages' "Out" lists and their posts against these names.
import { ACTIONS, type ActionId } from './viewModel'

/** What the page asks the controller for besides its one button (controller.ts `viewHandlers`, one handler each). */
const OTHER_REQUESTS = [
  'ready', 'open', 'select', 'answer', 'draft', 'link', 'next', 'regrade', 'escape', 'concern', 'include', 'retry',
  'modelSetting', 'pathSetting', 'install', 'tour', 'writeTour', 'openMr',
] as const
/** Every request the page sends: its button's (viewModel.ts ACTIONS: the id is the request) and the others. */
export const CHECK_VIEW_REQUESTS: readonly CheckViewRequest[] = [...(Object.keys(ACTIONS) as ActionId[]), ...OTHER_REQUESTS]
export type CheckViewRequest = ActionId | (typeof OTHER_REQUESTS)[number]

/** What the page reports about itself (view.ts handles these): drawn, an error, the keyboard arrived in a box. */
export const CHECK_VIEW_REPORTS = ['rendered', 'error', 'focused'] as const
export type CheckViewReport = (typeof CHECK_VIEW_REPORTS)[number]

/** The requests that carry nothing but their name. */
type Bare = Exclude<CheckViewRequest, 'open' | 'select' | 'regrade' | 'answer' | 'draft' | 'link' | 'concern' | 'include'>

/** A message from the page, by type. The page is a webview: every field is checked where it is used. */
export type CheckViewMessage =
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

/** The message of type `T` (its member of CheckViewMessage). */
export type CheckViewMessageOf<T extends CheckViewMessage['type']> =
  CheckViewMessage extends infer M ? (M extends { type: infer U } ? (T extends U ? M : never) : never) : never
