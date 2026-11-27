// The code lenses above code journeys walk: outside a walk, "◇ Step 3 of Place an order" (or "◇ 3 journeys") above
// the function a step is about; while walking, "← Back to step n" above a ref opened from the card.

import * as vscode from 'vscode'
import { journeys } from './ports'
import { tourState, walk } from './instances'
import { cfg } from '../platform/settings'
import { Block, groupSteps } from '../core/codeBlocks'
import { LruMap } from '../core/lruMap'
import { fileOf } from '../journeys/steps'
import { blocksOf } from '../platform/symbolBlocks'
import { inNotesFolder } from '../notes/notesFolder'
import { relPath } from '../platform/documents'
import { Cmd, HiddenCmd } from '../platform/commands'
import { openStepLinkArgs, StepTarget } from './stepLink'

/** A journey step whose lines are in a file (for the lenses). */
interface LensStep extends StepTarget { line: number; end: number; title: string; stepTitle: string }

/** Lines of a document that get no lens (another feature has the code there to itself). */
export type QuietLines = (doc: vscode.TextDocument, blocks: Block[]) => (line: number) => boolean

/** How long the language may take to have its symbols ready before the lenses are asked for again (once). */
const SYMBOLS_RETRY_MS = 2000
/** Document versions remembered as retried. */
const RETRIES_KEPT = 200

/**
 * While walking: "← Back to step n" above an opened ref. Outside a walk: one quiet line above the code a journey step
 * is about, "◇ Step 3 of Place an order" (only where its code is found); click = that step.
 */
export class StepLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changedEmitter = new vscode.EventEmitter<void>()
  readonly onDidChangeCodeLenses = this.changedEmitter.event
  /** Documents (uri and version) whose lenses were asked for again once. */
  private readonly retried = new LruMap<string, true>(RETRIES_KEPT)
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()

  /** `quiet`: lines another feature keeps free of lenses (a check's open question: checkTour.ts). */
  constructor(private readonly quiet: QuietLines) {}

  /** The lenses are asked for again (the walk, the journeys or the ref opened changed). */
  changed(): void { this.changedEmitter.fire() }

  async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (walk().touring()) return backToStepLens(doc)
    if (!cfg().get<boolean>('journeys.codeLens', true) || doc.uri.scheme !== 'file') return []
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri)
    if (!folder || inNotesFolder(doc.uri)) return []
    const hits = stepsIn(folder, relPath(folder, doc.uri))
    if (!hits.length) return []
    // At most one lens per function, on its first line: the step there, or how many journeys pass there.
    const { blocks, fromText } = await blocksOf(doc)
    if (fromText) this.retryWhenSymbolsReady(doc)
    const quiet = this.quiet(doc, blocks)
    return groupSteps(hits, blocks).filter((g) => !quiet(g.line)).map((g) => stepLens(g.line, g.steps))
  }

  /** The language's symbols were not ready: the text's blocks for now, the lenses asked for again in a moment (once). */
  private retryWhenSymbolsReady(doc: vscode.TextDocument): void {
    const key = JSON.stringify([doc.uri.toString(), doc.version])
    if (this.retried.has(key)) return
    this.retried.set(key, true)
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      this.changed()
    }, SYMBOLS_RETRY_MS)
    this.timers.add(timer)
  }

  dispose(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    this.changedEmitter.dispose()
  }
}

/** "← Back to step n" above the ref opened from the card, when it is in this document. */
function backToStepLens(doc: vscode.TextDocument): vscode.CodeLens[] {
  const lj = walk().tourJourney()!
  const ref = tourState().refHere
  if (!ref || ref.uri !== doc.uri.toString()) return []
  const n = tourState().step
  const range = new vscode.Range(ref.start, 0, ref.start, 0)
  return [new vscode.CodeLens(range, { title: `← Back to step ${n}`, command: Cmd.backToStep, tooltip: lj.j.steps[n - 1].title })]
}

/** The steps of this folder's journeys whose code is found in file `rel`. */
function stepsIn(folder: vscode.WorkspaceFolder, rel: string): LensStep[] {
  const hits: LensStep[] = []
  for (const lj of journeys().all()) {
    if (lj.folder.uri.toString() !== folder.uri.toString()) continue
    for (const s of lj.j.steps) {
      const at = lj.at[s.n - 1]
      if (!at || at.stale || fileOf(lj, s.n) !== rel) continue
      hits.push({
        line: at.start - 1, end: at.end - 1, title: lj.j.title, stepTitle: s.title,
        journey: lj.j.id, step: s.id, n: s.n, folder: folder.uri.toString(),
      })
    }
  }
  return hits
}

/** The lens on `line`: one journey's step there ("◇ Step 3 of …"), or how many journeys pass there. */
function stepLens(line: number, steps: LensStep[]): vscode.CodeLens {
  const range = new vscode.Range(line, 0, line, 0)
  const journeyIds = [...new Set(steps.map((x) => x.journey))]
  if (journeyIds.length === 1) {
    const s = firstStep(steps)
    const title = `◇ Step ${s.n} of ${s.title}`
    return new vscode.CodeLens(range, { title, command: HiddenCmd.openStepLink, arguments: openStepLinkArgs(s), tooltip: s.stepTitle })
  }
  const titles = [...new Set(steps.map((x) => x.title))].join(' · ')
  const title = `◇ ${journeyIds.length} journeys`
  return new vscode.CodeLens(range, { title, command: Cmd.pickJourneyStep, arguments: [steps], tooltip: titles })
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
  if (pick) await vscode.commands.executeCommand(HiddenCmd.openStepLink, ...openStepLinkArgs(pick.s))
}
