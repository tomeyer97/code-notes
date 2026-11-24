// The extension's error and async policy, in one place. Work nobody waits for goes through `fireAndForget` (or `run`),
// so a failure is logged with what was being done instead of becoming an unhandled rejection that no one sees. An
// error the person must see is shown as an error (`showError`), and is in the Output channel too. ESLint keeps it so
// (`no-floating-promises`, `void` included).
//
// No vscode at run time: activate hands over the Output channel and the window (`useWindow`); unit tests a fake.
import type * as vscode from 'vscode'

/** Where failures go: the Output channel and the window's error message. */
export interface Window {
  log: Pick<vscode.LogOutputChannel, 'error' | 'warn' | 'debug'>
  showErrorMessage(text: string, ...items: string[]): Thenable<string | undefined>
}

/** Until activate hands over the window: the console (an error before that is still not lost). */
let win: Window = {
  log: { error: (m: unknown) => console.error(m), warn: (m: unknown) => console.warn(m), debug: () => undefined },
  showErrorMessage: () => Promise.resolve(undefined),
}

export function useWindow(w: Window): void { win = w }

/** What every message the extension shows starts with (the Output channel is Code Notes' own: no prefix there). */
export const PREFIX = 'Code Notes: '

/** Shows `text` as an error (with PREFIX) and logs it; resolves to the button clicked. */
export function showError(text: string, ...items: string[]): Thenable<string | undefined> {
  win.log.error(text)
  return win.showErrorMessage(PREFIX + text, ...items)
}

/**
 * How a failure is surfaced: 'silent' (expected, e.g. a window closed meanwhile: debug log only), 'log' (an error in
 * the Output channel), 'toast' (also shown as an error).
 */
export type Surface = 'silent' | 'log' | 'toast'

export interface RunOptions {
  /** What was being done, for the log line: `what: error`. */
  what: string
  /** Default 'log'. */
  surface?: Surface
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Reports a failure the way `surface` says. */
export function report(e: unknown, o: RunOptions): void {
  const line = `${o.what}: ${messageOf(e)}`
  const surface = o.surface ?? 'log'
  if (surface === 'silent') win.log.debug(line)
  else if (surface === 'log') win.log.error(line)
  else showError(line).then(undefined, () => undefined) // the window itself is going away: nothing left to tell
}

/** Runs `task` (a promise, or a function that returns a value or a promise); a failure is reported, never thrown:
 *  resolves to undefined then. */
export async function run<T>(task: PromiseLike<T> | (() => T | PromiseLike<T>) | undefined, o: RunOptions): Promise<T | undefined> {
  try {
    return await (typeof task === 'function' ? task() : task)
  } catch (e) {
    report(e, o)
    return undefined
  }
}

/** Starts `task` and does not wait for it; a failure is reported (see `run`). Undefined (`x?.post()`): nothing. */
export function fireAndForget(task: PromiseLike<unknown> | (() => unknown) | undefined, what: string, surface: Surface = 'log'): void {
  // run() never rejects: there is nothing left to handle here.
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  void run(task, { what, surface })
}
