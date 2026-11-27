// The connection to a controller: dial its addresses in turn until one answers, say hello (with the token), answer
// each request, and dial again with a backoff when the connection drops or none can be reached: the address that
// connected first, then the others. Which controller (if any) is said from outside: use(target).
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

/**
 * How long a dial may take when there are several addresses, before the next one is tried. A wrong address may never
 * answer (a firewall drops the packets): without this, the right one would wait for the system's own timeout.
 */
export const DIAL_TIMEOUT_MS = 3_000

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
  /** DIAL_TIMEOUT_MS unless given (tests). */
  dialTimeoutMs?: number
}

export class BridgeClient {
  private target: BridgeTarget | undefined
  private socket: SocketLike | undefined
  /** The address dialled or connected now. */
  private url: string | undefined
  /** The addresses still to try in this round, in order. */
  private round: string[] = []
  /** The address that connected last: each round starts with it. */
  private preferred: string | undefined
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
    this.preferred = undefined
    this.backoff.reset()
    this.quietRetries = false
    if (target) this.startRound()
  }

  /** Sends to the controller when connected (dropped otherwise: the next hello says it all again). */
  send(message: FromExtension): void {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(message))
  }

  /** For tests and the log: the address dialled or connected, whether connected, how many dials so far. */
  get state(): { target?: string; connected: boolean; dials: number } {
    const target = this.target && (this.url ?? this.target.urls[0])
    return { target, connected: this.socket?.readyState === OPEN, dials: this.dials }
  }

  dispose(): void { this.use(undefined) }

  /** Every address once: the one that connected last first, then the others in the file's order. */
  private startRound(): void {
    const urls = this.target!.urls
    this.round = this.preferred ? [this.preferred, ...urls.filter((u) => u !== this.preferred)] : [...urls]
    this.dialNext()
  }

  /** The next address of the round; after the last, the backoff's wait and a new round. */
  private dialNext(): void {
    const url = this.round.shift()
    if (url) this.dial(url)
    else this.later()
  }

  private dial(url: string): void {
    const target = this.target!
    this.dials++
    this.url = url
    let socket: SocketLike
    try {
      socket = this.deps.dial(url)
    } catch (e) {
      this.deps.log(`bridge: can't dial ${url}: ${e}`)
      this.dialNext()
      return
    }
    this.socket = socket
    let opened = false
    const disarm = this.armDialTimeout(socket)
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return
      disarm()
      opened = true
      this.preferred = url
      this.backoff.reset()
      this.quietRetries = false
      this.deps.log(`bridge: connected to ${target.name} (${url})`)
      socket.send(JSON.stringify(this.deps.hello(target)))
    })
    socket.addEventListener('message', (e) => { if (typeof e.data === 'string') this.received(socket, target, e.data) })
    // A dial that fails gets 'error' alone in Node (no 'close'); a drop gets both: the first one counts.
    const lost = () => {
      if (this.socket !== socket) return
      disarm()
      this.socket = undefined
      if (!this.quietRetries) this.deps.log(`bridge: no connection to ${target.name}; trying again`)
      this.quietRetries = true
      // A drop waits, then dials every address again; an address that never answered gives way to the next one.
      if (opened) this.later()
      else this.dialNext()
    }
    socket.addEventListener('error', lost)
    socket.addEventListener('close', lost)
  }

  /**
   * With several addresses, gives `socket` DIAL_TIMEOUT_MS to open before the next address is tried (one address:
   * nothing else to try, the system's own timeout is waited for). Returns what cancels it.
   */
  private armDialTimeout(socket: SocketLike): () => void {
    if (this.target!.urls.length < 2) return () => undefined
    const timer = this.deps.timers.set(() => this.giveUp(socket), this.deps.dialTimeoutMs ?? DIAL_TIMEOUT_MS)
    return () => this.deps.timers.clear(timer)
  }

  /** A dial that took too long: closed, so the next address is tried (its 'close' or 'error' comes later or never). */
  private giveUp(socket: SocketLike): void {
    if (this.socket !== socket) return
    this.socket = undefined
    try { socket.close() } catch { /* a socket still connecting may refuse to close: it is forgotten either way */ }
    this.dialNext()
  }

  private received(socket: SocketLike, target: BridgeTarget, data: string): void {
    const request = readFrame(data)
    if (!request) return
    this.deps.handle(request, target).then(
      (response) => { if (this.socket === socket && socket.readyState === OPEN) socket.send(JSON.stringify(response)) },
      (e) => this.deps.log(`bridge: ${request.method}: ${e}`),
    )
  }

  /** The next round, after the backoff's wait. */
  private later(): void {
    this.retry = this.deps.timers.set(() => { this.retry = undefined; if (this.target) this.startRound() }, this.backoff.next())
  }

  private hangUp(): void {
    if (this.retry !== undefined) this.deps.timers.clear(this.retry)
    this.retry = undefined
    this.round = []
    this.url = undefined
    const s = this.socket
    this.socket = undefined
    if (s) {
      this.deps.log('bridge: disconnected')
      try { s.close(1000, 'bye') } catch { /* closing a socket that never opened: nothing to do */ }
    }
  }
}
