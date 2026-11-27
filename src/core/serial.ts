// Jobs run one at a time, two policies for the calls made while one runs (test/serial.test.ts shows them side by side):
// - Coalesced: every waiting call shares ONE more run (a refresh asked for five times runs twice).
// - LatestWins: only the newest waiting value runs next, the others are dropped (a drag across a timeline moves once).
// No vscode here: unit tests use it as is.

/**
 * Runs `job` one at a time. A call while it runs doesn't start another run each: all such calls share ONE next run,
 * which starts when the current one ends (forced when any of them asked for it). Each call's promise settles after a
 * run that started after the call.
 */
export class Coalesced {
  private running: Promise<void> | undefined
  private next: { force: boolean; p: Promise<void> } | undefined
  constructor(private job: (force: boolean) => Promise<void>) {}

  run(force: boolean): Promise<void> {
    if (this.next) { this.next.force ||= force; return this.next.p }
    if (!this.running) return this.start(force)
    const n = { force, p: Promise.resolve() }
    const go = () => { this.next = undefined; return this.start(n.force) }
    n.p = this.running.then(go, go)
    this.next = n
    return n.p
  }

  get busy(): boolean { return !!this.running }

  private start(force: boolean): Promise<void> {
    const p: Promise<void> = Promise.resolve()
      .then(() => this.job(force))
      .finally(() => {
        if (this.running === p) this.running = undefined
      })
    this.running = p
    return p
  }
}

/**
 * Runs `job` on the newest value only: one job at a time; values pushed while one runs replace each other, and only
 * the last of them runs next (a drag across the timeline, keys held down: the journey moves once, to where it ended).
 * `current(v)` tells a running job whether it is still the newest one (a superseded job stops early).
 */
export class LatestWins<T> {
  private running = false
  private pending: { v: T } | undefined
  private gen = 0
  constructor(private job: (v: T, current: () => boolean) => Promise<void>) {}

  push(v: T): void {
    this.gen++
    if (this.running) { this.pending = { v }; return }
    // run() catches each job's failure itself (the job logs it): it never rejects.
    this.run(v).then(undefined, () => undefined)
  }

  get busy(): boolean { return this.running }

  /** Settles once nothing runs or waits (tests). */
  async idle(): Promise<void> {
    while (this.running) await new Promise((r) => setTimeout(r, 5))
  }

  private async run(v: T): Promise<void> {
    this.running = true
    let next: { v: T } | undefined = { v }
    while (next) {
      const mine = this.gen
      const now = next.v
      next = undefined
      try { await this.job(now, () => mine === this.gen) } catch { /* the job logs its own errors */ }
      next = this.pending
      this.pending = undefined
    }
    this.running = false
  }
}
