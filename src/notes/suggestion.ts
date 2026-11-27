// An agent's ```suggestion block applied to the note's lines (the editor's Undo takes it back), recorded on its message.

import * as vscode from 'vscode'
import { notesPorts, store } from './ports'
import { byId } from './visible'
import { showError } from '../platform/run'
import { anchorAt, docUri, neverAnchored, placement } from './location'
import { notesChanged } from './model'
import { Note } from './store'
import { rangeLabel } from '../core/text'
import { suggestionOf } from '../threads/comments'
import { appliedOf, withApplied } from '../threads/text'
import { docLines } from '../platform/documents'
import { fireAndForget } from '../platform/run'
import { alternateAnchor } from './alternateAnchor'
import { placeAt } from './place'
import { hint } from './hint'
import { me } from './identity'

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
  const m = n?.data.messages[mi]
  const text = m ? suggestionOf(m.body, k) : undefined
  if (!n || !m || text === undefined) { hint('That suggestion is gone'); return false }
  // Applied once: a second click would put it in again over the code it already is.
  const done = appliedOf(m.extra, k)
  if (done) { hint(`Already applied by ${done.by}`); return false }
  const why = cannotApply(n)
  if (why) { fireAndForget(showError(why), 'suggestion: showError'); return false }
  const doc = await vscode.workspace.openTextDocument(docUri(n))
  const start = n.data.range.start - 1, end = Math.min(n.data.range.end - 1, doc.lineCount - 1)
  // A note whose anchor was lost (an agent rewrote the file from an older copy): take it now, so Undo has the old code.
  if (neverAnchored(n.data.anchor)) n.data.anchor = await anchorAt(docLines(doc), start, end, n.folder)
  // Recorded before the edit: saved then, the note file still has the lines on disk (the new ones are saved with the code).
  const extra = m.extra
  m.extra = withApplied(extra, { suggestion: k, by: me(), at: new Date().toISOString() })
  await store().save(n)
  const edit = new vscode.WorkspaceEdit()
  edit.replace(doc.uri, new vscode.Range(start, 0, end, doc.lineAt(end).text.length), text)
  if (!(await vscode.workspace.applyEdit(edit))) {
    m.extra = extra
    await store().save(n)
    notesChanged({ kind: 'placed', ids: [n.data.id] })
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
