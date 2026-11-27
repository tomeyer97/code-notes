// The connection to a controller: dial its URL, say hello (with the token), answer each request, and dial again with
// a backoff when the connection drops or can't be made. Which controller (if any) is said from outside: use(target).
// The socket, the timers and the handling are given, so this has no vscode and no network of its own (unit-tested
// with a real WebSocket server in test/bridgeClient.test.ts).
import type { BridgeRequest, BridgeResponse, FromExtension } from '../../protocol/bridge'
import { Backoff } from './backoff'
import { BridgeTarget, sameTarget } from './discovery'
import { readFrame } from './requests'

/** What the client needs of a WebSocket (the global WebSocket has it). */
export interface SocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'close' | 'error' | 'message', listener: (e: { data?: unknown }) => void): void
}

/** WebSocket.OPEN. */
const OPEN = 1

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface ClientDeps {
  dial(url: string): SocketLike
  /** The first message on every connection. */
  hello(target: BridgeTarget): FromExtension
  /** A request answered (never rejects: a failure is an `ok: false` response). */
  handle(request: BridgeRequest, target: BridgeTarget): Promise<BridgeResponse>
  timers: Timers
  log(line: string): void
}

export class BridgeClient {
  private target: BridgeTarget | undefined
  private socket: SocketLike | undefined
  private retry: unknown
  private readonly backoff = new Backoff()
  /** Whether the drop of the open connection was said (one log line per drop, not one per dial). */
  private quietRetries = false
  private dials = 0

  constructor(private readonly deps: ClientDeps) {}

  /** Dials `target` from now on (none: hangs up). A different target is dialled at once, the backoff reset. */
  use(target: BridgeTarget | undefined): void {
    if (sameTarget(target, this.target)) return
    this.hangUp()
    this.target = target
    this.backoff.reset()
    this.quietRetries = false
    if (target) this.dial()
  }

  /** Sends to the controller when connected (dropped otherwise: the next hello says it all again). */
  send(message: FromExtension): void {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(message))
  }

  /** For tests and the log: who, whether connected, how many dials so far. */
  get state(): { target?: string; connected: boolean; dials: number } {
    return { target: this.target?.url, connected: this.socket?.readyState === OPEN, dials: this.dials }
  }

  dispose(): void { this.use(undefined) }

  private dial(): void {
    const target = this.target!
    this.dials++
    let socket: SocketLike
    try {
      socket = this.deps.dial(target.url)
    } catch (e) {
      this.deps.log(`bridge: can't dial ${target.url}: ${e}`)
      this.later()
      return
    }
    this.socket = socket
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return
      this.backoff.reset()
      this.quietRetries = false
      this.deps.log(`bridge: connected to ${target.name} (${target.url})`)
      socket.send(JSON.stringify(this.deps.hello(target)))
    })
    socket.addEventListener('message', (e) => { if (typeof e.data === 'string') this.received(socket, target, e.data) })
    // A dial that fails gets 'error' alone in Node (no 'close'); a drop gets both: the first one counts.
    const lost = () => {
      if (this.socket !== socket) return
      this.socket = undefined
      if (!this.quietRetries) this.deps.log(`bridge: no connection to ${target.name}; trying again`)
      this.quietRetries = true
      this.later()
    }
    socket.addEventListener('error', lost)
    socket.addEventListener('close', lost)
  }

  private received(socket: SocketLike, target: BridgeTarget, data: string): void {
    const request = readFrame(data)
    if (!request) return
    this.deps.handle(request, target).then(
      (response) => { if (this.socket === socket && socket.readyState === OPEN) socket.send(JSON.stringify(response)) },
      (e) => this.deps.log(`bridge: ${request.method}: ${e}`),
    )
  }

  /** The next dial, after the backoff's wait. */
  private later(): void {
    this.retry = this.deps.timers.set(() => { this.retry = undefined; if (this.target) this.dial() }, this.backoff.next())
  }

  private hangUp(): void {
    if (this.retry !== undefined) this.deps.timers.clear(this.retry)
    this.retry = undefined
    const s = this.socket
    this.socket = undefined
    if (s) {
      this.deps.log('bridge: disconnected')
      try { s.close(1000, 'bye') } catch { /* closing a socket that never opened: nothing to do */ }
    }
  }
}
