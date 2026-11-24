// Notes another feature asks about in its own way (the understanding check's questions: what was typed is a question
// about the code, answered in a note of its own). Ask Claude and its reply box hand those notes to the feature, and
// a feature adds its own hints to the prompt of notes it asked about.
import type * as vscode from 'vscode'
import type { Note } from '../notes/store'

export interface AskHandler {
  /** This note is the feature's: its asks go to `ask`. */
  owns(n: Note): boolean
  /** Ask about `n`; `text`: what was typed in its reply box, if anything. */
  ask(n: Note, text?: string): Promise<void>
  /** What the feature adds to the prompt of any note Claude answers (e.g. a note asked from the feature), or ''. */
  hint?(n: Note): string
}

const handlers = new Set<AskHandler>()

/** `h` takes the asks on its notes until disposed. */
export function handleAsks(h: AskHandler): vscode.Disposable {
  handlers.add(h)
  return { dispose: () => handlers.delete(h) }
}

/** The feature that asks about `n` itself, if any. */
export const askHandlerOf = (n: Note): AskHandler | undefined => [...handlers].find((h) => h.owns(n))

/** The hints every feature adds to note `n`'s prompt. */
export const askHints = (n: Note): string => [...handlers].map((h) => h.hint?.(n) ?? '').join('')
