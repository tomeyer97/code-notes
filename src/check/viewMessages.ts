// The names of the messages the Check view's page (media/check.js, media/checkAnswer.js) sends, and the fields of each
// request, in one table (REQUEST_FIELDS); the message types both sides compile against are src/protocol/check.ts
// FromCheck. No vscode here.
import type { ActionId } from './checkWords'

/** A field's type, as a page's message must carry it. */
type FieldType = 'string' | 'number' | 'boolean' | 'concernAction'

/** The fields of a request that carries more than its name. */
const WITH_FIELDS = {
  open: { id: 'string' },
  select: { id: 'string' },
  regrade: { id: 'string' },
  answer: { id: 'string', text: 'string' },
  draft: { id: 'string', text: 'string' },
  link: { id: 'string', i: 'number' },
  concern: { id: 'string', action: 'concernAction' },
  include: { file: 'string', on: 'boolean' },
} as const satisfies Record<string, Record<string, FieldType>>

/** Every request the page sends, with its fields: the button's (checkWords.ts ACTIONS: the id is the request), then
 *  the others (controller.ts `viewHandlers`, one handler each), in the order they are listed in the golden. */
export const REQUEST_FIELDS = {
  start: {}, topUp: {}, scm: {}, commitPush: {}, openFile: {}, merge: {}, pull: {},
  ready: {},
  open: WITH_FIELDS.open, select: WITH_FIELDS.select, answer: WITH_FIELDS.answer, draft: WITH_FIELDS.draft,
  link: WITH_FIELDS.link, next: {}, regrade: WITH_FIELDS.regrade, escape: {}, concern: WITH_FIELDS.concern,
  include: WITH_FIELDS.include, retry: {}, modelSetting: {}, pathSetting: {}, install: {}, tour: {}, writeTour: {},
  openMr: {},
} as const satisfies Record<ActionId, Record<string, never>> & Record<string, Record<string, FieldType>>

export type CheckViewRequest = keyof typeof REQUEST_FIELDS
/** The requests that carry nothing but their name. */
export type BareCheckViewRequest = Exclude<CheckViewRequest, keyof typeof WITH_FIELDS>

/** Every request the page sends. */
export const CHECK_VIEW_REQUESTS = Object.keys(REQUEST_FIELDS) as readonly CheckViewRequest[]

/** What the page reports about itself (view.ts handles these): drawn, an error, the keyboard arrived in a box. */
export const CHECK_VIEW_REPORTS = ['rendered', 'error', 'focused'] as const
export type CheckViewReport = (typeof CHECK_VIEW_REPORTS)[number]

/** A page's message `m` is one of its reports (else it may be a request). */
export const isCheckViewReport = <M extends { type: string }>(m: M): boolean => (CHECK_VIEW_REPORTS as readonly string[]).includes(m.type)
