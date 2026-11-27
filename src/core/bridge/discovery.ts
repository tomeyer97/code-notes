// Finding a controller: the discovery file it writes (`~/.code-notes/bridge.json`, mode 0600) while it runs, read and
// checked here (one address or several); where to look for it, inside WSL also in the Windows user's home. No vscode,
// no fs: the caller reads files and runs programs (unit-tested in test/bridgeDiscovery.test.ts).

/**
 * What a discovery file says: the addresses to dial, in order (its `url`, then its `urls`), the token to show, and the
 * controller's name (shown as the author).
 */
export interface BridgeTarget { urls: string[]; token: string; name: string }

/** The discovery file's folder and name, under a home folder. */
export const DISCOVERY_DIR = '.code-notes'
export const DISCOVERY_FILE = 'bridge.json'

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/**
 * A discovery file's text as a target, or undefined when it can't be used: not JSON, no token, or no URL that is
 * ws:// on this machine. A token is never sent off the machine, nor in clear text to another one: the only hosts
 * allowed are loopback ones and `hosts` (inside WSL, the Windows host's address: wslHost.ts).
 */
export function parseBridgeFile(text: string, hosts: readonly string[] = []): BridgeTarget | undefined {
  let v: unknown
  try { v = JSON.parse(text) } catch { return undefined }
  if (!v || typeof v !== 'object') return undefined
  const { url, urls, token, name } = v as Record<string, unknown>
  const usable = addresses(url, urls).filter((u) => isLocalWs(u, hosts))
  if (!usable.length || !nonEmpty(token)) return undefined
  return { urls: usable, token, name: nonEmpty(name) ? name.trim() : 'Controller' }
}

/** `url` then each of `urls`, the strings among them, each once. */
function addresses(url: unknown, urls: unknown): string[] {
  const all = [url, ...(Array.isArray(urls) ? urls : [])].filter(nonEmpty).map((u) => u.trim())
  return [...new Set(all)]
}

/** ws:// to a loopback host (127.0.0.0/8, ::1, localhost) or to one of `hosts`. */
export function isLocalWs(url: string, hosts: readonly string[] = []): boolean {
  let u: URL
  try { u = new URL(url) } catch { return false }
  if (u.protocol !== 'ws:') return false
  const host = u.hostname
  return host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host) || hosts.includes(host)
}

export const sameTarget = (a: BridgeTarget | undefined, b: BridgeTarget | undefined) =>
  a === b || (!!a && !!b && a.urls.join(' ') === b.urls.join(' ') && a.token === b.token && a.name === b.name)

/** Where to look, in order: only `override` when it is set; else this home's file, then the Windows home's (WSL). */
export function discoveryPaths(o: { override?: string; home: string; windowsHome?: string; join(...p: string[]): string }): string[] {
  if (o.override?.trim()) return [o.override.trim()]
  const under = (home: string) => o.join(home, DISCOVERY_DIR, DISCOVERY_FILE)
  return o.windowsHome ? [under(o.home), under(o.windowsHome)] : [under(o.home)]
}

/** Runs a program with arguments; its standard output (rejects when it fails or can't start). */
export type RunProgram = (file: string, args: string[]) => Promise<string>

/**
 * Inside WSL, the Windows user's home as a path in WSL (/mnt/c/Users/<name>): `%USERPROFILE%` from cmd.exe, then
 * wslpath. Undefined when either can't run or says nothing usable (interop off, no Windows).
 */
export async function windowsHomeInWsl(run: RunProgram): Promise<string | undefined> {
  try {
    // cmd.exe complains about a UNC working folder on stderr, and its line ends in \r\n.
    const win = (await run('cmd.exe', ['/c', 'echo %USERPROFILE%'])).trim()
    if (!win || win.includes('%')) return undefined
    const linux = (await run('wslpath', ['-u', win])).trim()
    return linux || undefined
  } catch {
    return undefined
  }
}

/** Whether this is WSL: its distro variable, or a kernel that says Microsoft. */
export const isWsl = (env: Record<string, string | undefined>, kernel: string) =>
  !!env.WSL_DISTRO_NAME || /microsoft/i.test(kernel)
