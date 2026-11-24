// The grader's two backends: Claude Code (the `claude` CLI, which can read the repository) or the Anthropic API.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULTS, GRADER } from './constants'
import type { Config } from './types'

/**
 * Claude Code may read the repository and nothing else: the grading's security boundary. It edits no file and runs
 * no command (the answer it grades is the author's text, and may carry instructions).
 */
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob']
const DENIED_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'Bash']

/**
 * The `claude` to run, by the extension's first rule: the one named (UNDERSTANDING_CLAUDE here, the
 * codeNotes.claude.path setting there), else `claude` on PATH. The extension's next rule (the newest install among
 * PATH and the usual places, src/platform/agent/claudeCli.ts) is not shared: it reads this process's PATH and home
 * folder, where `grade` runs with the environment it is given (a CI job, a test), so with several installs a
 * terminal `grade` may run another version than VS Code.
 */
const claudeCommand = (env: NodeJS.ProcessEnv): string => env.UNDERSTANDING_CLAUDE || 'claude'

/** A command's path: as given when it has a "/", else the first executable of that name on PATH. */
function onPath(cmd: string): string | undefined {
  if (cmd.includes('/')) return fs.existsSync(cmd) ? cmd : undefined
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    const p = path.join(d, cmd)
    try { fs.accessSync(p, fs.constants.X_OK); return p } catch { /* next */ }
  }
  return undefined
}

/** Which grader: --backend, UNDERSTANDING_BACKEND, config, else `claude` when it is on PATH, else `anthropic` with a key. */
export function pickBackend({ flag, cfg = DEFAULTS, env = process.env }: { flag?: string; cfg?: Config; env?: NodeJS.ProcessEnv } = {}): 'claude' | 'anthropic' {
  const want = flag || env.UNDERSTANDING_BACKEND || cfg.backend
  if (want) {
    if (want !== 'claude' && want !== 'anthropic') throw new Error(`unknown grader backend "${want}": use claude or anthropic`)
    return want
  }
  if (onPath(claudeCommand(env))) return 'claude'
  if (env.ANTHROPIC_API_KEY) return 'anthropic'
  throw new Error('no grader: install Claude Code (the claude CLI) or set ANTHROPIC_API_KEY')
}

/** One run of the grader: the prompt, the repository it may read, the model, the environment, the time limit. */
type GraderRun = { prompt: string; repo: string; model?: string | null; env?: NodeJS.ProcessEnv; timeoutMs?: number }

/** Runs the grader once; returns its text. */
export async function runGrader(backend: string | undefined, { prompt, repo, model, env = process.env, timeoutMs = GRADER.timeoutMs }: GraderRun): Promise<string> {
  if (backend === 'anthropic') return runAnthropic({ prompt, model, env, timeoutMs })
  return runClaudeCli({ prompt, repo, model, env, timeoutMs })
}

/** The Messages API (ANTHROPIC_API_KEY; ANTHROPIC_BASE_URL for another endpoint): the reply's text. */
async function runAnthropic({ prompt, model, env, timeoutMs }: Omit<Required<GraderRun>, 'repo' | 'model'> & Pick<GraderRun, 'model'>): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set')
  const url = `${(env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': GRADER.apiVersion },
    body: JSON.stringify({ model: model || GRADER.model, max_tokens: GRADER.maxTokens, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body: any = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${body?.error?.message ?? res.statusText}`)
  if (body.stop_reason === 'refusal') throw new Error('the model declined to grade this answer')
  return (body.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
}

/** Claude Code, read-only (it reads the repository; it edits nothing and runs no command): its result's text. */
async function runClaudeCli({ prompt, repo, model, env, timeoutMs }: Omit<Required<GraderRun>, 'model'> & Pick<GraderRun, 'model'>): Promise<string> {
  const cli = claudeCommand(env)
  const tools = ['--allowedTools', ...READ_ONLY_TOOLS, '--disallowedTools', ...DENIED_TOOLS]
  const args = ['-p', '--output-format', 'json', ...tools, ...(model ? ['--model', model] : [])]
  const r = await runProcess(cli, args, { input: prompt, cwd: repo, env, timeoutMs })
  if (r.timedOut) throw new Error(`the claude CLI took longer than ${Math.round(timeoutMs / 1000)}s`)
  if (r.startError) throw new Error(`couldn't start ${cli}: ${r.startError}`)
  // Its result is the last line of its output, as JSON.
  let v: any
  try {
    v = JSON.parse(r.out.trim().split('\n').pop()!)
  } catch {
    throw new Error(`claude exited (${r.code}): ${(r.err || r.out).trim().slice(-300)}`)
  }
  if (v.is_error) throw new Error(`claude: ${v.result ?? 'error'}`)
  return String(v.result ?? '')
}

/** What a process did: its exit code and output (stderr at most ~4000 characters), or that it timed out or didn't start. */
type ProcessRun = { code: number | null; out: string; err: string; timedOut?: boolean; startError?: string }

/** Runs a command with `input` on stdin, killed after `timeoutMs`; settles once, with the first thing that happened. */
function runProcess(cmd: string, args: string[], { input, cwd, env, timeoutMs }: { input: string; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<ProcessRun> {
  return new Promise<ProcessRun>((resolve) => {
    const p = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = '', settled = false
    const settle = (r: Partial<ProcessRun>): void => {
      if (settled) return
      settled = true
      clearTimeout(t)
      resolve({ code: null, out, err, ...r })
    }
    const t = setTimeout(() => { p.kill('SIGTERM'); settle({ timedOut: true }) }, timeoutMs)
    p.stdout.on('data', (b: Buffer) => { out += b })
    p.stderr.on('data', (b: Buffer) => { if (err.length < 4000) err += b })
    p.on('error', (e) => settle({ startError: e.message }))
    p.on('close', (code) => settle({ code }))
    p.stdin.end(input)
  })
}
