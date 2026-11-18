// A tree view's redraws and reveals kept in step with what VS Code holds of the tree.
//
// VS Code's extension host keeps the rows it was given until the next redraw, and finds a revealed row there. A reveal
// of a row it doesn't hold makes it ask for the children of the row's parent again and look for the row among them:
// when that parent's children were given before (and so are not asked for again), or another fetch of them is under way,
// or a redraw drops them meanwhile, it logs "Failed to resolve tree node" and the reveal fails. So a reveal goes ahead
// only when VS Code holds the row, or holds its parents and won't ask for the parent's children itself (they were not
// given yet and the parent is folded); and a redraw waits for a reveal under way. VS Code applies a redraw that comes
// within 200 ms of the one before only when that time is up (rows given meanwhile are then dropped): redraws are spaced
// further apart than that, so each is applied as it is fired.

import * as vscode from 'vscode'

/** Redraws at least this far apart (VS Code's extension host debounces them by 200 ms). */
const REDRAW_GAP_MS = 250
/** A reveal under way holds a redraw back at most this long. */
const REVEAL_HOLDS_MS = 1000
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
  /** Rows the person expanded (true) or folded (false) since they were drawn. */
  private readonly expanded = new WeakMap<T, boolean>()
  private redrawTimer: NodeJS.Timeout | undefined
  private retryTimer: NodeJS.Timeout | undefined
  private revealing: Promise<void> | undefined
  private redrawWaits = false
  private lastRedraw = 0

  /** `wait`: one redraw for a burst of changes this long. */
  constructor(private readonly wait: number) {}

  /** The provider to give VS Code: `rows`'s, with what VS Code is given noted. (The tests' snapshots call `rows`.) */
  provider(rows: vscode.TreeDataProvider<T>): vscode.TreeDataProvider<T> {
    return {
      onDidChangeTreeData: this.onDidChangeTreeData,
      getTreeItem: (x) => rows.getTreeItem(x),
      getParent: (x) => rows.getParent!(x),
      getChildren: (x) => this.given(x, (rows.getChildren(x) ?? []) as T[]),
    }
  }

  /** Follows what the person expands and folds in `view`. */
  watch(view: vscode.TreeView<T>): vscode.Disposable[] {
    return [
      view.onDidExpandElement((e) => this.expanded.set(e.element, true)),
      view.onDidCollapseElement((e) => this.expanded.set(e.element, false)),
    ]
  }

  private given(parent: T | undefined, children: T[]): T[] {
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
    this.changed.fire(undefined)
  }

  /** Reveals the row `target()` names, once VS Code can find it (tried again a few times); the last reveal asked wins. */
  reveal(view: vscode.TreeView<T>, rows: vscode.TreeDataProvider<T>, target: () => T | undefined, o: { select?: boolean; focus?: boolean; expand?: boolean }, tries = RETRIES): void {
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
    const parents: T[] = []
    for (let p = rows.getParent!(node) as T | undefined; p; p = rows.getParent!(p) as T | undefined) parents.push(p)
    if (!parents.every((p) => this.held.has(p))) return false
    if (this.held.has(node)) return true
    return parents.length > 0 && !this.opened.has(parents[0]) && !this.isExpanded(rows, parents[0])
  }

  private isExpanded(rows: vscode.TreeDataProvider<T>, node: T): boolean {
    const known = this.expanded.get(node)
    if (known !== undefined) return known
    return (rows.getTreeItem(node) as vscode.TreeItem).collapsibleState === vscode.TreeItemCollapsibleState.Expanded
  }

  /** A reveal under way: a redraw meanwhile waits for it (not longer than REVEAL_HOLDS_MS). */
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
