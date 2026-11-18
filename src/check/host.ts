// What the understanding check needs from the rest of the extension (src/check/wiring.ts provides it), and the parts
// of VS Code's git extension API it listens to.
import * as vscode from 'vscode'
import type { Note, Store } from '../store'
import type { Check } from './types'

/**
 * What the check needs from the rest of the extension, by role. One object has them all: src/check/wiring.ts
 * createUnderstanding builds it from the notes, the threads, the tour and the settings.
 */
export type CheckHost = NotesHost & ClaudeHost & EditorHost & TourHost

/** The notes store and the workspace: the check's threads are notes (threads.ts, grading.ts, concern.ts). */
export interface NotesHost {
  log: vscode.LogOutputChannel
  store: Store
  extUri: vscode.Uri
  /** Per-workspace memory (drafts, applied fixes, TODOs, background runs). */
  memento: vscode.Memento
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
  /** The `claude` CLI (Claude Code; src/claudeCli.ts findCli), or undefined. Not the understanding CLI (controller's `cli`). */
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

/** The check's tour, walked like a journey, and the journeys list (controller.ts, writer.ts). */
export interface TourHost {
  /** The check (or none) changed: its tour is shown and walked like a journey (absolute path of the check file). */
  tourChanged(check: Check | undefined, file: string | undefined, branch: string | undefined): Promise<void>
  /** Walks the check's tour (where it was left, else step 1); false when there is none. */
  walkTour(): Promise<boolean>
  /** A question of the tour: its step, then its thread; false when it has no step (then it opens on its own). */
  openInTour(id: string): Promise<boolean>
  /** The check's row in the journeys list changed (and what the editor shows around it: lenses). */
  listChanged(): void
}

/** The parts of VS Code's git extension API used here. */
export interface GitRepo {
  rootUri: vscode.Uri
  state: { HEAD?: { name?: string; commit?: string; upstream?: unknown; ahead?: number }; onDidChange: vscode.Event<void> }
}
export interface GitApi { repositories: GitRepo[]; onDidOpenRepository: vscode.Event<GitRepo> }
