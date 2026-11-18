// Run one job at a time; the calls made meanwhile share one more run. No vscode here: unit tests use it as is.

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
