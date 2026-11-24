// Edits the check makes in the code's files (a TODO comment): where in a document, and the edit itself.
import * as vscode from 'vscode'

/** Line index `line` (0-based) kept inside a document of `lineCount` lines. */
export const clampLine = (doc: { lineCount: number }, line: number): number => Math.min(doc.lineCount - 1, Math.max(0, line))

/** `lines` inserted above line `line` (0-based) of `doc`, which is then saved; false when the edit was refused. */
export async function insertLinesAbove(doc: vscode.TextDocument, line: number, lines: string[]): Promise<boolean> {
  const edit = new vscode.WorkspaceEdit()
  edit.insert(doc.uri, new vscode.Position(line, 0), lines.map((l) => `${l}\n`).join(''))
  if (!(await vscode.workspace.applyEdit(edit))) return false
  await doc.save()
  return true
}
