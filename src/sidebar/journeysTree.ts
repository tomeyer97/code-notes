// The Journeys view: the journey lists by group (In this file, Continue, All by area), searching and sorting them.

import * as vscode from 'vscode'
import { journeys, mapPanel, state } from '../app'
import { Group, SORTS } from '../journeyList'
import { walkJourney } from '../tour/open'
import { revealHereGroup } from './journeyRows'
import { activeRel, listModel, listSort, listState, SORT_KEY, updateCursorSpan } from './listModel'
import { cached, Node } from './nodes'
import { tree } from './notesTree'

class JourneysTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>()
  readonly onDidChangeTreeData = this.changed.event
  private parents = new Map<string, Node>()
  /** One redraw for a burst of changes (a step, the editor, the cursor): VS Code asked for the children of a group
   *  from one drawing after the next had dropped it ("Failed to resolve tree node"). */
  private timer: NodeJS.Timeout | undefined
  refresh() { clearTimeout(this.timer); this.timer = setTimeout(() => this.changed.fire(undefined), 80) }
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
      const n: Node = cached(`journey:${g.id}:${k}`, { kind: 'journey' as const, lj: journeys.list.get(k)!, group: g.id })
      this.parents.set(`${g.id}:${k}`, parent)
      return n
    }).filter((n) => n.kind !== 'journey' || !!n.lj)
    // "Show all": the rest of a capped group (In this file).
    if (g.more) { const m: Node = cached(`jmore:${g.id}`, { kind: 'jmore' as const, g: g.id, n: g.more }); this.parents.set(`more:${g.id}`, parent); rows.push(m) }
    return rows
  }
  getChildren(node?: Node): Node[] {
    if (!node) {
      listState.last = listModel()
      this.parents.clear()
      const bad = [...journeys.invalid.values()].sort((a, b) => a.uri.path.localeCompare(b.uri.path)).map((x) => cached(`badJourney:${x.uri}`, { kind: 'badJourney' as const, uri: x.uri, why: x.why }))
      if (!listState.last.total) return bad
      return [...listState.last.groups.map((g) => cached(`jgroup:${g.id}`, { kind: 'jgroup' as const, g })), ...bad]
    }
    if (node.kind === 'jgroup') {
      if (node.g.children) return node.g.children.map((c) => { const n = cached(`jgroup:${c.id}`, { kind: 'jgroup' as const, g: c }); this.parents.set(`group:${c.id}`, node); return n })
      return this.rowsOf(node.g, node)
    }
    // A journey's step questions: under its row in "All" only (a row is listed once there).
    if (node.kind === 'journey' && (node.group === 'all' || node.group?.startsWith('area:'))) return tree.getChildren(node)
    if (node.kind === 'questions') return tree.getChildren(node)
    return []
  }
  getParent(node: Node): Node | undefined {
    if (node.kind === 'jgroup') return this.parents.get(`group:${node.g.id}`)
    if (node.kind === 'journey' && node.group) return this.parents.get(`${node.group}:${node.lj.key}`)
    if (node.kind === 'jmore') return this.parents.get(`more:${node.g}`)
    if (node.kind === 'questions') { const g = this.groupOf(node.lj.key); return g ? cached(`journey:${g}:${node.lj.key}`, { kind: 'journey' as const, lj: node.lj, group: g }) : undefined }
    return undefined
  }
  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'jgroup') {
      const g = node.g
      const open = g.id !== 'all' || !listState.last?.groups.some((x) => x.id === 'here' || x.id === 'continue')
      // Areas fold when there are many of them; a handful stay open.
      const areas = listState.last?.groups.find((x) => x.id === 'all')?.children?.length ?? 0
      const item = new vscode.TreeItem(g.label, g.id.startsWith('area:') ? (areas > 4 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded) : open ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
      item.id = `jgroup:${g.id}`
      const n = g.children ? g.children.reduce((a, c) => a + c.keys.length, 0) : g.keys.length + (g.more ?? 0)
      item.description = String(n)
      item.contextValue = 'jgroup'
      return item
    }
    if (node.kind === 'jmore') {
      const item = new vscode.TreeItem(`Show all (${node.n} more)`)
      item.id = `jmore:${node.g}`
      item.command = { command: 'codeNotes.journeysHereAll', title: 'Show all' }
      return item
    }
    const item = tree.getTreeItem(node)
    if (node.kind === 'journey' && node.group) {
      item.id = `${node.group}|${item.id}`
      // Under its area's group the area is not said again.
      const area = node.group.startsWith('area:') ? node.group.slice(5) : ''
      if (area && typeof item.description === 'string') item.description = item.description.replace(new RegExp(`^${area.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( · |$)`), '') || undefined
      if (!(node.group === 'all' || node.group.startsWith('area:'))) item.collapsibleState = vscode.TreeItemCollapsibleState.None
      // In this file: how much of it is here ("3 of 7 steps here"), unless it is being walked or was left.
      const r = listState.last?.rows[node.lj.key]
      if (node.group === 'here' && r && !(r.walking || r.resume > 1)) item.description = [r.hereText, r.stale ? '⚠ Stale' : ''].filter(Boolean).join(' · ')
    }
    return item
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
    const rows = [...new Set(keys)].map((k) => { const r = m.rows[k]; return { key: k, label: r.title, description: r.meta, detail: [r.question, ...r.hits.length ? [r.stepTitles.find((t) => r.hits.some((h) => t.toLowerCase().includes(h))) ?? ''] : []].filter(Boolean).join(' · '), alwaysShow: true } })
    // No journey has every word: the ones with any, under one line saying so.
    qp.items = m.fallback ? [{ key: '', label: m.fallback.note, kind: vscode.QuickPickItemKind.Separator }, ...rows] : rows
  }
  qp.onDidChangeValue(fill)
  qp.onDidAccept(() => {
    const it = qp.selectedItems[0]
    qp.hide()
    if (!it) return
    const lj = journeys.list.get(it.key)
    if (lj) void walkJourney(lj)
  })
  qp.onDidHide(() => qp.dispose())
  fill()
  qp.show()
}

export async function sortJourneys(): Promise<void> {
  const cur = listSort()
  const pick = await vscode.window.showQuickPick(SORTS.map((x) => ({ label: x.label, id: x.id, description: x.id === cur ? 'current' : undefined })), { title: 'Sort journeys' })
  if (!pick) return
  await state.update(SORT_KEY, pick.id)
  journeysTree.refresh()
  mapPanel.update()
}

/** The Journeys view; its "In this file" follows the editor (capped again), ranked by the cursor's function, and in view. */
export function createJourneysView(context: vscode.ExtensionContext): void {
  journeysTree = new JourneysTree()
  journeysView = vscode.window.createTreeView('codeNotes.journeys', { treeDataProvider: journeysTree, showCollapseAll: true })
  let spanTimer: NodeJS.Timeout | undefined
  let spanSig = ''
  const followCursor = (editorChanged: boolean) => {
    clearTimeout(spanTimer)
    spanTimer = setTimeout(async () => {
      await updateCursorSpan()
      const sig = `${activeRel()}|${listState.cursorSpan?.start}-${listState.cursorSpan?.end}`
      if (sig === spanSig && !editorChanged) return
      spanSig = sig
      journeysTree.refresh()
      if (mapPanel) mapPanel.update()
      if (editorChanged) revealHereGroup()
    }, editorChanged ? 50 : 300)
  }
  context.subscriptions.push(journeysView, vscode.window.onDidChangeActiveTextEditor(() => { listState.hereAll = false; followCursor(true) }),
    vscode.window.onDidChangeTextEditorSelection((e) => { if (e.textEditor === vscode.window.activeTextEditor) followCursor(false) }))
}

export const showAllHere = () => { listState.hereAll = true; journeysTree.refresh(); mapPanel.update() }
