// A tree view's redraws and reveals kept in step with what VS Code holds of the tree.
//
// VS Code's extension host keeps the rows it was given until the next redraw, and finds a revealed row there. A reveal
// of a row it doesn't hold makes it ask for the children of the row's parent again and look for the row among them:
// when that parent's children were given before (and so are not asked for again), or another fetch of them is under way,
// or a redraw drops them meanwhile, it logs "Failed to resolve tree node" and the reveal fails. So a reveal goes ahead
// only when VS Code holds the row, or holds its parents and won't ask for the parent's children itself (they were not
// given yet and the parent is folded); and a redraw waits for a reveal under way. VS Code applies a redraw that comes
// within 200 ms of the one before only when that time is up (rows given meanwhile are then dropped): redraws are spaced
// further apart than that. Even so it applies a redraw a little after it is fired (seconds on a busy machine): rows it
// asks for before it asks for the top rows again are of the drawing it is about to drop, so they don't count as held.

import * as vscode from 'vscode'

/** Redraws at least this far apart (VS Code's extension host debounces them by 200 ms). */
const REDRAW_GAP_MS = 250
/** A reveal under way holds a redraw back until VS Code answers it (seconds on a busy machine: a redraw before that
 *  drops the row it is resolving); at most this long, for an answer that never comes (the window closing). */
const REVEAL_HOLDS_MS = 10000
/** A reveal that can't go ahead yet (a redraw due, its rows not drawn yet) is tried again this often, so many times. */
const RETRY_MS = 150
const RETRIES = 8

/** What the parent of a top row is called here (VS Code asks for the top rows with no parent). */
const TOP = Symbol('top')

export class ViewSync<T extends object> {
  private readonly changed = new vscode.EventEmitter<undefined>()
  readonly onDidChangeTreeData = this.changed.event
  /** The rows VS Code was given since the last redraw, and the rows whose children it was given. */
  private readonly held = new Set<T>()
  private readonly opened = new Set<T | typeof TOP>()
  /** VS Code has applied the last redraw: it asked for the top rows since. It applies one up to 200 ms after it is
   *  fired (longer on a busy machine), and rows it asks for before that are of the drawing it is about to drop. */
  private applied = true
  /** What the person expanded (true) or folded (false), by row id: rows are made again, their ids stay. */
  private readonly expanded = new Map<string, boolean>()
  /** The rows' provider (set by `provider`). */
  private rows: vscode.TreeDataProvider<T> | undefined
  private redrawTimer: NodeJS.Timeout | undefined
  private retryTimer: NodeJS.Timeout | undefined
  private revealing: Promise<void> | undefined
  private redrawWaits = false
  private lastRedraw = 0

  /** `wait`: one redraw for a burst of changes this long. `keepFolds`: a row drawn again (after a filter hid it, say)
   *  is expanded or folded as the person left it, not as its row says. */
  constructor(private readonly wait: number, private readonly o: { keepFolds?: boolean } = {}) {}

  /** The provider to give VS Code: `rows`'s, with what VS Code is given noted. (The tests' snapshots call `rows`.) */
  provider(rows: vscode.TreeDataProvider<T>): vscode.TreeDataProvider<T> {
    this.rows = rows
    return {
      onDidChangeTreeData: this.onDidChangeTreeData,
      getTreeItem: (x) => (this.o.keepFolds ? this.asLeft(itemOf(rows, x)) : rows.getTreeItem(x)),
      getParent: (x) => rows.getParent!(x),
      getChildren: (x) => this.given(x, (rows.getChildren(x) ?? []) as T[]),
    }
  }

  /** Follows what the person expands and folds in `view` (by row id). */
  watch(view: vscode.TreeView<T>): vscode.Disposable[] {
    const note = (row: T, open: boolean) => {
      const id = this.rows && itemOf(this.rows, row).id
      if (id) this.expanded.set(id, open)
    }
    return [
      view.onDidExpandElement((e) => note(e.element, true)),
      view.onDidCollapseElement((e) => note(e.element, false)),
    ]
  }

  /** `item` expanded or folded as the person left its row, when they did and it can be. */
  private asLeft(item: vscode.TreeItem): vscode.TreeItem {
    const open = item.id === undefined ? undefined : this.expanded.get(item.id)
    const foldable = item.collapsibleState !== undefined && item.collapsibleState !== vscode.TreeItemCollapsibleState.None
    if (open !== undefined && foldable) item.collapsibleState = open ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
    return item
  }

  private given(parent: T | undefined, children: T[]): T[] {
    if (parent === undefined) this.applied = true
    else if (!this.applied) return children
    this.opened.add(parent ?? TOP)
    for (const c of children) this.held.add(c)
    return children
  }

  /** A redraw, once the burst of changes is over and no reveal is under way. */
  refresh(): void {
    clearTimeout(this.redrawTimer)
    this.redrawTimer = setTimeout(() => { this.redrawTimer = undefined; this.redraw() }, this.wait)
  }

  private redraw(): void {
    if (this.revealing) { this.redrawWaits = true; return }
    const early = this.lastRedraw + REDRAW_GAP_MS - Date.now()
    if (early > 0) { this.redrawTimer = setTimeout(() => { this.redrawTimer = undefined; this.redraw() }, early); return }
    this.lastRedraw = Date.now()
    this.held.clear()
    this.opened.clear()
    this.applied = false
    this.changed.fire(undefined)
  }

  /** Reveals the row `target()` names, once VS Code can find it (tried again a few times); the last reveal asked wins. */
  reveal(
    view: vscode.TreeView<T>, rows: vscode.TreeDataProvider<T>, target: () => T | undefined,
    o: { select?: boolean; focus?: boolean; expand?: boolean }, tries = RETRIES,
  ): void {
    clearTimeout(this.retryTimer)
    if (!view.visible) return
    const node = target()
    if (!node) return
    if (!this.redrawTimer && !this.revealing && this.findable(rows, node)) { this.start(view.reveal(node, o)); return }
    if (tries > 0) this.retryTimer = setTimeout(() => this.reveal(view, rows, target, o, tries - 1), RETRY_MS)
  }

  /** VS Code holds the row and its parents; or holds the parents, and the row's siblings are asked for only by the
   *  reveal (not given yet, and the parent folded: an expanded one's are asked for by the window, at the same time). */
  findable(rows: vscode.TreeDataProvider<T>, node: T): boolean {
    const parents = [...parentsOf(rows, node)]
    if (!parents.every((p) => this.held.has(p))) return false
    if (this.held.has(node)) return true
    return parents.length > 0 && !this.opened.has(parents[0]) && !this.isExpanded(rows, parents[0])
  }

  private isExpanded(rows: vscode.TreeDataProvider<T>, node: T): boolean {
    const item = itemOf(rows, node)
    const known = item.id === undefined ? undefined : this.expanded.get(item.id)
    if (known !== undefined) return known
    return item.collapsibleState === vscode.TreeItemCollapsibleState.Expanded
  }

  /** A reveal under way: a redraw meanwhile waits for VS Code's answer (not longer than REVEAL_HOLDS_MS). */
  private start(reveal: Thenable<void>): void {
    const holds = new Promise<void>((resolve) => setTimeout(resolve, REVEAL_HOLDS_MS))
    const done = Promise.race([Promise.resolve(reveal).then(undefined, () => undefined), holds])
    const revealing = done.then(() => {
      if (this.revealing !== revealing) return
      this.revealing = undefined
      if (this.redrawWaits) { this.redrawWaits = false; this.redraw() }
    })
    this.revealing = revealing
  }
}

/** A row's item (both trees build theirs at once, not as a promise). */
const itemOf = <T>(rows: vscode.TreeDataProvider<T>, node: T) => rows.getTreeItem(node) as vscode.TreeItem

/** A row's parents, nearest first. */
function* parentsOf<T>(rows: vscode.TreeDataProvider<T>, node: T): Generator<T> {
  const parentOf = (x: T) => (rows.getParent?.(x) ?? undefined) as T | undefined
  for (let p = parentOf(node); p !== undefined; p = parentOf(p)) yield p
}
