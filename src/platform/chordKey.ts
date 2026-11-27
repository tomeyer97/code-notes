// The chord prefix as hints name it: Ctrl+' then a plain letter. Both prefixes (Ctrl+' and, on ISO keyboards, Ctrl+<)
// run the same commands; hints show the one last used, Ctrl+' until then (it exists on every layout). chords.ts sets
// it from the key pressed; what shows a hint reads `chordKey()` and repaints on `onDidChangeChordKey`.
import * as vscode from 'vscode'
import { fireAndForget } from './run'
import { STATE, StateStore } from './state'

/** The prefix a chord key's command passes (package.json's keybindings: `args.prefix`). */
export type ChordPrefix = "'" | '<'

let key = "Ctrl+'"
let stored: StateStore | undefined
let changed: vscode.EventEmitter<string> | undefined

/** The prefix to show in hints: "Ctrl+'" or "Ctrl+<". */
export const chordKey = () => key

/** Reads the prefix last used (stored for every workspace); the event goes with the extension. */
export function startChordKey(context: vscode.ExtensionContext, state: StateStore): void {
  stored = state
  changed = new vscode.EventEmitter<string>()
  context.subscriptions.push(changed)
  key = state.get(STATE.chordPrefix) ?? key
}

/** Hints name another prefix now. */
export const onDidChangeChordKey: vscode.Event<string> = (listener, thisArg, disposables) => {
  if (!changed) throw new Error('Code Notes: chord key read before the extension started')
  return changed.event(listener, thisArg, disposables)
}

/** What a chord key's command is passed (package.json's keybindings). */
export interface ChordArgs { prefix?: ChordPrefix }

const isChordArgs = (a: unknown): a is ChordArgs => !!a && typeof a === 'object' && 'prefix' in a

/** A chord key passes which prefix was pressed: hints show that one from now on. Anything else (a menu, a link) is
 *  no chord: nothing changes. */
export function prefixUsed(a: unknown): void {
  const p = isChordArgs(a) ? a.prefix : undefined
  if (p === "'" || p === '<') useChordPrefix(p)
}

/** A chord key's command: says which prefix was pressed, then runs. */
export const chord = <R>(fn: () => R) => (a?: unknown): R => { prefixUsed(a); return fn() }

/** The prefix pressed: hints show it from now on (stored; every hint repaints). */
export function useChordPrefix(p: ChordPrefix): void {
  const k = `Ctrl+${p}`
  if (k === key) return
  key = k
  if (stored) fireAndForget(stored.set(STATE.chordPrefix, k), 'chords: store chordPrefix')
  changed?.fire(k)
}

/**
 * Who D (next) and A (previous) step through: the first registered whose `step` takes the key, by `priority` (lowest
 * first). A feature registers its own (the podcast, the walk, the check's questions, unread replies).
 */
export interface Stepper {
  /** Steps `dir` when this feature has the key now (true, or the step's promise); false: the next one is asked. */
  step(dir: 1 | -1): boolean | PromiseLike<unknown>
}

/** Which feature is asked for D / A first: lower goes first. */
export const STEP_PRIORITY = {
  /** A podcast on the map's parts (Intro, Recap) or playing: D is its ⏭ (one transport). */
  podcast: 10,
  /** A walk running: its next step. */
  walk: 20,
  /** Questions of a check still open (unread replies wait until the check is done). */
  check: 30,
  /** Else the next unread reply, as the status bar says. */
  unread: 40,
} as const

export interface Steppers {
  register(priority: number, stepper: Stepper): vscode.Disposable
}
