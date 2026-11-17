// The check's per-question memory in the workspace's memento: one entry per kind (drafts, applied fixes, TODOs), each
// a record per scope (a branch, or a check file), each a record per question.
import * as vscode from 'vscode'

export class PerScope<T> {
  constructor(private memento: vscode.Memento, private key: string) {}

  /** The scope's record ({} when there is no scope or nothing stored). */
  get(scope: string | undefined): Record<string, T> {
    return (scope === undefined ? undefined : this.all()[scope]) ?? {}
  }
  /** Sets (or, `v` undefined, removes) question `id`'s value in the scope. */
  async set(scope: string, id: string, v: T | undefined): Promise<void> {
    const all = this.all()
    const mine = { ...(all[scope] ?? {}) }
    if (v === undefined) delete mine[id]
    else mine[id] = v
    await this.memento.update(this.key, { ...all, [scope]: mine })
  }
  /** Replaces the scope's whole record. */
  async replace(scope: string, record: Record<string, T>): Promise<void> {
    await this.memento.update(this.key, { ...this.all(), [scope]: record })
  }

  private all(): Record<string, Record<string, T>> { return this.memento.get<Record<string, Record<string, T>>>(this.key) ?? {} }
}
