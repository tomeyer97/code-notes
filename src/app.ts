// What every part of the extension shares: the services made once when it starts (activate hands them over with
// `provide`), the settings, and a few small helpers. Read anywhere; set only through `provide` and `setKey`.

import * as vscode from 'vscode'
import { Beats } from './beats'
import { CheckController } from './check/controller'
import { ClaudeLinks } from './claudeLinks'
import { CodeLinks } from './codeLinks'
import { Journeys } from './journeys/journeys'
import { MapPanel } from './journeys/mapPanel'
import { Store } from './store'
import { label } from './tour/stepText'
import { TourItems } from './tour/walk'
import { TutorialSpot } from './tutorialSpot'
import { ValueHints } from './valueHints'

/** The notes, and the stored state of this workspace (`state`) and of every workspace (`gstate`). */
export let store: Store
export let state: vscode.Memento
export let gstate: vscode.Memento
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

interface Services {
  store: Store; state: vscode.Memento; gstate: vscode.Memento; log: vscode.LogOutputChannel; controller: vscode.CommentController
  extUri: vscode.Uri; extVersion: string; journeys: Journeys; understanding: CheckController; mapPanel: MapPanel; beats: Beats
  tutorialSpot: TutorialSpot; codeLinks: CodeLinks; claudeLinks: ClaudeLinks; valueHints: ValueHints; tourItems: TourItems
}

/** Hands over services as activate makes them. */
export function provide(s: Partial<Services>): void {
  if (s.store) store = s.store
  if (s.state) state = s.state
  if (s.gstate) gstate = s.gstate
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
export const PREFIX_KEY = 'codeNotes.chordPrefix'
export function setKey(k: string): void { KEY = k }

export const cfg = () => vscode.workspace.getConfiguration('codeNotes')
export const now = () => new Date().toISOString()

/** Context keys as last sent: the same value again is not sent (each is a message to the window; some follow the caret). */
const ctxSent = new Map<string, unknown>()
export const setCtx = (k: string, v: unknown): Thenable<unknown> => {
  if (ctxSent.has(k) && ctxSent.get(k) === v) return Promise.resolve(undefined)
  ctxSent.set(k, v)
  return vscode.commands.executeCommand('setContext', k, v)
}

/** The notes shown: all, except check threads of another branch's check (their lines belong to that branch). */
export const notes = () => store.all().filter((n) => !understanding?.offBranch(n))
export const byId = (id: string) => store.get(id)
/** The first workspace folder. */
export const n0 = () => vscode.workspace.workspaceFolders![0]

/** an error the person is shown also goes to the Output channel as [error]. */
export function showError(text: string, ...items: string[]): Thenable<string | undefined> {
  if (log) log.error(text.replace(/^Code Notes: /, ''))
  return vscode.window.showWarningMessage(text, ...items)
}

/** Markdown the extension writes itself, allowed to run its own commands. */
export function systemMarkdown(text: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(text)
  md.isTrusted = { enabledCommands: ['codeNotes.askClaude', 'codeNotes.cancelClaude', 'codeNotes.expandThread', 'codeNotes.openAt', 'codeNotes.gradeCheck', 'codeNotes.checkConcern', 'codeNotes.openStepLink'] }
  return md
}
export const cmdLink = (label: string, command: string, ...args: unknown[]) => `[${label}](command:${command}${args.length ? `?${encodeURIComponent(JSON.stringify(args))}` : ''})`
