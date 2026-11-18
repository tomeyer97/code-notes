// What Claude may do here: run at all (only in a trusted folder), and which skills and folders it may use.

import * as vscode from 'vscode'
import * as fs from 'fs'
import * as os from 'os'
import { cfg, log } from '../app'
import { SKILLS_HINT } from './prompts'

/**
 * Claude runs (answering a note, a step's question, writing a journey) run tools in the repository, the skill's
 * own scripts among them: only in a trusted folder. In Restricted Mode one line says why, with a button that opens
 * the trust editor; reading journeys and notes stays available.
 */
export const trusted = () => vscode.workspace.isTrusted

/** Whether Claude may `what` here; when not, says why (once per call) with a button to the trust editor. */
export function claudeAllowed(what: string): boolean {
  if (trusted()) return true
  log.info(`${what}: not run: this folder is in Restricted Mode (not trusted)`)
  void vscode.window.showInformationMessage(`Trust this folder to let Claude ${what}.`, 'Manage Trust').then((b) => {
    if (b) void vscode.commands.executeCommand('workbench.trust.manage')
  })
  return false
}

/** Claude Code skills a note may use: the Skill tool, Bash for each skill's own scripts only, and its cache folder. */
export function skillAccess(): { tools: string[]; dirs: string[]; hint: string } {
  const home = os.homedir()
  const skillDir = (name: string) => `${home}/.claude/skills/${name}`
  const names = (cfg().get<string[]>('claude.skills') ?? []).filter((x) => fs.existsSync(`${skillDir(x)}/SKILL.md`))
  if (!names.length) return { tools: [], dirs: [], hint: '' }
  const tools = ['Skill', ...names.map((x) => `Bash(${skillDir(x)}/scripts/*)`)]
  const cache = process.env.XDG_CACHE_HOME ?? `${home}/.cache`
  const dirs = names.map((x) => `${cache}/${x}`).filter((d) => fs.existsSync(d))
  return { tools, dirs, hint: `\n\n${SKILLS_HINT(names, home)}` }
}
