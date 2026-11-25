// Writing and refreshing journeys with Claude, and the requests an agent or a link leaves for the extension.
import * as path from 'path'
import * as vscode from 'vscode'
import { Cmd } from '../platform/commands'
import { registerCommands } from '../platform/registerCommands'
import { fireAndForget } from '../platform/run'
import { agentRunner } from '../platform/agent/runner'
import { folderName } from '../notes/notesFolder'
import { registerBeforeCopies } from './beforeCopies'
import { mapPanel, refreshJourneyList, useWritePorts, WritePorts } from './ports'
import { refreshJourney } from './refreshJourney'
import { askQuestion, watchRequestFiles } from './requests'
import { STAGING, sweepStaging } from './staging'
import { registerUriRoutes } from './uriRoutes'

export interface WriteFeature {
  /** Requests left for the extension (a file, a link) are taken from now on: once everything is shown. */
  takeRequests(): void
}

export function activateWrite(context: vscode.ExtensionContext, ports: WritePorts): WriteFeature {
  useWritePorts(ports)
  context.subscriptions.push(
    registerBeforeCopies(),
    // A journey starts or stops being written or refreshed: the lists show it (a row, "Refreshing…").
    agentRunner().inProgress.onDidChange((r) => {
      if (r.purpose !== 'journey') return
      refreshJourneyList()
      mapPanel().update()
    }),
  )
  registerCommands(context, {
    [Cmd.askQuestion]: askQuestion,
    [Cmd.refreshJourney]: refreshJourney,
  })
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    fireAndForget(sweepStaging(path.join(f.uri.fsPath, folderName(), STAGING)), 'write: sweep staging folders')
  }
  return { takeRequests: () => { context.subscriptions.push(registerUriRoutes(), watchRequestFiles()) } }
}
