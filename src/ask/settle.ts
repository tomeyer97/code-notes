// When each note's last Claude run ended. An Ask right after it, with nothing said since, is a click meant for Stop
// (the title's Ask and Stop swap under the pointer when an answer lands), not a new question. No vscode API here
// (unit-tested in test/claude.test.ts).

/** How long after a run ends an Ask with nothing new is ignored. */
export const SETTLE_MS = 1000

export class RunEnds {
  private readonly ends = new Map<string, { at: number; messages: number }>()

  constructor(private readonly clock: () => number = Date.now) {}

  /** Note `id`'s run is over (answered, stopped or failed); the note has `messages` messages now. */
  ended(id: string, messages: number): void { this.ends.set(id, { at: this.clock(), messages }) }

  /** An Ask on note `id` (now with `messages` messages) that lands within SETTLE_MS of its run ending, nothing said since. */
  tooSoon(id: string, messages: number): boolean {
    const e = this.ends.get(id)
    return !!e && e.messages === messages && this.clock() - e.at < SETTLE_MS
  }
}
