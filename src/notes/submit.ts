// Ctrl+Enter twice in a comment box: the box keeps its text until the command returns, so a second press while the
// first is being saved must not make a second note or reply. Pure (no vscode).

/** Runs one job per key at a time: a second `run` with a key whose job is still running does nothing. */
export class OncePerSubmit<K> {
  private readonly busy = new Set<K>()

  /** `fn`'s result; undefined when the same key is already being submitted. */
  async run<T>(key: K, fn: () => Promise<T>): Promise<T | undefined> {
    if (this.busy.has(key)) return undefined
    this.busy.add(key)
    try { return await fn() } finally { this.busy.delete(key) }
  }
}
