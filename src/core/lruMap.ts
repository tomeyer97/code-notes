// A Map that keeps at most `max` entries: setting one more drops the one least recently set or read. For the
// extension's caches, so each states its limit in one line. No vscode here: unit-tested.

export class LruMap<K, V> {
  private readonly map = new Map<K, V>()

  constructor(readonly max: number) {}

  get size(): number { return this.map.size }

  /** The value, now the most recently used. */
  get(k: K): V | undefined {
    if (!this.map.has(k)) return undefined
    const v = this.map.get(k) as V
    this.map.delete(k)
    this.map.set(k, v)
    return v
  }

  has(k: K): boolean { return this.map.has(k) }

  set(k: K, v: V): this {
    this.map.delete(k)
    this.map.set(k, v)
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K)
    return this
  }

  delete(k: K): boolean { return this.map.delete(k) }

  clear(): void { this.map.clear() }
}
