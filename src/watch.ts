// Files changed, created, deleted or renamed outside the editor (an agent, git), and edits in the editor: notes and
// journey steps follow their code.

import * as vscode from 'vscode'
import { Loc, shift, swallows } from './anchor'
import { journeys, mapPanel, notes, store } from './app'
import { refreshBranch } from './checkout'
import { authorChanged } from './identity'
import { fileOf } from './journeys/steps'
import { applyIgnoreInGit, changeFolder, rewriteReadmes } from './notes/folder'
import { refreshAll, updateCursorContext } from './refresh'
import { markRead, unread } from './seen'
import { journeysTree } from './sidebar/journeysTree'
import { findMovedFile, followMovedFiles, followRename, inNotesFolder, lineNotesFor, notesAtLine, notesFor, pathUri, reanchor, reanchorAll, recentCreates, relPath, toLoc } from './notes/location'
import { noteVisibleEditors } from './threads/settle'
import { refreshDecorations } from './notes/decorations'
import { syncThread, threads } from './threads/sync'
import { keepOffMap } from './tour/layout'
import { card, tour, walk } from './tour/tour'
import { docLines, wfs } from './wfs'

/** Steps whose file was renamed or deleted on disk: follow the code into a file created just now, or go stale. */
async function followJourneyFiles(): Promise<void> {
  for (const lj of journeys.list.values()) {
    let changed = false
    for (const s of lj.j.steps) {
      const f = fileOf(lj, s.n)
      try { await wfs.stat(vscode.Uri.joinPath(lj.folder.uri, f)); continue } catch { /* gone */ }
      // Only the same code (fresh) follows into a new file: edited look-alikes don't.
      const moved = await findMovedFile(
        (folder) => folder?.uri.toString() === lj.folder.uri.toString(),
        (lines) => journeys.findIn(lj, s.n, lines).state === 'fresh' || undefined,
      )
      if (moved) await journeys.moveStep(lj, s.n, relPath(lj.folder, moved.uri))
      if (fileOf(lj, s.n) === f && (await journeys.locate(lj, (k) => k === s.n))) changed = true
    }
    if (changed) { mapPanel.update(); if (lj.key === tour.key && tour.step) { await card.checkRefs(lj, tour.step); card.show(lj, tour.step) } }
  }
  card.refreshDecorations()
}

/** A journey changed (its file, or where its steps are), or a document it walks was edited. */
export function watchJourneys(context: vscode.ExtensionContext): void {
  context.subscriptions.push(journeys.onDidChange(() => {
    card.lensChanged.fire()
    for (const lj of journeys.list.values()) mapPanel.update(lj)
    refreshAll()
    // The journey file was rewritten: the same step (by id), with its new text.
    walk.followStep()
  }), journeys.onDidMoveSteps((lj) => {
    card.lensChanged.fire()
    mapPanel.update()
    journeysTree.refresh()
    if (lj.key === tour.key && tour.step) card.show(lj, tour.step)
    card.refreshDecorations()
  }), vscode.workspace.onDidChangeTextDocument((e) => { if (e.contentChanges.length) { journeys.onEdit(e); journeys.onDocument(e.document) } }))
}

/** A content change as anchor.ts's shift and swallows read it. */
const editOf = (c: vscode.TextDocumentContentChangeEvent) => ({
  startLine: c.range.start.line, startChar: c.range.start.character,
  endLine: c.range.end.line, endChar: c.range.end.character,
  newLines: (c.text.match(/\n/g) ?? []).length,
})

/** Notes re-anchor this long after typing stops. */
const REANCHOR_AFTER_TYPING_MS = 400

/** Notes follow edits live, and re-anchor (moved code, stale) shortly after typing stops. Saved to disk only with the
 *  file. */
export function watchEdits(context: vscode.ExtensionContext): void {
  const pending = new Map<string, NodeJS.Timeout>()
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
    const list = lineNotesFor(e.document.uri)
    if (!list.length || !e.contentChanges.length) return
    const changes = [...e.contentChanges].sort((a, b) => b.range.start.compareTo(a.range.start))
    const before = new Map<string, Loc>()
    for (const n of list) {
      let loc = toLoc(n.data)
      before.set(n.data.id, loc)
      let swallowed = false
      for (const c of changes) {
        const edit = editOf(c)
        if (swallows(loc, edit)) swallowed = true
        loc = shift(loc, edit)
      }
      // A replace of the whole note (a reload from disk, git stash/checkout): search for it rather than stretch it.
      if (swallowed) loc = before.get(n.data.id)!
      n.data.range = { start: loc.start + 1, end: loc.end + 1 }
    }
    for (const n of list) syncThread(n)
    refreshDecorations()
    const key = e.document.uri.toString()
    clearTimeout(pending.get(key))
    pending.set(key, setTimeout(async () => {
      pending.delete(key)
      const ls = docLines(e.document)
      for (const n of lineNotesFor(e.document.uri)) reanchor(n, ls, toLoc(n.data), before.get(n.data.id)?.start)
      refreshAll()
      if (!e.document.isDirty) for (const n of lineNotesFor(e.document.uri)) await store.save(n)
    }, REANCHOR_AFTER_TYPING_MS))
  }))
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (doc) => {
    const list = lineNotesFor(doc.uri)
    if (!list.length) return
    const ls = docLines(doc)
    for (const n of list) { reanchor(n, ls); await store.save(n) }
    refreshAll()
  }))
}

/** Files changed, created, deleted or renamed outside the editor (an agent, git): re-anchor and follow moves. */
export function watchFiles(context: vscode.ExtensionContext): void {
  const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*')
  const forgetStepPaths = () => { stepPaths = undefined }
  fileWatcher.onDidChange((u) => onDisk(u))
  fileWatcher.onDidCreate((u) => onDisk(u, true))
  fileWatcher.onDidDelete((u) => onDisk(u))
  context.subscriptions.push(
    journeys.onDidChange(forgetStepPaths), journeys.onDidMoveSteps(forgetStepPaths),
    fileWatcher, vscode.workspace.onDidRenameFiles(onRenamed),
  )
}

/**
 * The paths of the files journey steps are in. Every file event of the workspace comes here (a build writes
 * thousands): worked out once per change of the journeys (or of where their steps are), not per event. (A step found
 * in a renamed file by git alone says nothing: a few seconds at most.)
 */
let stepPaths: { at: number; paths: Set<string> } | undefined
const STEP_PATHS_MS = 5000

/** A journey step's code is in this file. */
function stepIn(u: vscode.Uri): boolean {
  if (!stepPaths || Date.now() - stepPaths.at > STEP_PATHS_MS) {
    const paths = [...journeys.list.values()].flatMap((lj) => lj.j.steps.map((s) => vscode.Uri.joinPath(lj.folder.uri, fileOf(lj, s.n)).path))
    stepPaths = { at: Date.now(), paths: new Set(paths) }
  }
  return stepPaths.paths.has(u.path)
}

/** Files with journey steps changed on disk since the last pass: their steps are found again. */
const stepFilesChanged = new Set<string>()
let diskTimer: NodeJS.Timeout | undefined
/** One pass after a burst of file events. */
const DISK_PASS_MS = 600

/** Whether a note is on this file, or on a folder it is in. */
const hasNotes = (u: vscode.Uri) =>
  notesFor(u).length > 0 || notes().some((n) => n.data.target === 'folder' && u.path.startsWith(pathUri(n).path))

/** A file changed, created or deleted on disk: a pass soon, when notes or journey steps are on it (or it is new). */
function onDisk(u: vscode.Uri, created = false): void {
  if (inNotesFolder(u) || u.path.includes('/.git/')) return
  if (stepIn(u)) stepFilesChanged.add(u.path)
  if (created) recentCreates.push({ uri: u, at: Date.now() })
  else if (!hasNotes(u) && !stepIn(u)) return
  clearTimeout(diskTimer)
  diskTimer = setTimeout(diskPass, DISK_PASS_MS)
}

/** Notes re-anchored and followed into moved files, then journey steps; steps in changed files found again. */
async function diskPass(): Promise<void> {
  await reanchorAll()
  await followMovedFiles()
  await followJourneyFiles()
  const paths = new Set(stepFilesChanged)
  stepFilesChanged.clear()
  if (paths.size) await journeys.relocateOnDisk(paths)
}

/** Files renamed in the editor: notes follow (notes/location.ts), and journey steps, in memory. */
async function onRenamed(e: vscode.FileRenameEvent): Promise<void> {
  for (const { oldUri, newUri } of e.files) {
    await followRename(oldUri, newUri)
    for (const lj of journeys.list.values()) {
      for (const s of lj.j.steps) {
        const old = vscode.Uri.joinPath(lj.folder.uri, fileOf(lj, s.n)).path
        if (old !== oldUri.path && !old.startsWith(oldUri.path + '/')) continue
        await journeys.moveStep(lj, s.n, relPath(lj.folder, vscode.Uri.joinPath(newUri, old.slice(oldUri.path.length))))
      }
    }
  }
  refreshAll()
}

/** The editors on screen, the active one and its cursor, tabs opened in the panel's group, the settings, the folders. */
export function watchEditors(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(() => { noteVisibleEditors(); refreshDecorations(); card.restore() }),
    vscode.window.tabGroups.onDidChangeTabs((e) => { for (const t of e.opened) void keepOffMap(t) }),
    vscode.window.onDidChangeActiveTextEditor(updateCursorContext),
    vscode.window.onDidChangeTextEditorSelection(cursorMoved),
    vscode.workspace.onDidChangeConfiguration(settingsChanged),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void store.load(); void journeys.load() }),
  )
}

/** The cursor on a note counts as reading it only when it is the one note on that line; not when a journey step put
 *  the cursor there (arriving is not reading). */
function cursorMoved(e: vscode.TextEditorSelectionChangeEvent): void {
  updateCursorContext()
  const line = (e.selections[0]?.active.line ?? -2) + 1
  const here = notesAtLine(e.textEditor.document.uri, line)
  if (Date.now() < tour.cursorUntil) return
  if (here.length === 1 && unread(here[0]) && threads.has(here[0].data.id)) markRead(here, here[0])
}

async function settingsChanged(e: vscode.ConfigurationChangeEvent): Promise<void> {
  const changed = (setting: string) => e.affectsConfiguration(setting)
  if (changed('codeNotes.folder')) { await changeFolder(); return }
  // The journeys folder: its journeys read again, then (it is a codeNotes setting too) the lenses, below.
  if (changed('codeNotes.journeys.folder')) { await journeys.load(); refreshAll() }
  if (changed('codeNotes.ignoreInGit')) { await applyIgnoreInGit(); return }
  if (changed('codeNotes.author')) {
    await authorChanged()
    await rewriteReadmes()
    refreshAll()
    return
  }
  if (changed('codeNotes')) { card.lensChanged.fire(); refreshAll() }
}

/** codeNotes.refresh: notes and journeys read again. */
export const reloadAll = async () => { await store.load(); await journeys.load() }

/** The checked-out branch per folder; another branch: every step is found again in the code checked out now. */
export async function watchBranches(context: vscode.ExtensionContext): Promise<void> {
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    await refreshBranch(f)
    const head = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(f, '.git/HEAD'))
    const onHead = () => refreshBranch(f).then(() => journeys.relocateOnDisk()).then(refreshAll)
    head.onDidChange(onHead)
    head.onDidCreate(onHead)
    context.subscriptions.push(head)
  }
}
