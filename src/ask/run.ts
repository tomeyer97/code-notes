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
import { syncThread } from '../threads/sync'
import { askHandlerOf, askHints } from './handlers'
import { CLAUDE_AUTHOR, claudePrompt, stepAskHint } from './prompts'
import { AskQueue, AskRun } from './queue'
import { skillAccess } from './skills'
import { fireAndForget } from '../platform/run'
import { STATE } from '../platform/state'
import { HiddenCmd } from '../platform/commands'

/** Runs at once; more wait in the queue. */
const MAX_ASKS = 3

let queue: AskQueue | undefined

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
  if (q.busy(n.data.id)) return
  if (!agentRunner().allowed('answer notes')) return
  if (q.add(n.data.id)) await runAsk(n.data.id)
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
  await recordAnswer(id, entry, res)
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

/** The answer as the newest message of the note, saved; on a failed save the note is left as it was. */
async function saveAnswer(n: Note, res: AskResult): Promise<boolean> {
  const before = { messages: n.data.messages.length, session: n.data.claudeSession }
  n.data.messages.push({ author: CLAUDE_AUTHOR, role: 'agent', body: res.text.trim(), at: now() })
  if (res.sessionId) n.data.claudeSession = res.sessionId
  if (await notesStore().save(n)) return true
  n.data.messages.length = before.messages
  if (before.session) n.data.claudeSession = before.session; else delete n.data.claudeSession
  return false
}

/** What the run ended with: cancelled (logged), a failure (kept for the thread), or the answer (saved to the note). */
async function recordAnswer(id: string, entry: AskRun, res: AskResult): Promise<void> {
  const answered = byId(id)
  if (res.cancelled) { log().info(`note ${id}: Claude cancelled`); return }
  if (res.error || !res.text.trim()) {
    log().error(`note ${id}: Ask Claude failed: ${res.error ?? 'no answer'}`)
    queue!.fail(id, res.error ?? 'Claude returned no answer.')
    return
  }
  if (!answered) return
  if (!(await saveAnswer(answered, res))) {
    log().error(`note ${id}: Claude's answer could not be saved`)
    queue!.fail(id, "Claude's answer could not be saved.")
    return
  }
  const secs = Math.round((Date.now() - entry.started) / 1000)
  log().info(`note ${id}: Claude answered in ${secs}s${res.costUsd ? `, $${res.costUsd.toFixed(3)}` : ''}`)
  // The person is looking at this note: the answer counts as read, with its "new" label for the visit.
  if (selection().revealed === id) await markRead([answered], answered)
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
