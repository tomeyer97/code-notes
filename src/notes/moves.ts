// Notes follow their code when files move: renamed in the editor (Explorer, a refactoring), or deleted and made again
// elsewhere on disk (git mv, mv, an agent's refactoring), where the code is looked for in the files made just now.
// Files changed on disk with notes on them are re-anchored (reanchor.ts) after a burst of changes.

import * as vscode from 'vscode'
import { log, notes, store } from '../app'
import { relPath } from '../platform/documents'
import { exists } from '../platform/exists'
import { FileOnDisk, WorkspaceEvents } from '../platform/events'
import { Debouncer } from '../platform/debounce'
import { Loc } from '../core/anchors/anchor'
import { Note } from './store'
import { docUri, notesFor, nothingToMatch, pathUri, placement } from './location'
import { checkTarget, findAnchor, reanchor, reanchorAll } from './reanchor'
import { locOf, range1Of } from './model/lines'
import { notesChanged, notesModel } from './model'

/** One pass after a burst of file events. */
const DISK_PASS_MS = 600

/** Files changed on disk and renamed in the editor: the notes on them follow. */
export function followNoteFiles(events: WorkspaceEvents): vscode.Disposable {
  const pass = new Debouncer('notes: files changed on disk')
  return vscode.Disposable.from(
    pass,
    events.onDidChangeFileOnDisk((f) => { if (concernsNotes(f)) pass.later('disk', DISK_PASS_MS, () => diskPass(events)) }),
    events.onDidRenameFiles((e) => notesModel().batch(() => followRenames(e))),
  )
}

/** A pass is due: notes are on the file (or on a folder it is in), or it is new (code may have moved there). */
function concernsNotes(f: FileOnDisk): boolean {
  if (f.kind === 'created') return true
  return notesFor(f.uri).length > 0 || notes().some((n) => n.data.target === 'folder' && f.uri.path.startsWith(pathUri(n).path))
}

/** Notes re-anchored, then followed into moved files. */
async function diskPass(events: WorkspaceEvents): Promise<void> {
  await reanchorAll()
  await followMovedFiles(events)
}

/** Notes whose file disappeared: their code looked for in the files made just now; found, the note moves there. */
export async function followMovedFiles(events: WorkspaceEvents): Promise<void> {
  const changed: string[] = []
  await notesModel().batch(async () => {
    for (const n of notes()) {
      if (n.data.target) { if (await checkTarget(n)) changed.push(n.data.id); continue }
      if (await exists(docUri(n))) continue
      const moved = nothingToMatch(n.data.anchor) ? undefined : await events.findMovedFile(
        (f) => !!f && f === n.folder,
        (lines) => { const r = findAnchor(lines, n.data.anchor, locOf(n.data.range)); return r.stale ? undefined : r.loc },
      )
      if (moved) await moveNoteTo(n, moved.uri, moved.found)
      else if (reanchor(n, undefined)) await store.save(n)
    }
    notesChanged({ kind: 'placed', ids: changed })
  })
}

/** A note follows its code into the file `uri`, at `loc`. */
async function moveNoteTo(n: Note, uri: vscode.Uri, loc: Loc): Promise<void> {
  const file = relPath(n.folder, uri)
  log.appendLine(`note ${n.data.id}: ${n.data.file} moved to ${file}`)
  n.data.file = file
  n.data.range = range1Of(loc)
  n.data.stale = false
  // A past-the-end state stays as it is: reanchorAll, which runs first, left none for a file that is gone.
  placement.found(n.data.id, true)
  await store.save(n)
}

/** Files or folders renamed in the editor: notes on them, or inside them, follow. */
async function followRenames(e: vscode.FileRenameEvent): Promise<void> {
  for (const { oldUri, newUri } of e.files) await followRename(oldUri, newUri)
  notesChanged({ kind: 'placed' })
}

/** A file or folder renamed in the editor: notes on it, or inside it, follow. */
export async function followRename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
  for (const n of notes()) {
    const old = pathUri(n).path
    if (old !== oldUri.path && !old.startsWith(oldUri.path + '/')) continue
    const folder = vscode.workspace.getWorkspaceFolder(newUri)
    if (!folder) continue
    n.data.file = relPath(folder, vscode.Uri.joinPath(newUri, old.slice(oldUri.path.length)))
    placement.found(n.data.id, true)
    await store.save(n)
  }
}
