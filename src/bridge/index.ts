// The bridge: a local program (a controller) drives this window over a WebSocket. The controller writes a discovery
// file while it runs; the extension finds it, dials it and answers its requests (reveal, journey.play, note.add,
// context.get). Silent when there is none. The protocol: docs/bridge.md.
import * as vscode from 'vscode'
import { BridgeClient } from '../core/bridge/client'
import type { BridgeTarget } from '../core/bridge/discovery'
import { DiscoveryWatch } from '../core/bridge/watch'
import { BRIDGE_PROTOCOL, FromExtension } from '../protocol/bridge'
import { Cmd } from '../platform/commands'
import { extVersion, log } from '../platform/host'
import { registerCommands } from '../platform/registerCommands'
import { fireAndForget } from '../platform/run'
import { cfg } from '../platform/settings'
import { Callout } from './callout'
import { handleRequest } from './handlers'
import { bridgePaths, nodeTimers, readText, webSocketDialer } from './machine'
import { BridgePorts, useBridgePorts } from './ports'
import { windowInfo } from './window'

export interface BridgeFeature {
  /** Looks for a controller from now on (once everything is shown: its first request finds the journeys read). */
  start(): void
  /** For tests: the discovery file used, the connection, the explanation shown. */
  snapshot(): { file?: string; target?: string; connected: boolean; dials: number; callout: Callout['state'] }
}

const enabled = () => cfg().get<boolean>('bridge.enabled', true)
const discoveryOverride = () => cfg().get<string>('bridge.discovery', '')

const hello = (t: BridgeTarget): FromExtension =>
  ({ type: 'hello', protocol: BRIDGE_PROTOCOL, token: t.token, client: 'code-notes', version: extVersion(), window: windowInfo() })

export function activateBridge(context: vscode.ExtensionContext, ports: BridgePorts): BridgeFeature {
  useBridgePorts(ports)
  const callout = new Callout()
  const dial = webSocketDialer()
  const client = dial && new BridgeClient({
    dial, hello, timers: nodeTimers,
    handle: (request, controller) => handleRequest(request, { controller, callout }),
    log: (line) => log().info(line),
  })
  let file: string | undefined
  const watch = new DiscoveryWatch({
    paths: () => bridgePaths(discoveryOverride()), read: readText, timers: nodeTimers,
    changed: (target, path) => {
      file = path
      if (target && !client) log().warn('bridge: this VS Code has no WebSocket (Node 22 or newer is needed): not connecting')
      client?.use(target)
    },
  })
  const follow = () => {
    if (enabled()) fireAndForget(watch.start(), 'bridge: read the discovery file')
    else { watch.stop(); client?.use(undefined) }
  }
  registerCommands(context, { [Cmd.dismissExplanation]: () => callout.dismiss() })
  let started = false
  context.subscriptions.push(callout,
    vscode.workspace.onDidChangeConfiguration((e) => { if (started && e.affectsConfiguration('codeNotes.bridge')) follow() }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => client?.send({ type: 'window', window: windowInfo() })),
    { dispose: () => { watch.stop(); client?.dispose() } },
  )
  return {
    start: () => { started = true; follow() },
    snapshot: () => ({ file, ...(client?.state ?? { connected: false, dials: 0 }), callout: callout.state }),
  }
}
