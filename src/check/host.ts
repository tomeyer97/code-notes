// What the understanding check needs from the rest of the extension (extension.ts provides it), and the parts of VS
// Code's git extension API it listens to.
import * as vscode from 'vscode'
import type { Note, Store } from '../store'
import type { Check } from '../checkModel'

/** What the check needs from the rest of the extension (extension.ts). */
export interface CheckHost {
  log: vscode.LogOutputChannel
  store: Store
  extUri: vscode.Uri
  /** Per-workspace memory (the .gitattributes offer). */
  memento: vscode.Memento
  me(): string
  now(): string
  newId(): string
  /** The `claude` CLI (Claude Code), or undefined. Not the understanding CLI (Understanding.cli). */
  cli(): string | undefined
  /** Claude may run here (a trusted folder); says why not otherwise. */
  allowed(what: string): boolean
  model(): string | undefined
  /** After a note was created or changed by the check: unread state, the threads, the list. */
  changed(n: Note, created: boolean): Promise<void>
  /** Adds the person's reply to a note (false: not saved). */
  addReply(n: Note, text: string): Promise<boolean>
  resolve(n: Note): Promise<void>
  /** `preserveFocus`: the keyboard stays where it is (the answer box). */
  reveal(n: Note, column?: vscode.ViewColumn, preserveFocus?: boolean): Promise<void>
  /** The note shown last (revealed), if any. */
  revealed(): string | undefined
  /** The caret in the note's reply box. */
  focusReply(n: Note): Promise<boolean>
  refresh(): void
  /** The view column the code is shown in. */
  codeColumn(): vscode.ViewColumn | undefined
  /** The check's row in the journeys list changed (and what the editor shows around it: lenses). */
  listChanged?(): void
  /** A new note on these lines with this question, asked to Claude (Ask Claude on a check question). */
  askAbout(file: string, start: number, end: number, question: string, extra: Record<string, unknown>): Promise<void>
  /** The code-journey skill's folder (its journey.py writes the tour), or undefined. */
  journeySkill?(): string | undefined
  /** The check (or none) changed: its tour is shown and walked like a journey (absolute path of the check file). */
  tourChanged?(check: Check | undefined, file: string | undefined, branch: string | undefined): Promise<void>
  /** Walks the check's tour (where it was left, else step 1); false when there is none. */
  walkTour?(): Promise<boolean>
  /** A question of the tour: its step, then its thread; false when it has no step (then it opens on its own). */
  openInTour?(id: string): Promise<boolean>
  /** After a pass: the walk is at this question, so it goes on to the next stop; false when no walk is there. */
  tourNext?(id: string): Promise<boolean>
}

/** The parts of VS Code's git extension API used here. */
export interface GitRepo {
  rootUri: vscode.Uri
  state: { HEAD?: { name?: string; commit?: string; upstream?: unknown; ahead?: number }; onDidChange: vscode.Event<void> }
}
export interface GitApi { repositories: GitRepo[]; onDidOpenRepository: vscode.Event<GitRepo> }
