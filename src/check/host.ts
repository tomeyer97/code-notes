// What the understanding check needs from the rest of the extension (src/check/wiring.ts provides it). Inside the
// check each part takes only its slice of it (its own ports, next to the part), never the controller.
import * as vscode from 'vscode'
import type { Note, Store } from '../notes/store'
import type { Check } from './types'
import type { StateStore } from '../platform/state'

/**
 * What the check needs from the rest of the extension, by role. One object has them all: src/check/wiring.ts
 * checkHost builds it from the notes, the threads, the tour and the settings.
 */
export type CheckHost = NotesHost & ClaudeHost & EditorHost & TourHost

/** The notes store and the workspace: the check's threads are notes (threads.ts, grading.ts, concern.ts). */
export interface NotesHost {
  log: vscode.LogOutputChannel
  store: Store
  extUri: vscode.Uri
  /** Per-workspace memory (drafts, applied fixes, TODOs, background runs): platform/state.ts's keys. */
  stored: StateStore
  /** Who writes, as a note's author. */
  me(): string
  now(): string
  newId(): string
  /** After a note was created or changed by the check: unread state, the threads, the list. */
  changed(n: Note, created: boolean): Promise<void>
  /** Adds the person's reply to a note (false: not saved). */
  addReply(n: Note, text: string): Promise<boolean>
  /** The notes' views and threads drawn again. */
  refresh(): void
  /** A new note on these lines with this question, asked to Claude (Ask Claude on a check question; Suggest a fix). */
  askAbout(file: string, start: number, end: number, question: string, extra: Record<string, unknown>): Promise<void>
}

/** Claude Code (writer.ts, grading.ts). */
export interface ClaudeHost {
  /** The `claude` CLI (Claude Code; the agent runner, src/platform/agent/runner.ts), or undefined. Not the understanding CLI (CheckCore's `cli`). */
  cli(): string | undefined
  /** Claude may run here (a trusted folder); says why not otherwise. */
  allowed(what: string): boolean
  model(): string | undefined
  /** The code-journey skill's folder (its journey.py writes the tour), or undefined. */
  journeySkill(): string | undefined
}

/** The editor: where a question's note is shown (controller.ts open). */
export interface EditorHost {
  /** `preserveFocus`: the keyboard stays where it is (the answer box). */
  reveal(n: Note, column?: vscode.ViewColumn, preserveFocus?: boolean): Promise<void>
  /** The note shown last (revealed), if any. */
  revealed(): string | undefined
  /** The caret in the note's reply box. */
  focusReply(n: Note): Promise<boolean>
  /** The view column the code is shown in. */
  codeColumn(): vscode.ViewColumn | undefined
}

/** The check's tour, walked like a journey (controller.ts, writer.ts). */
export interface TourHost {
  /** The check (or none) changed: its tour is shown and walked like a journey (absolute path of the check file). */
  tourChanged(check: Check | undefined, file: string | undefined, branch: string | undefined): Promise<void>
  /** Walks the check's tour (where it was left, else step 1); false when there is none. */
  walkTour(): Promise<boolean>
  /** A question of the tour: its step, then its thread; false when it has no step (then it opens on its own). */
  openInTour(id: string): Promise<boolean>
}
