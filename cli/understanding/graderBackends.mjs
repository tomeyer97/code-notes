// The grader's two backends: Claude Code (the `claude` CLI, which can read the repository) or the Anthropic API.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULTS } from './constants.mjs'

/** The model the anthropic backend asks when none is set (the claude backend: Claude Code's own default). */
const DEFAULT_MODEL = 'claude-opus-5-5'
/** The Messages API: its version header, the reply's length limit. */
const ANTHROPIC_VERSION = '2023-06-01'
const GRADER_MAX_TOKENS = 4000
/** How long one grade may take. */
const GRADER_TIMEOUT_MS = 300_000

/**
 * The `claude` to run: UNDERSTANDING_CLAUDE, else `claude` on PATH. The extension finds its own (src/platform/agent/claudeCli.ts:
 * the codeNotes.claude.path setting, else the newest install on PATH and the usual places) and grades with it; this one
 * is for `grade` in a terminal, so the two can differ when several are installed. This file has no dependencies and
 * reads no VS Code setting, so it doesn't share the extension's search.
 */
const claudeCommand = (env) => env.UNDERSTANDING_CLAUDE || 'claude'

/** A command's path: as given when it has a "/", else the first executable of that name on PATH. */
function onPath(cmd) {
  if (cmd.includes('/')) return fs.existsSync(cmd) ? cmd : undefined
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    const p = path.join(d, cmd)
    try { fs.accessSync(p, fs.constants.X_OK); return p } catch { /* next */ }
  }
  return undefined
}

/** Which grader: --backend, UNDERSTANDING_BACKEND, config, else `claude` when it is on PATH, else `anthropic` with a key. */
export function pickBackend({ flag, cfg = DEFAULTS, env = process.env } = {}) {
  const want = flag || env.UNDERSTANDING_BACKEND || cfg.backend
  if (want) {
    if (want !== 'claude' && want !== 'anthropic') throw new Error(`unknown grader backend "${want}": use claude or anthropic`)
    return want
  }
  if (onPath(claudeCommand(env))) return 'claude'
  if (env.ANTHROPIC_API_KEY) return 'anthropic'
  throw new Error('no grader: install Claude Code (the claude CLI) or set ANTHROPIC_API_KEY')
}

/** Runs the grader once; returns its text. */
export async function runGrader(backend, { prompt, repo, model, env = process.env, timeoutMs = GRADER_TIMEOUT_MS }) {
  if (backend === 'anthropic') return runAnthropic({ prompt, model, env, timeoutMs })
  return runClaudeCli({ prompt, repo, model, env, timeoutMs })
}

/** The Messages API (ANTHROPIC_API_KEY; ANTHROPIC_BASE_URL for another endpoint): the reply's text. */
async function runAnthropic({ prompt, model, env, timeoutMs }) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set')
  const url = `${(env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': ANTHROPIC_VERSION },
    body: JSON.stringify({ model: model || DEFAULT_MODEL, max_tokens: GRADER_MAX_TOKENS, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${body?.error?.message ?? res.statusText}`)
  if (body.stop_reason === 'refusal') throw new Error('the model declined to grade this answer')
  return (body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('')
}

/** Claude Code, read-only (it reads the repository; it edits nothing and runs no command): its result's text. */
function runClaudeCli({ prompt, repo, model, env, timeoutMs }) {
  const cli = claudeCommand(env)
  const tools = ['--allowedTools', 'Read', 'Grep', 'Glob', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'Bash']
  const args = ['-p', '--output-format', 'json', ...tools, ...(model ? ['--model', model] : [])]
  return new Promise((resolve, reject) => {
    const p = spawn(cli, args, { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = ''
    const t = setTimeout(() => {
      p.kill('SIGTERM')
      reject(new Error(`the claude CLI took longer than ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
    p.stdout.on('data', (b) => { out += b })
    p.stderr.on('data', (b) => { if (err.length < 4000) err += b })
    p.on('error', (e) => { clearTimeout(t); reject(new Error(`couldn't start ${cli}: ${e.message}`)) })
    p.on('close', (code) => {
      clearTimeout(t)
      let v
      try { v = JSON.parse(out.trim().split('\n').pop()) } catch { return reject(new Error(`claude exited (${code}): ${(err || out).trim().slice(-300)}`)) }
      if (v.is_error) return reject(new Error(`claude: ${v.result ?? 'error'}`))
      resolve(String(v.result ?? ''))
    })
    p.stdin.end(prompt)
  })
}
