// Calls that wait for a burst to end, one timer per key: the last call per key wins. What the call does goes through
// run.ts's policy (a failure is logged with `what`). No vscode here: unit-tested.
import { fireAndForget } from './run'

export class Debouncer<K = string> {
  private readonly timers = new Map<K, ReturnType<typeof setTimeout>>()

  /** `what`: for the log line when a call fails. */
  constructor(private readonly what: string) {}

  /** `fn` runs in `ms`; this key's earlier call, if still waiting, is dropped. */
  later(key: K, ms: number, fn: () => unknown): void {
    this.cancel(key)
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key)
      fireAndForget(fn, this.what)
    }, ms))
  }

  /** This key's waiting call, if any, is dropped. */
  cancel(key: K): void {
    clearTimeout(this.timers.get(key))
    this.timers.delete(key)
  }

  /** A call is waiting for this key. */
  waiting(key: K): boolean { return this.timers.has(key) }

  /** Every waiting call is dropped. */
  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }
}
