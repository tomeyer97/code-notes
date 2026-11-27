// A request's `file`: an absolute path, or a path relative to one of the window's folders (the first that has it).
import * as path from 'path'
import * as vscode from 'vscode'
import { exists } from '../platform/exists'

/** The file a request names, when it is there. */
export async function resolveFile(file: string): Promise<vscode.Uri | undefined> {
  if (path.isAbsolute(file)) {
    const uri = vscode.Uri.file(file)
    return (await exists(uri)) ? uri : undefined
  }
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    const uri = vscode.Uri.joinPath(f.uri, file.replace(/\\/g, '/'))
    if (await exists(uri)) return uri
  }
  return undefined
}

/** `uri` relative to its workspace folder (forward slashes), and that folder's path; nulls outside the folders. */
export function inWorkspace(uri: vscode.Uri): { relative: string | null; folder: string | null } {
  const folder = vscode.workspace.getWorkspaceFolder(uri)
  if (!folder) return { relative: null, folder: null }
  return { relative: path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/'), folder: folder.uri.fsPath }
}
