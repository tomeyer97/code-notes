// The connection to a controller (src/core/bridge/client.ts, backoff.ts) against a real WebSocket server
// (helpers/wsServer.ts) with Node's own WebSocket: the hello with the token, requests answered, dialling again after
// a drop with a backoff of 1 s to 30 s, several addresses tried in turn, and the discovery file (watch.ts) followed
// end to end.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { Backoff } from '../src/core/bridge/backoff'
import { BridgeClient, ClientDeps, SocketLike } from '../src/core/bridge/client'
import type { BridgeTarget } from '../src/core/bridge/discovery'
import { DiscoveryWatch } from '../src/core/bridge/watch'
import type { BridgeRequest, BridgeResponse } from '../src/protocol/bridge'
import { FakeController } from './helpers/wsServer'

const dial = (url: string) => new WebSocket(url) as unknown as SocketLike

/** The dial timeout in these tests: long enough for a dial on this machine, short enough to wait for. */
const DIAL_TIMEOUT = 300

/** Real timers, a waited delay shortened to 10 ms; every delay asked for is kept. The dial timeout runs as it is and
 *  is not kept: it is no wait between dials. */
function fastTimers() {
  const asked: number[] = []
  return {
    asked,
    set: (fn: () => void, ms: number) => {
      if (ms === DIAL_TIMEOUT) return setTimeout(fn, ms)
      asked.push(ms)
      return setTimeout(fn, 10)
    },
    clear: (h: unknown) => clearTimeout(h as NodeJS.Timeout),
  }
}

/** A client whose handler echoes the method; its log kept. */
function client(timers = fastTimers(), handle?: ClientDeps['handle']) {
  const log: string[] = []
  const c = new BridgeClient({
    dial, timers, log: (l) => log.push(l), dialTimeoutMs: DIAL_TIMEOUT,
    hello: (t) => ({ type: 'hello', protocol: 1, token: t.token, client: 'code-notes', version: '9.9.9', window: { folders: [], remoteName: null, wslDistro: 'Ubuntu' } }),
    handle: handle ?? (async (r: BridgeRequest): Promise<BridgeResponse> => ({ type: 'response', id: r.id, ok: true, result: { echo: r.method } })),
  })
  return { c, log, timers }
}

const target = (ctl: FakeController, token = 'secret'): BridgeTarget => ({ urls: [ctl.url], token, name: 'Desk' })

/** An address where nobody listens: a port taken, then freed. */
async function deadUrl(): Promise<string> {
  const ctl = await new FakeController().listen()
  const url = ctl.url
  await ctl.close()
  return url
}

test('Backoff: 1 s doubling to 30 s; back to 1 s after a reset', () => {
  const b = new Backoff()
  assert.deepEqual(Array.from({ length: 7 }, () => b.next()), [1000, 2000, 4000, 8000, 16000, 30000, 30000])
  b.reset()
  assert.equal(b.next(), 1000)
})

test('connects, says hello with the token first, answers requests; other frames are ignored', async () => {
  const ctl = await new FakeController().listen()
  const { c } = client()
  try {
    c.use(target(ctl))
    const hello = await ctl.until('hello', () => ctl.received[0])
    assert.deepEqual(hello, { type: 'hello', protocol: 1, token: 'secret', client: 'code-notes', version: '9.9.9', window: { folders: [], remoteName: null, wslDistro: 'Ubuntu' } })
    ctl.sendRaw('not json')
    ctl.sendRaw('{"type":"event"}')
    assert.deepEqual(await ctl.request('context.get'), { type: 'response', id: 'r1', ok: true, result: { echo: 'context.get' } })
    assert.equal(ctl.received.length, 2, 'nothing sent for the frames that are no request')
    assert.equal(c.state.connected, true)
    c.send({ type: 'window', window: { folders: [], remoteName: 'wsl', wslDistro: 'Ubuntu' } })
    await ctl.until('window', () => ctl.received.find((m) => m.type === 'window'))
  } finally { c.dispose(); await ctl.close() }
})

test('a handler that fails is logged, the connection stays', async () => {
  const ctl = await new FakeController().listen()
  const { c, log } = client(fastTimers(), async () => { throw new Error('boom') })
  try {
    c.use(target(ctl))
    await ctl.until('hello', () => ctl.received[0])
    ctl.sendRaw('{"type":"request","id":"x","method":"reveal"}')
    await new Promise((r) => setTimeout(r, 100))
    assert.ok(log.some((l) => /reveal: Error: boom/.test(l)), log.join('\n'))
    assert.equal(c.state.connected, true)
  } finally { c.dispose(); await ctl.close() }
})

test('dials again after a drop, waiting 1 s first, and says hello again', async () => {
  const ctl = await new FakeController().listen()
  const { c, timers, log } = client()
  try {
    c.use(target(ctl))
    await ctl.until('first hello', () => ctl.received.length === 1)
    ctl.drop()
    await ctl.until('second hello', () => ctl.received.length === 2 && ctl.connections === 2)
    assert.equal(timers.asked[0], 1000)
    assert.equal(ctl.received[1].type, 'hello')
    assert.equal(log.filter((l) => /trying again/.test(l)).length, 1, 'one line per drop')
  } finally { c.dispose(); await ctl.close() }
})

test('nobody listening: the waits double to 30 s; once connected, the next drop waits 1 s again', async () => {
  const ctl = await new FakeController().listen()
  const port = ctl.port
  const t = target(ctl)
  await ctl.close()
  const { c, timers, log } = client()
  try {
    c.use(t)
    await waitFor(() => timers.asked.length >= 7)
    assert.deepEqual(timers.asked.slice(0, 7), [1000, 2000, 4000, 8000, 16000, 30000, 30000])
    assert.equal(log.filter((l) => /trying again/.test(l)).length, 1, 'the retries are quiet')
    const back = await new FakeController().listen(port)
    try {
      await back.until('hello on the same port', () => back.received[0])
      const before = timers.asked.length
      back.drop()
      await waitFor(() => timers.asked.length > before)
      assert.equal(timers.asked[before], 1000, 'reset by the connection')
    } finally { await back.close() }
  } finally { c.dispose() }
})

test('use(): none hangs up for good; another target is dialled at once', async () => {
  const a = await new FakeController().listen()
  const b = await new FakeController().listen()
  const { c, timers } = client()
  try {
    c.use(target(a))
    await a.until('hello a', () => a.received[0])
    c.use(target(a))
    assert.equal(c.state.dials, 1, 'the same target: nothing to do')
    c.use(target(b, 'other'))
    const hello = await b.until('hello b', () => b.received[0])
    assert.equal(hello.token, 'other')
    await a.until('a hung up', () => !a.connected)
    assert.deepEqual(timers.asked, [], 'a switch is no failure: no wait')
    c.use(undefined)
    await b.until('b hung up', () => !b.connected)
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(c.state.dials, 2)
    assert.deepEqual(timers.asked, [], 'no dial after hanging up')
  } finally { c.dispose(); await a.close(); await b.close() }
})

test('several addresses: the second is dialled at once when the first does not answer, and kept', async () => {
  const dead = await deadUrl()
  const ctl = await new FakeController().listen()
  const { c, timers } = client()
  try {
    c.use({ urls: [dead, ctl.url], token: 'secret', name: 'Desk' })
    assert.equal((await ctl.until('hello', () => ctl.received[0])).token, 'secret')
    assert.deepEqual(c.state, { target: ctl.url, connected: true, dials: 2 })
    assert.deepEqual(timers.asked, [], 'no wait between the addresses of a round')
  } finally { c.dispose(); await ctl.close() }
})

test('several addresses: after a drop and the wait, the one that connected is dialled first', async () => {
  const dead = await deadUrl()
  const ctl = await new FakeController().listen()
  const { c, timers } = client()
  try {
    c.use({ urls: [dead, ctl.url], token: 'secret', name: 'Desk' })
    await ctl.until('first hello', () => ctl.received.length === 1)
    ctl.drop()
    await ctl.until('second hello', () => ctl.received.length === 2 && ctl.connections === 2)
    assert.deepEqual(timers.asked, [1000], 'the drop waits once')
    assert.equal(c.state.dials, 3, 'the dead address is not tried before the one that connected')
  } finally { c.dispose(); await ctl.close() }
})

test('several addresses, none answering: every one is tried each round, one wait per round', async () => {
  const [a, b] = [await deadUrl(), await deadUrl()]
  const { c, timers } = client()
  try {
    c.use({ urls: [a, b], token: 'secret', name: 'Desk' })
    await waitFor(() => timers.asked.length >= 3)
    c.dispose()
    assert.deepEqual(timers.asked.slice(0, 3), [1000, 2000, 4000])
    assert.ok(c.state.dials >= 6 && c.state.dials <= 8, `two dials per wait: ${c.state.dials}`)
  } finally { c.dispose() }
})

test('several addresses: one that never answers is given up after the dial timeout', async () => {
  const held: net.Socket[] = []
  const silent = net.createServer((socket) => { held.push(socket) }) // accepts, never answers the handshake
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
  const ctl = await new FakeController().listen()
  const { c, timers } = client()
  try {
    c.use({ urls: [`ws://127.0.0.1:${(silent.address() as net.AddressInfo).port}/`, ctl.url], token: 'secret', name: 'Desk' })
    await ctl.until('hello after the timeout', () => ctl.received[0])
    assert.equal(c.state.dials, 2)
    assert.deepEqual(timers.asked, [])
  } finally {
    c.dispose(); await ctl.close()
    for (const socket of held) socket.destroy()
    silent.close()
  }
})

test('end to end with a discovery file: found, a new port followed, gone hangs up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'))
  const file = path.join(dir, 'bridge.json')
  const a = await new FakeController().listen()
  const b = await new FakeController().listen()
  const { c } = client()
  const watch = new DiscoveryWatch({
    paths: async () => [path.join(dir, 'missing.json'), file],
    read: (p) => fs.promises.readFile(p, 'utf8').catch(() => undefined),
    changed: (t) => c.use(t),
    timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as NodeJS.Timeout) },
    pollMs: 20,
  })
  try {
    await watch.start()
    assert.equal(c.state.dials, 0, 'no file: no dial')
    fs.writeFileSync(file, JSON.stringify({ url: a.url, token: 'tok-a', name: 'Desk' }), { mode: 0o600 })
    assert.equal((await a.until('hello a', () => a.received[0])).token, 'tok-a')
    fs.writeFileSync(file, JSON.stringify({ url: b.url, token: 'tok-b', name: 'Desk' }))
    assert.equal((await b.until('hello b', () => b.received[0])).token, 'tok-b')
    fs.rmSync(file)
    await b.until('hung up', () => !b.connected)
  } finally {
    watch.stop(); c.dispose(); await a.close(); await b.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}
