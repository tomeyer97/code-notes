// How long to wait before dialling a controller again: 1 s, doubling to at most 30 s; back to 1 s once a connection
// opened. (A controller that is starting up is found within a second; one that is gone costs a dial every 30 s.)

export const FIRST_DELAY_MS = 1_000
export const MAX_DELAY_MS = 30_000

export class Backoff {
  private failures = 0

  /** The wait before the next dial, counting this failure. */
  next(): number {
    const ms = Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * 2 ** this.failures)
    this.failures++
    return ms
  }

  /** A connection opened: the next failure waits the first delay again. */
  reset(): void { this.failures = 0 }
}
