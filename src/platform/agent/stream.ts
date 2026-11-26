// Claude Code's `--output-format stream-json` lines, read into the few events a run cares about. The protocol is
// Claude Code's, so each line is narrowed once here (`readLine`); `foldEvent` then works on typed events only.
// No vscode API here (unit-tested in test/claude.test.ts).
import { isObject, Json } from './json'

export interface ToolCall {
  name: string
  input: Record<string, unknown>
}

/** What a run ended with, as Claude Code reported it (or the extension found out: `errorKind`). */
export interface AskResult {
  text: string
  sessionId?: string
  costUsd?: number
  /** The model that answered, as Claude Code named it at the start. */
  model?: string
  error?: string
  errorKind?: AskErrorKind
  cancelled?: boolean
}

/**
 * Why a run failed, when the extension knows it (not from Claude's own words): `no-cli`, Claude Code couldn't be run at
 * all (not installed, or not where the setting says).
 */
export type AskErrorKind = 'no-cli'

/** The events of a stream-json line that a run reads; every other line is `undefined`. */
export type StreamEvent =
  /** The session starts, with the model it runs. */
  | { kind: 'init'; model?: string }
  /** A new assistant message starts (a paragraph break in the text so far). */
  | { kind: 'message-start' }
  /** More of the answer's text. */
  | { kind: 'text'; text: string }
  /** A tool call starts (its input is not known yet). */
  | { kind: 'tool-start'; name: string }
  /** A finished tool call, with its input. */
  | { kind: 'tool-call'; call: ToolCall }
  /** The run's end. */
  | { kind: 'result'; text?: string; sessionId?: string; costUsd?: number; isError: boolean }

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** A `stream_event` line's inner event (Anthropic's streaming events). */
function streamEvent(ev: Json): StreamEvent | undefined {
  switch (ev.type) {
    case 'message_start':
      return { kind: 'message-start' }
    case 'content_block_delta': {
      const d = isObject(ev.delta) ? ev.delta : {}
      return d.type === 'text_delta' ? { kind: 'text', text: str(d.text) ?? '' } : undefined
    }
    case 'content_block_start': {
      const b = isObject(ev.content_block) ? ev.content_block : {}
      return b.type === 'tool_use' ? { kind: 'tool-start', name: String(b.name) } : undefined
    }
    default:
      return undefined
  }
}

/** An `assistant` line: its first tool call, if it has one. */
function assistantEvent(message: unknown): StreamEvent | undefined {
  const content = isObject(message) && Array.isArray(message.content) ? message.content : []
  const c = content.find((x): x is Json => isObject(x) && x.type === 'tool_use')
  if (!c) return undefined
  return { kind: 'tool-call', call: { name: String(c.name), input: isObject(c.input) ? c.input : {} } }
}

/** One line of the stream, narrowed; undefined for junk and for lines a run does not read. */
export function readLine(line: string): StreamEvent | undefined {
  let e: unknown
  try { e = JSON.parse(line) } catch { return undefined }
  if (!isObject(e)) return undefined
  switch (e.type) {
    case 'stream_event':
      return isObject(e.event) ? streamEvent(e.event) : undefined
    case 'assistant':
      return assistantEvent(e.message)
    case 'system':
      return e.subtype === 'init' ? { kind: 'init', model: str(e.model) } : undefined
    case 'result':
      return {
        kind: 'result',
        text: str(e.result),
        sessionId: str(e.session_id),
        costUsd: typeof e.total_cost_usd === 'number' ? e.total_cost_usd : undefined,
        isError: !!e.is_error,
      }
    default:
      return undefined
  }
}

/** What the activity line says while Claude uses a read-only tool ("Reading src/a.ts"); other tools: their name. */
const TOOL_VERB: Record<string, string> = { Read: 'Reading', Grep: 'Searching for', Glob: 'Looking for' }

/** "/repo/src/a/b.ts" -> "a/b.ts": a path's last two segments, short enough for an activity line. */
export function lastTwoSegments(p: string): string {
  return /\/([^/]+\/[^/]+)$/.exec(p)?.[1] ?? p
}

/** "Reading a/b.ts", "Bash journey.py check": what a finished tool call is looking at. */
function activityOf(call: ToolCall): string {
  const i = call.input
  const target = lastTwoSegments(String(i.file_path ?? i.pattern ?? i.path ?? ''))
  const verb = Object.hasOwn(TOOL_VERB, call.name) ? TOOL_VERB[call.name] : call.name
  return `${verb} ${target}`.trim()
}

/** What a run has read so far: the text, what Claude is doing, its last tool call, the result once it came. */
export interface FoldState {
  text: string
  activity?: string
  tool?: ToolCall
  model?: string
  result?: AskResult
}

/** Folds one stream-json line into the running state; true when something a person sees changed. */
export function foldEvent(state: FoldState, line: string): boolean {
  const ev = readLine(line)
  switch (ev?.kind) {
    case 'init':
      state.model = ev.model
      return false
    case 'message-start':
      if (!state.text || state.text.endsWith('\n\n')) return false
      state.text += '\n\n'
      return true
    case 'text':
      state.text += ev.text
      state.activity = undefined
      return true
    case 'tool-start':
      state.activity = `Using ${ev.name}…`
      return true
    case 'tool-call':
      state.tool = ev.call
      state.activity = activityOf(ev.call)
      return true
    case 'result':
      state.result = {
        text: ev.text ?? state.text,
        sessionId: ev.sessionId,
        costUsd: ev.costUsd,
        ...(state.model ? { model: state.model } : {}),
        ...(ev.isError ? { error: ev.text ?? 'Claude reported an error' } : {}),
      }
      return true
    default:
      return false
  }
}
