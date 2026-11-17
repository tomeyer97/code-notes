// The main suite's window: the workspace run.ts made (src/app.ts and nothing else at first), the extension's test API,
// and short ways to read its state. Every test file of the main suite imports these; suite.ts fills `ctx` once.
import * as vscode from 'vscode'
import * as path from 'path'
import { waiter } from '../helpers'

/* eslint-disable @typescript-eslint/no-explicit-any */
export const ctx = {
  /** The extension's test API (src/extension.ts: what `activate` returns). */
  api: undefined as any,
  folder: undefined as unknown as vscode.WorkspaceFolder,
  /** The workspace folder on disk. */
  ws: '',
  /** <ws>/.code-notes */
  notesDir: '',
}

/** The main suite's wait (6 s by default): on a timeout it prints the tour's state (most waits are on it). */
export const until = waiter({ dump: () => { try { const t = ctx.api?.snapshot().tour; return t && { ...t, story: undefined } } catch { return undefined } } })

/** Everything the extension shows, as data (notes, journeys, the tour, counts). */
export const snap = () => ctx.api.snapshot()
/** The tour/journey panel's state: the walk, the step card, the map, the tutorial. */
export const tour = () => snap().tour
export const noteById = (id: string): any => snap().notes.find((n: any) => n.id === id)
export const noteAtPath = (p: string): any => snap().notes.find((n: any) => n.path === p)
export const journeyById = (id: string): any => snap().journeys.find((j: any) => j.id === id)
/** The Notes view, one line per row. */
export const notesTree = (): string[] => snap().tree()
/** The Journeys view, one line per row. */
export const journeysTree = (): string[] => ctx.api.journeysTree()

export const wsPath = (...p: string[]) => path.join(ctx.ws, ...p)
export const notePath = (id: string) => path.join(ctx.notesDir, `${id}.json`)
/** The personal journeys folder, <ws>/.code-notes/journeys. */
export const journeysDir = () => path.join(ctx.notesDir, 'journeys')

/** Where the active editor is: "src/flow.ts:2" (1-based), '' with none. */
export const at = () => { const e = vscode.window.activeTextEditor; return e ? `${path.relative(ctx.ws, e.document.uri.fsPath)}:${e.selection.active.line + 1}` : '' }

/** Puts the caret at the start of `line` (0-based) in `editor`. */
export const caretAt = (editor: vscode.TextEditor, line: number) => { editor.selection = new vscode.Selection(line, 0, line, 0) }

/** The workspace setting codeNotes.<key> (undefined removes it). */
export const setting = (key: string, value: unknown) => vscode.workspace.getConfiguration('codeNotes').update(key, value, vscode.ConfigurationTarget.Workspace)

/** A thread's first comment as markdown. */
export const bodyOf = (c: vscode.Comment) => (c.body as vscode.MarkdownString).value

export const closeAllEditors = () => vscode.commands.executeCommand('workbench.action.closeAllEditors')

/** Is a text tab whose path matches `re` open in any group? */
export const tabOpen = (re: RegExp) => vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputText && re.test(t.input.uri.path)))

/** The CodeLenses VS Code gets for `uri`, as "line:title" (line 1-based). */
export async function lenses(uri: vscode.Uri): Promise<string[]> {
  return ((await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri)) as vscode.CodeLens[]).map((l) => `${l.range.start.line + 1}:${l.command?.title ?? ''}`)
}
