// Requests from scripts and agents (docs/agent-protocol.md; the envelope: platform/agent/protocol.ts): the request
// file, the vscode://…/explain link (old scripts; it never starts Claude) and the palette's Ask a Question all take
// this one path. The window that has the repo open handles a request file (also when it starts just now) and writes
// the result for the script to print. Answering it: journeyAnswer.ts.

import * as vscode from 'vscode'
import { extVersion, log } from '../platform/host'
import { fireAndForget } from '../platform/run'
import { wfs } from '../platform/workspaceFs'
import {
  readEnvelope, readRequest, REQUEST_FILE, RequestResult, RESULT_FILE, resultText, ScriptRequest, Via,
} from '../platform/agent/protocol'
import { answerQuestion, Outcome, showJourneysHome } from './journeyAnswer'
import { vagueQuestion } from './questions'

/** The same request again within this long (an old script sends a link and a file) is handled once. */
const DUPLICATE_MS = 30_000
/** How many requests the log keeps (the newest). */
const LOG_KEPT = 200

/** A request handled: by whom, and what it did (overview, opened:<id>, choose, confirm, writing, cancelled, …). */
export interface RequestLogEntry {
  /** Counts up from 1 over the window's life: entries after a mark are those with a larger `seq`. */
  seq: number
  action: string
  question: string
  via: Via
  outcome: string
}

/** The newest requests handled (the integration tests read it), at most LOG_KEPT. */
export const requestLog: RequestLogEntry[] = []
let seq = 0
function logRequest(e: Omit<RequestLogEntry, 'seq'>): RequestLogEntry {
  const entry = { seq: ++seq, ...e }
  requestLog.push(entry)
  if (requestLog.length > LOG_KEPT) requestLog.splice(0, requestLog.length - LOG_KEPT)
  return entry
}

/** The last request handled and its answer: the same request again soon after gets that answer, and nothing runs. */
class RecentRequest {
  private last?: { key: string; t: number; result?: RequestResult }

  /** `key` was handled less than DUPLICATE_MS ago: its answer so far (undefined: none yet). */
  repeat(key: string): { result?: RequestResult } | undefined {
    const l = this.last
    return l && l.key === key && Date.now() - l.t < DUPLICATE_MS ? { result: l.result } : undefined
  }

  handling(key: string): void { this.last = { key, t: Date.now() } }
  answered(key: string, result: RequestResult): void { if (this.last?.key === key) this.last.result = result }
  /** The request was not answered after all (a link no journey answers): the same one as a file still is. */
  forget(key: string): void { if (this.last?.key === key) this.last = undefined }
}
const recent = new RecentRequest()

/** What an outcome says in the log of requests. */
function logLabel(o: Outcome): string {
  switch (o.kind) {
    case 'opened':
    case 'picked':
      return `opened:${o.journey.j.id}`
    case 'not-answered':
      return 'overview'
    default:
      return o.kind
  }
}

/** What an outcome tells the script; undefined: nothing (it was told before, or nothing changed for it). */
function resultOf(o: Outcome): RequestResult | undefined {
  switch (o.kind) {
    case 'overview': return { outcome: 'overview' }
    case 'opened': return { outcome: 'opened', title: o.journey.j.title }
    case 'choose': return { outcome: 'choose', text: o.journeys.map((x) => x.j.title).join(' / ') }
    case 'confirm': return { outcome: 'confirm', model: o.model }
    case 'writing': return { outcome: 'writing', model: o.model }
    case 'untrusted': return { outcome: 'untrusted', message: 'Trust this folder in VS Code to let Claude write journeys.' }
    case 'error': return { outcome: 'error', message: o.message }
    case 'picked':
    case 'cancelled':
    case 'not-answered':
      return undefined
  }
}

/** Results written one after another (a confirm, then writing), each atomically: a temp file renamed over it. */
let resultWrites: Promise<void> = Promise.resolve()
function writeResult(folder: vscode.WorkspaceFolder, id: string, r: RequestResult): Promise<void> {
  const file = vscode.Uri.joinPath(folder.uri, RESULT_FILE)
  const tmp = vscode.Uri.joinPath(folder.uri, `${RESULT_FILE}.${process.pid}.tmp`)
  const write = async () => {
    try {
      await wfs.writeFile(tmp, new TextEncoder().encode(resultText(id, r)))
      await wfs.rename(tmp, file, { overwrite: true })
    } catch (e) { log().error(`explain: couldn't write ${RESULT_FILE}: ${e}`) }
  }
  resultWrites = resultWrites.then(write)
  return resultWrites
}

/** Where a request's answer goes: the request file's folder and id (a link or the palette has none). */
type ReplyTo = { folder: vscode.WorkspaceFolder; id?: string }

async function handleRequest(req: ScriptRequest, via: Via, replyTo?: ReplyTo): Promise<void> {
  const key = `${req.action}|${req.question.trim()}`
  const entry = logRequest({ action: req.action, question: req.question, via, outcome: '' })
  const tell = (r: RequestResult) => { if (replyTo?.id) fireAndForget(writeResult(replyTo.folder, replyTo.id, r), 'explain result') }
  // The same request just now (an old script's link and file): handled once; the script still gets its answer.
  const repeat = via !== 'command' ? recent.repeat(key) : undefined
  if (repeat) {
    entry.outcome = 'duplicate'
    tell(repeat.result ?? { outcome: 'overview' })
    return
  }
  recent.handling(key)
  let told = ''
  const report = (o: Outcome) => {
    entry.outcome = logLabel(o)
    const r = resultOf(o)
    if (!r || JSON.stringify(r) === told) return
    told = JSON.stringify(r)
    recent.answered(key, r)
    tell(r)
  }
  log().info(`explain (${via}): ${req.action}${req.question ? ` "${req.question}"` : ''}`)
  const q = req.question.trim()
  const answered = req.action === 'ask' && q ? await answerQuestion(q, req.model, via, report) : undefined
  if (answered?.kind === 'not-answered') recent.forget(key)
  if (answered && answered.kind !== 'not-answered') { report(answered); return }
  // Overview: the panel's Journeys list (one marked "Start here"), not a picker; the sidebar is left as it was.
  report({ kind: 'overview' })
  // A link's question no journey answers is said, with a way to ask it here (the person asks it; the link never does).
  const ask = () => handleRequest({ action: 'ask', question: q }, 'command')
  await showJourneysHome(answered?.kind === 'not-answered' ? { question: q, ask } : undefined)
}

/** vscode://<publisher>.code-notes/explain?action=…&q=…[&repo=<path>] (old scripts): `model` is ignored. */
export async function explainLink(query: string): Promise<void> {
  const p = new URLSearchParams(query)
  const req = readRequest({ action: p.get('action'), question: p.get('q') ?? '' })
  if (typeof req === 'string') { log().warn(`explain: link: ${req}`); return }
  await handleRequest(req, 'uri')
}

/** Reads and deletes .code-notes/.request.json, unless it needs a newer Code Notes (left for that window). */
async function consumeRequest(folder: vscode.WorkspaceFolder): Promise<void> {
  const uri = vscode.Uri.joinPath(folder.uri, REQUEST_FILE)
  const raw = await wfs.readFile(uri).then((b) => new TextDecoder().decode(b), () => undefined)
  // Gone already (another event for the same file took it).
  if (raw === undefined) return
  const env = readEnvelope(raw, { version: extVersion(), now: Date.now() })
  if (env.kind === 'too-new') {
    log().info(`explain: the request needs Code Notes ${env.needs} (this is ${extVersion()}): left for a reloaded window`)
    logRequest({ action: env.action, question: env.question, via: 'file', outcome: 'too-new' })
    return
  }
  await wfs.remove(uri).catch(() => undefined)
  if (env.kind === 'refused') {
    // Every request that can't be used gets the same answer, when it says where to send it.
    log().warn(`explain: ${REQUEST_FILE}: ${env.reason}: ignored`)
    if (env.id) await writeResult(folder, env.id, { outcome: 'error', message: env.reason })
    return
  }
  await handleRequest(env.request, 'file', { folder, id: env.request.id })
}

/**
 * "Ask a Question About the Code…": a request with a question, from the palette: the journey that answers it, else one
 * written for it.
 */
export const askQuestion = async () => {
  // A word or two would cost minutes of Claude for a guess: asked again before anything starts.
  const box = { prompt: 'Ask a question about the code', placeHolder: 'How does … work?', ignoreFocusOut: true, validateInput: vagueQuestion }
  const q = (await vscode.window.showInputBox(box))?.trim()
  if (!q) return
  // The same path as a request with a question (matching, a pick of close matches, trust, model check, the confirm).
  return handleRequest({ action: 'ask', question: q }, 'command')
}

/** The request file of `folder` watched; one there already (it came before this window did) is handled now. */
function watchFolder(folder: vscode.WorkspaceFolder): vscode.Disposable {
  const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, REQUEST_FILE))
  const take = () => fireAndForget(consumeRequest(folder), 'explain request')
  w.onDidCreate(take)
  w.onDidChange(take)
  take()
  return w
}

/** Request files, in every folder of the window: those open now and those added later. */
export function watchRequestFiles(): vscode.Disposable {
  /** Folder uri -> its watcher. */
  const watchers = new Map<string, vscode.Disposable>()
  const add = (f: vscode.WorkspaceFolder) => {
    const key = f.uri.toString()
    if (!watchers.has(key)) watchers.set(key, watchFolder(f))
  }
  const remove = (f: vscode.WorkspaceFolder) => {
    const key = f.uri.toString()
    watchers.get(key)?.dispose()
    watchers.delete(key)
  }
  for (const f of vscode.workspace.workspaceFolders ?? []) add(f)
  const folders = vscode.workspace.onDidChangeWorkspaceFolders((e) => {
    e.removed.forEach(remove)
    e.added.forEach(add)
  })
  return { dispose: () => { folders.dispose(); for (const w of watchers.values()) w.dispose() } }
}
