// A file's lines as the editor has them (an open document, unsaved edits included) or as they are on disk.
import * as vscode from 'vscode'
import { wfs } from './workspaceFs'

/** A document's lines, unsaved edits included. */
export function docLines(doc: vscode.TextDocument): string[] {
  return Array.from({ length: doc.lineCount }, (_, i) => doc.lineAt(i).text)
}

/** A file's lines: its open document's (unsaved edits count), else the disk's. Opens no document (a round trip). */
export async function fileLines(uri: vscode.Uri): Promise<string[] | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString() && !d.isClosed)
  if (open) return docLines(open)
  return diskLines(uri)
}

/** A file's lines on disk; undefined when it can't be read. */
export async function diskLines(uri: vscode.Uri): Promise<string[] | undefined> {
  try { return new TextDecoder().decode(await wfs.readFile(uri)).split(/\r?\n/) } catch { return undefined }
}

/** The open document of `uri`, if any (VS Code keeps closed or deleted files' documents around too). */
export function openDoc(uri: vscode.Uri): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())
}

/** A file's lines: an editor's with unsaved changes (they are the truth), else the disk's (a closed or deleted file's
 *  document may still be around: not used). */
export async function linesOfUri(uri: vscode.Uri): Promise<string[] | undefined> {
  const open = openDoc(uri)
  if (open && !open.isClosed && open.isDirty) return docLines(open)
  return diskLines(uri)
}

/** `uri`'s path relative to workspace folder `folder` (outside it: as VS Code shows it). */
export function relPath(folder: vscode.WorkspaceFolder, uri: vscode.Uri): string {
  const base = folder.uri.path.endsWith('/') ? folder.uri.path : folder.uri.path + '/'
  return uri.path.startsWith(base) ? uri.path.slice(base.length) : vscode.workspace.asRelativePath(uri, false)
}
