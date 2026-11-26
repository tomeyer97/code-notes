// Claude answers notes: the agent runner (platform/agent) run on a note, a few at a time, the rest queued (queue.ts).
// Only in a trusted folder. Failures are shown in the thread and kept until retried or dismissed.

import * as vscode from 'vscode'
import { codeColumn, notesStore } from './ports'
import { byId } from '../notes/visible'
import { firstFolder, log, now, stored } from '../platform/host'
import type { AskResult } from '../platform/agent/claude'
import { AgentProblem, agentRunner } from '../platform/agent/runner'
import { createNote } from '../notes/create'
import { docUri } from '../notes/location'
import { linesOfUri } from '../platform/documents'
import { reveal } from '../notes/reveal'
import { me } from '../notes/identity'
import { NotesApi, notesChanged, selection, whileTyping } from '../notes/model'
import { markRead } from '../notes/seen'
import { Note } from '../notes/store'
import { plural } from '../core/text'
import { syncThread, threads } from '../threads/sync'
import { askHandlerOf, askHints } from './handlers'
import { CLAUDE_AUTHOR, claudePrompt, nothingToAnswer, REPLY_TO_ASK_MORE, stepAskHint, STOPPED_MARK } from './prompts'
import { AskQueue, AskRun } from './queue'
import { RunEnds } from './settle'
import { skillAccess } from './skills'
import { fireAndForget } from '../platform/run'
import { STATE } from '../platform/state'
import { HiddenCmd } from '../platform/commands'

/** Runs at once; more wait in the queue. */
const MAX_ASKS = 3

let queue: AskQueue | undefined
const ends = new RunEnds()

/** How long the "Reply to ask more" hint stays in the status bar. */
const HINT_MS = 5000

/** The queue, kept over a reload through the workspace state (ask/index.ts makes it). */
export function createAskQueue(): AskQueue {
  queue = new AskQueue({
    load: () => stored().get(STATE.askErrors),
    save: (failures) => fireAndForget(stored().set(STATE.askErrors, failures), 'run: save ask failures'),
  }, MAX_ASKS)
  return queue
}

/** The state of note `id` (undefined before ask/ started, or when Claude has nothing to do with it). */
export const askState = (id: string) => queue?.state(id)

/** A note Claude is answering or that waits its turn, as the thread and the list show it. */
export interface Asking {
  text: string
  activity?: string
  started: number
}

/** Claude's run on note `id`, or its place in the queue ("Queued…"); for the thread and the list. */
export const asking = {
  has: (id: string): boolean => !!queue?.busy(id),
  get: (id: string): Asking | undefined => {
    const run = queue?.run(id)
    if (run) return run
    const since = queue?.queuedSince(id)
    return since === undefined ? undefined : { text: '', activity: 'Queued…', started: since }
  },
}

/** Why Claude couldn't answer note `id`, until retried or dismissed. */
export const askErrors = {
  has: (id: string): boolean => queue?.state(id) === 'failed',
  get: (id: string): string | undefined => queue?.failure(id),
}

/** A new note on lines of a file with this question, asked to Claude, and shown. */
export async function askAbout(file: string, start: number, end: number, question: string, extra: Record<string, unknown>): Promise<void> {
  const folder = firstFolder()
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, file))
  const n = await createNote(doc, { start: start - 1, end: end - 1 }, question, undefined, extra)
  if (!n) return
  await reveal(n, codeColumn())
  await askClaude(n)
}

/** Claude asked to answer the note: now, or queued behind MAX_ASKS runs. A feature's own notes go to that feature. */
export async function askClaude(n: Note, text?: string): Promise<void> {
  const handler = askHandlerOf(n)
  if (handler) return handler.ask(n, text)
  const q = queue!
  const id = n.data.id
  if (q.busy(id)) return
  // Claude's answer is the newest thing said: asking now would send it nothing (a paid run that can only say so).
  if (nothingToAnswer(n)) {
    vscode.window.setStatusBarMessage(REPLY_TO_ASK_MORE, HINT_MS)
    return
  }
  if (ends.tooSoon(id, n.data.messages.length)) { log().info(`note ${id}: Ask right after the run ended: ignored`); return }
  if (!agentRunner().allowed('answer notes')) return
  if (q.add(id)) await runAsk(id)
}

/** The next note in the queue, if any, is answered (on its own: not part of the run that just ended). */
function runNext(): void {
  const next = queue!.next()
  if (next) fireAndForget(runAsk(next), 'run: next in the queue')
}

/** What is said in the thread, and logged, when a run can't start. */
function cantRun(p: Exclude<AgentProblem, { kind: 'untrusted' }>): { said: string; logged: string } {
  switch (p.kind) {
    case 'no-cli':
      return {
        said: 'Claude Code (the `claude` CLI) was not found. Install it, or set **Code Notes › Claude: Path**.',
        logged: 'Ask Claude failed: the claude CLI was not found (setting codeNotes.claude.path, PATH)',
      }
    case 'bad-model':
      return { said: `${p.message} (setting Code Notes › Claude: Model)`, logged: `Ask Claude not run: ${p.message}` }
  }
}

/**
 * Claude answers note `id`. However it ends, the note leaves the running list and the queue moves on (with no CLI,
 * each note waiting says so).
 */
async function runAsk(id: string): Promise<void> {
  try {
    await answer(id)
  } finally {
    queue!.finish(id)
    // A failure's Try again is meant at once; only an answer or a stop settles.
    if (queue!.state(id) !== 'failed') ends.ended(id, byId(id)?.data.messages.length ?? 0)
    runNext()
  }
}

async function answer(id: string): Promise<void> {
  const n = byId(id)
  if (!n) return
  const q = queue!
  const entry = q.start(id)
  const runner = agentRunner()
  const model = runner.model('note')
  const ready = await runner.ready(model)
  // Trust was taken back while it waited in the queue: the queue empties, quietly.
  if (ready.kind === 'untrusted') return
  if (ready.kind !== 'ready') {
    const { said, logged } = cantRun(ready)
    log().error(`note ${id}: ${logged}`)
    q.fail(id, said)
    return
  }
  const run = await startAsk(n, ready.cli, model, entry)
  log().info(`note ${id}: asking Claude${n.data.claudeSession ? ' (follow-up)' : ''}`)
  const res = await run.done
  // The answer is shown without the "answering" row.
  q.finish(id)
  await recordAnswer(id, entry, { ...res, model: model || res.model })
}

/** Claude started on the note with its prompt, skills and model; its progress goes into the thread. */
async function startAsk(n: Note, cli: string, model: string | undefined, entry: AskRun) {
  const id = n.data.id
  const code = n.data.target ? undefined : await linesOfUri(docUri(n))
  const skills = await skillAccess()
  const run = agentRunner().start(cli, { key: `note:${id}`, purpose: 'note', label: n.data.messages[0]?.body ?? id }, {
    cwd: n.folder.uri.fsPath,
    prompt: claudePrompt(n, code, me()) + askHints(n) + stepAskHint(n) + skills.hint,
    resume: n.data.claudeSession,
    extraTools: skills.tools,
    addDirs: skills.dirs,
    model,
    onProgress: (p) => {
      entry.text = p.text
      entry.activity = p.activity
      const x = byId(id)
      if (x) syncThread(x)
    },
  })
  entry.run = run
  if (entry.cancelled) run.cancel() // Cancel was pressed while it was starting
  return run
}

/**
 * The answer as the newest message of the note, with the model and the seconds it took (shown beside the author),
 * saved; a stopped one ends with STOPPED_MARK. On a failed save the note is left as it was.
 */
async function saveAnswer(n: Note, res: AskResult, took: number): Promise<boolean> {
  const before = { messages: n.data.messages.length, session: n.data.claudeSession }
  const stopped = !!res.cancelled
  const body = stopped ? `${res.text.trim()}\n\n${STOPPED_MARK}` : res.text.trim()
  const extra = { ...(res.model ? { model: res.model } : {}), took, ...(stopped ? { stopped: true } : {}) }
  n.data.messages.push({ author: CLAUDE_AUTHOR, role: 'agent', body, at: now(), extra })
  if (res.sessionId) n.data.claudeSession = res.sessionId
  if (await notesStore().save(n)) return true
  n.data.messages.length = before.messages
  if (before.session) n.data.claudeSession = before.session; else delete n.data.claudeSession
  return false
}

/**
 * What the run ended with: stopped (what was written so far kept, marked), cancelled otherwise (logged: the window
 * closing), a failure (kept for the thread), or the answer (saved to the note).
 */
async function recordAnswer(id: string, entry: AskRun, res: AskResult): Promise<void> {
  const answered = byId(id)
  const secs = Math.round((Date.now() - entry.started) / 1000)
  if (res.cancelled) {
    log().info(`note ${id}: Claude stopped after ${secs}s`)
    if (!entry.cancelled || !res.text.trim() || !answered) return
    if (!(await saveAnswer(answered, res, secs))) { log().error(`note ${id}: Claude's stopped answer could not be saved`); return }
    // The person stopped it while reading it: not new to them.
    await markRead([answered])
    return
  }
  if (res.error || !res.text.trim()) {
    log().error(`note ${id}: Ask Claude failed: ${res.error ?? 'no answer'}`)
    queue!.fail(id, res.error ?? 'Claude returned no answer.')
    return
  }
  if (!answered) return
  if (!(await saveAnswer(answered, res, secs))) {
    log().error(`note ${id}: Claude's answer could not be saved`)
    queue!.fail(id, "Claude's answer could not be saved.")
    return
  }
  log().info(`note ${id}: Claude answered in ${secs}s${res.costUsd ? `, $${res.costUsd.toFixed(3)}` : ''}`)
  // Opened from the list: read, with its "new" label for the visit. Streamed into the open thread the person is
  // reading (a reply sent from it): read.
  if (selection().revealed === id) await markRead([answered], answered)
  else if (threadInView(answered)) await markRead([answered])
}

/** The note's thread is open in an editor on screen. */
function threadInView(n: Note): boolean {
  if (threads.get(n.data.id)?.collapsibleState !== vscode.CommentThreadCollapsibleState.Expanded) return false
  const uri = docUri(n).toString()
  return vscode.window.visibleTextEditors.some((e) => e.document.uri.toString() === uri)
}

/** Cancel: stops Claude on the note, takes it out of the queue, or dismisses its failure. */
export function cancelAsk(id: string): void {
  const q = queue!
  const state = q.state(id)
  if (state === 'failed') { q.dismiss(id); return }
  if (state === 'queued') { q.finish(id); return }
  const a = q.run(id)
  if (!a) return
  a.cancelled = true
  a.activity = 'Stopping…'
  a.run?.cancel()
}

/** The status bar item that says Claude is answering (how many notes); no note counter otherwise: the activity bar
 *  badge is the one unread count. It follows Claude's work on notes. */
export function askStatusItem(model: NotesApi): vscode.Disposable {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
  const refresh = () => {
    const busy = queue?.size ?? 0
    if (!busy) { item.hide(); return }
    item.text = `$(sync~spin) Claude · ${busy}`
    item.tooltip = `Claude is answering ${plural(busy, 'note')}`
    item.command = HiddenCmd.notesFocus
    item.show()
  }
  const sub = model.onDidChange((c) => { if (!whileTyping(c)) refresh() })
  return vscode.Disposable.from(item, sub)
}

/** Every change of a note's state is a change of its thread and row. */
export const announceAskChanges = (q: AskQueue): vscode.Disposable =>
  q.onDidChange((id) => notesChanged({ kind: 'activity', ids: [id] }))
