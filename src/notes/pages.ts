// The read-only pages Code Notes opens where there is no file to show: a folder note's page (its thread lives there)
// and the page of a note whose file is gone.

import * as vscode from 'vscode'
import { byId } from '../app'
import { Note } from '../store'
import { plain, rangeLabel } from '../text'
import { wfs } from '../workspaceFs'
import { baseName } from '../paths'

/** A folder note's thread lives on a read-only page about the folder (there is no document to put it on). */
const FOLDER_SCHEME = 'code-notes-folder'

/** A note whose file is gone, as a read-only document (never an unsaved Untitled buffer:). */
const ORPHAN_SCHEME = 'code-notes-note'

/** The page of folder `file` in this workspace folder. */
export function folderPage(folder: vscode.WorkspaceFolder, file: string): vscode.Uri {
  return vscode.Uri.from({ scheme: FOLDER_SCHEME, path: `/${file} (folder)`, query: folder.uri.toString() })
}

/** The page of a note whose file is gone. */
export function orphanPage(n: Note): vscode.Uri {
  return vscode.Uri.from({ scheme: ORPHAN_SCHEME, path: `/${baseName(n.data.file)} (note).md`, query: n.data.id })
}

const isDir = (t: vscode.FileType) => t & vscode.FileType.Directory

/** Folders before files, then by name. */
const dirsFirst = (a: [string, vscode.FileType], b: [string, vscode.FileType]) => isDir(b[1]) - isDir(a[1]) || a[0].localeCompare(b[0])

/** A folder page: the folder and what is in it. */
async function folderText(uri: vscode.Uri): Promise<string> {
  const rel = uri.path.replace(/^\//, '').replace(/ \(folder\)$/, '')
  const dir = vscode.Uri.joinPath(vscode.Uri.parse(uri.query), rel)
  let entries: [string, vscode.FileType][] = []
  try { entries = await wfs.readDirectory(dir) } catch { return `${rel}/ (not found)\n` }
  entries.sort(dirsFirst)
  return `${rel}/\n${entries.map(([name, t]) => `  ${name}${isDir(t) ? '/' : ''}`).join('\n')}\n`
}

/** A gone file's note page: its question, the code it was about, the conversation. */
function orphanMarkdown(n: Note): string {
  const code = n.data.anchor.text.trim() ? ['It was about:', '', '```', n.data.anchor.text, '```', ''] : []
  const messages = n.data.messages.flatMap((m) => [`**${m.author}** ${m.at ? m.at.slice(0, 16).replace('T', ' ') : ''}`, '', m.body, ''])
  return [
    `# ${plain(n.data.messages[0]?.body ?? 'Note', 80)}`, '',
    `_${n.data.file} ${rangeLabel(n)} no longer exists._`, '',
    ...code,
    ...messages,
  ].join('\n')
}

/** Both pages' providers. */
export function registerPages(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(FOLDER_SCHEME, { provideTextDocumentContent: folderText }),
    vscode.workspace.registerTextDocumentContentProvider(ORPHAN_SCHEME, {
      provideTextDocumentContent: (uri) => {
        const n = byId(uri.query)
        return n ? orphanMarkdown(n) : 'This note no longer exists.'
      },
    }),
  )
}
