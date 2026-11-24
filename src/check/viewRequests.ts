// The Check view's requests, checked once: a page's message (anything a webview posts) becomes a request whose
// fields are there and of the right type, or nothing. The controller's handlers take them as they are. No vscode here:
// unit-tested (test/checkViewRequests.test.ts).
import type { FromCheck } from '../protocol/check'
import { isViewConcernAction, type ConcernAction } from './concernState'
import { CHECK_VIEW_REQUESTS, type CheckViewRequest } from './viewMessages'

/** The requests that carry nothing but their name. */
type Bare = Exclude<CheckViewRequest, 'open' | 'select' | 'regrade' | 'answer' | 'draft' | 'link' | 'concern' | 'include'>

export type ViewRequest =
  | { type: 'open' | 'select' | 'regrade'; id: string }
  | { type: 'answer' | 'draft'; id: string; text: string }
  | { type: 'link'; id: string; i: number }
  | { type: 'concern'; id: string; action: ConcernAction }
  | { type: 'include'; file: string; on: boolean }
  | { type: Bare }

/** The request of type `T`. */
export type ViewRequestOf<T extends CheckViewRequest> =
  ViewRequest extends infer M ? (M extends { type: infer U } ? (T extends U ? M : never) : never) : never

const isRequest = (t: unknown): t is CheckViewRequest => (CHECK_VIEW_REQUESTS as readonly unknown[]).includes(t)

/** `m` as a request; undefined: not a request (a report), or a field missing or of the wrong type. */
export function decodeViewRequest(m: FromCheck): ViewRequest | undefined {
  const type = m.type
  if (!isRequest(type)) return undefined
  const f = m as { id?: unknown; text?: unknown; i?: unknown; action?: unknown; file?: unknown; on?: unknown }
  const id = typeof f.id === 'string' && f.id ? f.id : undefined
  switch (type) {
    case 'open': case 'select': case 'regrade':
      return id ? { type, id } : undefined
    case 'answer': case 'draft':
      return id && typeof f.text === 'string' ? { type, id, text: f.text } : undefined
    case 'link':
      return id && typeof f.i === 'number' ? { type, id, i: f.i } : undefined
    case 'concern':
      return id && isViewConcernAction(f.action) ? { type, id, action: f.action } : undefined
    case 'include':
      return typeof f.file === 'string' && f.file ? { type, file: f.file, on: !!f.on } : undefined
    default:
      return { type }
  }
}
