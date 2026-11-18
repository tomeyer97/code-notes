// Claude answers notes: headless Claude Code (claude.ts) run on a note, a few at a time, the rest queued. Only in a
// trusted folder. Failures are shown in the thread and kept until retried or dismissed.

import * as vscode from 'vscode'
import * as fs from 'fs'
import * as os from 'os'
import { byId, cfg, log, n0, now, setCtx, state, store, understanding } from './app'
import { Ask, findCli, findCliAsync } from './claude'
import { me } from './identity'
import { createNote, noteFromNewThread } from './notes/create'
import { reveal } from './notes/reveal'
import { addReply } from './notes/status'
import { notesFrom } from './notes/target'
import { refreshAll } from './refresh'
import { markRead } from './seen'
import { Note } from './store'
import { docUri, linesOfUri } from './threads/anchoring'
import { noteOfThread, revealed, shape, shapeOf, syncThread } from './threads/threads'
import { UPDATE_ASK } from './tour/askStep'
import { walk } from './tour/instances'
import { modelProblem } from './writing'

/** A note Claude is answering (or that waits its turn): the answer so far and what Claude is doing. */
interface Asking { ask?: Ask; text: string; activity?: string; started: number; cancelled?: boolean }
/** note id -> its run */
export const asking = new Map<string, Asking>()
/** note id -> why Claude couldn't answer */
export const askErrors = new Map<string, string>()
const askQueue: string[] = []
/** Runs at once; more wait in the queue. */
const MAX_ASKS = 3

export const claudeMode = () => cfg().get<string>('claude.mode', 'button')

/**
 * Claude runs (answering a note, a step's question, writing a journey) run tools in the repository, the skill's
 * own scripts among them: only in a trusted folder. In Restricted Mode one line says why, with a button that opens
 * the trust editor; reading journeys and notes stays available.
 */
export const trusted = () => vscode.workspace.isTrusted

export function claudeAllowed(what: string): boolean {
  if (trusted()) return true
  log.info(`${what}: not run: this folder is in Restricted Mode (not trusted)`)
  void vscode.window.showInformationMessage(`Trust this folder to let Claude ${what}.`, 'Manage Trust').then((b) => {
    if (b) void vscode.commands.executeCommand('workbench.trust.manage')
  })
  return false
}

/** Claude Code skills a note may use: the Skill tool, Bash for each skill's own scripts only, and its cache folder. */
function skillAccess(): { tools: string[]; dirs: string[]; hint: string } {
  const home = os.homedir()
  const names = (cfg().get<string[]>('claude.skills') ?? []).filter((x) => fs.existsSync(`${home}/.claude/skills/${x}/SKILL.md`))
  if (!names.length) return { tools: [], dirs: [], hint: '' }
  const tools = ['Skill', ...names.map((x) => `Bash(${home}/.claude/skills/${x}/scripts/*)`)]
  const dirs = names.map((x) => `${process.env.XDG_CACHE_HOME ?? `${home}/.cache`}/${x}`).filter((d) => fs.existsSync(d))
  return {
    tools, dirs,
    hint: `\n\nIf the note asks for something one of these skills does, use it: ${names.join(', ')}. Run a skill's scripts by their full path (${home}/.claude/skills/<skill>/scripts/…), one command per call: no shell variables, no && or pipes (anything else is refused). When you are done, reply with a short summary; findings you wrote as notes don't need repeating.`,
  }
}

/** A question asked on a journey step: the answer first, short (a yes/no question gets its yes or no). */
function stepAskHint(n: Note): string {
  const x = n.data.extra as { journey?: unknown } | undefined
  return x?.journey && !n.data.messages[0]?.body.startsWith(UPDATE_ASK)
    ? '\n\nStart with a one-line answer (yes or no first, for a yes/no question), then at most 2-4 sentences. No headings, no lists unless asked; more only if asked.'
    : ''
}

/**
 * A question asked about the code of an understanding-check question: explain the code, never write that answer.
 * "Suggest a fix" on a concern: the smallest change, as one suggestion block (Apply puts it in; Undo takes it back).
 */
function checkHint(n: Note): string {
  const x = n.data.extra as { checkAsk?: string; checkFix?: string } | undefined
  if (x?.checkFix && !n.data.target && !n.data.messages.some((m) => m.author === 'Claude')) {
    const { start, end } = n.data.range
    return `\n\nSuggest the smallest change that fixes it, and one that fits the problem: it must not rely on the thing that failed (no alert through the mail server that is down), and needs no new setting or environment variable unless there is no other way. Reply with one sentence (at most 25 words), then one \`\`\`suggestion block holding the new text of lines ${start}-${end} (the lines of this note: the block replaces exactly those lines, so repeat the ones that stay as they are). Nothing more: no headings, no lists, no other code blocks, no tests. If the fix is not in these lines, say in one sentence where it is instead, without a block.`
  }
  const q = x?.checkAsk
  return q ? `\n\nThe person is answering an understanding check about this code. Its question: "${q}". Explain the code they ask about; never write, or hint at, the answer to that check question: they answer it themselves.` : ''
}

function claudePrompt(n: Note, code: string[] | undefined): string {
  const d = n.data
  const where = d.target === 'folder' ? `the folder ${d.file}/` : d.target ? `the whole file ${d.file}` : `${d.file} lines ${d.range.start}-${d.range.end}`
  const snippet = code && !d.target ? code.slice(d.range.start - 1, d.range.end).join('\n') : ''
  const lastClaude = d.messages.map((m) => m.author === 'Claude').lastIndexOf(true)
  const rules = 'Read whatever code you need (Read, Grep, Glob); do not modify files. Reply in concise markdown; ' +
    'reference code as path:line (relative to the repository root) so it becomes a link. Your reply is posted into the note thread as is.'
  if (d.claudeSession && lastClaude >= 0) {
    const fresh = d.messages.slice(lastClaude + 1).map((m) => `${m.author}: ${m.body}`).join('\n\n')
    return `Follow-up on the same note (now on ${where}${d.stale ? ', and the code there changed' : ''}):\n\n${fresh}\n\nAnswer it. ${rules}`
  }
  return [
    `${me()} left a note on ${where} in this repository${d.stale ? ' (the code there has changed since; the note was about the lines under "Originally")' : ''}:`,
    snippet ? '```\n' + snippet + '\n```' : '',
    d.selection ? `It is about this exact text: \`${d.selection.text}\`` : '',
    d.stale && d.anchor.text ? `Originally:\n\`\`\`\n${d.anchor.text}\n\`\`\`` : '',
    'The conversation so far:',
    d.messages.map((m) => `${m.author}${m.role ? ` (${m.role})` : ''}: ${m.body}`).join('\n\n'),
    `Answer ${me()}'s latest message. ${rules}`,
  ].filter(Boolean).join('\n\n')
}

/** A new note on lines of a file with this question, asked to Claude, and shown. */
export async function askAbout(file: string, start: number, end: number, question: string, extra: Record<string, unknown>): Promise<void> {
  const folder = n0()
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, file))
  const n = await createNote(doc, { start: start - 1, end: end - 1 }, question, undefined, extra)
  if (!n) return
  await reveal(n, walk.codeColumn())
  await askClaude(n)
}

/** Failures survive a reload: kept per workspace until retried or dismissed. */
const ASK_ERR_KEY = 'codeNotes.askErrors'
const saveAskErrors = () => state.update(ASK_ERR_KEY, Object.fromEntries(askErrors))
/** The failures stored before the reload. */
export function loadAskErrors(): void {
  for (const [k, v] of Object.entries(state.get<Record<string, string>>(ASK_ERR_KEY) ?? {})) askErrors.set(k, v)
}

export async function askClaude(n: Note, text?: string): Promise<void> {
  // A check question: what do you want to know? The answer goes in a note of its own, never in the check's thread.
  if (understanding?.isCheck(n)) {
    const q = understanding.questionOf(n)
    const ask = text?.trim() || await vscode.window.showInputBox({ title: 'Ask Claude about this code', prompt: 'Claude explains the code; the check question stays yours.', placeHolder: 'What do you want to know?' })
    if (!ask?.trim()) return
    await askAbout(n.data.file, n.data.range.start, n.data.range.end, ask.trim(), { ...(q ? { checkAsk: q.text } : {}), ...understanding.branchOf(n) })
    return
  }
  if (asking.has(n.data.id) || askQueue.includes(n.data.id)) return
  if (!claudeAllowed('answer notes')) return
  if (askErrors.delete(n.data.id)) void saveAskErrors()
  if (asking.size >= MAX_ASKS) {
    askQueue.push(n.data.id)
    asking.set(n.data.id, { text: '', activity: 'Queued…', started: Date.now() })
    refreshAll()
    return
  }
  await runAsk(n.data.id)
}

/** The next note in the queue, if any, is answered. */
async function runNext(): Promise<void> {
  const next = askQueue.shift()
  if (next) await runAsk(next)
}

/** A run that couldn't start: why, in its thread. */
function cantRun(id: string, error: string, logLine: string): void {
  asking.delete(id)
  askErrors.set(id, error)
  log.error(`note ${id}: ${logLine}`)
  void saveAskErrors()
  refreshAll()
}

async function runAsk(id: string): Promise<void> {
  const n = byId(id)
  if (!n) return
  // Trust was taken back while it waited in the queue: the queue empties.
  if (!trusted()) {
    asking.delete(id)
    refreshAll()
    await runNext()
    return
  }
  const cli = findCli(cfg().get<string>('claude.path') || undefined)
  if (!cli) {
    cantRun(id, 'Claude Code (the `claude` CLI) was not found. Install it, or set **Code Notes › Claude: Path**.', 'Ask Claude failed: the claude CLI was not found (setting codeNotes.claude.path, PATH)')
    return
  }
  const bad = modelProblem(cfg().get<string>('claude.model') || undefined)
  if (bad) {
    cantRun(id, `${bad} (setting Code Notes › Claude: Model)`, `Ask Claude not run: ${bad}`)
    await runNext()
    return
  }
  const entry: Asking = { text: '', activity: 'Starting Claude…', started: Date.now() }
  asking.set(id, entry)
  refreshAll()
  const code = n.data.target ? undefined : await linesOfUri(docUri(n))
  const skills = skillAccess()
  const ask = new Ask({
    cli, cwd: n.folder.uri.fsPath, prompt: claudePrompt(n, code) + checkHint(n) + stepAskHint(n) + skills.hint, resume: n.data.claudeSession,
    extraTools: skills.tools, addDirs: skills.dirs,
    model: cfg().get<string>('claude.model') || undefined,
    onProgress: (p) => { entry.text = p.text; entry.activity = p.activity; const x = byId(id); if (x) syncThread(x) },
  })
  entry.ask = ask
  if (entry.cancelled) ask.cancel() // Cancel was pressed while it was starting
  log.info(`note ${id}: asking Claude${n.data.claudeSession ? ' (follow-up)' : ''}`)
  const res = await ask.done
  asking.delete(id)
  const answered = byId(id)
  if (res.cancelled) log.info(`note ${id}: Claude cancelled`)
  else if (res.error || !res.text.trim()) {
    askErrors.set(id, res.error ?? 'Claude returned no answer.')
    log.error(`note ${id}: Ask Claude failed: ${res.error ?? 'no answer'}`)
    void saveAskErrors()
  } else if (answered) {
    answered.data.messages.push({ author: 'Claude', role: 'agent', body: res.text.trim(), at: now() })
    if (res.sessionId) answered.data.claudeSession = res.sessionId
    shape.set(id, shapeOf(answered))
    await store.save(answered)
    log.info(`note ${id}: Claude answered in ${Math.round((Date.now() - entry.started) / 1000)}s${res.costUsd ? `, $${res.costUsd.toFixed(3)}` : ''}`)
    // The person is looking at this note: the answer counts as read, with its "new" label for the visit.
    if (revealed.id === id) await markRead([answered], answered)
  }
  refreshAll()
  await runNext()
}

/** Cancel: stops Claude on the note, takes it out of the queue, or dismisses its failure. */
function cancelAsk(id: string): void {
  if (!asking.has(id) && askErrors.delete(id)) {
    void saveAskErrors()
    refreshAll()
    return
  }
  const queued = askQueue.indexOf(id)
  if (queued >= 0) {
    askQueue.splice(queued, 1)
    asking.delete(id)
    refreshAll()
    return
  }
  const a = asking.get(id)
  if (!a) return
  a.cancelled = true
  a.activity = 'Stopping…'
  a.ask?.cancel()
}

/** Whether the claude CLI is there (the context key codeNotes.claudeFound), asked again when its setting or the trust changes. */
export function watchClaudeCli(context: vscode.ExtensionContext): void {
  // In Restricted Mode `codeNotes.claude.path` comes from the user's settings only (package.json:
  // restrictedConfigurations), so a folder's own settings never pick the program run here.
  // Off the extension host's path: each candidate's `claude --version` runs as its own process (findCli then answers from the cache).
  let probes = 0
  const probeClaude = () => {
    const n = ++probes
    void findCliAsync(cfg().get<string>('claude.path') || undefined).then((c) => { if (n === probes) void setCtx('codeNotes.claudeFound', !!c) })
  }
  probeClaude()
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('codeNotes.claude.path')) probeClaude() }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => probeClaude()))
}

/** Ask Claude: from the note box (a new note), a thread's reply box (a follow-up), a row, a link, or the cursor. */
export const askClaudeCommand = async (arg?: any, many?: any[]) => {
  if (arg && typeof arg === 'object' && 'thread' in arg && 'text' in arg) {
    const reply = arg as vscode.CommentReply
    const existing = noteOfThread(reply.thread)
    if (!existing) { const n = await noteFromNewThread(reply); if (n) await askClaude(n); return }
    if (understanding?.isCheck(existing)) { await askClaude(existing, reply.text); return }
    if (reply.text.trim() && !(await addReply(existing, reply.text.trim()))) return
    await askClaude(existing)
    return
  }
  const list = typeof arg === 'string' ? [byId(arg)].filter((n): n is Note => !!n) : notesFrom(arg, many)
  for (const n of list) await askClaude(n)
}

export const cancelClaudeCommand = (arg?: any) => {
  const ids = typeof arg === 'string' ? [arg] : notesFrom(arg).map((n) => n.data.id)
  for (const id of ids) cancelAsk(id)
}
