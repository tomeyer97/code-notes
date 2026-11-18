// The Claude settings: which claude CLI (and whether there is one: the context key codeNotes.claudeFound), and when
// Claude answers on its own (codeNotes.claude.mode).

import * as vscode from 'vscode'
import { cfg, setCtx } from '../app'
import { findCli, findCliAsync } from '../claudeCli'

export const claudeMode = () => cfg().get<string>('claude.mode', 'button')

/** The claude CLI (setting codeNotes.claude.path, else PATH), or undefined. */
export const claudeCli = () => findCli(cfg().get<string>('claude.path') || undefined)

/** Claude answers every new note and reply on its own (mode "always"). */
export const askAlways = () => claudeMode() === 'always'

/** A question asked on a journey step is a question for Claude: answered unless Claude is off or not installed. */
export const askOnQuestion = () => claudeMode() !== 'off' && !!claudeCli()

/** Whether the claude CLI is there (the context key codeNotes.claudeFound), asked again when its setting or the trust changes. */
export function watchClaudeCli(context: vscode.ExtensionContext): void {
  // In Restricted Mode `codeNotes.claude.path` comes from the user's settings only (package.json:
  // restrictedConfigurations), so a folder's own settings never pick the program run here.
  // Off the extension host's path: each candidate's `claude --version` runs as its own process (findCli then answers
  // from the cache). Only the latest probe's answer is kept.
  let probes = 0
  const probeClaude = () => {
    const n = ++probes
    void findCliAsync(cfg().get<string>('claude.path') || undefined).then((c) => {
      if (n === probes) void setCtx('codeNotes.claudeFound', !!c)
    })
  }
  probeClaude()
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('codeNotes.claude.path')) probeClaude() }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => probeClaude()),
  )
}
