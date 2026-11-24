// The chord keys D and A: Ctrl+' (or Ctrl+<) then D or A step through whatever has the key now. Each feature
// registers what it steps (ChordSteppers.register, by priority: a podcast's transport, the walk, the check's open
// questions, then unread replies); this file only asks them in order.
import type * as vscode from 'vscode'
import type { Stepper, Steppers } from './platform/chordKey'

export class ChordSteppers implements Steppers {
  private readonly list: { priority: number; stepper: Stepper }[] = []

  /** `prefixUsed`: told what a chord key's command was passed (hints then show the prefix pressed). */
  constructor(private readonly prefixUsed: (a: unknown) => void) {}

  register(priority: number, stepper: Stepper): vscode.Disposable {
    const entry = { priority, stepper }
    this.list.push(entry)
    this.list.sort((a, b) => a.priority - b.priority)
    return {
      dispose: () => {
        const i = this.list.indexOf(entry)
        if (i >= 0) this.list.splice(i, 1)
      },
    }
  }

  /** D (1) or A (-1): the first stepper that takes the key (its step, to wait for). */
  step(dir: 1 | -1, a?: unknown): unknown {
    this.prefixUsed(a)
    for (const { stepper } of this.list) {
      const took = stepper.step(dir)
      if (took !== false) return took
    }
    return undefined
  }
}
