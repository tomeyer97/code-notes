// Asking Claude about a note: the commands, the answer written into its thread, the status bar item while it runs.
import * as vscode from 'vscode'
import { Cmd } from '../platform/commands'
import { registerCommands } from '../platform/registerCommands'
import type { NotesApi } from '../notes/model'
import { askClaudeCommand, cancelClaudeCommand } from './commands'
import { AskPorts, useAskPorts } from './ports'
import { announceAskChanges, askStatusItem, createAskQueue } from './run'
import { watchClaudeCli } from './settings'
import { agentRunner } from '../platform/agent/runner'

export interface AskFeature {
  /** The status item follows the notes' changes. */
  follow(model: NotesApi): vscode.Disposable
}

export function activateAsk(context: vscode.ExtensionContext, ports: AskPorts): AskFeature {
  useAskPorts(ports)
  const queue = createAskQueue()
  // The runner goes with the window: the runs it started stop then (runner.ts dispose).
  context.subscriptions.push(queue, announceAskChanges(queue), agentRunner())
  // No claude CLI: no Ask Claude anywhere; the setting's description says how to get it.
  watchClaudeCli(context)
  registerCommands(context, {
    [Cmd.askClaude]: askClaudeCommand,
    [Cmd.cancelClaude]: cancelClaudeCommand,
  })
  return { follow: (model) => askStatusItem(model) }
}
