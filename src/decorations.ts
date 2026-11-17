import * as vscode from 'vscode'

// Decorations go to the window as a message per editor and type, each time they are set, also when they are the same
// as before (over Remote-SSH: over the network). Every visible-editors change repaints what several parts of the
// extension draw, mostly nothing on most editors: only a change is sent. After an edit of the document everything is
// sent again (the window moves decorations with the text; the extension's lines may say otherwise).

const sent = new WeakMap<vscode.TextEditor, Map<vscode.TextEditorDecorationType, { version: number; sig: string }>>()

/** editor.setDecorations, unless this editor already shows exactly these (an editor shown anew starts with none). */
export function setDecorations(e: vscode.TextEditor, type: vscode.TextEditorDecorationType, ranges: readonly vscode.Range[] | readonly vscode.DecorationOptions[]): void {
  let m = sent.get(e)
  if (!m) sent.set(e, (m = new Map()))
  const sig = ranges.length ? JSON.stringify(ranges) : ''
  const was = m.get(type)
  if (was ? was.version === e.document.version && was.sig === sig : !sig) return
  m.set(type, { version: e.document.version, sig })
  e.setDecorations(type, ranges as vscode.Range[])
}
