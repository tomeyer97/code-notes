// The notes' comment threads: one per note drawn in the editor, its comments, links and buttons.
import * as vscode from 'vscode'
import { Cmd } from '../platform/commands'
import type { WorkspaceEvents } from '../platform/events'
import { registerCommands } from '../platform/registerCommands'
import type { NotesApi } from '../notes/model'
import { collapseThread, expandThread } from './comments'
import { ThreadsPorts, useThreadsPorts } from './ports'
import { followNotes, threads } from './sync'

export interface ThreadsFeature {
  /** The note's thread is drawn now. */
  has(id: string): boolean
  /** The threads follow the notes (first: the list and the marks read them) and the editors. */
  follow(model: NotesApi, events: WorkspaceEvents): vscode.Disposable
}

export function activateThreads(context: vscode.ExtensionContext, ports: ThreadsPorts): ThreadsFeature {
  useThreadsPorts(ports)
  registerCommands(context, {
    [Cmd.expandThread]: expandThread,
    [Cmd.collapseThread]: collapseThread,
  })
  return {
    has: (id) => threads.has(id),
    follow: (model, events) => followNotes(model, events),
  }
}
