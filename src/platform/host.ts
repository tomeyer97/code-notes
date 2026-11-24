// The extension's own platform services: its Output channel, its stored state, where it is installed and its version.
// Made once by activate (startHost); every part reads them through these getters, which throw before that (a read at
// import time is a bug, not a silent undefined). Feature objects are not here: each feature gets them as ports.
import * as vscode from 'vscode'
import { useWindow } from './run'
import type { StateStore } from './state'

export interface Host {
  log: vscode.LogOutputChannel
  /** This workspace's and every workspace's stored state (platform/state.ts's keys). */
  stored: StateStore
  extUri: vscode.Uri
  /** This extension's version (a request may need a newer one). */
  extVersion: string
}

let host: Host | undefined

/** Makes the host services for this window (`stored`: activate's, over the context's Mementos); the Output channel
 *  goes with the extension. */
export function startHost(context: vscode.ExtensionContext, stored: StateStore): Host {
  const log = vscode.window.createOutputChannel('Code Notes', { log: true })
  context.subscriptions.push(log)
  host = {
    log,
    stored,
    extUri: context.extensionUri,
    extVersion: String(context.extension.packageJSON?.version ?? '0.0.0'),
  }
  useWindow({ log, showErrorMessage: (text, ...items) => vscode.window.showErrorMessage(text, ...items) })
  return host
}

function started(): Host {
  if (!host) throw new Error('Code Notes: read before the extension started')
  return host
}

export const log = () => started().log
export const stored = () => started().stored
export const extUri = () => started().extUri
export const extVersion = () => started().extVersion

/** The first workspace folder. */
export const firstFolder = () => vscode.workspace.workspaceFolders![0]

/** Now, as notes and positions store it. */
export const now = () => new Date().toISOString()
