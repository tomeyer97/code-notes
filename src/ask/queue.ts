// The notes Claude is answering, the ones waiting their turn, and the ones it couldn't answer (kept, also over a
// reload, until retried or dismissed). One owner for all three; the UI reads a note's state and is told of changes.
import * as vscode from 'vscode'
import type { AgentRun } from '../platform/agent/agent'

export type AskState = 'queued' | 'running' | 'failed'

/** A note Claude is answering: the answer so far, what Claude is doing, and the run (to cancel it). */
export interface AskRun {
  text: string
  activity?: string
  started: number
  run?: AgentRun
  cancelled?: boolean
}

/** Where the failures are kept over a reload. */
export interface FailureStore {
  load(): Record<string, string>
  save(failures: Record<string, string>): void
}

export class AskQueue implements vscode.Disposable {
  private readonly waiting: { id: string; since: number }[] = []
  private readonly running = new Map<string, AskRun>()
  private readonly failures: Map<string, string>
  private readonly changed = new vscode.EventEmitter<string>()
  /** A note's state changed (its id). */
  readonly onDidChange = this.changed.event

  /** `max`: runs at once; more wait their turn. */
  constructor(private readonly store: FailureStore, private readonly max: number) {
    this.failures = new Map(Object.entries(store.load()))
  }

  state(id: string): AskState | undefined {
    if (this.running.has(id)) return 'running'
    if (this.waiting.some((w) => w.id === id)) return 'queued'
    return this.failures.has(id) ? 'failed' : undefined
  }

  /** Running or waiting. */
  busy(id: string): boolean {
    const s = this.state(id)
    return s === 'running' || s === 'queued'
  }

  /** How many notes are running or waiting. */
  get size(): number { return this.running.size + this.waiting.length }

  run(id: string): AskRun | undefined { return this.running.get(id) }

  /** Since when note `id` waits its turn. */
  queuedSince(id: string): number | undefined { return this.waiting.find((w) => w.id === id)?.since }

  failure(id: string): string | undefined { return this.failures.get(id) }

  /** Note `id` runs now (true), or waits its turn (false). A failure it had is forgotten. */
  add(id: string): boolean {
    this.forget(id)
    if (this.running.size < this.max) return true
    this.waiting.push({ id, since: Date.now() })
    this.changed.fire(id)
    return false
  }

  /** The next note waiting, if any (it leaves the queue). */
  next(): string | undefined { return this.waiting.shift()?.id }

  /** Note `id` starts running. */
  start(id: string): AskRun {
    const run: AskRun = { text: '', activity: 'Starting Claude…', started: Date.now() }
    this.running.set(id, run)
    this.changed.fire(id)
    return run
  }

  /** Note `id` is done running (or waiting). */
  finish(id: string): void {
    const i = this.waiting.findIndex((w) => w.id === id)
    if (i >= 0) this.waiting.splice(i, 1)
    if (this.running.delete(id) || i >= 0) this.changed.fire(id)
  }

  /** Note `id` failed: `why`, kept until retried or dismissed. */
  fail(id: string, why: string): void {
    this.running.delete(id)
    this.failures.set(id, why)
    this.saveFailures()
    this.changed.fire(id)
  }

  /** A failure dismissed (true when there was one). */
  dismiss(id: string): boolean {
    if (!this.forget(id)) return false
    this.changed.fire(id)
    return true
  }

  /** The window closes: nothing waiting starts any more. */
  dispose(): void {
    this.waiting.length = 0
    this.changed.dispose()
  }

  private forget(id: string): boolean {
    if (!this.failures.delete(id)) return false
    this.saveFailures()
    return true
  }

  private saveFailures(): void { this.store.save(Object.fromEntries(this.failures)) }
}
