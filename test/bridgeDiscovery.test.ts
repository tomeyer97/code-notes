// The bridge's discovery (src/core/bridge/discovery.ts, watch.ts, wslHost.ts): the file a controller writes (one
// address or several), where it is looked for (inside WSL also the Windows user's home), the Windows host's address
// inside WSL, and the file followed as it appears, changes and goes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'path'
import { discoveryPaths, isLocalWs, isWsl, parseBridgeFile, RunProgram, windowsHomeInWsl } from '../src/core/bridge/discovery'
import { DiscoveryWatch, findTarget } from '../src/core/bridge/watch'
import type { BridgeTarget } from '../src/core/bridge/discovery'
import { defaultGateway } from '../src/core/bridge/wslHost'

const file = (o: object) => JSON.stringify(o)
const good = { url: 'ws://127.0.0.1:7777/v1/bridge', token: 't0k', name: 'Desk' }
/** `good` as a target: its one address. */
const goodTarget: BridgeTarget = { urls: [good.url], token: 't0k', name: 'Desk' }

test('parseBridgeFile: url, token and name; a missing name reads "Controller"', () => {
  assert.deepEqual(parseBridgeFile(file(good)), goodTarget)
  assert.deepEqual(parseBridgeFile(file({ ...good, name: '' })), { ...goodTarget, name: 'Controller' })
  assert.deepEqual(parseBridgeFile(file({ ...good, name: '  Desk  ', extra: 1 })), goodTarget, 'trimmed; unknown fields ignored')
})

test('parseBridgeFile: `urls` after `url`, in order, each once; unusable ones left out', () => {
  const a = 'ws://127.0.0.1:1/b', b = 'ws://localhost:2/b'
  assert.deepEqual(parseBridgeFile(file({ ...good, urls: [a, b] }))?.urls, [good.url, a, b])
  assert.deepEqual(parseBridgeFile(file({ token: 't', urls: [a, b] }))?.urls, [a, b], '`urls` alone is enough')
  assert.deepEqual(parseBridgeFile(file({ token: 't', url: a, urls: [b, a, ` ${b} `] }))?.urls, [a, b])
  assert.deepEqual(parseBridgeFile(file({ token: 't', urls: ['ws://10.0.0.2:1/x', 7, '', b] }))?.urls, [b])
  assert.equal(parseBridgeFile(file({ token: 't', urls: ['ws://10.0.0.2:1/x'] })), undefined, 'no usable address')
  assert.equal(parseBridgeFile(file({ token: 't', urls: 'ws://127.0.0.1:1/x' })), undefined, '`urls` is a list')
})

test('parseBridgeFile: a host allowed besides loopback (the Windows host inside WSL)', () => {
  const host = 'ws://172.20.48.1:7777/v1/bridge'
  assert.equal(parseBridgeFile(file({ token: 't', urls: [host] })), undefined, 'not allowed by default')
  assert.deepEqual(parseBridgeFile(file({ ...good, urls: [host] }), ['172.20.48.1'])?.urls, [good.url, host])
  assert.equal(parseBridgeFile(file({ token: 't', urls: ['ws://172.20.48.2:1/x'] }), ['172.20.48.1']), undefined, 'only that host')
})

test('defaultGateway: the default route\'s gateway in /proc/net/route, as a dotted address', () => {
  const table = [
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
    'eth0\t0030A8C0\t00000000\t0001\t0\t0\t0\t00F0FFFF\t0\t0\t0',
    'eth0\t00000000\t0130A8AC\t0003\t0\t0\t0\t00000000\t0\t0\t0',
  ].join('\n')
  assert.equal(defaultGateway(table), '172.168.48.1')
  assert.equal(defaultGateway(table.split('\n').slice(0, 2).join('\n')), undefined, 'no default route')
  assert.equal(defaultGateway(''), undefined)
})

test('parseBridgeFile: unusable files are none (no token, not JSON, not a local ws:// URL)', () => {
  for (const bad of ['', 'not json', '[]', 'null', file({ ...good, token: '' }), file({ url: good.url }),
    file({ ...good, url: 'wss://127.0.0.1:1/x' }), file({ ...good, url: 'ws://example.com:1/x' }),
    file({ ...good, url: 'http://127.0.0.1:1/x' }), file({ ...good, url: 'ws://10.0.0.2:1/x' }), file({ ...good, url: 42 })]) {
    assert.equal(parseBridgeFile(bad), undefined, bad)
  }
})

test('isLocalWs: loopback hosts, and the hosts it is given', () => {
  assert.equal(isLocalWs('ws://172.20.48.1:1/', ['172.20.48.1']), true)
  assert.equal(isLocalWs('wss://172.20.48.1:1/', ['172.20.48.1']), false, 'ws:// only')
  assert.equal(isLocalWs('ws://127.0.0.1:1/'), true)
  assert.equal(isLocalWs('ws://127.1.2.3:1/'), true)
  assert.equal(isLocalWs('ws://localhost:1/'), true)
  assert.equal(isLocalWs('ws://[::1]:1/'), true)
  assert.equal(isLocalWs('ws://127.0.0.1.example.com:1/'), false)
  assert.equal(isLocalWs('ws://192.168.1.2:1/'), false)
  assert.equal(isLocalWs('nonsense'), false)
})

test('discoveryPaths: the home\'s file; in WSL also the Windows home\'s; the setting alone when set', () => {
  const join = path.posix.join
  assert.deepEqual(discoveryPaths({ home: '/home/u', join }), ['/home/u/.code-notes/bridge.json'])
  assert.deepEqual(discoveryPaths({ home: '/home/u', windowsHome: '/mnt/c/Users/U', join }),
    ['/home/u/.code-notes/bridge.json', '/mnt/c/Users/U/.code-notes/bridge.json'])
  assert.deepEqual(discoveryPaths({ override: ' /tmp/b.json ', home: '/home/u', windowsHome: '/mnt/c/Users/U', join }), ['/tmp/b.json'])
  assert.deepEqual(discoveryPaths({ override: '  ', home: '/home/u', join }), ['/home/u/.code-notes/bridge.json'], 'a blank setting is no setting')
})

test('windowsHomeInWsl: %USERPROFILE% from cmd.exe, then wslpath', async () => {
  const calls: string[] = []
  const run: RunProgram = async (f, args) => {
    calls.push([f, ...args].join(' '))
    if (f === 'cmd.exe') return 'C:\\Users\\Sam\r\n'
    if (f === 'wslpath') return `/mnt/c/Users/${args[1].split('\\').pop()}\n`
    throw new Error('unexpected')
  }
  assert.equal(await windowsHomeInWsl(run), '/mnt/c/Users/Sam')
  assert.deepEqual(calls, ['cmd.exe /c echo %USERPROFILE%', 'wslpath -u C:\\Users\\Sam'])
})

test('windowsHomeInWsl: none when interop is off, the variable is unset or wslpath fails', async () => {
  assert.equal(await windowsHomeInWsl(async () => { throw new Error('ENOENT') }), undefined)
  assert.equal(await windowsHomeInWsl(async () => '%USERPROFILE%\r\n'), undefined, 'cmd.exe echoes an unset variable as it is')
  assert.equal(await windowsHomeInWsl(async (f) => { if (f === 'wslpath') throw new Error('bad'); return 'C:\\Users\\Sam' }), undefined)
  assert.equal(await windowsHomeInWsl(async (f) => (f === 'wslpath' ? '' : 'C:\\Users\\Sam')), undefined)
})

test('isWsl: the distro variable, or a Microsoft kernel', () => {
  assert.equal(isWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, ''), true)
  assert.equal(isWsl({}, 'Linux version 6.6.87.2-microsoft-standard-WSL2'), true)
  assert.equal(isWsl({}, 'Linux version 6.8.0-generic'), false)
})

test('findTarget: the first usable file in order', async () => {
  const files: Record<string, string> = { '/b': 'broken', '/c': file(good), '/d': file({ ...good, name: 'Other' }) }
  const read = async (p: string) => files[p]
  assert.deepEqual(await findTarget(['/a', '/b', '/c', '/d'], read), { target: goodTarget, path: '/c' })
  assert.equal(await findTarget(['/a', '/b'], read), undefined)
})

/** Timers run by hand: tick() runs what is due. */
function manualTimers() {
  let due: { fn: () => void; ms: number }[] = []
  return {
    set: (fn: () => void, ms: number) => { const t = { fn, ms }; due.push(t); return t },
    clear: (h: unknown) => { due = due.filter((t) => t !== h) },
    pending: () => due.map((t) => t.ms),
    tick: () => { const now = due; due = []; for (const t of now) t.fn() },
  }
}

test('DiscoveryWatch: silent with no file; the target when it appears, changes and goes; none after stop', async () => {
  const files: Record<string, string> = {}
  const timers = manualTimers()
  const changes: (string | undefined)[] = []
  const watch = new DiscoveryWatch({
    paths: async () => ['/home/u/.code-notes/bridge.json', '/mnt/c/Users/U/.code-notes/bridge.json'],
    read: async (p) => files[p], timers, pollMs: 50,
    changed: (t: BridgeTarget | undefined, p) => changes.push(t ? `${t.name} ${t.urls.join(' ')} @${p}` : undefined),
  })
  const poll = async () => { timers.tick(); await watch.check() }
  await watch.start()
  assert.deepEqual(changes, [], 'no file: nothing to say')
  assert.deepEqual(timers.pending(), [50], 'read again later')

  files['/mnt/c/Users/U/.code-notes/bridge.json'] = file(good)
  await poll()
  assert.deepEqual(changes, ['Desk ws://127.0.0.1:7777/v1/bridge @/mnt/c/Users/U/.code-notes/bridge.json'])
  await poll()
  assert.equal(changes.length, 1, 'the same file again: no change')

  files['/mnt/c/Users/U/.code-notes/bridge.json'] = file({ ...good, url: 'ws://127.0.0.1:8888/v1/bridge' })
  await poll()
  assert.equal(changes.at(-1), 'Desk ws://127.0.0.1:8888/v1/bridge @/mnt/c/Users/U/.code-notes/bridge.json', 'a new port: the new target')

  delete files['/mnt/c/Users/U/.code-notes/bridge.json']
  await poll()
  assert.equal(changes.at(-1), undefined, 'the file gone: no target')
  assert.equal(changes.length, 3)

  files['/home/u/.code-notes/bridge.json'] = file(good)
  watch.stop()
  assert.deepEqual(timers.pending(), [], 'stopped: no more reads')
  await watch.check()
  assert.equal(changes.length, 3, 'a read after stop says nothing')
  await watch.start()
  assert.equal(changes.at(-1), 'Desk ws://127.0.0.1:7777/v1/bridge @/home/u/.code-notes/bridge.json', 'started again: said again')
  watch.stop()
})

test('DiscoveryWatch: the hosts it is given allow their addresses; a new address list is a new target', async () => {
  const path = '/home/u/.code-notes/bridge.json'
  const files: Record<string, string> = { [path]: file({ ...good, urls: ['ws://172.20.48.1:7777/v1/bridge'] }) }
  const timers = manualTimers()
  const changes: string[][] = []
  const watch = new DiscoveryWatch({
    paths: async () => [path], read: async (p) => files[p], hosts: async () => ['172.20.48.1'], timers,
    changed: (t) => changes.push(t?.urls ?? []),
  })
  await watch.start()
  assert.deepEqual(changes, [[good.url, 'ws://172.20.48.1:7777/v1/bridge']])
  files[path] = file({ ...good, urls: ['ws://127.0.0.2:7777/v1/bridge'] })
  timers.tick()
  await watch.check()
  assert.deepEqual(changes.at(-1), [good.url, 'ws://127.0.0.2:7777/v1/bridge'])
  watch.stop()
})
