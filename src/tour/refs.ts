// References from a step card: opened as a peek under the card, or in a tab with "← Back to step n" above them; and
// the read-only pages they may open (a step whose file is gone, a copy of the step's own file).

import * as vscode from 'vscode'
import { card, tourProbe, tourState, walk } from './instances'
import { showError } from '../platform/run'
import { LoadedJourney } from '../journeys/steps'
import { clampLines } from '../notes/model/lines'
import { wfs } from '../platform/workspaceFs'
import { cardLine, stepUri as stepUriOf } from './stepPlace'
import type { StepRef } from './stepText'
import { fireAndForget } from '../platform/run'

/** A read-only copy of a file (its text now, unsaved edits included), peeked for a ref into the step's own file. */
const REF_SCHEME = 'code-notes-ref'

/** The copy's uri: the file's own scheme kept in the query, and a fresh fragment per peek (VS Code keeps a virtual
 *  document's text once read). */
const refCopyUri = (uri: vscode.Uri) => uri.with({ scheme: REF_SCHEME, query: uri.scheme, fragment: String(Date.now()) })

/** The copy's text: the file's (an open document's, unsaved edits included), or one line saying why there is none. */
async function refCopy(uri: vscode.Uri): Promise<string> {
  const real = uri.with({ scheme: uri.query || 'file', query: '', fragment: '' })
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === real.toString())
  if (open) return open.getText()
  try {
    return new TextDecoder().decode(await wfs.readFile(real))
  } catch (e) {
    return `⚠ ${vscode.workspace.asRelativePath(real, false)} can't be read (${e instanceof Error ? e.message : String(e)}).\n`
  }
}

/** The page shown for a step whose file doesn't exist. */
export const STEP_SCHEME = 'code-notes-step'

const stepPage = (file: string) => `⚠ ${file} doesn't exist any more (moved or deleted). The step is below; its code can't be shown.\n`

/** The read-only pages: a step whose file is gone, and a copy of a file peeked from its own step. */
export function registerRefPages(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(STEP_SCHEME, { provideTextDocumentContent: (uri) => stepPage(uri.query) }))
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(REF_SCHEME, { provideTextDocumentContent: refCopy }))
}

/** Where a reference goes: a file of the journey's folder and its lines (1-based, as a step's text writes them). */
export type RefPlace = Pick<StepRef, 'file' | 'line' | 'end'>

/** A reference from step n's card (positional, as the map and a note's link call it): see openStepRef. */
export const openRef = (lj: LoadedJourney, file: string, line: number, end: number, n: number) => openStepRef(lj, n, { file, line, end })

/**
 * A reference from step n's card, lit. With the step's editor on screen, a peek right under the card; else a tab with
 * "← Back to step n" above the lines.
 */
export async function openStepRef(lj: LoadedJourney, n: number, ref: RefPlace): Promise<void> {
  tourProbe().lastPeek = undefined
  const uri = vscode.Uri.joinPath(lj.folder.uri, ref.file)
  try { await wfs.stat(uri) } catch {
    fireAndForget(showError(`${ref.file} doesn't exist in this folder.`), 'refs: showError')
    return
  }
  const stepUri = stepUriOf(lj, n)
  const stepEditor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === stepUri.toString())
  if (stepEditor && !tourState().fileGone) await peekRefUnderCard(stepEditor, peekPosition(stepEditor, lj, n), uri, ref)
  else await openRefInTab(lj, n, stepEditor, uri, ref)
}

/** Right under the step card: the card's own line (not the end of the step's code), within the step's document. */
function peekPosition(stepEditor: vscode.TextEditor, lj: LoadedJourney, n: number): vscode.Position {
  const lastLine = stepEditor.document.lineCount - 1
  const under = lj.at[n - 1].removed ? 0 : cardLine(lj, n)
  return new vscode.Position(Math.max(0, Math.min(under, lastLine)), 0)
}

/**
 * The inline card lives in the step's tab: a ref opens as a peek right under the card (`under`), so the tab, the code
 * and the card stay. Esc closes it. A ref into the step's own file peeks a read-only copy (REF_SCHEME): a peek of the
 * file itself embeds a second editor on it, with its own copy of the card's thread, and closing that peek collapsed
 * the card in the step's editor too.
 */
async function peekRefUnderCard(stepEditor: vscode.TextEditor, under: vscode.Position, uri: vscode.Uri, ref: RefPlace): Promise<void> {
  const stepUri = stepEditor.document.uri
  const target = uri.toString() === stepUri.toString() ? refCopyUri(uri) : uri
  const doc = await vscode.workspace.openTextDocument(target)
  const { start: a, end: b } = clampLines(doc, ref.line, ref.end)
  await vscode.window.showTextDocument(stepEditor.document, { viewColumn: stepEditor.viewColumn, preview: true, preserveFocus: false })
  tourProbe().lastPeek = { uri: target.toString(), start: a, end: b, under: under.line }
  const location = new vscode.Location(target, new vscode.Range(a, 0, b, doc.lineAt(b).text.length))
  await vscode.commands.executeCommand('editor.action.peekLocations', stepUri, under, [location], 'peek')
}

/** The ref in a tab of the code group, its lines lit by the card, "← Back to step n" above them (the step lenses). */
async function openRefInTab(
  lj: LoadedJourney, n: number, stepEditor: vscode.TextEditor | undefined, uri: vscode.Uri, ref: RefPlace,
): Promise<void> {
  // Go Back (Alt+Left) lands on the step's lines: the editor is left from there.
  if (stepEditor) {
    const at = lj.at[n - 1]
    const stepLine = Math.max(0, (at.removed ? 1 : at.start) - 1)
    stepEditor.selection = new vscode.Selection(stepLine, 0, stepLine, 0)
  }
  const ed = await vscode.window.showTextDocument(uri, { preview: true, viewColumn: walk().claimCodeColumn() })
  const { start: a, end: b } = clampLines(ed.document, ref.line, ref.end)
  // Known as the walk's ref before the caret moves there (the walk reads it on that move).
  card().showRef({ uri: uri.toString(), start: a, end: b })
  ed.selection = new vscode.Selection(a, 0, a, 0)
  ed.revealRange(new vscode.Range(Math.max(0, a - 1), 0, b, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
}
