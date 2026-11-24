// The notes folder setting (moving the notes there) and keeping them out of git.

import * as vscode from 'vscode'
import { cfg, journeys, notes, showError, store, stored } from '../app'
import { notesChanged } from './model'
import { me } from './identity'
import { folderProblem } from '../core/format/noteModel'
import { DEFAULT_FOLDER, folderName, writeGitignore, writeReadme } from './notesFolder'
import { plural } from '../core/text'
import { wfs } from '../platform/workspaceFs'
import { fireAndForget } from '../platform/run'
import { STATE_FAMILIES } from '../platform/state'

/** The notes folder as last set (a change offers to move the notes). */
let currentFolder = DEFAULT_FOLDER
export function rememberFolder(): void { currentFolder = folderName() }

/** The notes folder setting changed: offer to move the notes there, so they don't silently disappear. */
export async function changeFolder(): Promise<void> {
  const raw = cfg().get<string>('folder') || DEFAULT_FOLDER
  const problem = folderProblem(raw)
  if (problem) fireAndForget(showError(`the folder "${raw}" can't be used: ${problem}. Using ${DEFAULT_FOLDER}.`), 'folder: showError')
  const from = currentFolder, to = folderName()
  currentFolder = to
  if (from === to) return
  for (const f of vscode.workspace.workspaceFolders ?? []) await offerMove(f, from, to)
  await store.load()
  await journeys.load()
  await rewriteReadmes()
  if (!notes().length) notesChanged({ kind: 'view', notice: `Reading notes from ${to}/` })
}

/** The note files of workspace folder `f` in its notes folder `dir` (none: not there). */
async function noteFiles(f: vscode.WorkspaceFolder, dir: string): Promise<string[]> {
  try {
    const entries = await wfs.readDirectory(vscode.Uri.joinPath(f.uri, dir))
    return entries.filter(([n, t]) => t === vscode.FileType.File && n.endsWith('.json') && !n.startsWith('.')).map(([n]) => n)
  } catch { return [] }
}

/** Workspace folder `f`'s notes in `from`/: moved to `to`/ if the person says so. */
async function offerMove(f: vscode.WorkspaceFolder, from: string, to: string): Promise<void> {
  const files = await noteFiles(f, from)
  if (!files.length) return
  const detail = `Cancel leaves them in ${from}/, where Code Notes no longer shows them.`
  const pick = await vscode.window.showWarningMessage(`Move ${plural(files.length, 'note')} from ${from}/ to ${to}/?`, { modal: true, detail }, 'Move Notes')
  if (pick !== 'Move Notes') return
  await moveNotesFolder(f, files, from, to)
  await writeGitignore(f)
  vscode.window.setStatusBarMessage(`$(check) Moved ${files.length} notes to ${to}/`, 4000)
}

/** The note `files` and the trash from `from`/ to `to`/; the old README and .gitignore go, so no agent writes into a
 *  dead folder, and so does `from`/ when nothing else is left in it. */
async function moveNotesFolder(f: vscode.WorkspaceFolder, files: string[], from: string, to: string): Promise<void> {
  const oldDir = vscode.Uri.joinPath(f.uri, from)
  const newDir = vscode.Uri.joinPath(f.uri, to)
  await wfs.createDirectory(newDir)
  for (const name of files) await wfs.rename(vscode.Uri.joinPath(oldDir, name), vscode.Uri.joinPath(newDir, name), { overwrite: false })
  try {
    await wfs.rename(vscode.Uri.joinPath(oldDir, '.trash'), vscode.Uri.joinPath(newDir, '.trash'), { overwrite: false })
  } catch { /* no trash */ }
  for (const name of ['README.md', '.gitignore']) {
    try { await wfs.remove(vscode.Uri.joinPath(oldDir, name)) } catch { /* none */ }
  }
  try {
    if (!(await wfs.readDirectory(oldDir)).length) await wfs.remove(oldDir)
  } catch { /* keep it */ }
}

/** Each workspace folder with notes gets its notes folder's README (for agents) written again. */
export async function rewriteReadmes(): Promise<void> {
  for (const f of vscode.workspace.workspaceFolders ?? []) if (notes().some((n) => n.folder === f)) await writeReadme(f, me())
}

/** The "keep notes out of git" setting changed: add or remove the notes folder's .gitignore now. */
export async function applyIgnoreInGit(): Promise<void> {
  const on = cfg().get<boolean>('ignoreInGit', true)
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    try { await wfs.stat(vscode.Uri.joinPath(f.uri, folderName())) } catch { continue }
    await writeGitignore(f) // shared through git: still not the trash
  }
  // Said once (no lasting status-bar item); after that it is in the notes item's tooltip.
  const said = STATE_FAMILIES.gitSaid(on)
  if (!stored.get(said)) {
    await stored.set(said, true)
    vscode.window.setStatusBarMessage(on ? `$(eye-closed) Notes in ${folderName()}/ are kept out of git` : `$(git-commit) Notes in ${folderName()}/ can now be committed`, 4000)
  }
  notesChanged({ kind: 'settings' })
}
