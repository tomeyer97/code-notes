// Opening a note: its thread (expanded, the others on its lines folded), its row, or a page when its file is gone;
// stepping through unread replies.

import * as vscode from 'vscode'
import { byId, firstFolder, log, mapPanel, notes, showError, store, understanding } from '../app'
import { ownSelection } from '../claudeLinks'
import { markRead, unread, visitFrom } from '../seen'
import { journeyOfNote } from '../sidebar/journeyRows'
import { hiddenSessions, matchesFilter, Node, noteNode, order, sessionOf } from '../sidebar/nodes'
import { treeView } from '../sidebar/notesTree'
import { serialize } from '../noteModel'
import { Note } from '../store'
import { plain } from '../text'
import { clampLines, docUri, missing, notesFor, relPath } from '../threads/anchoring'
import { lines, threadRange } from '../threads/comments'
import { editorSettling, editorShownAt, setCollapse, settling } from '../threads/settle'
import { expandWhenMade, revealed, syncThread, threads } from '../threads/threads'
import { openRef } from '../tour/refs'
import { walk } from '../tour/tour'
import { wfs } from '../wfs'
import { rangesAskedAt } from './create'
import { startMove } from './move'
import { resolve } from './status'
import { notesFrom } from './target'

/** A note whose file is gone, as a read-only document (never an unsaved Untitled buffer:). */
const ORPHAN_SCHEME = 'code-notes-note'

function orphanMarkdown(n: Note): string {
  return [`# ${plain(n.data.messages[0]?.body ?? 'Note', 80)}`, '', `_${n.data.file} ${lines(n)} no longer exists._`, '',
    ...(n.data.anchor.text.trim() ? ['It was about:', '', '```', n.data.anchor.text, '```', ''] : []),
    ...n.data.messages.flatMap((m) => [`**${m.author}** ${m.at ? m.at.slice(0, 16).replace('T', ' ') : ''}`, '', m.body, ''])].join('\n')
}

export async function reveal(n: Note, column?: vscode.ViewColumn, preserveFocus = false): Promise<void> {
  if (missing.has(n.data.id)) {
    revealInList(n)
    const uri = vscode.Uri.from({ scheme: ORPHAN_SCHEME, path: `/${n.data.file.split('/').pop()} (note).md`, query: n.data.id })
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true })
    await markRead([n])
    const pick = await vscode.window.showWarningMessage(`${n.data.file} no longer exists. Select the code this note belongs to, then use Move.`, 'Move…', 'Resolve')
    if (pick === 'Move…') await startMove(n)
    else if (pick === 'Resolve') await resolve([n])
    return
  }
  const prev = revealed.id
  revealed.id = n.data.id
  for (const id of [...visitFrom.keys()]) if (id !== n.data.id) visitFrom.delete(id)
  if (prev && prev !== n.data.id) { const p = byId(prev); if (p) syncThread(p) }
  // Never in the map's group: the code group, reusing its preview tab.
  const col = column ?? (vscode.window.visibleTextEditors.some((e) => e.document.uri.toString() === docUri(n).toString()) ? walk.columnFor(docUri(n))
    : mapPanel.viewColumn !== undefined && vscode.window.tabGroups.activeTabGroup.viewColumn === mapPanel.viewColumn ? walk.codeColumn() : undefined)
  const r = threadRange(n)
  ownSelection()
  // The caret goes with the show: one call into the window.
  const editor = await vscode.window.showTextDocument(docUri(n), { preview: true, preserveFocus, selection: new vscode.Selection(r.start, r.start), ...(col ? { viewColumn: col } : {}) })
  // A long range: its thread hangs below its last line, so that end (and the thread) is what comes into view, not a
  // screen of highlighted code with the question below the fold.
  const tall = r.end.line - r.start.line > 12
  editor.revealRange(tall ? new vscode.Range(Math.max(r.start.line, r.end.line - 3), 0, r.end.line, 0) : new vscode.Range(r.start, r.end.translate(4)),
    tall ? vscode.TextEditorRevealType.AtTop : vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  // Its thread not made yet (its editor is still opening: made once it has settled): it is made expanded.
  if (!threads.has(n.data.id)) expandWhenMade.add(n.data.id)
  syncThread(n)
  if (threads.has(n.data.id)) expandWhenMade.delete(n.data.id)
  // Only this note's thread is open: others on the same lines collapse, so the one clicked is the one shown.
  for (const other of notesFor(docUri(n))) {
    const t = threads.get(other.data.id)
    if (!t) continue
    const overlaps = other.data.range.start <= n.data.range.end && other.data.range.end >= n.data.range.start
    if (other === n) setCollapse(t, vscode.CommentThreadCollapsibleState.Expanded, other.data.id)
    else if (overlaps) setCollapse(t, vscode.CommentThreadCollapsibleState.Collapsed, other.data.id)
  }
  // Read: the threads and the list follow now; storing it is not waited for (a round trip to the window).
  void markRead([n], n).then(undefined, (e) => log.error(`mark read: ${e}`))
  // Its row in the list, once the list has been redrawn for it (a row revealed while the list redraws can't be found).
  revealInList(n)
}

/**
 * The keyboard in a note's thread, not in the code under it (where typing would edit the file). VS Code's API can't put
 * the caret in a thread's reply box; "Focus Comment on Current Line" moves focus into the thread (Tab reaches Reply).
 */
export async function focusReply(n: Note): Promise<boolean> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  for (let k = 0; k < 20 && (!threads.get(n.data.id) || settling(threads.get(n.data.id)!)); k++) await wait(50)
  if (!threads.get(n.data.id)) return false
  // Its widget is drawn after the thread's first state arrives, and in an editor that has just opened, after the
  // editor has settled: too early, and the command finds no thread and the keyboard stays in the code.
  // An editor that has just opened asks for the file's comments, then draws their widgets: wait for that question.
  const u = docUri(n).toString()
  editorSettling(docUri(n))
  const shownAt = editorShownAt.get(u) ?? 0
  for (let k = 0; k < 40 && (rangesAskedAt.get(u) ?? 0) < shownAt; k++) await wait(50)
  const since = Date.now() - Math.max(shownAt, rangesAskedAt.get(u) ?? 0)
  await wait(Math.max(150, 400 - since))
  const e = vscode.window.activeTextEditor
  if (!e || e.document.uri.toString() !== docUri(n).toString()) return false
  // The command looks for a thread on the caret's line: the thread's last line, where its widget hangs.
  const at = threadRange(n).end
  e.selection = new vscode.Selection(at.line, 0, at.line, 0)
  return vscode.commands.executeCommand('workbench.action.focusCommentOnCurrentLine').then(() => true, () => false)
}

/** Selects the note's row in the sidebar, when the sidebar is open. */
function revealInList(n: Note): void {
  // A step's question is listed under its journey in the Journeys view, not in this one.
  if (!treeView.visible || !matchesFilter(n) || journeyOfNote(n)) return
  treeView.reveal(noteNode(n), { select: true, focus: false }).then(undefined, () => { /* not in the list */ })
}

/** Next/previous note with unread replies after the cursor, across files in the sidebar's order. Hidden sessions are skipped. */
export async function stepUnread(dir: 1 | -1): Promise<void> {
  const list = notes().filter((n) => (unread(n) > 0 || visitFrom.has(n.data.id)) && !hiddenSessions().has(sessionOf(n)))
    .sort((a, b) => a.data.file.localeCompare(b.data.file) || order(a, b))
  const pending = list.filter((n) => unread(n) > 0)
  // With a map open, say what D does outside a tour, and how to walk the steps instead.
  if (!pending.length) { vscode.window.setStatusBarMessage(mapPanel.journey ? '$(check) No unread replies · to walk the steps, press ▶ on the map' : '$(check) No unread replies', 4000); return }
  const e = vscode.window.activeTextEditor
  const here = e ? { file: notesFor(e.document.uri)[0]?.data.file ?? relPath(vscode.workspace.getWorkspaceFolder(e.document.uri) ?? firstFolder(), e.document.uri), line: e.selection.active.line + 1 } : undefined
  const key = (n: Note) => [n.data.file, n.data.range.start] as const
  const after = (n: Note) => !here || (dir === 1
    ? key(n)[0] > here.file || (key(n)[0] === here.file && key(n)[1] > here.line)
    : key(n)[0] < here.file || (key(n)[0] === here.file && key(n)[1] < here.line))
  const ordered = dir === 1 ? pending : [...pending].reverse()
  await reveal(ordered.find(after) ?? ordered[0])
}

/** Back from a check thread's code link: the question, with the keyboard in its answer box (never in the code). */
export async function backToQuestion(n: Note): Promise<void> {
  const q = understanding?.qidOf(n)
  if (q) { await understanding!.open(q); return }
  await reveal(n, walk.codeColumn())
  await focusReply(n)
}

/** A code link key of a check thread ("check|<note id>|<message index>"): its note and that message's links. */
export function checkLinkNote(key: string): { n: Note; links: ReturnType<NonNullable<typeof understanding>['linksIn']> } | undefined {
  const m = /^check\|([^|]+)\|(\d+)$/.exec(key)
  const n = m ? byId(m[1]) : undefined
  return n && understanding ? { n, links: understanding.linksIn(n, Number(m![2])) } : undefined
}

/** D / A walk a check's open questions while it has some: when the thread shown is one of them, or nothing is unread. */
export const checkStepping = () => !!understanding?.hasOpen() && (!notes().some((n) => unread(n) > 0) || (!!revealed.id && !!byId(revealed.id) && understanding.isCheck(byId(revealed.id)!)))

/** The page a note whose file is gone opens on. */
export function registerOrphanPage(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(ORPHAN_SCHEME, {
    provideTextDocumentContent: (uri) => { const n = byId(uri.query); return n ? orphanMarkdown(n) : 'This note no longer exists.' },
  }))
}

export const openAt = async (folderUri: string, file: string, line: number, end?: number, step?: number) => {
  const lj = walk.tourJourney()
  if (step && lj && walk.touring() && lj.folder.uri.toString() === folderUri) return openRef(lj, file, line, end ?? line, step)
  const uri = vscode.Uri.joinPath(vscode.Uri.parse(folderUri), file)
  try { await wfs.stat(uri) } catch { void showError(`Code Notes: ${file} doesn't exist in this folder.`); return }
  const ed = await vscode.window.showTextDocument(uri, { preview: true })
  const pos = new vscode.Position(clampLines(ed.document, line, line).start, 0)
  ed.selection = new vscode.Selection(pos, pos)
  ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
}

/** A broken note file: open it at the field that is wrong. */
export const openBroken = async (node?: Node) => {
  if (node?.kind !== 'broken') return
  const uri = vscode.Uri.parse(node.uri)
  const doc = await vscode.workspace.openTextDocument(uri)
  const field = /"(range|status|messages|file)/.exec(node.why)?.[1] ?? (/^message \d/.test(node.why) ? 'messages' : undefined)
  const at = field ? doc.getText().indexOf(`"${field}"`) : node.why.startsWith('not valid JSON') ? doc.getText().length : -1
  const pos = at >= 0 ? doc.positionAt(at) : new vscode.Position(0, 0)
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) })
  vscode.window.setStatusBarMessage(`$(warning) ${node.why}`, 6000)
}

export const restoreBroken = async (node?: Node) => {
  if (node?.kind !== 'broken') return
  const known = store.notes.get(node.uri)
  if (!known) return
  await wfs.writeFile(known.uri, new TextEncoder().encode(serialize(known.data)))
  vscode.window.setStatusBarMessage('$(check) Restored the last good version', 3000)
}

export const revealCommand = (node?: Node) => { const [n] = notesFrom(node); if (n) return reveal(n) }

export const openNoteFile = (arg?: any) => { const [n] = notesFrom(arg); if (n) return vscode.window.showTextDocument(n.uri) }

export const openNoteId = (id: string) => { const nt = byId(id); if (nt) return reveal(nt) }
