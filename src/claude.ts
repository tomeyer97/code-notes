// Answers a note with Claude Code running headless (`claude -p`), streaming its text as it writes.
// No vscode API here (unit-tested in test/claude.test.ts with a fake CLI).
import { spawn, spawnSync, ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

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

export interface AskResult { text: string; sessionId?: string; costUsd?: number; error?: string; cancelled?: boolean }

/** Read-only: Claude can look at the code but not change it. */
export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob']

/** "2.1.322 (Claude Code)" -> [2,1,322]. */
export function parseVersion(out: string): number[] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(out)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined
}
const newer = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

let found: { key: string; cli?: string } | undefined
/**
 * The `claude` CLI: the setting if given, else the NEWEST install among PATH and the usual places (VS Code's PATH
 * often finds an old global install before the one you update, e.g. nvm's).
 */
export function findCli(setting: string | undefined): string | undefined {
  const key = `${setting ?? ''}|${process.env.PATH ?? ''}`
  if (found?.key === key) return found.cli
  const all = candidates(setting)
  if (setting && all[0] === setting) { found = { key, cli: setting }; return setting }
  let best: { cli: string; v: number[] } | undefined
  const seen = new Set<string>()
  for (const c of all) {
    let real = c
    try { real = fs.realpathSync(c) } catch { continue }
    if (seen.has(real)) continue
    seen.add(real)
    const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 5000 })
    const v = parseVersion(`${r.stdout ?? ''}`)
    if (v && (!best || newer(v, best.v) > 0)) best = { cli: c, v }
  }
  found = { key, cli: best?.cli ?? all[0] }
  return found.cli
}

function candidates(setting: string | undefined): string[] {
  const candidates: string[] = []
  if (setting) candidates.push(setting)
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) if (dir) candidates.push(path.join(dir, 'claude'))
  const home = os.homedir()
  candidates.push(path.join(home, '.local/bin/claude'), path.join(home, '.claude/local/claude'), '/usr/local/bin/claude')
  try {
    const nvm = path.join(home, '.nvm/versions/node')
    for (const v of fs.readdirSync(nvm).sort().reverse()) candidates.push(path.join(nvm, v, 'bin/claude'))
  } catch { /* no nvm */ }
  return candidates.filter((c) => { try { fs.accessSync(c, fs.constants.X_OK); return true } catch { return false } })
}

/** Folds one stream-json line into the running state. Exported for tests. */
export function foldEvent(state: { text: string; activity?: string; tool?: ToolCall; result?: AskResult }, line: string): boolean {
  let e: any
  try { e = JSON.parse(line) } catch { return false }
  if (e.type === 'stream_event') {
    const ev = e.event
    if (ev?.type === 'message_start' && state.text && !state.text.endsWith('\n\n')) { state.text += '\n\n'; return true }
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') { state.text += ev.delta.text; state.activity = undefined; return true }
    if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') { state.activity = `Using ${ev.content_block.name}…`; return true }
    return false
  }
  if (e.type === 'assistant') {
    // A finished tool call: say what it is looking at.
    for (const c of e.message?.content ?? []) {
      if (c.type !== 'tool_use') continue
      const i = c.input ?? {}
      state.tool = { name: String(c.name), input: i }
      const target = i.file_path ?? i.pattern ?? i.path ?? ''
      state.activity = `${c.name === 'Read' ? 'Reading' : c.name === 'Grep' ? 'Searching for' : c.name === 'Glob' ? 'Looking for' : c.name} ${String(target).replace(/^.*\/(?=[^/]+\/[^/]+$)/, '')}`.trim()
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
      const args = ['-p', o.prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--allowedTools', ...READ_ONLY_TOOLS, ...(o.extraTools ?? []),
        // Edits and any other command stay blocked; Bash only as allowed by extraTools (a skill's own scripts).
        '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', ...(o.extraTools?.some((t) => t.startsWith('Bash(')) ? [] : ['Bash'])]
      for (const d of o.addDirs ?? []) args.push('--add-dir', d)
      if (o.model) args.push('--model', o.model)
      if (o.resume) args.push('--resume', o.resume)
      const state: { text: string; activity?: string; tool?: ToolCall; result?: AskResult } = { text: '' }
      let buf = '', err = ''
      const p = (this.proc = spawn(o.cli, args, { cwd: o.cwd, env: o.env ? { ...process.env, ...o.env } : process.env, stdio: ['ignore', 'pipe', 'pipe'] }))
      let last = 0
      const progress = (force = false) => {
        if (!o.onProgress || (!force && Date.now() - last < 250)) return
        last = Date.now()
        o.onProgress({ text: state.text, activity: state.activity, tool: state.tool })
      }
      p.stdout!.on('data', (b: Buffer) => {
        buf += b.toString()
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (line && foldEvent(state, line)) progress(!!state.activity)
        }
      })
      p.stderr!.on('data', (b: Buffer) => { if (err.length < 4000) err += b.toString() })
      p.on('error', (e) => resolve({ text: state.text, error: `couldn't start Claude Code (${o.cli}): ${e.message}` }))
      p.on('close', (code) => {
        if (buf.trim()) foldEvent(state, buf.trim())
        if (this.cancelled) return resolve({ text: state.text, cancelled: true, sessionId: state.result?.sessionId })
        if (state.result) return resolve(state.result)
        resolve({ text: state.text, error: `Claude Code exited (${code})${err ? `: ${err.trim().split('\n').slice(-3).join(' ')}` : ''}` })
      })
    })
  }

  cancel(): void {
    this.cancelled = true
    this.proc?.kill('SIGTERM')
  }
}
