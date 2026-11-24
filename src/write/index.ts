// Writing and refreshing journeys with Claude, and the requests an agent or a link leaves for the extension.
import * as vscode from 'vscode'
import { Cmd } from '../platform/commands'
import { registerCommands } from '../platform/registerCommands'
import { writingChanged } from './inProgress'
import { useWritePorts, WritePorts } from './ports'
import { refreshJourney } from './refreshJourney'
import { askQuestion, watchRequestFiles } from './requests'
import { registerUriRoutes } from './uriRoutes'

export interface WriteFeature {
  /** Requests left for the extension (a file, a link) are taken from now on: once everything is shown. */
  takeRequests(): void
}

export function activateWrite(context: vscode.ExtensionContext, ports: WritePorts): WriteFeature {
  useWritePorts(ports)
  context.subscriptions.push(writingChanged)
  registerCommands(context, {
    [Cmd.askQuestion]: askQuestion,
    [Cmd.refreshJourney]: refreshJourney,
  })
  return { takeRequests: () => { context.subscriptions.push(registerUriRoutes(), watchRequestFiles()) } }
}
