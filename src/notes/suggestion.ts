// An agent's ```suggestion block applied to the note's lines (the editor's Undo takes it back).

import * as vscode from 'vscode'
import { byId, showError, understanding } from '../app'
import { refreshAll } from '../refresh'
import { anchorAt, docUri, missing, noAnchor, otherAnchor, pastEnd } from './location'
import { rangeLabel } from '../core/text'
import { suggestionOf } from '../threads/comments'
import { docLines } from '../platform/documents'
import { fireAndForget } from '../platform/run'

/** Apply on an agent's ```suggestion block: replaces the note's lines; the editor's Undo takes it back. */
export async function applySuggestion(id: string, mi: number, k: number): Promise<boolean> {
  const n = byId(id)
  const text = n ? suggestionOf(n.data.messages[mi]?.body ?? '', k) : undefined
  if (!n || text === undefined) { vscode.window.setStatusBarMessage('$(info) That suggestion is gone', 3000); return false }
  if (n.data.target) { fireAndForget(showError('a suggestion needs a note on lines, not a whole file.'), 'suggestion: showError'); return false }
  if (n.data.stale || missing.has(n.data.id) || pastEnd.has(n.data.id)) {
    fireAndForget(showError('the code changed since this suggestion, so it was not applied. Check it, then Keep Note Here and apply again.'), 'suggestion: showError')
    return false
  }
  const doc = await vscode.workspace.openTextDocument(docUri(n))
  const start = n.data.range.start - 1, end = Math.min(n.data.range.end - 1, doc.lineCount - 1)
  // A note whose anchor was lost (an agent rewrote the file from an older copy): take it now, so Undo has the old code.
  if (noAnchor(n.data.anchor)) n.data.anchor = await anchorAt(docLines(doc), start, end, n.folder)
  const edit = new vscode.WorkspaceEdit()
  edit.replace(doc.uri, new vscode.Range(start, 0, end, doc.lineAt(end).text.length), text)
  if (!(await vscode.workspace.applyEdit(edit))) { fireAndForget(showError('the suggestion could not be applied.'), 'suggestion: showError'); return false }
  // The note now covers the new lines (not stale: this is the change it asked for).
  const newEnd = start + text.split('\n').length - 1
  n.data.range = { start: start + 1, end: newEnd + 1 }
  otherAnchor.set(n.data.id, n.data.anchor)
  n.data.anchor = await anchorAt(docLines(doc), start, newEnd, n.folder)
  // Not missing or past the end: checked above.
  n.data.stale = false
  if (n.data.selection && !n.data.anchor.text.includes(n.data.selection.text)) delete n.data.selection
  const ed = await vscode.window.showTextDocument(doc, { preview: false })
  ed.selection = new vscode.Selection(start, 0, start, 0)
  refreshAll()
  vscode.window.setStatusBarMessage(`$(check) Applied to ${rangeLabel(n)}. Save to keep; Ctrl+Z undoes.`, 5000)
  // A fix suggested for a check's concern: the check offers it with Commit & push.
  const fixFor = (n.data.extra as { checkFix?: string } | undefined)?.checkFix
  if (fixFor) fireAndForget(understanding?.fixApplied(fixFor, n.data.file), 'suggestion: understanding?.fixApplied')
  return true
}
