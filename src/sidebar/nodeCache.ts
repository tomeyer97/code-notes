// One object per row key for a tree view: TreeView.reveal finds a row by identity, so a row made again for the same key
// must be the object VS Code was given. Rows not made again during a whole drawing are forgotten. No vscode here.

export class NodeCache<N extends object> {
  private readonly rows = new Map<string, N>()
  /** The keys asked for since the last sweep. */
  private used = new Set<string>()

  /** The row for `key`: the object made before (its fields now `fresh`'s), or `fresh` the first time. */
  get<T extends N>(key: string, fresh: T): T {
    this.used.add(key)
    const old = this.rows.get(key)
    if (!old) { this.rows.set(key, fresh); return fresh }
    for (const k of Object.keys(old)) Reflect.deleteProperty(old, k)
    return Object.assign(old, fresh)
  }

  /** Called when a drawing starts: the rows not asked for since the one before are dropped. */
  sweep(): void {
    for (const key of [...this.rows.keys()]) if (!this.used.has(key)) this.rows.delete(key)
    this.used = new Set()
  }

  get size(): number { return this.rows.size }
}
