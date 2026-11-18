// The grader's two backends: Claude Code (the `claude` CLI, which can read the repository) or the Anthropic API.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULTS } from './constants.mjs'

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
  if (onPath(env.UNDERSTANDING_CLAUDE || 'claude')) return 'claude'
  if (env.ANTHROPIC_API_KEY) return 'anthropic'
  throw new Error('no grader: install Claude Code (the claude CLI) or set ANTHROPIC_API_KEY')
}

/** Runs the grader once; returns its text. */
export async function runGrader(backend, { prompt, repo, model, env = process.env, timeoutMs = 300_000 }) {
  if (backend === 'anthropic') {
    if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set')
    const res = await fetch(`${(env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: model || 'claude-opus-5-5', max_tokens: 4000, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${body?.error?.message ?? res.statusText}`)
    if (body.stop_reason === 'refusal') throw new Error('the model declined to grade this answer')
    return (body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('')
  }
  const cli = env.UNDERSTANDING_CLAUDE || 'claude'
  const args = ['-p', '--output-format', 'json', '--allowedTools', 'Read', 'Grep', 'Glob', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'Bash', ...(model ? ['--model', model] : [])]
  return new Promise((resolve, reject) => {
    const p = spawn(cli, args, { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = ''
    const t = setTimeout(() => { p.kill('SIGTERM'); reject(new Error(`the claude CLI took longer than ${Math.round(timeoutMs / 1000)}s`)) }, timeoutMs)
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
