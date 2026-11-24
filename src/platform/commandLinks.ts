// Markdown that may run commands: which ones is said where it is made (platform/commands.ts has the command ids, the
// lists of what each kind of text may run, and the links themselves).
import * as vscode from 'vscode'
import { SYSTEM_COMMANDS } from './commands'

/** Markdown allowed to run `commands`. */
export function trustedMarkdown(text: string, commands: readonly string[]): vscode.MarkdownString {
  const md = new vscode.MarkdownString(text)
  md.isTrusted = { enabledCommands: [...commands] }
  return md
}

/** Markdown the extension writes itself, allowed to run its own commands. */
export const systemMarkdown = (text: string) => trustedMarkdown(text, SYSTEM_COMMANDS)

/** `md` may also run `command`. */
export function alsoAllow(md: vscode.MarkdownString, command: string): void {
  md.isTrusted = { enabledCommands: [...(typeof md.isTrusted === 'object' ? md.isTrusted.enabledCommands : []), command] }
}
