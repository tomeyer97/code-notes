// context.get: what the reader has in front of them. The selected text only when asked (file contents never go out
// unless a request asks for them).
import * as vscode from 'vscode'
import type { BridgePosition, ContextGetParams, EditorContext } from '../protocol/bridge'
import { inWorkspace } from './files'

const position = (p: vscode.Position): BridgePosition => ({ line: p.line + 1, column: p.character + 1 })

export function editorContext(p: ContextGetParams): EditorContext {
  const ed = vscode.window.activeTextEditor
  if (!ed || ed.document.uri.scheme !== 'file') return { file: null }
  const { relative, folder } = inWorkspace(ed.document.uri)
  const visible = ed.visibleRanges
  const s = ed.selection
  return {
    file: { relative, absolute: ed.document.uri.fsPath, folder },
    languageId: ed.document.languageId,
    ...(visible.length ? { visible: { start: visible[0].start.line + 1, end: visible[visible.length - 1].end.line + 1 } } : {}),
    selection: {
      start: position(s.start), end: position(s.end),
      ...(p.selectionText ? { text: ed.document.getText(s) } : {}),
    },
  }
}
