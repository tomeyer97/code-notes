// A controller for the bridge's tests: a WebSocket server on 127.0.0.1 (the handshake and text frames of RFC 6455, no
// dependency) that keeps what the extension sent and sends it requests. Used by the unit tests (bridgeClient.test.ts)
// and the integration tests (integration/main/bridge.ts).
import * as crypto from 'crypto'
import * as http from 'http'
import type { AddressInfo, Socket } from 'net'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** A text frame from the server (servers never mask). */
function frame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length
  const head = n < 126 ? Buffer.from([0x80 | opcode, n])
    : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 0xff])
    : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b })()])
  return Buffer.concat([head, payload])
}

/** The complete frames at the start of `buf` (a client's: masked), and what is left. */
function readFrames(buf: Buffer): { frames: { opcode: number; payload: Buffer }[]; rest: Buffer } {
  const frames: { opcode: number; payload: Buffer }[] = []
  let at = 0
  for (;;) {
    if (buf.length - at < 2) break
    const opcode = buf[at] & 0x0f
    let len = buf[at + 1] & 0x7f
    let p = at + 2
    if (len === 126) { if (buf.length - p < 2) break; len = buf.readUInt16BE(p); p += 2 }
    else if (len === 127) { if (buf.length - p < 8) break; len = Number(buf.readBigUInt64BE(p)); p += 8 }
    const masked = (buf[at + 1] & 0x80) !== 0
    const mask = masked ? buf.subarray(p, p + 4) : undefined
    if (masked) p += 4
    if (buf.length - p < len) break
    const payload = Buffer.from(buf.subarray(p, p + len))
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
    frames.push({ opcode, payload })
    at = p + len
  }
  return { frames, rest: buf.subarray(at) }
}

export interface Received { [key: string]: unknown; type?: string }

export class FakeController {
  /** Every message the extension sent, oldest first, across connections. */
  readonly received: Received[] = []
  /** Connections accepted so far. */
  connections = 0
  private readonly server = http.createServer((_q, r) => { r.writeHead(426); r.end() })
  private socket: Socket | undefined
  private waiters: (() => void)[] = []
  private nextId = 1

  /** Listens on 127.0.0.1 (port 0: any free one; a given port to come back on the same one). */
  async listen(port = 0): Promise<this> {
    this.server.on('upgrade', (req, socket: Socket) => this.accept(req, socket))
    await new Promise<void>((resolve) => this.server.listen(port, '127.0.0.1', resolve))
    return this
  }

  get url(): string { return `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1/bridge` }
  get port(): number { return (this.server.address() as AddressInfo).port }
  get connected(): boolean { return !!this.socket && !this.socket.destroyed }

  private accept(req: http.IncomingMessage, socket: Socket): void {
    const key = String(req.headers['sec-websocket-key'] ?? '')
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    this.socket?.destroy()
    this.socket = socket
    this.connections++
    let buf: Buffer = Buffer.alloc(0)
    socket.on('data', (d: Buffer) => {
      const { frames, rest } = readFrames(Buffer.concat([buf, d]))
      buf = rest
      for (const f of frames) {
        if (f.opcode === 0x1) this.received.push(JSON.parse(f.payload.toString('utf8')))
        else if (f.opcode === 0x8) { socket.end(frame(0x8, f.payload.subarray(0, 2))); continue }
        else if (f.opcode === 0x9) socket.write(frame(0xa, f.payload))
      }
      this.wake()
    })
    socket.on('error', () => socket.destroy())
    socket.on('close', () => { if (this.socket === socket) this.socket = undefined; this.wake() })
    this.wake()
  }

  private wake(): void { const w = this.waiters; this.waiters = []; for (const f of w) f() }

  /** Waits until `check` holds (checked on every message and connection change). */
  until<T>(what: string, check: () => T | undefined | false, ms = 8000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}; received ${JSON.stringify(this.received.slice(-3))}`)), ms)
      const test = () => {
        const v = check()
        if (v) { clearTimeout(timer); resolve(v) } else this.waiters.push(test)
      }
      test()
    })
  }

  /** Sends a raw text frame (a test of what the extension ignores). */
  sendRaw(text: string): void {
    if (!this.socket) throw new Error('no connection')
    this.socket.write(frame(0x1, Buffer.from(text, 'utf8')))
  }

  /** Sends a request and waits for its response. */
  async request(method: string, params?: unknown, ms?: number): Promise<{ ok: boolean; result?: any; error?: string }> {
    const id = `r${this.nextId++}`
    this.sendRaw(JSON.stringify({ type: 'request', id, method, params }))
    const r = await this.until(`response to ${method}`, () => this.received.find((m) => m.type === 'response' && m.id === id), ms)
    return r as never
  }

  /** Drops the connection as a crashed controller would (no close frame). */
  drop(): void { this.socket?.destroy(); this.socket = undefined }

  async close(): Promise<void> {
    this.drop()
    this.server.closeAllConnections?.()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}
