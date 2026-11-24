// The notes' comment threads: one per note drawn in the editor, its comments, links and buttons.
import * as vscode from 'vscode'
import { Cmd } from '../platform/commands'
import type { WorkspaceEvents } from '../platform/events'
import { registerCommands } from '../platform/registerCommands'
import type { NotesApi } from '../notes/model'
import { ThreadsPorts, check, journeys, tour, useThreadsPorts } from './ports'
import { ThreadContributions, type ThreadContribution } from './rows'
import { claudeAnswering, claudeFailed } from './rows/ask'
import { checkRows } from './rows/check'
import { stepLinkRows } from './rows/stepLink'
import { disposeSettleGate, settleGate } from './settle'
import { useThreadView } from './sync'
import { ThreadView } from './view'

export interface ThreadsFeature {
  /** The note's thread is drawn now. */
  has(id: string): boolean
  /** The threads follow the notes (first: the list and the marks read them) and the editors. */
  follow(model: NotesApi, events: WorkspaceEvents): vscode.Disposable
  /** A feature's rows and say on the threads (after the ones there). */
  contribute(c: ThreadContribution): vscode.Disposable
}

export function activateThreads(context: vscode.ExtensionContext, ports: ThreadsPorts): ThreadsFeature {
  useThreadsPorts(ports)
  const contributions = new ThreadContributions()
  // In the order their rows show: Claude answering, the check, the step link, Claude's failure.
  context.subscriptions.push(
    contributions.add(claudeAnswering),
    contributions.add(checkRows(check, tour)),
    contributions.add(stepLinkRows(journeys, tour)),
    contributions.add(claudeFailed),
  )
  const view = new ThreadView(ports.controller, settleGate(), contributions)
  useThreadView(view)
  context.subscriptions.push(view, { dispose: () => { useThreadView(undefined); disposeSettleGate() } })
  registerCommands(context, {
    [Cmd.expandThread]: (id: string) => view.expand(id),
    [Cmd.collapseThread]: (id: string) => view.collapse(id),
  })
  return {
    has: (id) => view.has(id),
    follow: (model, events) => view.follow(model, events),
    contribute: (c) => contributions.add(c),
  }
}
