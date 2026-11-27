// The Claude settings: which claude CLI (and whether there is one: the context key codeNotes.claudeFound), and when
// Claude answers on its own (codeNotes.claude.mode).

import * as vscode from 'vscode'
import { cfg } from '../platform/settings'
import { setCtx } from '../platform/context'
import { agentRunner } from '../platform/agent/runner'
import { fireAndForget } from '../platform/run'

/** codeNotes.claude.mode (package.json): Claude answers on a button press, every note on its own, or never. */
export type ClaudeMode = 'button' | 'always' | 'off'
const MODES: readonly ClaudeMode[] = ['button', 'always', 'off']

export const claudeMode = (): ClaudeMode => {
  const m = cfg().get<string>('claude.mode', 'button')
  return (MODES as readonly string[]).includes(m) ? (m as ClaudeMode) : 'button'
}

/** The claude CLI as found so far (the agent runner's one search: setting codeNotes.claude.path, else PATH). */
export const claudeCli = () => agentRunner().knownCli()

/** Claude answers every new note and reply on its own (mode "always"). */
export const askAlways = () => claudeMode() === 'always'

/** A question asked on a journey step is a question for Claude: answered unless Claude is off or not installed. */
export const askOnQuestion = () => claudeMode() !== 'off' && !!claudeCli()

/** Whether the claude CLI is there (the context key codeNotes.claudeFound), asked again when its setting or the trust changes. */
export function watchClaudeCli(context: vscode.ExtensionContext): void {
  // Each candidate's `claude --version` runs as its own process, off the extension host's path. Only the latest
  // probe's answer is kept.
  let probes = 0
  const probeClaude = () => {
    const n = ++probes
    fireAndForget(agentRunner().cli().then((c) => {
      if (n === probes) fireAndForget(setCtx('codeNotes.claudeFound', !!c), 'settings: setCtx codeNotes.claudeFound')
    }), 'settings: find claude')
  }
  probeClaude()
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('codeNotes.claude.path')) probeClaude() }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => probeClaude()),
  )
}
