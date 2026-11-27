// Registering a feature's commands: each feature's activate passes its own table, keyed by the command ids of
// platform/commands.ts (so an id that is not contributed or listed there does not compile).
import * as vscode from 'vscode'
import type { CommandId } from './commands'

/** What a command runs: VS Code passes whatever the menu, key or link gives, so each handler says what it takes. */
export type CommandHandler = (...args: never[]) => unknown

export type CommandTable = Partial<Record<CommandId, CommandHandler>>

/** Registers every command of `table`; they go with the extension. */
export function registerCommands(context: vscode.ExtensionContext, table: CommandTable): void {
  for (const [id, fn] of Object.entries(table)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn as (...args: unknown[]) => unknown))
  }
}
