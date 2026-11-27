// What the journey files' loader decides without touching a file: why a file is not listed, and waiting for one to
// be. No vscode here: unit-tested (test/journeyFileStates.test.ts).
import { isOldFormat } from '../core/format/journeyModel'

/** A journey file the parser refused: in the old format (v1, steps as notes), or broken (half-written, most likely). */
export type Unreadable = 'oldFormat' | 'broken'

export const classifyUnreadable = (why: string): Unreadable => (isOldFormat(why) ? 'oldFormat' : 'broken')

/** The dimmed row of a journey file that was never readable; `why`: the parser's words. */
export function invalidRow(kind: Unreadable, why: string): string {
  return kind === 'oldFormat' ? 'Old format (v1): migrate it with journey.py migrate.' : `Can't read it: ${why}.`
}

/** What a listed journey says once its file can't be read any more (the parser's words are in the Output panel). */
export const SHOWING_LAST_GOOD = "Can't read this journey's file; showing its last good version."

/**
 * Resolves with `get()` once it gives something: now, or after one of `onChange`'s events; undefined after `ms`.
 * The readiness of a journey file just written, instead of polling for it.
 */
export function whenThere<T>(
  get: () => T | undefined, onChange: (listener: () => void) => { dispose(): unknown }, ms: number,
): Promise<T | undefined> {
  const now = get()
  if (now !== undefined) return Promise.resolve(now)
  return new Promise((resolve) => {
    const done = (v: T | undefined) => {
      clearTimeout(timer)
      sub.dispose()
      resolve(v)
    }
    const timer = setTimeout(() => done(undefined), ms)
    const sub = onChange(() => {
      const v = get()
      if (v !== undefined) done(v)
    })
  })
}
