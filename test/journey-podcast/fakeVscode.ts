// The part of VS Code's API the Listen view and the audio's relay (src/podcast/listenView.ts, audioHost.ts) use, for
// running them outside VS Code: in the unit tests and in the browser harness (shoot.mjs), which drives the real relay
// between the two pages. Importing this file makes `require('vscode')` return it (import it before the modules under
// test); `commands.handlers` say what a command does.
import Module from 'node:module'
import { pathToFileURL } from 'node:url'

export class Uri {
  readonly scheme = 'file'
  constructor(readonly path: string) {}
  static file(p: string): Uri { return new Uri(p) }
  static joinPath(u: Uri, ...parts: string[]): Uri { return new Uri([u.path.replace(/\/$/, ''), ...parts].join('/')) }
  get fsPath(): string { return this.path }
  with(o: { path?: string }): Uri { return new Uri(o.path ?? this.path) }
  toString(): string { return pathToFileURL(this.path).href }
}

export class Disposable {
  constructor(private readonly f: () => void = () => undefined) {}
  dispose(): void { this.f() }
}

export class EventEmitter<T> {
  private listeners = new Set<(e: T) => void>()
  event = (f: (e: T) => void) => { this.listeners.add(f); return new Disposable(() => this.listeners.delete(f)) }
  fire(e: T): void { for (const f of [...this.listeners]) f(e) }
  dispose(): void { this.listeners.clear() }
}

/** Commands run (their ids, in order); `handlers[id]` runs for one (default: nothing). */
export const commands = {
  ran: [] as string[],
  handlers: {} as Record<string, (...args: unknown[]) => unknown>,
  async executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
    commands.ran.push(id)
    return commands.handlers[id]?.(...args)
  },
}

export const window = {
  registerWebviewViewProvider: () => new Disposable(),
}

export const workspace = {
  workspaceFolders: [] as { uri: Uri }[],
  getConfiguration: () => ({ get: <T>(_k: string, d?: T) => d }),
}

export class ThemeColor { constructor(readonly id: string) {} }
export class ThemeIcon { constructor(readonly id: string) {} }

const api = { Uri, Disposable, EventEmitter, commands, window, workspace, ThemeColor, ThemeIcon }

/** `require('vscode')` gets this module from now on. */
function install(): typeof api {
  const m = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown }
  const load = m._load
  m._load = function (request: string, ...rest: unknown[]) {
    return request === 'vscode' ? api : load.call(this, request, ...rest)
  }
  return api
}

/** A webview of a view, and its page's end: what the extension posts goes to `toPage`; `fromPage(m)` is a message
 *  the page posts. `html` is the page the view made. */
export function fakeWebviewView(toPage: (m: unknown) => void, cspSource: string) {
  const received = new EventEmitter<unknown>()
  const disposed = new EventEmitter<void>()
  const webview = {
    options: {},
    html: '',
    cspSource,
    asWebviewUri: (u: Uri) => u,
    postMessage: async (m: unknown) => { toPage(m); return true },
    onDidReceiveMessage: received.event,
  }
  const view = { webview, visible: true, onDidDispose: disposed.event }
  return { view, fromPage: (m: unknown) => received.fire(m), dispose: () => disposed.fire() }
}

/** The fake, installed. */
export const vscode = install()
