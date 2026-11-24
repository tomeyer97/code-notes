// What every part of the extension shares: the services made once when it starts (activate hands them over with
// `provide`), the settings, and a few small helpers. Read anywhere; set only through `provide` and `setKey`.

import * as vscode from 'vscode'
import { Beats } from './codeLinks/beats'
import { CheckController } from './check/controller'
import { ClaudeLinks } from './codeLinks/claudeChatLinks'
import { CodeLinks } from './codeLinks/codeLinks'
import { Journeys } from './journeys/journeys'
import { MapPanel } from './journeys/mapPanel'
import { Store } from './notes/store'
import { StateStore } from './platform/state'
import { SYSTEM_COMMANDS } from './platform/commands'
import { TourItems } from './tour/walk'
import { TutorialSpot } from './tour/tutorialSpot'
import { ValueHints } from './codeLinks/valueHints'

/** The notes, and the stored state (this workspace's and every workspace's: platform/state.ts's keys). */
export let store: Store
export let stored: StateStore
export let log: vscode.LogOutputChannel
/** The notes' comment threads. */
export let controller: vscode.CommentController
export let extUri: vscode.Uri
/** This extension's version (a request may need a newer one). */
export let extVersion = '0.0.0'
export let journeys: Journeys
/** The understanding check (src/check/): its questions are notes of a session "Check · <branch>". */
export let understanding: CheckController | undefined
export let mapPanel: MapPanel
export let beats: Beats
export let tutorialSpot: TutorialSpot
export let codeLinks: CodeLinks
export let claudeLinks: ClaudeLinks
export let valueHints: ValueHints
export let tourItems: TourItems

/**
 * What `provide` takes: the services above. They are `let`s, so every module reads the one made in activate by its
 * bare name (an import is a live binding); a module can only assign its own `let`s, hence this list and provide's.
 */
interface Services {
  store: Store
  stored: StateStore
  log: vscode.LogOutputChannel
  controller: vscode.CommentController
  extUri: vscode.Uri
  extVersion: string
  journeys: Journeys
  understanding: CheckController
  mapPanel: MapPanel
  beats: Beats
  tutorialSpot: TutorialSpot
  codeLinks: CodeLinks
  claudeLinks: ClaudeLinks
  valueHints: ValueHints
  tourItems: TourItems
}

/** Hands over services as activate (extension.ts) makes them: the only place they are set. */
export function provide(s: Partial<Services>): void {
  if (s.store) store = s.store
  if (s.stored) stored = s.stored
  if (s.log) log = s.log
  if (s.controller) controller = s.controller
  if (s.extUri) extUri = s.extUri
  if (s.extVersion) extVersion = s.extVersion
  if (s.journeys) journeys = s.journeys
  if (s.understanding) understanding = s.understanding
  if (s.mapPanel) mapPanel = s.mapPanel
  if (s.beats) beats = s.beats
  if (s.tutorialSpot) tutorialSpot = s.tutorialSpot
  if (s.codeLinks) codeLinks = s.codeLinks
  if (s.claudeLinks) claudeLinks = s.claudeLinks
  if (s.valueHints) valueHints = s.valueHints
  if (s.tourItems) tourItems = s.tourItems
}

/**
 * The chord prefix, as the UI names it: Ctrl+' then a plain letter. Both prefixes (Ctrl+' and, on ISO keyboards,
 * Ctrl+<) run the same commands; hints show the one last used, Ctrl+' until then (it exists on every layout).
 */
export let KEY = "Ctrl+'"
export function setKey(k: string): void { KEY = k }

/** The settings: platform/settings.ts; context keys: platform/context.ts. */
export { cfg } from './platform/settings'
export { setCtx } from './platform/context'
export const now = () => new Date().toISOString()

/** The notes shown: all, except check threads of another branch's check (their lines belong to that branch). */
export const notes = () => store.all().filter((n) => !understanding?.offBranch(n))
export const byId = (id: string) => store.get(id)
/** The first workspace folder. */
export const firstFolder = () => vscode.workspace.workspaceFolders![0]

/** An error the person is shown (as an error, after `Code Notes: `), also in the Output channel: platform/run.ts. */
export { showError } from './platform/run'

/** The commands Markdown may run, and command links: platform/commands.ts. */
export { BANNER_COMMANDS, cmdLink, commandUri, MESSAGE_COMMANDS, SYSTEM_COMMANDS, titledCmdLink } from './platform/commands'

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
