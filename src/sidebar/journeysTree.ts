// The Journeys view: the journey lists by group (In this file, Continue, All by area), searching and sorting them.
// Its rows are drawn by rowItems.ts (a journey's: journeyRows.ts); its model is listModel.ts.

import * as vscode from 'vscode'
import { journeys, mapPanel, stored } from '../app'
import { Group, SORTS } from '../core/list/journeyList'
import { pickOne } from '../platform/quickPick'
import { walkJourney } from '../tour/commands'
import { badJourneyNodes, jgroupNode, jmoreNode, journeyRowNode, Node } from './nodes'
import { journeyQuestionRows, questionRows, revealHereGroup } from './journeyRows'
import { followCursor, listModel, listSort, listState } from './listModel'
import { itemOf } from './rowItems'
import { ViewSync } from './viewSync'
import { fireAndForget } from '../platform/run'
import { STATE } from '../platform/state'

/** Where a row's parent is kept (set while the rows are made, read back by getParent): the same strings both ways. */
const parentKey = {
  group: (id: string) => `group:${id}`,
  row: (group: string, key: string) => `${group}:${key}`,
  more: (group: string) => `more:${group}`,
}

/** The groups under which a journey's row lists its step questions (a row is listed once there). */
const nestsQuestions = (group: string | undefined) => group === 'all' || !!group?.startsWith('area:')

class JourneysTree implements vscode.TreeDataProvider<Node> {
  private parents = new Map<string, Node>()
  /** One redraw for a burst of changes (a step, the editor, the cursor): VS Code asked for the children of a group
   *  from one drawing after the next had dropped it ("Failed to resolve tree node"). Reveals: `revealRow`. */
  readonly sync = new ViewSync<Node>(80)
  refresh() { this.sync.refresh() }

  /** Selects or expands the row `target()` names once the view holds it (viewSync.ts). */
  revealRow(target: () => Node | undefined, o: { select: boolean; expand: boolean }): void {
    this.sync.reveal(journeysView, this, target, { ...o, focus: false })
  }

  /** The group a journey is listed under in "All" (for reveal). */
  groupOf(key: string): string | undefined {
    const m = listState.last ?? listModel()
    const all = m.groups.find((g) => g.id === 'all')
    if (!all) return undefined
    if (all.keys.includes(key)) return 'all'
    return all.children?.find((c) => c.keys.includes(key))?.id
  }

  private rowsOf(g: Group, parent: Node): Node[] {
    const rows: Node[] = g.keys.map((k) => {
      const n: Node = journeyRowNode(journeys.list.get(k)!, g.id)
      this.parents.set(parentKey.row(g.id, k), parent)
      return n
    }).filter((n) => n.kind !== 'journey' || !!n.lj)
    // "Show all": the rest of a capped group (In this file).
    if (g.more) {
      rows.push(jmoreNode(g))
      this.parents.set(parentKey.more(g.id), parent)
    }
    return rows
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      listState.last = listModel()
      this.parents.clear()
      const bad = badJourneyNodes()
      if (!listState.last.total) return bad
      return [...listState.last.groups.map(jgroupNode), ...bad]
    }
    if (node.kind === 'jgroup') {
      if (!node.g.children) return this.rowsOf(node.g, node)
      return node.g.children.map((c) => {
        this.parents.set(parentKey.group(c.id), node)
        return jgroupNode(c)
      })
    }
    // A journey's step questions: under its row in "All" only.
    if (node.kind === 'journey' && nestsQuestions(node.group)) return journeyQuestionRows(node.lj)
    if (node.kind === 'questions') return questionRows(node.notes)
    return []
  }

  getParent(node: Node): Node | undefined {
    if (node.kind === 'jgroup') return this.parents.get(parentKey.group(node.g.id))
    if (node.kind === 'journey' && node.group) return this.parents.get(parentKey.row(node.group, node.lj.key))
    if (node.kind === 'jmore') return this.parents.get(parentKey.more(node.g))
    if (node.kind === 'questions') {
      const g = this.groupOf(node.lj.key)
      return g ? journeyRowNode(node.lj, g) : undefined
    }
    return undefined
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return itemOf(node)
  }
}

export let journeysTree: JourneysTree

export let journeysView: vscode.TreeView<Node>

/** Search every journey (title, question, summary, step titles, files): a picker, best match first (or the view's sort). */
export async function searchJourneys(): Promise<void> {
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { key: string }>()
  qp.placeholder = 'Search journeys: words of the title, question, steps or file paths'
  // The results follow the view's sort when one was picked (else best match first).
  const sort = listSort()
  if (sort !== 'area') qp.title = `Search journeys · ${SORTS.find((x) => x.id === sort)!.label}`
  qp.matchOnDescription = true
  qp.matchOnDetail = true
  const fill = () => {
    const m = listModel({ query: qp.value })
    const keys = m.sections.flatMap((s) => s.keys)
    // The order is ours (best first): VS Code filters our results again by label/description/detail, so they carry the words.
    const rows = [...new Set(keys)].map((k) => {
      const r = m.rows[k]
      const stepHit = r.hits.length ? [r.stepTitles.find((t) => r.hits.some((h) => t.toLowerCase().includes(h))) ?? ''] : []
      return { key: k, label: r.title, description: r.meta, detail: [r.question, ...stepHit].filter(Boolean).join(' · '), alwaysShow: true }
    })
    // No journey has every word: the ones with any, under one line saying so.
    qp.items = m.fallback ? [{ key: '', label: m.fallback.note, kind: vscode.QuickPickItemKind.Separator }, ...rows] : rows
  }
  qp.onDidChangeValue(fill)
  fill()
  // Not awaited: the command returns while the pick is open.
  fireAndForget(pickOne(qp).then((it) => {
    const lj = it && journeys.list.get(it.key)
    if (lj) fireAndForget(walkJourney(lj), 'journeysTree: walkJourney')
  }), 'journeysTree: pickOne')
}

export async function sortJourneys(): Promise<void> {
  const cur = listSort()
  const items = SORTS.map((x) => ({ label: x.label, id: x.id, description: x.id === cur ? 'current' : undefined }))
  const pick = await vscode.window.showQuickPick(items, { title: 'Sort journeys' })
  if (!pick) return
  await stored.set(STATE.journeySort, pick.id)
  journeysTree.refresh()
  mapPanel.update()
}

/** The Journeys view; its "In this file" follows the editor (capped again), ranked by the cursor's function, and in view. */
export function createJourneysView(context: vscode.ExtensionContext): void {
  journeysTree = new JourneysTree()
  journeysView = vscode.window.createTreeView('codeNotes.journeys', { treeDataProvider: journeysTree.sync.provider(journeysTree), showCollapseAll: true })
  const editorChanged = vscode.window.onDidChangeActiveTextEditor(() => {
    listState.hereAll = false
    followCursor(true, cursorMoved)
  })
  const selectionChanged = vscode.window.onDidChangeTextEditorSelection((e) => {
    if (e.textEditor === vscode.window.activeTextEditor) followCursor(false, cursorMoved)
  })
  context.subscriptions.push(journeysView, editorChanged, selectionChanged, ...journeysTree.sync.watch(journeysView))
}

/** The file or the function under the cursor changed: the lists follow; another file shows its "In this file". */
function cursorMoved(editorChanged: boolean): void {
  journeysTree.refresh()
  if (mapPanel) mapPanel.update()
  if (editorChanged) revealHereGroup()
}

export const journeysHereAll = () => { listState.hereAll = true; journeysTree.refresh(); mapPanel.update() }
