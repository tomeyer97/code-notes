// The notes folder setting (moving the notes there) and keeping them out of git.

import * as vscode from 'vscode'
import { notesPorts, store } from './ports'
import { cfg } from '../platform/settings'
import { visibleNotes } from './visible'
import { showError } from '../platform/run'
import { log, stored } from '../platform/host'
import { notesChanged } from './model'
import { me } from './identity'
import { DEFAULT_FOLDER, folderName, readFolderSetting, writeGitignore, writeReadme } from './notesFolder'
import { plural } from '../core/text'
import { wfs } from '../platform/workspaceFs'
import { exists } from '../platform/exists'
import { hint } from './hint'
import { fireAndForget } from '../platform/run'
import { STATE_FAMILIES } from '../platform/state'

/** The notes folder as last set (a change offers to move the notes). */
let currentFolder = DEFAULT_FOLDER
export function rememberFolder(): void { currentFolder = folderName() }

/** The notes folder setting changed: offer to move the notes there, so they don't silently disappear. */
export async function changeFolder(): Promise<void> {
  const { refused } = readFolderSetting('folder', DEFAULT_FOLDER)
  if (refused) {
    const why = `the folder "${refused.set}" can't be used: ${refused.problem}. Using ${DEFAULT_FOLDER}.`
    fireAndForget(showError(why), 'folder: showError')
  }
  const from = currentFolder, to = folderName()
  currentFolder = to
  if (from === to) return
  for (const f of vscode.workspace.workspaceFolders ?? []) await offerMove(f, from, to)
  await store().load()
  await notesPorts().journeys.load()
  await rewriteReadmes()
  if (!visibleNotes().length) notesChanged({ kind: 'view', notice: `Reading notes from ${to}/` })
}

/** The note files of workspace folder `f` in its notes folder `dir` (none: not there). */
async function noteFiles(f: vscode.WorkspaceFolder, dir: string): Promise<string[]> {
  try {
    const entries = await wfs.readDirectory(vscode.Uri.joinPath(f.uri, dir))
    return entries.filter(([n, t]) => t === vscode.FileType.File && n.endsWith('.json') && !n.startsWith('.')).map(([n]) => n)
  } catch { return [] }
}

/** How long "Moved N notes" stays. */
const MOVED_MS = 4000

/** Workspace folder `f`'s notes in `from`/: moved to `to`/ if the person says so. */
async function offerMove(f: vscode.WorkspaceFolder, from: string, to: string): Promise<void> {
  const files = await noteFiles(f, from)
  if (!files.length) return
  const detail = `Cancel leaves them in ${from}/, where Code Notes no longer shows them.`
  const pick = await vscode.window.showWarningMessage(`Move ${plural(files.length, 'note')} from ${from}/ to ${to}/?`, { modal: true, detail }, 'Move Notes')
  if (pick !== 'Move Notes') return
  const left = await moveNotesFolder(f, files, from, to)
  await writeGitignore(f)
  if (!left.length) {
    hint(`Moved ${files.length} notes to ${to}/`, 'check', MOVED_MS)
    return
  }
  // Some stayed: say so, or they silently disappear from the list.
  const moved = files.length - left.length
  const why = `moved ${moved} of ${plural(files.length, 'note')} to ${to}/; ${left.length} stayed in ${from}/ (the log says why).`
  fireAndForget(showError(why), 'folder: showError')
}

/** The note `files` and the trash from `from`/ to `to`/; the old README and .gitignore go, so no agent writes into a
 *  dead folder, and so does `from`/ when nothing else is left in it. The note files that could not be moved. */
async function moveNotesFolder(f: vscode.WorkspaceFolder, files: string[], from: string, to: string): Promise<string[]> {
  const oldDir = vscode.Uri.joinPath(f.uri, from)
  const newDir = vscode.Uri.joinPath(f.uri, to)
  await wfs.createDirectory(newDir)
  const left: string[] = []
  for (const name of files) {
    try {
      await wfs.rename(vscode.Uri.joinPath(oldDir, name), vscode.Uri.joinPath(newDir, name), { overwrite: false })
    } catch (e) {
      log().warn(`moving the notes folder: ${from}/${name} stays (${e})`)
      left.push(name)
    }
  }
  // Each of these may fail as expected (none there, a trash already in `to`/, other files left): logged, not said.
  const skipped = (what: string) => (e: unknown) => log().info(`moving the notes folder: ${what} (${e})`)
  await wfs.rename(vscode.Uri.joinPath(oldDir, '.trash'), vscode.Uri.joinPath(newDir, '.trash'), { overwrite: false })
    .catch(skipped(`no trash moved from ${from}/`))
  // Not while notes are left in it: the README tells agents what the folder is.
  if (left.length) return left
  for (const name of ['README.md', '.gitignore']) {
    await wfs.remove(vscode.Uri.joinPath(oldDir, name)).catch(skipped(`no ${from}/${name} removed`))
  }
  const rest = await wfs.readDirectory(oldDir).catch(() => undefined)
  if (rest && !rest.length) await wfs.remove(oldDir).catch(skipped(`${from}/ kept`))
  else log().info(`moving the notes folder: ${from}/ kept (${rest ? 'other files in it' : 'not read'})`)
  return left
}

/** Each workspace folder with notes gets its notes folder's README (for agents) written again. */
export async function rewriteReadmes(): Promise<void> {
  for (const f of vscode.workspace.workspaceFolders ?? []) if (visibleNotes().some((n) => n.folder === f)) await writeReadme(f, me())
}

/** How long the git hint stays. */
const GIT_SAID_MS = 4000

/** The "keep notes out of git" setting changed: add or remove the notes folder's .gitignore now. */
export async function applyIgnoreInGit(): Promise<void> {
  const on = cfg().get<boolean>('ignoreInGit', true)
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    if (!(await exists(vscode.Uri.joinPath(f.uri, folderName())))) continue // no notes folder
    await writeGitignore(f) // shared through git: still not the trash
  }
  // Said once (no lasting status-bar item); after that it is in the notes item's tooltip.
  const said = STATE_FAMILIES.gitSaid(on)
  if (!stored().get(said)) {
    await stored().set(said, true)
    const dir = folderName()
    if (on) hint(`Notes in ${dir}/ are kept out of git`, 'eye-closed', GIT_SAID_MS)
    else hint(`Notes in ${dir}/ can now be committed`, 'git-commit', GIT_SAID_MS)
  }
  notesChanged({ kind: 'settings' })
}
