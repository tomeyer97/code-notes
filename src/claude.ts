// Runs Claude Code headless (`claude -p`, read-only unless a skill's scripts are allowed), streaming its text as it
// writes: a note's answer, a journey, the check's questions and grades. Finding the binary: claudeCli.ts.
// No vscode API here (unit-tested in test/claude.test.ts with a fake CLI).
import { spawn, ChildProcess } from 'child_process'

export interface AskOptions {
  cli: string
  cwd: string
  prompt: string
  /** Continue this Claude session (follow-ups on the same note keep their context). */
  resume?: string
  model?: string
  /** More tools to allow (e.g. "Skill", "Bash(/path/to/skill/scripts/*)") and directories Claude may read. */
  extraTools?: string[]
  addDirs?: string[]
  /** More environment for the CLI (and the commands it runs), e.g. JOURNEY_MODEL for journey.py. */
  env?: Record<string, string>
  /** Called as text arrives (the whole text so far) and when Claude starts using a tool; `tool`: the last finished call. */
  onProgress?: (p: { text: string; activity?: string; tool?: ToolCall }) => void
}

export interface ToolCall { name: string; input: Record<string, unknown> }

/**
 * Why a run failed, when the extension knows it (not from Claude's own words): `no-cli`, Claude Code couldn't be run at
 * all (not installed, or not where the setting says).
 */
export type AskErrorKind = 'no-cli'

export interface AskResult { text: string; sessionId?: string; costUsd?: number; error?: string; errorKind?: AskErrorKind; cancelled?: boolean }

/** A model Claude Code knows (an alias or a claude-* id), else the message to show; nothing runs then. */
export function modelProblem(m: string | undefined): string | undefined {
  if (!m) return undefined
  if (/^(sonnet|opus|haiku|fable)(\[1m\])?$/i.test(m) || /^claude-[a-z0-9][\w.-]*(\[1m\])?$/i.test(m)) return undefined
  return `Unknown model '${m}'. Use sonnet, opus, haiku or fable.`
}

/** Read-only: Claude can look at the code but not change it. */
export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob']
/** What the activity line says while Claude uses a read-only tool ("Reading src/a.ts"); other tools: their name. */
const TOOL_VERB: Record<string, string> = { Read: 'Reading', Grep: 'Searching for', Glob: 'Looking for' }
/** How often the text streamed so far is reported (a tool starting is reported at once). */
const PROGRESS_MS = 250
/** How much of Claude Code's stderr is kept (the last lines are said when it fails). */
const STDERR_KEPT = 4000

/** A line of `claude -p --output-format stream-json` (only the fields read here; events and content as Claude sends them). */
/* eslint-disable @typescript-eslint/no-explicit-any */
interface StreamLine {
  type?: string
  event?: any
  message?: { content?: any[] }
  result?: unknown
  session_id?: string
  total_cost_usd?: number
  is_error?: boolean
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** What a run has read so far: the text, what Claude is doing, its last tool call, the result once it came. */
type FoldState = { text: string; activity?: string; tool?: ToolCall; result?: AskResult }

/** Folds one stream-json line into the running state. Exported for tests. */
export function foldEvent(state: FoldState, line: string): boolean {
  let e: StreamLine
  try { e = JSON.parse(line) } catch { return false }
  if (e.type === 'stream_event') {
    const ev = e.event
    if (ev?.type === 'message_start' && state.text && !state.text.endsWith('\n\n')) {
      state.text += '\n\n'
      return true
    }
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      state.text += ev.delta.text
      state.activity = undefined
      return true
    }
    if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
      state.activity = `Using ${ev.content_block.name}…`
      return true
    }
    return false
  }
  if (e.type === 'assistant') {
    // A finished tool call: say what it is looking at.
    for (const c of e.message?.content ?? []) {
      if (c.type !== 'tool_use') continue
      const i = c.input ?? {}
      state.tool = { name: String(c.name), input: i }
      const target = String(i.file_path ?? i.pattern ?? i.path ?? '').replace(/^.*\/(?=[^/]+\/[^/]+$)/, '')
      state.activity = `${Object.hasOwn(TOOL_VERB, c.name) ? TOOL_VERB[c.name] : c.name} ${target}`.trim()
      return true
    }
    return false
  }
  if (e.type === 'result') {
    state.result = {
      text: typeof e.result === 'string' ? e.result : state.text,
      sessionId: e.session_id,
      costUsd: e.total_cost_usd,
      ...(e.is_error ? { error: typeof e.result === 'string' ? e.result : 'Claude reported an error' } : {}),
    }
    return true
  }
  return false
}

export class Ask {
  private proc?: ChildProcess
  private cancelled = false
  readonly done: Promise<AskResult>

  constructor(o: AskOptions) {
    this.done = new Promise((resolve) => {
      const state: FoldState = { text: '' }
      let err = ''
      const env = o.env ? { ...process.env, ...o.env } : process.env
      const p = (this.proc = spawn(o.cli, argsFor(o), { cwd: o.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }))
      let last = 0
      // What arrived so far, at most every PROGRESS_MS (`force`: now, e.g. a tool starting).
      const progress = (force = false) => {
        if (!o.onProgress || (!force && Date.now() - last < PROGRESS_MS)) return
        last = Date.now()
        o.onProgress({ text: state.text, activity: state.activity, tool: state.tool })
      }
      const lines = lineSplitter((line) => { if (foldEvent(state, line)) progress(!!state.activity) })
      p.stdout!.on('data', (b: Buffer) => lines.push(b.toString()))
      p.stderr!.on('data', (b: Buffer) => { if (err.length < STDERR_KEPT) err += b.toString() })
      p.on('error', (e) => resolve({ text: state.text, error: `couldn't start Claude Code (${o.cli}): ${e.message}`, errorKind: 'no-cli' }))
      p.on('close', (code) => {
        const rest = lines.rest()
        if (rest) foldEvent(state, rest)
        if (this.cancelled) return resolve({ text: state.text, cancelled: true, sessionId: state.result?.sessionId })
        if (state.result) return resolve(state.result)
        const said = err ? `: ${err.trim().split('\n').slice(-3).join(' ')}` : ''
        resolve({ text: state.text, error: `Claude Code exited (${code})${said}` })
      })
    })
  }

  /** The process id of the running `claude` (a window reloaded meanwhile can tell it is still at work). */
  get pid(): number | undefined { return this.proc?.pid }

  cancel(): void {
    this.cancelled = true
    this.proc?.kill('SIGTERM')
  }
}

/**
 * `claude -p`'s arguments: the prompt, streamed JSON events, the tools allowed (read-only, and `extraTools`) and
 * blocked, the folders it may read, the model, a session to resume.
 */
function argsFor(o: AskOptions): string[] {
  // Edits and any other command stay blocked; Bash only as allowed by extraTools (a skill's own scripts).
  const bash = o.extraTools?.some((t) => t.startsWith('Bash(')) ? [] : ['Bash']
  const args = [
    '-p', o.prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--allowedTools', ...READ_ONLY_TOOLS, ...(o.extraTools ?? []),
    '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', ...bash,
  ]
  for (const d of o.addDirs ?? []) args.push('--add-dir', d)
  if (o.model) args.push('--model', o.model)
  if (o.resume) args.push('--resume', o.resume)
  return args
}

/** A stream cut into lines: `push(chunk)` calls `onLine` with each whole line (trimmed, not empty); `rest()`: the rest. */
function lineSplitter(onLine: (line: string) => void): { push(chunk: string): void; rest(): string } {
  let buf = ''
  return {
    push(chunk) {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) onLine(line)
      }
    },
    rest: () => buf.trim(),
  }
}
