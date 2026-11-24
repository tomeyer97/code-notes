import type * as vscode from 'vscode'

// A record kept in VS Code's workspace state, by key. No vscode API at run time (only its types).

/** A record kept in workspace state across reloads (no state, in tests: always empty). */
export class Kept<T> {
  constructor(private state: vscode.Memento | undefined, private key: string) {}

  all(): Record<string, T> { return this.state?.get<Record<string, T>>(this.key) ?? {} }

  get(k: string): T | undefined { return this.all()[k] }

  /** `undefined` drops `k`. */
  async set(k: string, v: T | undefined): Promise<void> {
    const all = { ...this.all() }
    if (v !== undefined) all[k] = v
    else if (k in all) delete all[k]
    else return
    await this.state?.update(this.key, all)
  }
}
