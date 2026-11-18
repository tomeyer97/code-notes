// The code lenses above code journeys walk: outside a walk, "◇ Step 3 of Place an order" (or "◇ 3 journeys") above
// the function a step is about; while walking, "← Back to step n" above a ref opened from the card.

import * as vscode from 'vscode'
import { cfg, journeys, understanding } from '../app'
import { Block, blockAt, groupSteps } from '../codeBlocks'
import { fileOf } from '../journeys/steps'
import { blocksOf } from '../sidebar/listModel'
import { inNotesFolder, notesFor, relPath } from '../threads/anchoring'
import { card, tour, walk } from './tour'

/** A journey step whose lines are in a file (for the lenses). */
interface LensStep { line: number; end: number; journey: string; title: string; step: string; n: number; stepTitle: string }

/**
 * While walking: "← Back to step n" above an opened ref. Outside a walk: one quiet line above the code a journey step
 * is about, "◇ Step 3 of Place an order" (only where its code is found); click = that step.
 */
export async function stepLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
  if (walk.touring()) return backToStepLens(doc)
  if (!cfg().get<boolean>('journeys.codeLens', true) || doc.uri.scheme !== 'file') return []
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri)
  if (!folder || inNotesFolder(doc.uri)) return []
  const hits = stepsIn(folder, relPath(folder, doc.uri))
  if (!hits.length) return []
  // At most one lens per function, on its first line: the step there, or how many journeys pass there.
  const { blocks, fromText } = await blocksOf(doc)
  if (fromText) retryWhenSymbolsReady(doc)
  const quiet = askedHere(doc, blocks)
  return groupSteps(hits, blocks).filter((g) => !quiet(g.line)).map((g) => stepLens(g.line, g.steps))
}

/** "← Back to step n" above the ref opened from the card, when it is in this document. */
function backToStepLens(doc: vscode.TextDocument): vscode.CodeLens[] {
  const lj = walk.tourJourney()!
  const ref = tour.refHere
  if (!ref || ref.uri !== doc.uri.toString()) return []
  const n = tour.step
  const range = new vscode.Range(ref.start, 0, ref.start, 0)
  return [new vscode.CodeLens(range, { title: `← Back to step ${n}`, command: 'codeNotes.backToStep', tooltip: lj.j.steps[n - 1].title })]
}

/** The steps of this folder's journeys whose code is found in file `rel`. */
function stepsIn(folder: vscode.WorkspaceFolder, rel: string): LensStep[] {
  const hits: LensStep[] = []
  for (const lj of journeys.all()) {
    if (lj.folder.uri.toString() !== folder.uri.toString()) continue
    for (const s of lj.j.steps) {
      const at = lj.at[s.n - 1]
      if (!at || at.stale || fileOf(lj, s.n) !== rel) continue
      hits.push({ line: at.start - 1, end: at.end - 1, journey: lj.j.id, title: lj.j.title, step: s.id, n: s.n, stepTitle: s.title })
    }
  }
  return hits
}

/** Documents (uri|version) whose lenses were asked for again once. */
const lensRetried = new Set<string>()

/** The language's symbols were not ready: the text's blocks for now, the lenses asked for again in a moment (once). */
function retryWhenSymbolsReady(doc: vscode.TextDocument): void {
  const key = `${doc.uri}|${doc.version}`
  if (lensRetried.has(key)) return
  lensRetried.add(key)
  setTimeout(() => card.lensChanged.fire(), 2000)
}

/**
 * An open check question: the code it asks about is the only thing in view there. True for a lens line in the
 * function of such a question (or within 2 lines of it, outside any function); the rest of the file keeps its lenses.
 */
function askedHere(doc: vscode.TextDocument, blocks: Block[]): (line: number) => boolean {
  const open = new Set(understanding?.openIn(doc.uri) ?? [])
  const isOpenQuestion = (n: ReturnType<typeof notesFor>[number]) => open.has(understanding!.questionOf(n)?.id ?? '')
  const asked = open.size ? notesFor(doc.uri).filter(isOpenQuestion).map((n) => n.data.range) : []
  return (line) => asked.some((r) => {
    const b = blockAt(r.start - 1, blocks)
    return b ? b.start === line : Math.abs(r.start - 1 - line) <= 2
  })
}

/** The lens on `line`: one journey's step there ("◇ Step 3 of …"), or how many journeys pass there. */
function stepLens(line: number, steps: LensStep[]): vscode.CodeLens {
  const range = new vscode.Range(line, 0, line, 0)
  const journeyIds = [...new Set(steps.map((x) => x.journey))]
  if (journeyIds.length === 1) {
    const s = firstStep(steps)
    return new vscode.CodeLens(range, { title: `◇ Step ${s.n} of ${s.title}`, command: 'codeNotes.openStepLink', arguments: [s.journey, s.step, s.n], tooltip: s.stepTitle })
  }
  const titles = [...new Set(steps.map((x) => x.title))].join(' · ')
  return new vscode.CodeLens(range, { title: `◇ ${journeyIds.length} journeys`, command: 'codeNotes.pickJourneyStep', arguments: [steps], tooltip: titles })
}

/** The lowest-numbered step. */
const firstStep = (steps: LensStep[]) => steps.reduce((a, b) => (b.n < a.n ? b : a))

/** "◇ 3 journeys" above a function: which journey, and which step, then walk to it. */
export async function pickJourneyStep(steps?: LensStep[]): Promise<void> {
  if (!Array.isArray(steps) || !steps.length) return
  // One row per journey (its first step here), most steps here first.
  const byJourney = new Map<string, LensStep[]>()
  for (const s of steps) byJourney.set(s.journey, [...(byJourney.get(s.journey) ?? []), s])
  const groups = [...byJourney.values()].sort((a, b) => b.length - a.length || a[0].title.localeCompare(b[0].title))
  const rows = groups.map((l) => {
    const s = firstStep(l)
    const numbers = l.map((x) => x.n).sort((a, b) => a - b).join(', ')
    return { label: s.title, description: l.length > 1 ? `steps ${numbers}` : `step ${s.n}`, detail: s.stepTitle, s }
  })
  const pick = await vscode.window.showQuickPick(rows, { title: 'Journeys through this code', placeHolder: 'Walk to which step?' })
  if (pick) await vscode.commands.executeCommand('codeNotes.openStepLink', pick.s.journey, pick.s.step, pick.s.n)
}
