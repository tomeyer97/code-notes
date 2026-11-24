// The request envelope scripts and agents use to ask this extension for something (docs/agent-protocol.md): a request
// in .code-notes/.request.json, the answer in .code-notes/.result.json. The vscode:// link and the palette command
// make the same request. One staleness rule and one "newer extension needed" rule for all of them.
// No vscode API here (unit-tested in test/agentProtocol.test.ts).
import { olderThan } from './versions'
import { isObject, Json } from './json'

/** Where a script leaves its request, and finds the answer (relative to the repository). */
export const REQUEST_FILE = '.code-notes/.request.json'
export const RESULT_FILE = '.code-notes/.result.json'

/** A request older than this is not handled (its script gave up long ago). */
export const REQUEST_MAX_AGE_MS = 2 * 60_000

export type RequestAction = 'overview' | 'ask'

/**
 * A request: the overview, or a question to answer with a journey (`model`: for one written for it; `id`: the
 * script's, echoed in its result).
 */
export interface ScriptRequest {
  action: RequestAction
  question: string
  model?: string
  id?: string
}

/** Where a request came from: the request file, a vscode:// link (old scripts), or the palette's Ask a Question. */
export type Via = 'file' | 'uri' | 'command'

/** What a request did, as the script reads it back. Every field is a string: the file is a flat map of strings. */
export type RequestResult =
  | { outcome: 'overview' }
  | { outcome: 'opened'; title: string }
  | { outcome: 'choose'; text: string }
  | { outcome: 'confirm'; model: string }
  | { outcome: 'writing'; model: string }
  | { outcome: 'untrusted'; message: string }
  | { outcome: 'error'; message: string }

/** The result file's contents: the request's id and its result. */
export type ResultFile = { id: string } & RequestResult

/** A request as written, checked: one to handle, one left for a newer extension, or one refused (`reason`: the
 *  message its result carries). */
export type Envelope =
  | { kind: 'request'; request: ScriptRequest }
  | { kind: 'too-new'; needs: string; action: string; question: string }
  | { kind: 'refused'; reason: string; id?: string }

/** A non-empty string field. */
const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/**
 * The fields of a request, whatever brought it: `action` (overview | ask), `question` (or the old links' `q`), `model`
 * and `id` when they are non-empty strings. A string when the action is unknown (why).
 */
export function readRequest(v: Json): ScriptRequest | string {
  const action = v.action
  if (action !== 'overview' && action !== 'ask') return `unknown action "${String(action)}"`
  // `q`: the old links' name for the question.
  const question = [v.question, v.q].find((x): x is string => typeof x === 'string') ?? ''
  const model = typeof v.model === 'string' ? v.model.trim() : undefined
  const id = text(v.id)
  return { action, question, ...(model ? { model } : {}), ...(id ? { id } : {}) }
}

/** The request file's text, checked against this extension's version and the time now. */
export function readEnvelope(raw: string, o: { version: string; now: number }): Envelope {
  let v: unknown
  try { v = JSON.parse(raw) } catch { v = undefined }
  if (!isObject(v)) return { kind: 'refused', reason: 'the request is not a JSON object' }
  const id = text(v.id)
  if (typeof v.needs === 'string' && olderThan(o.version, v.needs)) {
    return { kind: 'too-new', needs: v.needs, action: String(v.action), question: String(v.question ?? '') }
  }
  const at = Date.parse(typeof v.at === 'string' ? v.at : '')
  if (!at) return { kind: 'refused', reason: 'the request has no time ("at")', id }
  if (o.now - at > REQUEST_MAX_AGE_MS) return { kind: 'refused', reason: 'the request is older than 2 minutes', id }
  const request = readRequest(v)
  return typeof request === 'string' ? { kind: 'refused', reason: request, id } : { kind: 'request', request }
}

/** The result file's text for request `id`. */
export const resultText = (id: string, r: RequestResult): string => `${JSON.stringify({ id, ...r })}\n`
