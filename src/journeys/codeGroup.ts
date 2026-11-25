import * as vscode from 'vscode'
import { ownSelection } from '../codeLinks/claudeChatLinks'
import { shownOutside } from './codeColumn'
import { openDoc } from '../platform/documents'

// A step's code in the editor group beside the panel (the code group): where a file a step names is now, and showing
// it there. Used by code links (codeLinks.ts), the beat's line (beats.ts), value hints (valueHints.ts) and the podcast.

/** The file a step names, in the workspace folder `folder`, where it is now (`renames`: old path -> new path). */
export function stepFileUri(folder: vscode.Uri, renames: Map<string, string>, file: string): vscode.Uri {
  return vscode.Uri.joinPath(folder, renames.get(file) ?? file)
}

export interface ShowOptions {
  /** The keyboard stays where it is. */
  keepFocus: boolean
  /** A document on screen already is not shown again. */
  reuseVisible?: boolean
  /** Where the caret goes. */
  selection?: vscode.Selection
  /** How long the selection this makes is the extension's own (ownSelection's default when unset). */
  ownMs?: number
}

/**
 * The code group, one rule for every part that shows code: a file is shown in the editor that already shows it
 * (outside the map's group: a second editor on one file confuses its comment threads), else in `column()`. The
 * selection this makes is the extension's own (ownSelection), not the reader moving away.
 */
export class CodeGroup {
  constructor(
    private readonly column: () => vscode.ViewColumn | undefined,
    private readonly mapColumn: () => vscode.ViewColumn | undefined = () => undefined,
  ) {}

  /** The visible editor showing `uri`, outside the map's group. */
  private shown(uri: vscode.Uri): vscode.TextEditor | undefined {
    return shownOutside(vscode.window.visibleTextEditors, uri.toString(), this.mapColumn())
  }

  /** Where to show `uri`: the group of the editor showing it, else the code group. */
  columnFor(uri: vscode.Uri): vscode.ViewColumn | undefined {
    return this.shown(uri)?.viewColumn ?? this.column()
  }

  async show(target: vscode.TextDocument | vscode.Uri, o: ShowOptions): Promise<vscode.TextEditor> {
    const uri = target instanceof vscode.Uri ? target : target.uri
    const shown = this.shown(uri)
    ownSelection(o.ownMs)
    if (shown && o.reuseVisible) return shown
    const col = shown?.viewColumn ?? this.column()
    const options: vscode.TextDocumentShowOptions = {
      preview: true,
      preserveFocus: o.keepFocus,
      ...(col ? { viewColumn: col } : {}),
      ...(o.selection ? { selection: o.selection } : {}),
    }
    return target instanceof vscode.Uri ? showUri(target, options) : vscode.window.showTextDocument(target, options)
  }
}

/** How long to wait for the window to report the editor `vscode.open` made, before showing it the usual way. */
const OPENED_EDITOR_WAIT_MS = 1000

/**
 * Shows `uri` in one call into the window. showTextDocument with a file the extension host has not opened yet first
 * opens it (a round trip), then shows it (another); `vscode.open` does both in the window, and the editor and its
 * document reach the extension host with the window's own update.
 */
async function showUri(uri: vscode.Uri, options: vscode.TextDocumentShowOptions): Promise<vscode.TextEditor> {
  if (openDoc(uri)) return vscode.window.showTextDocument(uri, options)
  await vscode.commands.executeCommand('vscode.open', uri, options)
  return (await openedEditor(uri, options.viewColumn)) ?? vscode.window.showTextDocument(uri, options)
}

/** The visible editor showing `uri` (in `column` when given), now or once the window reports it; undefined: not seen. */
function openedEditor(uri: vscode.Uri, column: vscode.ViewColumn | undefined): Promise<vscode.TextEditor | undefined> {
  const find = () => {
    const eds = vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === uri.toString())
    return eds.find((e) => column === undefined || e.viewColumn === column) ?? eds[0]
  }
  const now = find()
  if (now) return Promise.resolve(now)
  return new Promise((resolve) => {
    const done = (ed: vscode.TextEditor | undefined) => { clearTimeout(t); sub.dispose(); resolve(ed) }
    const sub = vscode.window.onDidChangeVisibleTextEditors(() => { const ed = find(); if (ed) done(ed) })
    const t = setTimeout(() => done(undefined), OPENED_EDITOR_WAIT_MS)
  })
}

/** Shows a document in the code group whose column is `column()` (CodeGroup.show). */
export function showInCodeGroup(
  target: vscode.TextDocument | vscode.Uri, column: () => vscode.ViewColumn | undefined, o: ShowOptions,
): Promise<vscode.TextEditor> {
  return new CodeGroup(column).show(target, o)
}
