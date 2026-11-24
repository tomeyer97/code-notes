// Asking Claude about a note: the commands, the answer written into its thread, the status bar item while it runs.
import * as vscode from 'vscode'
import { Cmd } from '../platform/commands'
import { registerCommands } from '../platform/registerCommands'
import type { NotesApi } from '../notes/model'
import { askClaudeCommand, cancelClaudeCommand } from './commands'
import { AskPorts, useAskPorts } from './ports'
import { askStatusItem, createAskStatusItem, followNotes, loadAskErrors } from './run'
import { watchClaudeCli } from './settings'

export interface AskFeature {
  /** The status item follows the notes' changes. */
  follow(model: NotesApi): vscode.Disposable
}

export function activateAsk(context: vscode.ExtensionContext, ports: AskPorts): AskFeature {
  useAskPorts(ports)
  loadAskErrors()
  // No claude CLI: no Ask Claude anywhere; the setting's description says how to get it.
  watchClaudeCli(context)
  createAskStatusItem()
  context.subscriptions.push(askStatusItem)
  registerCommands(context, {
    [Cmd.askClaude]: askClaudeCommand,
    [Cmd.cancelClaude]: cancelClaudeCommand,
  })
  return { follow: (model) => followNotes(model) }
}
