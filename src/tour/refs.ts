// References from a step card: opened as a peek under the card, or in a tab with "← Back to step n" above them; and
// the read-only pages they may open (a step whose file is gone, a copy of the step's own file).

import * as vscode from 'vscode'
import { showError } from '../app'
import { setDecorations } from '../decorations'
import { fileOf, LoadedJourney } from '../journeys/steps'
import { clampLines } from '../threads/anchoring'
import { wfs } from '../wfs'
import { cardLine } from './stepPlace'
import { card, tourState, walk } from './instances'

/** A read-only copy of a file (its text now, unsaved edits included), peeked for a ref into the step's own file. */
const REF_SCHEME = 'code-notes-ref'

/** A fresh copy per peek (the fragment): VS Code keeps a virtual document's text once read. */
const refCopyUri = (uri: vscode.Uri) => uri.with({ scheme: REF_SCHEME, query: uri.scheme, fragment: String(Date.now()) })

async function refCopy(uri: vscode.Uri): Promise<string> {
  const real = uri.with({ scheme: uri.query || 'file', query: '', fragment: '' })
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === real.toString())
  if (open) return open.getText()
  try { return new TextDecoder().decode(await wfs.readFile(real)) } catch { return '' }
}

/** The page shown for a step whose file doesn't exist. */
export const STEP_SCHEME = 'code-notes-step'

const stepPage = (file: string) => `⚠ ${file} doesn't exist any more (moved or deleted). The step is below; its code can't be shown.\n`

/** The read-only pages: a step whose file is gone, and a copy of a file peeked from its own step. */
export function registerRefPages(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(STEP_SCHEME, { provideTextDocumentContent: (uri) => stepPage(uri.query) }))
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(REF_SCHEME, { provideTextDocumentContent: refCopy }))
}

/**
 * A reference from step n's card: lines `line`-`end` of `file`, lit. With the step's editor on screen, a peek right
 * under the card; else a tab with "← Back to step n" above the lines.
 */
export async function openRef(lj: LoadedJourney, file: string, line: number, end: number, n: number): Promise<void> {
  tourState.lastPeek = undefined
  const uri = vscode.Uri.joinPath(lj.folder.uri, file)
  try { await wfs.stat(uri) } catch {
    void showError(`Code Notes: ${file} doesn't exist in this folder.`)
    return
  }
  const stepUri = vscode.Uri.joinPath(lj.folder.uri, fileOf(lj, n))
  const stepEditor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === stepUri.toString())
  if (stepEditor && !tourState.fileGone) await peekRefUnderCard(lj, n, stepEditor, stepUri, uri, line, end)
  else await openRefInTab(lj, n, stepEditor, uri, line, end)
}

/**
 * The inline card lives in the step's tab: a ref opens as a peek right under the card, so the tab, the code and the
 * card stay. Esc closes it. A ref into the step's own file peeks a read-only copy (REF_SCHEME): a peek of the file
 * itself embeds a second editor on it, with its own copy of the card's thread, and closing that peek collapsed the
 * card in the step's editor too.
 */
async function peekRefUnderCard(
  lj: LoadedJourney, n: number, stepEditor: vscode.TextEditor, stepUri: vscode.Uri, uri: vscode.Uri, line: number, end: number,
): Promise<void> {
  const target = uri.toString() === stepUri.toString() ? refCopyUri(uri) : uri
  const doc = await vscode.workspace.openTextDocument(target)
  const { start: a, end: b } = clampLines(doc, line, end)
  const at = lj.at[n - 1]
  // Right under the step card: the card's own line, not the end of the step's code.
  const lastLine = stepEditor.document.lineCount - 1
  const under = new vscode.Position(Math.max(0, Math.min(at.removed ? 0 : cardLine(lj, n), lastLine)), 0)
  await vscode.window.showTextDocument(stepEditor.document, { viewColumn: stepEditor.viewColumn, preview: true, preserveFocus: false })
  tourState.lastPeek = { uri: target.toString(), start: a, end: b, under: under.line }
  const location = new vscode.Location(target, new vscode.Range(a, 0, b, doc.lineAt(b).text.length))
  await vscode.commands.executeCommand('editor.action.peekLocations', stepUri, under, [location], 'peek')
}

/** The ref in a tab of the code group, its lines lit, "← Back to step n" above them (stepLenses). */
async function openRefInTab(
  lj: LoadedJourney, n: number, stepEditor: vscode.TextEditor | undefined, uri: vscode.Uri, line: number, end: number,
): Promise<void> {
  // Go Back (Alt+Left) lands on the step's lines: the editor is left from there.
  if (stepEditor) {
    const at = lj.at[n - 1]
    const stepLine = Math.max(0, (at.removed ? 1 : at.start) - 1)
    stepEditor.selection = new vscode.Selection(stepLine, 0, stepLine, 0)
  }
  const ed = await vscode.window.showTextDocument(uri, { preview: true, viewColumn: walk.codeColumn() })
  const { start: a, end: b } = clampLines(ed.document, line, end)
  tourState.refHere = { uri: uri.toString(), start: a, end: b }
  ed.selection = new vscode.Selection(a, 0, a, 0)
  ed.revealRange(new vscode.Range(Math.max(0, a - 1), 0, b, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  for (const e of vscode.window.visibleTextEditors) {
    setDecorations(e, card.refDeco!, e.document.uri.toString() === tourState.refHere.uri ? [new vscode.Range(a, 0, b, 0)] : [])
  }
  card.lensChanged.fire()
}
