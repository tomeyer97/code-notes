// Who this window is, for the controller: its folders, where it runs (remote name, WSL distro). Sent in the hello and
// again when the folders change.
import * as vscode from 'vscode'
import type { BridgeWindow } from '../protocol/bridge'
import { wslDistro } from './machine'

export function windowInfo(): BridgeWindow {
  return {
    folders: (vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, path: f.uri.fsPath, uri: f.uri.toString() })),
    remoteName: vscode.env.remoteName ?? null,
    wslDistro: wslDistro(),
  }
}
