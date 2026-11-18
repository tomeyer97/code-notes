// Note files that can't be used (not valid JSON, a field wrong): opened at what is wrong, or their last good version
// written back.

import * as vscode from 'vscode'
import { store } from '../app'
import { serialize } from '../noteModel'
import { Node } from '../sidebar/nodes'
import { wfs } from '../workspaceFs'

/** Where in the file the problem `why` (store.ts's words) is: a field's name, the end (bad JSON), or the top. */
function problemAt(doc: vscode.TextDocument, why: string): vscode.Position {
  const field = /"(range|status|messages|file)/.exec(why)?.[1] ?? (/^message \d/.test(why) ? 'messages' : undefined)
  const text = doc.getText()
  const at = field ? text.indexOf(`"${field}"`) : why.startsWith('not valid JSON') ? text.length : -1
  return at >= 0 ? doc.positionAt(at) : new vscode.Position(0, 0)
}

/** codeNotes.openBroken: the file, at the field that is wrong. */
export const openBroken = async (node?: Node) => {
  if (node?.kind !== 'broken') return
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(node.uri))
  const pos = problemAt(doc, node.why)
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) })
  vscode.window.setStatusBarMessage(`$(warning) ${node.why}`, 6000)
}

/** codeNotes.restoreBroken: the last version read that was good, written back. */
export const restoreBroken = async (node?: Node) => {
  if (node?.kind !== 'broken') return
  const known = store.notes.get(node.uri)
  if (!known) return
  await wfs.writeFile(known.uri, new TextEncoder().encode(serialize(known.data)))
  vscode.window.setStatusBarMessage('$(check) Restored the last good version', 3000)
}
