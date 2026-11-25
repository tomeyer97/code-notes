// The integration tests' waits. Each wait is a poll for a condition (`waiter`, `untilEqual`, `untilAll`) or a fixed
// wait that says why (`quiet`, `settle`); every one is scaled by SCALE. No VS Code API here (unit-tested).
import assert from 'assert'
import { testEnv } from './testEnv'

/** Module-private: a fixed wait goes through `quiet` or `settle`, which scale it and say why. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Waits are tuned for a fast machine; CI (or CODE_NOTES_TIMEOUT_SCALE=n) gives every wait n times longer. */
export const SCALE = testEnv.timeoutScale

/** How often a wait looks again: fast enough not to slow a test down, slow enough not to load the extension host. */
export const POLL_MS = 100

/** How long a wait waits by default (× SCALE): the extension answers most actions well inside it on a fast machine. */
export const WAIT_MS = 6000

/** How much of a wait's state dump is printed on a timeout (enough to see the state, short enough to read). */
const DUMP_CHARS = 3000

export type Until = <T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, ms?: number) => Promise<T>

/**
 * A wait for a condition: polls `fn` every POLL_MS until it returns something truthy (which it returns), or throws
 * "timed out waiting for: <what>" after `ms` × SCALE. `ms` defaults to the waiter's; `dump`, when given, is printed on
 * a timeout (the state the condition was looking at). A condition of several clauses: `untilAll`, which says which
 * one is still false.
 */
export function waiter(defaults: { ms?: number; dump?: () => unknown; scale?: number } = {}): Until {
  const scale = defaults.scale ?? SCALE
  return async (what, fn, ms = defaults.ms ?? WAIT_MS) => {
    const t0 = Date.now()
    for (;;) {
      const v = await fn()
      if (v) return v
      if (Date.now() - t0 > ms * scale) {
        if (defaults.dump) console.log('state:', JSON.stringify(defaults.dump(), null, 1)?.slice(0, DUMP_CHARS))
        throw new Error(`timed out waiting for: ${what}`)
      }
      await sleep(POLL_MS)
    }
  }
}

/**
 * Waits until every clause is true; on a timeout the error names the clauses still false ("timed out waiting for:
 * <what> (still false: saved, shown)"), where one `until` over `a && b && c` only says it timed out.
 */
export async function untilAll(what: string, clauses: Record<string, () => unknown | Promise<unknown>>, ms = WAIT_MS, scale = SCALE): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    const failing: string[] = []
    for (const [name, clause] of Object.entries(clauses)) {
      let ok = false
      try { ok = !!(await clause()) } catch { ok = false }
      if (!ok) failing.push(name)
    }
    if (!failing.length) return
    if (Date.now() - t0 > ms * scale) throw new Error(`timed out waiting for: ${what} (still false: ${failing.join(', ')})`)
    await sleep(POLL_MS)
  }
}

/**
 * Waits until `get()` deep-equals `want`; on a timeout the failure shows both (where `until` with several clauses
 * joined by && only says it timed out).
 */
export async function untilEqual<T>(what: string, get: () => T, want: T, ms = WAIT_MS, scale = SCALE): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    let got: T | undefined
    try { got = get() } catch { got = undefined }
    try { assert.deepStrictEqual(got, want); return } catch { /* not yet */ }
    if (Date.now() - t0 > ms * scale) assert.deepStrictEqual(got, want, `timed out waiting for: ${what}`)
    await sleep(POLL_MS)
  }
}

/**
 * A fixed wait before asserting that something did NOT happen (no write, no event, no second message): there is no
 * condition to wait for, only time for a wrong reaction to show up. `ms` is how long the extension would take to
 * react (its debounces are 300-500 ms), scaled by SCALE like every wait; `what` says what must not happen.
 */
export async function quiet(ms: number, what: string): Promise<void> {
  void what
  await sleep(ms * SCALE)
}

/**
 * A fixed wait for something VS Code gives no event for (a reveal's own delayed scrolls, a view laying itself out,
 * focus moving between groups), scaled by SCALE. `why` says what is being waited for.
 */
export async function settle(ms: number, why: string): Promise<void> {
  void why
  await sleep(ms * SCALE)
}

/** @deprecated An unscaled wait with no reason: use `settle(ms, why)` or `quiet(ms, what)`. Kept for its callers. */
export const unscaledSleep = sleep
