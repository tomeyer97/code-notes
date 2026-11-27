// The machine the extension runs on, for the bridge: its home, the discovery file's places (inside WSL also the
// Windows user's home, asked once), reading a file, inside WSL the Windows host's address, and dialling a WebSocket
// (Node's own: no dependency).
import { execFile } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { discoveryPaths, isWsl, RunProgram, windowsHomeInWsl } from '../core/bridge/discovery'
import type { SocketLike } from '../core/bridge/client'
import { defaultGateway } from '../core/bridge/wslHost'

/** cmd.exe and wslpath answer in well under a second; one that hangs (interop stuck) is given up. */
const RUN_TIMEOUT_MS = 5_000

const run: RunProgram = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: RUN_TIMEOUT_MS, windowsHide: true }, (e, stdout) => (e ? reject(e) : resolve(String(stdout))))
})

const kernel = () => { try { return fs.readFileSync('/proc/version', 'utf8') } catch { return '' } }

/** Inside WSL: the Windows home, asked once per window (it does not change while VS Code runs). */
let windowsHome: Promise<string | undefined> | undefined
const windowsHomeOnce = () => (windowsHome ??= isWsl(process.env, kernel()) ? windowsHomeInWsl(run) : Promise.resolve(undefined))

/** Where the discovery file may be: `override` (the setting) alone, else the homes. */
export async function bridgePaths(override: string): Promise<string[]> {
  if (override.trim()) return discoveryPaths({ override, home: os.homedir(), join: path.join })
  return discoveryPaths({ home: os.homedir(), windowsHome: await windowsHomeOnce(), join: path.join })
}

export const readText = (file: string) => fs.promises.readFile(file, 'utf8').catch(() => undefined)

/** Inside WSL, the Windows host's address (the default gateway), read once: a controller there may list it. */
let wslHosts: Promise<readonly string[]> | undefined
export const bridgeHosts = () => (wslHosts ??= windowsHosts())

async function windowsHosts(): Promise<readonly string[]> {
  if (!isWsl(process.env, kernel())) return []
  const host = defaultGateway(await readText('/proc/net/route') ?? '')
  return host ? [host] : []
}

/** The WSL distro this runs in (none outside WSL). */
export const wslDistro = () => process.env.WSL_DISTRO_NAME || null

/** Node's WebSocket (Node 22: a global); undefined on an older runtime, where the bridge stays off. */
export function webSocketDialer(): ((url: string) => SocketLike) | undefined {
  const WS = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket
  return WS && ((url) => new WS(url))
}

export const nodeTimers = {
  set: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clear: (h: unknown) => clearTimeout(h as NodeJS.Timeout),
}
