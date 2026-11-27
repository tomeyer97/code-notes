// Note files that can't be used (not valid JSON, a field wrong): opened at what is wrong, or their last good version
// written back.

import * as vscode from 'vscode'
import { store } from './ports'
import { serialize } from '../core/format/noteModel'
import { BrokenRow, isRow } from './model/rows'
import { writeAtomic } from './store'
import { brokenOffset } from './brokenAt'
import { hint } from './hint'

/** How long the reason a file can't be read stays in the status bar. */
const WHY_MS = 6000

/** codeNotes.openBroken: the file, at the field that is wrong. */
export const openBroken = async (node?: unknown) => {
  if (!isRow<BrokenRow>(node, 'broken')) return
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(node.uri))
  const pos = doc.positionAt(brokenOffset(doc.getText()))
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) })
  hint(node.why, 'warning', WHY_MS)
}

/** codeNotes.restoreBroken: the last version read that was good, written back (in one step, as every note save). */
export const restoreBroken = async (node?: unknown) => {
  if (!isRow<BrokenRow>(node, 'broken')) return
  const known = store().atUri(node.uri)
  if (!known) return
  await writeAtomic(known.uri, serialize(known.data))
  hint('Restored the last good version', 'check')
}
