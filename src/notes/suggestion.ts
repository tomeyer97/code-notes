// An agent's ```suggestion block applied to the note's lines (the editor's Undo takes it back).

import * as vscode from 'vscode'
import { byId, showError, understanding } from '../app'
import { commitInfo } from '../identity'
import { refreshAll } from '../refresh'
import { captureAnchor, docUri, linesOf, missing, otherAnchor, pastEnd } from '../threads/anchoring'
import { lines, suggestionOf } from '../threads/comments'

/** Apply on an agent's ```suggestion block: replaces the note's lines; the editor's Undo takes it back. */
export async function applySuggestion(id: string, mi: number, k: number): Promise<boolean> {
  const n = byId(id)
  const text = n ? suggestionOf(n.data.messages[mi]?.body ?? '', k) : undefined
  if (!n || text === undefined) { vscode.window.setStatusBarMessage('$(info) That suggestion is gone', 3000); return false }
  if (n.data.target) { void showError('Code Notes: a suggestion needs a note on lines, not a whole file.'); return false }
  if (n.data.stale || missing.has(n.data.id) || pastEnd.has(n.data.id)) {
    void showError('Code Notes: the code changed since this suggestion, so it was not applied. Check it, then Keep Note Here and apply again.')
    return false
  }
  const doc = await vscode.workspace.openTextDocument(docUri(n))
  const start = n.data.range.start - 1, end = Math.min(n.data.range.end - 1, doc.lineCount - 1)
  // A note whose anchor was lost (an agent rewrote the file from an older copy): take it now, so Undo has the old code.
  if (!n.data.anchor.text && !n.data.anchor.before && !n.data.anchor.after) n.data.anchor = { ...captureAnchor(linesOf(doc), start, end), ...(await commitInfo(n.folder)) }
  const edit = new vscode.WorkspaceEdit()
  edit.replace(doc.uri, new vscode.Range(start, 0, end, doc.lineAt(end).text.length), text)
  if (!(await vscode.workspace.applyEdit(edit))) { void showError('Code Notes: the suggestion could not be applied.'); return false }
  // The note now covers the new lines (not stale: this is the change it asked for).
  const newEnd = start + text.split('\n').length - 1
  n.data.range = { start: start + 1, end: newEnd + 1 }
  otherAnchor.set(n.data.id, n.data.anchor)
  n.data.anchor = { ...captureAnchor(linesOf(doc), start, newEnd), ...(await commitInfo(n.folder)) }
  n.data.stale = false
  if (n.data.selection && !n.data.anchor.text.includes(n.data.selection.text)) delete n.data.selection
  const ed = await vscode.window.showTextDocument(doc, { preview: false })
  ed.selection = new vscode.Selection(start, 0, start, 0)
  refreshAll()
  vscode.window.setStatusBarMessage(`$(check) Applied to ${lines(n)}. Save to keep; Ctrl+Z undoes.`, 5000)
  // A fix suggested for a check's concern: the check offers it with Commit & push.
  const fixFor = (n.data.extra as { checkFix?: string } | undefined)?.checkFix
  if (fixFor) void understanding?.fixApplied(fixFor, n.data.file)
  return true
}
