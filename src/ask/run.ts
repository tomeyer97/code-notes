// Claude answers notes: headless Claude Code (claude.ts) run on a note, a few at a time, the rest queued. Only in a
// trusted folder. Failures are shown in the thread and kept until retried or dismissed.

import * as vscode from 'vscode'
import { byId, cfg, firstFolder, log, now, store, stored, understanding } from '../app'
import { Ask, AskResult, modelProblem } from '../platform/agent/claude'
import { createNote } from '../notes/create'
import { docUri } from '../notes/location'
import { linesOfUri } from '../platform/documents'
import { reveal } from '../notes/reveal'
import { NotesApi, notesChanged, selection, whileTyping } from '../notes/model'
import { markRead } from '../notes/seen'
import { Note } from '../notes/store'
import { plural } from '../core/text'
import { syncThread } from '../threads/sync'
import { walk } from '../tour/instances'
import { checkHint, claudePrompt, stepAskHint } from './prompts'
import { claudeCli } from './settings'
import { claudeAllowed, skillAccess, trusted } from './trust'
import { fireAndForget } from '../platform/run'
import { STATE } from '../platform/state'
import { HiddenCmd } from '../platform/commands'

/** A note Claude is answering (or that waits its turn): the answer so far and what Claude is doing. */
interface Asking { ask?: Ask; text: string; activity?: string; started: number; cancelled?: boolean }
/** note id -> its run */
export const asking = new Map<string, Asking>()
/** note id -> why Claude couldn't answer */
export const askErrors = new Map<string, string>()
const askQueue: string[] = []
/** Runs at once; more wait in the queue. */
const MAX_ASKS = 3

/** A new note on lines of a file with this question, asked to Claude, and shown. */
export async function askAbout(file: string, start: number, end: number, question: string, extra: Record<string, unknown>): Promise<void> {
  const folder = firstFolder()
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, file))
  const n = await createNote(doc, { start: start - 1, end: end - 1 }, question, undefined, extra)
  if (!n) return
  await reveal(n, walk.codeColumn())
  await askClaude(n)
}

const saveAskErrors = () => stored.set(STATE.askErrors, Object.fromEntries(askErrors))
/** The failures stored before the reload. */
export function loadAskErrors(): void {
  for (const [k, v] of Object.entries(stored.get(STATE.askErrors))) askErrors.set(k, v)
}

/** Claude asked to answer the note: now, or queued behind MAX_ASKS runs. A check question asks what to explain. */
export async function askClaude(n: Note, text?: string): Promise<void> {
  if (understanding?.isCheck(n)) return askAboutCheckQuestion(n, text)
  if (asking.has(n.data.id) || askQueue.includes(n.data.id)) return
  if (!claudeAllowed('answer notes')) return
  if (askErrors.delete(n.data.id)) fireAndForget(saveAskErrors(), 'run: saveAskErrors')
  if (asking.size >= MAX_ASKS) {
    askQueue.push(n.data.id)
    asking.set(n.data.id, { text: '', activity: 'Queued…', started: Date.now() })
    notesChanged({ kind: 'activity', ids: [n.data.id] })
    return
  }
  await runAsk(n.data.id)
}

/** A check question: what do you want to know? The answer goes in a note of its own, never in the check's thread. */
async function askAboutCheckQuestion(n: Note, text?: string): Promise<void> {
  const q = understanding!.questionOf(n)
  const box = { title: 'Ask Claude about this code', prompt: 'Claude explains the code; the check question stays yours.', placeHolder: 'What do you want to know?' }
  const ask = text?.trim() || await vscode.window.showInputBox(box)
  if (!ask?.trim()) return
  const extra = { ...(q ? { checkAsk: q.text } : {}), ...understanding!.branchOf(n) }
  await askAbout(n.data.file, n.data.range.start, n.data.range.end, ask.trim(), extra)
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
  fireAndForget(saveAskErrors(), 'run: saveAskErrors')
  notesChanged({ kind: 'activity', ids: [id] })
}

const NO_CLI = 'Claude Code (the `claude` CLI) was not found. Install it, or set **Code Notes › Claude: Path**.'

/** Claude answers note `id`. Each way out says why, and moves the queue on (with no CLI, each note waiting says so). */
async function runAsk(id: string): Promise<void> {
  const n = byId(id)
  if (!n) return
  // Trust was taken back while it waited in the queue: the queue empties.
  if (!trusted()) {
    asking.delete(id)
    notesChanged({ kind: 'activity', ids: [id] })
    await runNext()
    return
  }
  const cli = claudeCli()
  if (!cli) {
    cantRun(id, NO_CLI, 'Ask Claude failed: the claude CLI was not found (setting codeNotes.claude.path, PATH)')
    await runNext()
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
  notesChanged({ kind: 'activity', ids: [id] })
  const ask = await startAsk(n, cli, entry)
  log.info(`note ${id}: asking Claude${n.data.claudeSession ? ' (follow-up)' : ''}`)
  const res = await ask.done
  asking.delete(id)
  await recordAnswer(id, entry, res)
  notesChanged({ kind: 'activity', ids: [id] })
  await runNext()
}

/** Claude started on the note with its prompt, skills and model; its progress goes into the thread. */
async function startAsk(n: Note, cli: string, entry: Asking): Promise<Ask> {
  const id = n.data.id
  const code = n.data.target ? undefined : await linesOfUri(docUri(n))
  const skills = skillAccess()
  const ask = new Ask({
    cli, cwd: n.folder.uri.fsPath,
    prompt: claudePrompt(n, code) + checkHint(n) + stepAskHint(n) + skills.hint,
    resume: n.data.claudeSession,
    extraTools: skills.tools, addDirs: skills.dirs,
    model: cfg().get<string>('claude.model') || undefined,
    onProgress: (p) => {
      entry.text = p.text
      entry.activity = p.activity
      const x = byId(id)
      if (x) syncThread(x)
    },
  })
  entry.ask = ask
  if (entry.cancelled) ask.cancel() // Cancel was pressed while it was starting
  return ask
}

/** What the run ended with: cancelled (logged), a failure (kept for the thread), or the answer (saved to the note). */
async function recordAnswer(id: string, entry: Asking, res: AskResult): Promise<void> {
  const answered = byId(id)
  if (res.cancelled) log.info(`note ${id}: Claude cancelled`)
  else if (res.error || !res.text.trim()) {
    askErrors.set(id, res.error ?? 'Claude returned no answer.')
    log.error(`note ${id}: Ask Claude failed: ${res.error ?? 'no answer'}`)
    fireAndForget(saveAskErrors(), 'run: saveAskErrors')
  } else if (answered) {
    answered.data.messages.push({ author: 'Claude', role: 'agent', body: res.text.trim(), at: now() })
    if (res.sessionId) answered.data.claudeSession = res.sessionId
    await store.save(answered)
    const secs = Math.round((Date.now() - entry.started) / 1000)
    log.info(`note ${id}: Claude answered in ${secs}s${res.costUsd ? `, $${res.costUsd.toFixed(3)}` : ''}`)
    // The person is looking at this note: the answer counts as read, with its "new" label for the visit.
    if (selection().revealed === id) await markRead([answered], answered)
  }
}

/** Cancel: stops Claude on the note, takes it out of the queue, or dismisses its failure. */
export function cancelAsk(id: string): void {
  if (!asking.has(id) && askErrors.delete(id)) {
    fireAndForget(saveAskErrors(), 'run: saveAskErrors')
    notesChanged({ kind: 'activity', ids: [id] })
    return
  }
  const queued = askQueue.indexOf(id)
  if (queued >= 0) {
    askQueue.splice(queued, 1)
    asking.delete(id)
    notesChanged({ kind: 'activity', ids: [id] })
    return
  }
  const a = asking.get(id)
  if (!a) return
  a.cancelled = true
  a.activity = 'Stopping…'
  a.ask?.cancel()
}

/** The status bar item that says Claude is answering. */
export let askStatusItem: vscode.StatusBarItem

export function createAskStatusItem(): void {
  askStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
}

/** Shown while Claude answers (how many notes); no note counter otherwise: the activity bar badge is the one unread count. */
/** The status bar item follows Claude's work on notes. */
export const followNotes = (model: NotesApi) => model.onDidChange((c) => { if (!whileTyping(c)) refreshAskStatus() })

export function refreshAskStatus(): void {
  if (!asking.size) { askStatusItem.hide(); return }
  askStatusItem.text = `$(sync~spin) Claude · ${asking.size}`
  askStatusItem.tooltip = `Claude is answering ${plural(asking.size, 'note')}`
  askStatusItem.command = HiddenCmd.notesFocus
  askStatusItem.show()
}
