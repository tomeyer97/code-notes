// A controller's requests read and checked before anything runs: the frame as a request, and each method's params.
// A param reader returns the params or the reason they can't be used (sent back as the error). No vscode (unit-tested
// in test/bridgeRequests.test.ts).
import { BRIDGE_METHODS, BridgeMethod, BridgeRequest, BridgeLines, ContextGetParams, JourneyPlayParams, NoteAddParams, RevealParams } from '../../protocol/bridge'

/** Params read, or why not. */
export type Read<T> = { ok: true; value: T } | { ok: false; error: string }
const ok = <T>(value: T): Read<T> => ({ ok: true, value })
const no = (error: string): Read<never> => ({ ok: false, error })

/** The longest text an explanation or a note takes: a controller's explanation, not a file. */
export const MAX_TEXT = 20_000

/** A frame as a request: undefined when it is not one (no id to answer: nothing is sent back). */
export function readFrame(data: string): BridgeRequest | undefined {
  let v: unknown
  try { v = JSON.parse(data) } catch { return undefined }
  if (!isRecord(v) || v.type !== 'request' || typeof v.id !== 'string' || !v.id) return undefined
  return { type: 'request', id: v.id, method: typeof v.method === 'string' ? v.method : '', params: v.params }
}

export const isMethod = (m: string): m is BridgeMethod => (BRIDGE_METHODS as readonly string[]).includes(m)

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isLine = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1

/** file, start and end: 1-based lines, end at or after start. */
function readLines(p: Record<string, unknown>): Read<BridgeLines> {
  if (typeof p.file !== 'string' || !p.file.trim()) return no('file: a path is needed')
  if (!isLine(p.start)) return no('start: a line number (1-based) is needed')
  const end = p.end ?? p.start
  if (!isLine(end) || end < p.start) return no('end: a line number at or after start')
  return ok({ file: p.file, start: p.start, end })
}

/** A text field: absent, or a string no longer than MAX_TEXT. */
function readText(p: Record<string, unknown>, key: string, required: boolean): Read<string | undefined> {
  const v = p[key]
  if (v === undefined && !required) return ok(undefined)
  if (typeof v !== 'string' || (required && !v.trim())) return no(`${key}: text is needed`)
  if (v.length > MAX_TEXT) return no(`${key}: longer than ${MAX_TEXT} characters`)
  return ok(v)
}

export function readReveal(params: unknown): Read<RevealParams> {
  if (!isRecord(params)) return no('params: an object is needed')
  const lines = readLines(params)
  if (!lines.ok) return lines
  const text = readText(params, 'text', false)
  if (!text.ok) return text
  return ok(text.value?.trim() ? { ...lines.value, text: text.value } : lines.value)
}

export function readJourneyPlay(params: unknown): Read<JourneyPlayParams> {
  if (!isRecord(params) || typeof params.id !== 'string' || !params.id) return no('id: a journey id is needed')
  const { id, step, folder } = params
  if (step !== undefined && !isLine(step) && (typeof step !== 'string' || !step)) return no('step: a step number (1-based) or a step id')
  if (folder !== undefined && typeof folder !== 'string') return no('folder: a workspace folder path or URI')
  return ok({ id, ...(step !== undefined ? { step: step as number | string } : {}), ...(folder ? { folder } : {}) })
}

export function readNoteAdd(params: unknown): Read<NoteAddParams> {
  if (!isRecord(params)) return no('params: an object is needed')
  const lines = readLines(params)
  if (!lines.ok) return lines
  const body = readText(params, 'body', true)
  if (!body.ok) return body
  if (typeof params.session !== 'string' || !params.session.trim()) return no('session: a session name is needed')
  return ok({ ...lines.value, body: body.value!, session: params.session.trim() })
}

export function readContextGet(params: unknown): Read<ContextGetParams> {
  if (params !== undefined && !isRecord(params)) return no('params: an object, or none')
  return ok(isRecord(params) && params.selectionText === true ? { selectionText: true } : {})
}
