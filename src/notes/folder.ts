// The notes folder setting (moving the notes there) and keeping them out of git; a prompt for an agent.

import * as vscode from 'vscode'
import { cfg, gstate, journeys, notes, showError, store } from '../app'
import { me } from '../identity'
import { refreshAll } from '../refresh'
import { treeView } from '../sidebar/notesTree'
import { folderProblem } from '../noteModel'
import { folderName, Note } from '../store'
import { lines } from '../threads/comments'
import { wfs } from '../wfs'

/** The notes folder as last set (a change offers to move the notes). */
let currentFolder = '.code-notes'
export function rememberFolder(): void { currentFolder = folderName() }

/** The notes folder setting changed: offer to move the notes there, so they don't silently disappear. */
export async function changeFolder(): Promise<void> {
  const raw = cfg().get<string>('folder') || '.code-notes'
  const problem = folderProblem(raw)
  if (problem) void showError(`Code Notes: the folder "${raw}" can't be used: ${problem}. Using .code-notes.`)
  const from = currentFolder, to = folderName()
  currentFolder = to
  if (from === to) return
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    const oldDir = vscode.Uri.joinPath(f.uri, from)
    let files: [string, vscode.FileType][] = []
    try { files = (await wfs.readDirectory(oldDir)).filter(([n, t]) => t === vscode.FileType.File && n.endsWith('.json') && !n.startsWith('.')) } catch { continue }
    if (!files.length) continue
    const pick = await vscode.window.showWarningMessage(`Move ${files.length} note${files.length === 1 ? '' : 's'} from ${from}/ to ${to}/?`,
      { modal: true, detail: `Cancel leaves them in ${from}/, where Code Notes no longer shows them.` }, 'Move Notes')
    if (pick !== 'Move Notes') continue
    const newDir = vscode.Uri.joinPath(f.uri, to)
    await wfs.createDirectory(newDir)
    for (const [name] of files) await wfs.rename(vscode.Uri.joinPath(oldDir, name), vscode.Uri.joinPath(newDir, name), { overwrite: false })
    // The trash moves too; the old README and.gitignore go, so no agent writes into a dead folder.
    try { await wfs.rename(vscode.Uri.joinPath(oldDir, '.trash'), vscode.Uri.joinPath(newDir, '.trash'), { overwrite: false }) } catch { /* none */ }
    for (const name of ['README.md', '.gitignore']) try { await wfs.delete(vscode.Uri.joinPath(oldDir, name)) } catch { /* none */ }
    try { if (!(await wfs.readDirectory(oldDir)).length) await wfs.delete(oldDir) } catch { /* keep */ }
    await store.writeGitignore(f)
    vscode.window.setStatusBarMessage(`$(check) Moved ${files.length} notes to ${to}/`, 4000)
  }
  await store.load()
  await journeys.load()
  for (const f of vscode.workspace.workspaceFolders ?? []) if (notes().some((n) => n.folder === f)) await store.writeReadme(f)
  if (!notes().length) treeView.message = `Reading notes from ${to}/`
}

/** The "keep notes out of git" setting changed: add or remove the notes folder's.gitignore now. */
export async function applyIgnoreInGit(): Promise<void> {
  const on = cfg().get<boolean>('ignoreInGit', true)
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    try { await wfs.stat(vscode.Uri.joinPath(f.uri, folderName())) } catch { continue }
    await store.writeGitignore(f) // shared through git: still not the trash
  }
  // Said once (no lasting status-bar item); after that it is in the notes item's tooltip.
  const k = `codeNotes.gitSaid.${on}`
  if (!gstate.get<boolean>(k)) {
    await gstate.update(k, true)
    vscode.window.setStatusBarMessage(on ? `$(eye-closed) Notes in ${folderName()}/ are kept out of git` : `$(git-commit) Notes in ${folderName()}/ can now be committed`, 4000)
  }
  refreshAll()
}

export function agentPrompt(list?: Note[]): string {
  const dir = folderName()
  // No frozen timestamp: a prompt pasted an hour later must not date replies in the past.
  const rules = `Format and rules: ${dir}/README.md. I'm ${me()}. Use the current time for "at". If a note is "stale", the code changed: "anchor.text" is what it was about. Answer in the note; don't change code unless a note asks you to.`
  if (list?.length) {
    const which = list.map((n) => `${dir}/${n.uri.path.split('/').pop()} (${n.data.file} ${lines(n)})`).join(', ')
    return `Answer ${list.length === 1 ? 'my code note' : `these ${list.length} code notes`}: ${which}. Read the code each one points at, then append your answer to "messages" with "role": "agent". ${rules}`
  }
  return `Answer my open code notes in ${dir}/: a note needs an answer when its status is "open" and its last message has "role": "human". Read the code each one points at, then append your answer to "messages" with "role": "agent". ${rules}`
}
