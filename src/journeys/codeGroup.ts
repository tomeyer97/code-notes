import * as vscode from 'vscode'
import { ownSelection } from '../claudeChatLinks'

// A step's code in the editor group beside the panel (the code group): where a file a step names is now, and showing
// it there. Used by code links (codeLinks.ts), the beat's line (beats.ts) and value hints (valueHints.ts).

/** The file a step names, in the workspace folder `folder`, where it is now (`renames`: old path -> new path). */
export function stepFileUri(folder: vscode.Uri, renames: Map<string, string>, file: string): vscode.Uri {
  return vscode.Uri.joinPath(folder, renames.get(file) ?? file)
}

/**
 * Shows a document in the code group: the group it is visible in, else `column()`. The selection this makes is the
 * extension's own (ownSelection), not the reader moving away. `keepFocus`: the keyboard stays where it is;
 * `reuseVisible`: a document on screen already is not shown again; `selection`: where the caret goes.
 */
export async function showInCodeGroup(
  target: vscode.TextDocument | vscode.Uri, column: () => vscode.ViewColumn | undefined,
  o: { keepFocus: boolean; reuseVisible?: boolean; selection?: vscode.Selection },
): Promise<vscode.TextEditor> {
  const uri = (target instanceof vscode.Uri ? target : target.uri).toString()
  const shown = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri)
  ownSelection()
  if (shown && o.reuseVisible) return shown
  const col = shown?.viewColumn ?? column()
  const options: vscode.TextDocumentShowOptions = {
    preview: true,
    preserveFocus: o.keepFocus,
    ...(col ? { viewColumn: col } : {}),
    ...(o.selection ? { selection: o.selection } : {}),
  }
  return target instanceof vscode.Uri ? vscode.window.showTextDocument(target, options) : vscode.window.showTextDocument(target, options)
}
