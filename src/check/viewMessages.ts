// The names of the messages the Check view's page (media/check.js, media/checkAnswer.js) sends; their fields are
// src/protocol/check.ts FromCheck, the type both sides are compiled against. No vscode here.
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
