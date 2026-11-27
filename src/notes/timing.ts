// Waiting for the window: VS Code draws comment widgets a little after the extension asks, and its API says nothing
// when they are there, so a few commands look again until they are. Pure (no vscode).

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** How often a wait looks, and how long it looks for at most (tries × everyMs). */
export interface Poll { tries: number; everyMs: number }

/** Checks `done` up to `poll.tries` times, `poll.everyMs` apart, until it is true. True: it became true. */
export async function waitUntil(done: () => boolean, poll: Poll): Promise<boolean> {
  for (let k = 0; k < poll.tries; k++) {
    if (done()) return true
    await sleep(poll.everyMs)
  }
  return done()
}
