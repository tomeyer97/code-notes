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
