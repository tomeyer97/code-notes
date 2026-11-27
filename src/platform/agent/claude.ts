// Claude Code, the agent behind every run (agent.ts says what an agent is): `claude -p`, read-only unless a skill's
// scripts are allowed, its stream-json read as it comes (stream.ts). Finding the binary: claudeCli.ts.
// No vscode API here (unit-tested in test/claude.test.ts with a fake CLI).
import { spawn, ChildProcess } from 'child_process'
import type { Agent, AgentRunOptions } from './agent'
import { AskResult, foldEvent, FoldState } from './stream'

export type { AskErrorKind, AskResult, ToolCall } from './stream'
export { foldEvent } from './stream'

/** A run of Claude Code: `cli`, the program found by claudeCli.ts, and what the agent is asked. */
export interface AskOptions extends AgentRunOptions {
  cli: string
}

/** Claude Code's model aliases (`claude --help`, `--model`); any `claude-*` id is taken as it is. */
export const MODEL_ALIASES = ['sonnet', 'opus', 'haiku', 'fable']

/** "a, b, c or d" */
const orList = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} or ${xs.at(-1)}` : xs.join(''))
/** An alias, or a full model id; either may ask for the long context window (`[1m]`). */
const ALIAS = new RegExp(`^(${MODEL_ALIASES.join('|')})(\\[1m\\])?$`, 'i')
const MODEL_ID = /^claude-[a-z0-9][\w.-]*(\[1m\])?$/i

/**
 * A model Claude Code knows (an alias or a claude-* id), else the message to show; nothing runs then. The aliases
 * are a list (not any word of the right shape) so that a typo like "sonet" is caught before a paid run.
 */
export function modelProblem(m: string | undefined): string | undefined {
  if (!m || ALIAS.test(m) || MODEL_ID.test(m)) return undefined
  return `Unknown model '${m}'. Use ${orList(MODEL_ALIASES)}.`
}

/** Read-only: Claude can look at the code but not change it. */
export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob']
/** Never allowed: edits (and Bash, unless `extraTools` allows some of it). */
const BLOCKED_TOOLS = ['Edit', 'Write', 'NotebookEdit']
/** How often the text streamed so far is reported (a tool starting is reported at once). */
const PROGRESS_MS = 250
/** How much of Claude Code's stderr is kept (the last lines are said when it fails). */
const STDERR_KEPT = 4000

/**
 * `claude -p`'s arguments: the prompt, streamed JSON events, the tools allowed (read-only, and `extraTools`) and
 * blocked, the folders it may read, the model, a session to resume. The understanding CLI runs the same program.
 */
export function claudeArgs(o: AgentRunOptions): string[] {
  // Edits and any other command stay blocked; Bash only as allowed by extraTools (a skill's own scripts).
  const bash = o.extraTools?.some((t) => t.startsWith('Bash(')) ? [] : ['Bash']
  const args = [
    '-p', o.prompt,
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--allowedTools', ...READ_ONLY_TOOLS, ...(o.extraTools ?? []),
    '--disallowedTools', ...BLOCKED_TOOLS, ...bash,
  ]
  for (const d of o.addDirs ?? []) args.push('--add-dir', d)
  if (o.model) args.push('--model', o.model)
  if (o.resume) args.push('--resume', o.resume)
  return args
}

/** The four ways a run ends. */
const outcome = {
  /** Cancel was pressed: what was written so far, and the session (a follow-up can go on with it). */
  cancelled: (s: FoldState): AskResult => ({ text: s.text, cancelled: true, sessionId: s.result?.sessionId }),
  /** Claude Code said it was done (with its answer, or its error). */
  finished: (s: FoldState & { result: AskResult }): AskResult => s.result,
  /** The process ended without a result: its exit code and the last lines it printed on stderr. */
  exited: (s: FoldState, code: number | null, stderr: string): AskResult => {
    const said = stderr ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''
    return { text: s.text, error: `Claude Code exited (${code})${said}` }
  },
  /** The program could not be started at all. */
  noCli: (s: FoldState, cli: string, e: Error): AskResult => ({
    text: s.text,
    error: `couldn't start Claude Code (${cli}): ${e.message}`,
    errorKind: 'no-cli',
  }),
}

/** A running `claude -p`: its result in `done`, `cancel()` stops it. Started with `Ask.start`. */
export class Ask {
  private readonly state: FoldState = { text: '' }
  private stderr = ''
  private cancelled = false
  private lastProgress = 0
  private resolve!: (r: AskResult) => void
  readonly done = new Promise<AskResult>((r) => { this.resolve = r })

  private constructor(private readonly o: AskOptions, private readonly proc: ChildProcess) {}

  /** Claude Code started on `o`. */
  static start(o: AskOptions): Ask {
    const env = o.env ? { ...process.env, ...o.env } : process.env
    const proc = spawn(o.cli, claudeArgs(o), { cwd: o.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const ask = new Ask(o, proc)
    const lines = lineSplitter((line) => ask.read(line))
    proc.stdout!.on('data', (b: Buffer) => lines.push(b.toString()))
    proc.stderr!.on('data', (b: Buffer) => { if (ask.stderr.length < STDERR_KEPT) ask.stderr += b.toString() })
    proc.on('error', (e) => ask.resolve(outcome.noCli(ask.state, o.cli, e)))
    proc.on('close', (code) => {
      const rest = lines.rest()
      if (rest) foldEvent(ask.state, rest)
      ask.finish(code)
    })
    return ask
  }

  /** The process id of the running `claude` (a window reloaded meanwhile can tell it is still at work). */
  get pid(): number | undefined { return this.proc.pid }

  cancel(): void {
    this.cancelled = true
    this.proc.kill('SIGTERM')
  }

  /** One line of output: folded in, and reported (a tool starting at once, text at most every PROGRESS_MS). */
  private read(line: string): void {
    if (!foldEvent(this.state, line) || !this.o.onProgress) return
    if (!this.state.activity && Date.now() - this.lastProgress < PROGRESS_MS) return
    this.lastProgress = Date.now()
    this.o.onProgress({ text: this.state.text, activity: this.state.activity, tool: this.state.tool })
  }

  /** The process closed with `code`: how the run ended. */
  private finish(code: number | null): void {
    const s = this.state
    if (this.cancelled) this.resolve(outcome.cancelled(s))
    else if (s.result) this.resolve(outcome.finished({ ...s, result: s.result }))
    else this.resolve(outcome.exited(s, code, this.stderr))
  }
}

/** Claude Code as the agent (agent.ts): runs with the program found for it. */
export const claudeCode = (cli: string): Agent => ({
  name: 'Claude Code',
  modelProblem,
  start: (o) => Ask.start({ ...o, cli }),
})

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
