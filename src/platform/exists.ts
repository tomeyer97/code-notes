// Whether a file is there, with "not found" the expected answer and any other failure logged, not taken for it.
import * as vscode from 'vscode'
import { report } from './run'
import { wfs } from './workspaceFs'

/** `e` says the file is not there (workspaceFs turns Node's ENOENT into FileNotFound). */
export const notFound = (e: unknown) =>
  (e instanceof vscode.FileSystemError && e.code === 'FileNotFound') || (e as NodeJS.ErrnoException)?.code === 'ENOENT'

/** The file's stat; undefined when it is not there. Another failure (no permission, …) is logged and counts as not
 *  there too: what to do next is the same. */
export async function statOf(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
  try { return await wfs.stat(uri) } catch (e) {
    if (!notFound(e)) report(e, { what: `stat ${uri.fsPath}` })
    return undefined
  }
}

export const exists = async (uri: vscode.Uri) => !!(await statOf(uri))

/** A folder (false when it is missing). */
export const isFolder = async (uri: vscode.Uri) => !!(((await statOf(uri))?.type ?? 0) & vscode.FileType.Directory)
