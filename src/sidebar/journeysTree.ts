// The Journeys view: the journeys Claude is writing, the journey lists by group (In this file, Continue, All by area;
// a few journeys: one flat list), sorting them, and revealing rows in it. Its rows are drawn by rowItems.ts (a
// journey's: journeyRows.ts); its model is listModel.ts; searching is journeySearch.ts.

import * as vscode from 'vscode'
import { journeys, tour } from './ports'
import { stored } from '../platform/host'
import { Group, ListModel, SORTS } from '../core/list/journeyList'
import { agentRunner } from '../platform/agent/runner'
import type { Journeys } from '../journeys/journeys'
import type { LoadedJourney } from '../journeys/steps'
import { badJourneyNodes, jgroupNode, jmoreNode, journeyRowNode, Node } from './nodes'
import { drawnWritingNodes, journeyQuestionRows, questionRows, writingNodes } from './journeyRows'
import { nestsQuestions } from './journeyRowText'
import { activeRel as activeFile, capHere, followCursor, listModel, listSort, onDidChangeListState, showAllHere, sortChanged, useDrawnModel } from './listModel'
import { itemOf } from './rowItems'
import { ViewSync } from './viewSync'
import { STATE } from '../platform/state'

/** How long the Journeys view waits before a reveal (revealSettled): the walk's row once the walk's redraw is done; the
 *  editor's "In this file" once the editor stayed (the cursor's follow, listModel.ts, redraws before it). */
const REVEAL_WALK_MS = 300
const REVEAL_EDITOR_MS = 700
/** While Claude writes a journey, its row's clock is drawn again this often. */
const WRITING_TICK_MS = 1000

class JourneysTree implements vscode.TreeDataProvider<Node> {
  /** Each row's parent, set while the rows are made and read back by getParent (rows are one object each: nodes.ts). */
  private parents = new Map<Node, Node>()
  /** The model the view drew: made when VS Code asks for the top rows (a drawing; `refresh` only asks for one). */
  private drawn: ListModel | undefined
  private view: vscode.TreeView<Node> | undefined
  private revealTimer: NodeJS.Timeout | undefined
  /** One redraw for a burst of changes (a step, the editor, the cursor): VS Code asked for the children of a group
   *  from one drawing after the next had dropped it ("Failed to resolve tree node"). Reveals: `revealRow`. */
  readonly sync = new ViewSync<Node>(80)
  refresh() { this.sync.refresh() }

  /** The model of the last drawing (undefined before the first). */
  drawnModel(): ListModel | undefined { return this.drawn }

  /** The view showing this tree (createJourneysView). */
  attach(view: vscode.TreeView<Node>): void { this.view = view }

  /** Selects or expands the row `target()` names once the view holds it (viewSync.ts). */
  revealRow(target: () => Node | undefined, o: { select: boolean; expand: boolean }): void {
    if (this.view) this.sync.reveal(this.view, this, target, { ...o, focus: false })
  }

  /**
   * A reveal goes only to a node the view holds now and keeps holding: a reveal of a node that a redraw dropped
   * meanwhile (the "In this file" group of the file before) logged "Failed to resolve tree node". So: once things
   * settle (`wait`), against the model as it is then, and only for groups that don't come and go with the editor.
   */
  revealSettled(f: (m: ListModel) => Node | undefined, o: { select: boolean; expand: boolean }, wait: number): void {
    clearTimeout(this.revealTimer)
    if (!this.view?.visible) return
    const file = activeFile()
    this.revealTimer = setTimeout(() => this.revealRow(() => (activeFile() === file ? f(listModel()) : undefined), o), wait)
  }

  /** The group a journey is listed under in "All" (for reveal). */
  groupOf(key: string): string | undefined {
    const all = (this.drawn ?? listModel()).groups.find((g) => g.id === 'all')
    if (!all) return undefined
    if (all.keys.includes(key)) return 'all'
    return all.children?.find((c) => c.keys.includes(key))?.id
  }

  /** Group `g`'s rows; `parent`: its row (none: they are the view's top rows). */
  private rowsOf(g: Group, parent?: Node): Node[] {
    const rows: Node[] = g.keys.map((k) => journeyRowNode(journeys().list.get(k)!, g.id))
      .filter((n) => n.kind !== 'journey' || !!n.lj)
    // "Show all": the rest of a capped group (In this file).
    if (g.more) rows.push(jmoreNode(g))
    if (parent) for (const r of rows) this.parents.set(r, parent)
    return rows
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const m = this.drawn = listModel()
      this.parents.clear()
      const writing = writingNodes()
      const bad = badJourneyNodes()
      if (!m.total) return [...writing, ...bad]
      // A few journeys, none in progress or here: one row each, no "All" above them (journeyList.ts `flat`).
      return [...writing, ...(m.flat ? this.rowsOf(m.groups[0]) : m.groups.map(jgroupNode)), ...bad]
    }
    if (node.kind === 'writing') return []
    if (node.kind === 'jgroup') {
      if (!node.g.children) return this.rowsOf(node.g, node)
      const groups = node.g.children.map(jgroupNode)
      for (const g of groups) this.parents.set(g, node)
      return groups
    }
    // A journey's step questions: under its row in "All" only.
    if (node.kind === 'journey' && node.group && nestsQuestions(node.group)) return journeyQuestionRows(node.lj)
    if (node.kind === 'questions') return questionRows(node.notes)
    return []
  }

  getParent(node: Node): Node | undefined {
    if (node.kind === 'questions') {
      const g = this.groupOf(node.lj.key)
      return g ? journeyRowNode(node.lj, g) : undefined
    }
    return this.parents.get(node)
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return itemOf(node)
  }
}

/** The Journeys view's rows; shown once createJourneysView has made the view. */
export const journeysTree = new JourneysTree()
useDrawnModel(() => journeysTree.drawnModel())

export async function sortJourneys(): Promise<void> {
  const cur = listSort()
  const items = SORTS.map((x) => ({ label: x.label, id: x.id, description: x.id === cur ? 'current' : undefined }))
  const pick = await vscode.window.showQuickPick(items, { title: 'Sort journeys' })
  if (!pick) return
  await stored().set(STATE.journeySort, pick.id)
  sortChanged()
}

/** The Journeys view; its "In this file" follows the editor (capped again), ranked by the cursor's function, and in view. */
export function createJourneysView(context: vscode.ExtensionContext): void {
  // The provider's changes: the whole tree's, or only the writing rows' clocks (followWriting), both through ViewSync.
  const view = vscode.window.createTreeView('codeNotes.journeys', { treeDataProvider: journeysTree.sync.provider(journeysTree), showCollapseAll: true })
  journeysTree.attach(view)
  const editorChanged = vscode.window.onDidChangeActiveTextEditor(() => {
    capHere()
    followCursor(true)
  })
  const selectionChanged = vscode.window.onDidChangeTextEditorSelection((e) => {
    if (e.textEditor === vscode.window.activeTextEditor) followCursor(false)
  })
  // The file or the function under the cursor changed, or the sort: the view follows; another file shows its "In this file".
  const listChanged = onDidChangeListState((e) => {
    journeysTree.refresh()
    if (e.editorChanged) revealHereGroup()
  })
  context.subscriptions.push(view, editorChanged, selectionChanged, listChanged, ...journeysTree.sync.watch(view),
    followWriting(view, (rows) => journeysTree.sync.redrawRows(rows)))
}

/** The journeys Claude is writing: their rows come and go with the runs (the whole tree drawn again), and their clocks
 *  tick while the view shows (only those rows drawn again, by `redrawRows`). */
function followWriting(view: vscode.TreeView<Node>, redrawRows: (rows: Node[]) => void): vscode.Disposable {
  let tick: NodeJS.Timeout | undefined
  const runs = agentRunner().inProgress.onDidChange((r) => {
    if (r.purpose !== 'journey') return
    journeysTree.refresh()
    clearInterval(tick)
    tick = writingNodes().length ? setInterval(() => { if (view.visible) redrawRows(drawnWritingNodes()) }, WRITING_TICK_MS) : undefined
  })
  return vscode.Disposable.from(runs, { dispose: () => clearInterval(tick) })
}

/** "Show all" under "In this file". */
export const journeysHereAll = () => showAllHere()

/** The rows follow where the journeys' steps are (stale counts). */
export const followJourneyMoves = (j: Journeys) => j.onDidMoveSteps(() => journeysTree.refresh())

/** The walk's row in Continue (where a walk is listed first): never deep in All, which scrolled the view away. */
export function revealJourneyRow(lj: LoadedJourney): void {
  const inContinue = (m: ListModel) => m.groups.find((x) => x.id === 'continue')?.keys.includes(lj.key)
  journeysTree.revealSettled((m) => (inContinue(m) ? journeyRowNode(lj, 'continue') : undefined), { select: true, expand: false }, REVEAL_WALK_MS)
}

/** The editor changed (and stayed): the Journeys view shows "In this file" (the top), not a row deep in All. */
export function revealHereGroup(): void {
  if (tour().touring()) return
  journeysTree.revealSettled((m) => {
    const g = m.groups.find((x) => x.id === 'here')
    return g ? jgroupNode(g) : undefined
  }, { select: false, expand: true }, REVEAL_EDITOR_MS)
}
