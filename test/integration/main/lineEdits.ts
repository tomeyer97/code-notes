// Code moved under a test: lines inserted at the top of a document, or its first lines deleted, as an unsaved edit
// (what typing does). Shared by the tests that check that something follows the code.
import * as vscode from 'vscode'

/** Inserts `text` at the top of the document `uri`, or deletes its first `deleteLines` lines (unsaved). */
export async function shiftLines(uri: vscode.Uri, change: { insert: string } | { deleteLines: number }): Promise<void> {
  const edit = new vscode.WorkspaceEdit()
  if ('insert' in change) edit.insert(uri, new vscode.Position(0, 0), change.insert)
  else edit.delete(uri, new vscode.Range(0, 0, change.deleteLines, 0))
  await vscode.workspace.applyEdit(edit)
}
