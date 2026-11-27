// An agent's ```suggestion block applied to the note's lines (the editor's Undo takes it back).

import * as vscode from 'vscode'
import { notesPorts } from './ports'
import { byId } from './visible'
import { showError } from '../platform/run'
import { anchorAt, docUri, neverAnchored, placement } from './location'
import { notesChanged } from './model'
import { Note } from './store'
import { rangeLabel } from '../core/text'
import { suggestionOf } from '../threads/comments'
import { docLines } from '../platform/documents'
import { fireAndForget } from '../platform/run'
import { alternateAnchor } from './alternateAnchor'
import { placeAt } from './place'
import { hint } from './hint'

/** How long "Applied … Save to keep" stays in the status bar. */
const APPLIED_MS = 5000

/** The concern of an understanding check a suggestion fixes: `extra.checkFix`, written by the check with the note. */
export function checkFixOf(n: Note): string | undefined {
  const v = n.data.extra?.checkFix
  return typeof v === 'string' ? v : undefined
}

/** Why the suggestion can't be applied to the note's lines now, or undefined. */
function cannotApply(n: Note): string | undefined {
  if (n.data.target) return 'a suggestion needs a note on lines, not a whole file.'
  if (n.data.stale || placement.missing(n.data.id) || placement.pastEnd(n.data.id) !== undefined) {
    return 'the code changed since this suggestion, so it was not applied. Check it, then Keep Note Here and apply again.'
  }
  return undefined
}

/** Apply on an agent's ```suggestion block: replaces the note's lines; the editor's Undo takes it back. */
export async function applySuggestion(id: string, mi: number, k: number): Promise<boolean> {
  const n = byId(id)
  const text = n ? suggestionOf(n.data.messages[mi]?.body ?? '', k) : undefined
  if (!n || text === undefined) { hint('That suggestion is gone'); return false }
  const why = cannotApply(n)
  if (why) { fireAndForget(showError(why), 'suggestion: showError'); return false }
  const doc = await vscode.workspace.openTextDocument(docUri(n))
  const start = n.data.range.start - 1, end = Math.min(n.data.range.end - 1, doc.lineCount - 1)
  // A note whose anchor was lost (an agent rewrote the file from an older copy): take it now, so Undo has the old code.
  if (neverAnchored(n.data.anchor)) n.data.anchor = await anchorAt(docLines(doc), start, end, n.folder)
  const edit = new vscode.WorkspaceEdit()
  edit.replace(doc.uri, new vscode.Range(start, 0, end, doc.lineAt(end).text.length), text)
  if (!(await vscode.workspace.applyEdit(edit))) {
    fireAndForget(showError('the suggestion could not be applied.'), 'suggestion: showError')
    return false
  }
  // The note now covers the new lines (not stale: this is the change it asked for); the code before is its alternate
  // anchor, so Ctrl+Z finds it again.
  alternateAnchor.set(n.data.id, n.data.anchor)
  await placeAt(n, doc, { start, end: start + text.split('\n').length - 1 }, n.folder, 'keep')
  const ed = await vscode.window.showTextDocument(doc, { preview: false })
  ed.selection = new vscode.Selection(start, 0, start, 0)
  notesChanged({ kind: 'placed', ids: [n.data.id] })
  hint(`Applied to ${rangeLabel(n)}. Save to keep; Ctrl+Z undoes.`, 'check', APPLIED_MS)
  // A fix suggested for a check's concern: the check offers it with Commit & push.
  const fixFor = checkFixOf(n)
  if (fixFor) fireAndForget(notesPorts().fixApplied(fixFor, n.data.file), 'suggestion: fixApplied')
  return true
}
