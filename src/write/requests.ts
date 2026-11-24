import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { claudeLinks, extVersion, journeys, log, mapPanel, showError, state } from '../app'
import { claudeAllowed, trusted } from '../ask/trust'
import { modelProblem } from '../platform/agent/claude'
import { linkTarget } from '../core/linkUri'
import { posKey } from '../journeys/steps'
import { walkJourney } from '../tour/commands'
import { walk } from '../tour/instances'
import { MAP_KEY } from '../tour/state'
import { wfs } from '../platform/workspaceFs'
import { chooseJourney, confirmWrite, matchJourneys } from './rank'
import { writeJourney } from './writeJourney'
import { journeyModel, modelLabel } from './claudeRun'

// Requests from scripts: a request file or a link (docs/journey-format.md).
// The script writes .code-notes/.request.json in the repo ({action, question, model, at, id, needs}); the window that
// has the repo open handles it (also when it starts just now) and writes .code-notes/.result.json ({id, outcome, …})
// for the script to print. A request older than 2 minutes is ignored; one that needs a newer Code Notes is left for
// the reloaded window. The vscode://<publisher>.code-notes/explain link (old scripts) still works, but never starts
// Claude: it opens the overview or an existing journey.

/** A request: the overview, or a question to answer with a journey (`model`: for one written for it; `id`: the
 *  script's, echoed in its result). */
interface ScriptRequest { action: 'overview' | 'ask'; question: string; model?: string; id?: string }

/** Where a request came from: the request file, a vscode:// link (old scripts), or the palette's Ask a Question. */
type Via = 'file' | 'uri' | 'command'

/** The script's answer: what was done (flat, string values). */
interface RequestResult { outcome: string; title?: string; model?: string; message?: string; text?: string }

const REQUEST_FILE = '.code-notes/.request.json'

const RESULT_FILE = '.code-notes/.result.json'

const REQUEST_MAX_AGE = 2 * 60_000

/** The same request again within this long (an old script sends a link and a file) is handled once. */
const DUPLICATE_MS = 30_000

/** The last request handled, and its answer (a duplicate gets the same one). */
let lastRequest: { key: string; t: number; res?: RequestResult } | undefined

/** What each request did (for the integration test): overview, opened:<id>, confirm, writing, cancelled, untrusted, duplicate. */
export const requestLog: { action: string; question: string; via: string; outcome: string }[] = []

/** `a` is an older version than `b` (major.minor.patch; a request may need a newer Code Notes than this one). */
function olderThan(a: string, b: string): boolean {
  const semver = (v: string) => (/(\d+)\.(\d+)\.(\d+)/.exec(v) ?? ['', '0', '0', '0']).slice(1).map(Number)
  const x = semver(a)
  const y = semver(b)
  return (x[0] - y[0] || x[1] - y[1] || x[2] - y[2]) < 0
}

/** The script's answer, written atomically. */
function writeResult(folder: vscode.WorkspaceFolder, id: string | undefined, r: RequestResult): void {
  if (!id) return
  const file = path.join(folder.uri.fsPath, RESULT_FILE)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    const flat = Object.fromEntries(Object.entries({ id, ...r }).filter(([, v]) => typeof v === 'string'))
    fs.writeFileSync(tmp, JSON.stringify(flat) + '\n')
    fs.renameSync(tmp, file)
  } catch (e) { log.error(`explain: couldn't write ${RESULT_FILE}: ${e}`) }
}

/** What a request did: `outcome` for the log of requests, and `r` (if any) the script's answer. */
type Outcome = (outcome: string, r?: RequestResult) => void

async function handleRequest(req: ScriptRequest, via: Via, folder?: vscode.WorkspaceFolder): Promise<void> {
  const key = `${req.action}|${req.question.trim()}`
  const entry = { action: req.action, question: req.question, via, outcome: '' }
  requestLog.push(entry)
  const outcome: Outcome = (o, r) => {
    entry.outcome = o
    if (!r) return
    if (lastRequest?.key === key) lastRequest.res = r
    if (folder && via === 'file') writeResult(folder, req.id, r)
  }
  // The same request just now (an old script's link and file): handled once; the script still gets its answer.
  const duplicate = via !== 'command' && lastRequest && lastRequest.key === key && Date.now() - lastRequest.t < DUPLICATE_MS
  if (duplicate) {
    entry.outcome = 'duplicate'
    if (folder && via === 'file') writeResult(folder, req.id, lastRequest!.res ?? { outcome: 'overview' })
    return
  }
  lastRequest = { key, t: Date.now() }
  log.info(`explain (${via}): ${req.action}${req.question ? ` "${req.question}"` : ''}`)
  const q = req.question.trim()
  if (req.action === 'ask' && q && (await answerQuestion(q, req.model, via, outcome))) return
  // Overview: the panel's Journeys list (one marked "Start here"), not a picker; the sidebar is left as it was.
  outcome('overview', { outcome: 'overview' })
  await showJourneysHome()
}

/**
 * A question: the journey that answers it, a pick of a few that do, else (after a confirm) one written for it. False
 * when a link asked it and no journey answers it (a link never starts Claude: the overview instead).
 */
async function answerQuestion(q: string, model: string | undefined, via: Via, outcome: Outcome): Promise<boolean> {
  const found = matchJourneys(q)
  if (found.length > 1) {
    outcome('choose', { outcome: 'choose', text: found.map((x) => x.j.title).join(' / ') })
    log.info(`explain: ${found.length} journeys answer it about equally: ${found.map((x) => x.j.id).join(', ')}: a pick`)
    const c = await chooseJourney(q, found)
    if (c) {
      outcome(`opened:${c.j.id}`)
      await walkJourney(c, { fromStart: true })
    }
    return true
  }
  const lj = found[0]
  if (lj) {
    outcome(`opened:${lj.j.id}`, { outcome: 'opened', title: lj.j.title })
    log.info(`explain: opening journey ${lj.j.id}`)
    // A question asks about the whole flow: from step 1, not where it was left.
    await walkJourney(lj, { fromStart: true })
    return true
  }
  if (via === 'uri') {
    // A link can come from any web page: it never starts Claude. The overview instead.
    lastRequest = undefined // the same request as a file (from the script) is still handled
    log.info('explain: no journey answers it; a link never starts Claude: the overview')
    return false
  }
  if (!trusted()) {
    outcome('untrusted', { outcome: 'untrusted', message: 'Trust this folder in VS Code to let Claude write journeys.' })
    claudeAllowed('write journeys')
    return true
  }
  const bad = modelProblem(journeyModel(model))
  if (bad) {
    outcome('error', { outcome: 'error', message: bad })
    void showError(`Code Notes: ${bad}`)
    return true
  }
  await confirmAndWrite(q, model, outcome)
  return true
}

/** No journey answers it: the closest ones, or Write (Claude writes one in the background), or Cancel. */
async function confirmAndWrite(q: string, model: string | undefined, outcome: Outcome): Promise<void> {
  const label = modelLabel(journeyModel(model))
  outcome('confirm', { outcome: 'confirm', model: label })
  const c = await confirmWrite(q, model)
  if (c === 'write') {
    outcome('writing', { outcome: 'writing', model: label })
    void writeJourney(q, { model }).catch((e) => log.error(`journey: ${e}`))
  } else if (c) {
    outcome(`opened:${c.j.id}`, { outcome: 'opened', title: c.j.title })
    await walkJourney(c, { fromStart: true })
  } else outcome('cancelled')
}

/** The journey panel with its Journeys list in front: over the journey being walked or last shown, else the first one. */
async function showJourneysHome(): Promise<void> {
  const all = journeys.all()
  const lj = walk.tourJourney() ?? journeys.byPos(state.get<string>(MAP_KEY)) ?? all.find((x) => x.j.start) ?? all[0]
  if (!lj) { void vscode.window.showInformationMessage('Code Notes: no journeys in this workspace yet.'); return }
  // The walk is not ended here (a new card right after an ended walk's made VS Code's comment widgets loop on their
  // collapsed state: "Maximum call stack size exceeded"); choosing a journey switches as usual.
  mapPanel.showHome(lj)
  void state.update(MAP_KEY, posKey(lj))
}

/** A request as the script writes it; undefined (logged) when it can't be used. `model` only from the file. */
function parseRequest(v: any, where: string): ScriptRequest | undefined {
  const action = v?.action
  if (action !== 'overview' && action !== 'ask') {
    log.warn(`explain: ${where}: unknown action "${String(action)}"`)
    return undefined
  }
  const question = typeof v.question === 'string' ? v.question : typeof v.q === 'string' ? v.q : ''
  const model = typeof v.model === 'string' && v.model.trim() ? { model: v.model.trim() } : {}
  const id = typeof v.id === 'string' && v.id ? { id: v.id } : {}
  return { action, question, ...model, ...id }
}

/** vscode://<publisher>.code-notes/explain?action=…&q=…[&repo=<path>] (old scripts): `model` is ignored. */
async function onUri(uri: vscode.Uri): Promise<void> {
  if (uri.path.replace(/\/+$/, '') === '/link') {
    const t = linkTarget(uri.query)
    if (!t) { log.warn(`link: no file or start: ${uri.toString(true)}`); return }
    const folder = vscode.workspace.workspaceFolders?.[0]
    const file = path.isAbsolute(t.file) || !folder ? vscode.Uri.file(t.file) : vscode.Uri.joinPath(folder.uri, t.file)
    await claudeLinks.light(file, t.start - 1, t.end - 1)
    return
  }
  if (uri.path.replace(/\/+$/, '') !== '/explain') { log.warn(`unknown link: ${uri.toString(true)}`); return }
  const p = new URLSearchParams(uri.query)
  const repo = p.get('repo')
  const real = (x: string) => { try { return fs.realpathSync(x) } catch { return x } }
  const folder = repo ? (vscode.workspace.workspaceFolders ?? []).find((f) => real(f.uri.fsPath) === real(repo)) : vscode.workspace.workspaceFolders?.[0]
  // Another repository's request: the window that has it open handles it (through the request file).
  if (repo && !folder) { log.info(`explain: a link for ${repo}, not open in this window: left to that window`); return }
  const req = parseRequest({ action: p.get('action'), question: p.get('q') ?? '' }, 'link')
  if (req) await handleRequest(req, 'uri')
}

/** Reads and deletes .code-notes/.request.json, unless it needs a newer Code Notes (left for that window). */
async function consumeRequest(folder: vscode.WorkspaceFolder): Promise<void> {
  const uri = vscode.Uri.joinPath(folder.uri, REQUEST_FILE)
  let raw: string
  try { raw = new TextDecoder().decode(await wfs.readFile(uri)) } catch { return }
  let v: any
  try { v = JSON.parse(raw) } catch { v = undefined }
  if (v && typeof v.needs === 'string' && olderThan(extVersion, v.needs)) {
    log.info(`explain: the request needs Code Notes ${v.needs} (this is ${extVersion}): left for a reloaded window`)
    requestLog.push({ action: String(v.action), question: String(v.question ?? ''), via: 'file', outcome: 'too-new' })
    return
  }
  try { await wfs.delete(uri) } catch { /* gone already */ }
  if (!v) { log.warn(`explain: ${REQUEST_FILE} is not JSON: ignored`); return }
  const at = Date.parse(typeof v?.at === 'string' ? v.at : '')
  if (!at || Date.now() - at > REQUEST_MAX_AGE) { log.info(`explain: ${REQUEST_FILE} is ${at ? 'older than 2 minutes' : 'undated'}: ignored`); return }
  const req = parseRequest(v, REQUEST_FILE)
  if (req) await handleRequest(req, 'file', folder)
  else writeResult(folder, typeof v.id === 'string' ? v.id : undefined, { outcome: 'error', message: `unknown action "${String(v.action)}"` })
}

/**
 * "Ask a Question About the Code…": a request with a question, from the palette: the journey that answers it, else one
 * written for it.
 */
export const askQuestion = async () => {
  const q = (await vscode.window.showInputBox({ prompt: 'Ask a question about the code', placeHolder: 'How does … work?', ignoreFocusOut: true }))?.trim()
  if (!q) return
  // The same path as a request with a question (matching, a pick of close matches, trust, model check, the confirm).
  return handleRequest({ action: 'ask', question: q }, 'command')
}

/** Requests from scripts: the link, and the request file (one that came before this window did is handled now). */
export function watchRequests(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri: (u) => void onUri(u).catch((e) => log.error(`explain link: ${e}`)) }))
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(f, REQUEST_FILE))
    const take = () => void consumeRequest(f).catch((e) => log.error(`explain request: ${e}`))
    w.onDidCreate(take); w.onDidChange(take)
    context.subscriptions.push(w)
    take()
  }
}
