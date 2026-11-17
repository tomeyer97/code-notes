// References from a step card (peeked or opened, with the way back), the step lenses above code journeys walk, and
// the read-only pages they open.

import * as vscode from 'vscode'
import { cfg, journeys, showError, understanding } from '../app'
import { blockAt, groupSteps } from '../codeBlocks'
import { setDecorations } from '../decorations'
import { fileOf, LoadedJourney } from '../journeys'
import { blocksOf } from '../sidebar/listModel'
import { clampLines, inNotesFolder, notesFor, relPath } from '../threads/anchoring'
import { wfs } from '../wfs'
import { cardLine } from './card'
import { card, tour, walk } from './tour'

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

/** A reference from the step card: open it with its lines lit and "← Back to step n" above them (R8). */
export async function openRef(lj: LoadedJourney, file: string, line: number, end: number, n: number): Promise<void> {
  tour.lastPeek = undefined
  const uri = vscode.Uri.joinPath(lj.folder.uri, file)
  try { await wfs.stat(uri) } catch { void showError(`Code Notes: ${file} doesn't exist in this folder.`); return }
  // The inline card lives in the step's tab: a ref opens as a peek right under the card, so the tab, the code and the
  // card stay. Esc closes it. A ref into the step's own file peeks a read-only copy (REF_SCHEME): a peek of the
  // file itself embeds a second editor on it, with its own copy of the card's thread, and closing that peek collapsed
  // the card in the step's editor too.
  const stepUri0 = vscode.Uri.joinPath(lj.folder.uri, fileOf(lj, n))
  const stepEd = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === stepUri0.toString())
  if (stepEd && !tour.fileGone) {
    const same = uri.toString() === stepUri0.toString()
    const target = same ? refCopyUri(uri) : uri
    const doc = await vscode.workspace.openTextDocument(target)
    const { start: a, end: b } = clampLines(doc, line, end)
    const at = lj.at[n - 1]
    // Right under the step card: the card's own line, not the end of the step's code.
    const under = new vscode.Position(Math.max(0, Math.min(at.removed ? 0 : cardLine(lj, n), stepEd.document.lineCount - 1)), 0)
    await vscode.window.showTextDocument(stepEd.document, { viewColumn: stepEd.viewColumn, preview: true, preserveFocus: false })
    tour.lastPeek = { uri: target.toString(), start: a, end: b, under: under.line }
    await vscode.commands.executeCommand('editor.action.peekLocations', stepUri0, under, [new vscode.Location(target, new vscode.Range(a, 0, b, doc.lineAt(b).text.length))], 'peek')
    return
  }
  // Go Back (Alt+Left) lands on the step's lines: the editor is left from there.
  if (stepEd) { const at = lj.at[n - 1]; const l = Math.max(0, (at.removed ? 1 : at.start) - 1); stepEd.selection = new vscode.Selection(l, 0, l, 0) }
  const ed = await vscode.window.showTextDocument(uri, { preview: true, viewColumn: walk.codeColumn() })
  const { start: a, end: b } = clampLines(ed.document, line, end)
  tour.refHere = { uri: uri.toString(), start: a, end: b }
  ed.selection = new vscode.Selection(a, 0, a, 0)
  ed.revealRange(new vscode.Range(Math.max(0, a - 1), 0, b, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  for (const e of vscode.window.visibleTextEditors) setDecorations(e, card.refDeco!, e.document.uri.toString() === tour.refHere.uri ? [new vscode.Range(a, 0, b, 0)] : [])
  card.lensChanged.fire()
  void n
}

/**
 * While walking: "← Back to step n" above an opened ref (R8). Outside a walk: one quiet line above the code a
 * journey step is about, "◇ Step 3 of Place an order" (only where its code is found); click = that step.
 */
export async function stepLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
  if (walk.touring()) {
    const lj = walk.tourJourney()!
    if (!tour.refHere || tour.refHere.uri !== doc.uri.toString()) return []
    const n = tour.step
    return [new vscode.CodeLens(new vscode.Range(tour.refHere.start, 0, tour.refHere.start, 0), { title: `← Back to step ${n}`, command: 'codeNotes.backToStep', tooltip: lj.j.steps[n - 1].title })]
  }
  if (!cfg().get<boolean>('journeys.codeLens', true) || doc.uri.scheme !== 'file') return []
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri)
  if (!folder || inNotesFolder(doc.uri)) return []
  const rel = relPath(folder, doc.uri)
  const hits: LensStep[] = []
  for (const lj of journeys.all()) {
    if (lj.folder.uri.toString() !== folder.uri.toString()) continue
    for (const s of lj.j.steps) {
      const at = lj.at[s.n - 1]
      if (!at || at.stale || fileOf(lj, s.n) !== rel) continue
      hits.push({ line: at.start - 1, end: at.end - 1, journey: lj.j.id, title: lj.j.title, step: s.id, n: s.n, stepTitle: s.title })
    }
  }
  if (!hits.length) return []
  // At most one lens per function, on its first line: the step there, or how many journeys pass there.
  const { blocks, fromText } = await blocksOf(doc)
  // The language's symbols were not ready: the text's blocks for now, the symbols' in a moment.
  if (fromText && !lensRetried.has(`${doc.uri}|${doc.version}`)) { lensRetried.add(`${doc.uri}|${doc.version}`); setTimeout(() => card.lensChanged.fire(), 2000) }
  // An open check question: the code it asks about is the only thing in view there (its function has no lens; the
  // rest of the file keeps theirs).
  const open = new Set(understanding?.openIn(doc.uri) ?? [])
  const asked = open.size ? notesFor(doc.uri).filter((n) => open.has(understanding!.questionOf(n)?.id ?? '')).map((n) => n.data.range) : []
  const quiet = (line: number) => asked.some((r) => { const b = blockAt(r.start - 1, blocks); return b ? b.start === line : Math.abs(r.start - 1 - line) <= 2 })
  return groupSteps(hits, blocks).filter((g) => !quiet(g.line)).map((g) => {
    const r = new vscode.Range(g.line, 0, g.line, 0)
    const js = [...new Set(g.steps.map((x) => x.journey))]
    if (js.length === 1) {
      const s = g.steps.reduce((a, b) => (b.n < a.n ? b : a))
      return new vscode.CodeLens(r, { title: `◇ Step ${s.n} of ${s.title}`, command: 'codeNotes.openStepLink', arguments: [s.journey, s.step, s.n], tooltip: s.stepTitle })
    }
    return new vscode.CodeLens(r, { title: `◇ ${js.length} journeys`, command: 'codeNotes.pickJourneyStep', arguments: [g.steps], tooltip: [...new Set(g.steps.map((x) => x.title))].join(' · ') })
  })
}

const lensRetried = new Set<string>()

/** A journey step whose lines are in a file (for the lenses). */
interface LensStep { line: number; end: number; journey: string; title: string; step: string; n: number; stepTitle: string }

/** The read-only pages: a step whose file is gone, and a copy of a file peeked from its own step. */
export function registerRefPages(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(STEP_SCHEME, { provideTextDocumentContent: (uri) => stepPage(uri.query) }))
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(REF_SCHEME, { provideTextDocumentContent: refCopy }))
}

/** "◇ 3 journeys" above a function: which journey, and which step, then walk to it. */
export const pickJourneyStep = async (steps?: LensStep[]) => {
  if (!Array.isArray(steps) || !steps.length) return
  // One row per journey (its first step here), most steps here first.
  const by = new Map<string, LensStep[]>()
  for (const s of steps) by.set(s.journey, [...(by.get(s.journey) ?? []), s])
  const rows = [...by.values()].sort((a, b) => b.length - a.length || a[0].title.localeCompare(b[0].title)).map((l) => { const s = l.reduce((a, b) => (b.n < a.n ? b : a)); return { label: s.title, description: l.length > 1 ? `steps ${l.map((x) => x.n).sort((a, b) => a - b).join(', ')}` : `step ${s.n}`, detail: s.stepTitle, s } })
  const pick = await vscode.window.showQuickPick(rows, { title: 'Journeys through this code', placeHolder: 'Walk to which step?' })
  if (pick) await vscode.commands.executeCommand('codeNotes.openStepLink', pick.s.journey, pick.s.step, pick.s.n)
}
