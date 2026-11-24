// src/webview/channel.ts with a fake webview: what is sent waits for the page's 'ready', the page's errors are logged,
// a detached page gets nothing, the same view twice goes once.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type * as vscode from 'vscode'
import { WebviewChannel } from '../src/webview/channel'

type In = { type: 'ready' } | { type: 'error'; message?: string; text?: string } | { type: 'hi'; n: number }
type Out = { type: 'show'; n: number } | { type: 'hello' }

/** A webview that keeps what is posted to it; `say(m)` is a message from its page. */
function fakeWebview() {
  const posted: Out[] = []
  let listener: ((m: In) => void) | undefined
  const webview = {
    postMessage: (m: Out) => { posted.push(m); return Promise.resolve(true) },
    onDidReceiveMessage: (f: (m: In) => void) => { listener = f; return { dispose: () => { listener = undefined } } },
  } as unknown as vscode.Webview
  return { webview, posted, say: (m: In) => listener?.(m) }
}

function fakeLog() {
  const errors: string[] = []
  return { log: { error: (m: string) => errors.push(m) } as unknown as vscode.LogOutputChannel, errors }
}

test('a message waits for the page to be ready, then goes in order after onReady', () => {
  const { log } = fakeLog()
  const order: string[] = []
  const ch = new WebviewChannel<In, Out>('test page', log, { onReady: () => order.push('onReady') })
  const w = fakeWebview()
  const got: In[] = []
  ch.attach(w.webview, (m) => { got.push(m); order.push(`message ${m.type}`) })
  ch.send({ type: 'show', n: 1 })
  ch.send({ type: 'show', n: 2 })
  assert.deepEqual(w.posted, [])
  assert.equal(ch.ready, false)
  w.say({ type: 'ready' })
  assert.equal(ch.ready, true)
  assert.deepEqual(w.posted, [{ type: 'show', n: 1 }, { type: 'show', n: 2 }])
  assert.deepEqual(order, ['onReady', 'message ready'])
  ch.send({ type: 'show', n: 3 })
  assert.deepEqual(w.posted.at(-1), { type: 'show', n: 3 })
  assert.deepEqual(got, [{ type: 'ready' }])
})

test('sendNow goes before ready; sendChanged only when ready and changed', () => {
  const ch = new WebviewChannel<In, Out>('test page', fakeLog().log)
  const w = fakeWebview()
  ch.attach(w.webview, () => undefined)
  ch.sendNow({ type: 'hello' })
  ch.sendChanged({ type: 'show', n: 1 })
  assert.deepEqual(w.posted, [{ type: 'hello' }])
  w.say({ type: 'ready' })
  ch.sendChanged({ type: 'show', n: 1 })
  ch.sendChanged({ type: 'show', n: 1 })
  ch.sendChanged({ type: 'show', n: 2 }, 'same key')
  ch.sendChanged({ type: 'show', n: 3 }, 'same key')
  assert.deepEqual(w.posted, [{ type: 'hello' }, { type: 'show', n: 1 }, { type: 'show', n: 2 }])
  // A new 'ready' (the page loaded again) sends the same view again.
  w.say({ type: 'ready' })
  ch.sendChanged({ type: 'show', n: 2 }, 'same key')
  assert.deepEqual(w.posted.at(-1), { type: 'show', n: 2 })
  assert.equal(w.posted.length, 4)
})

test("the page's errors go to the log under the channel's name, and on to the handler", () => {
  const { log, errors } = fakeLog()
  const ch = new WebviewChannel<In, Out>('test page', log)
  const w = fakeWebview()
  const got: In[] = []
  ch.attach(w.webview, (m) => got.push(m))
  w.say({ type: 'error', message: 'boom' })
  w.say({ type: 'error', text: 'bang' })
  assert.deepEqual(errors, ['test page: boom', 'test page: bang'])
  assert.equal(got.length, 2)
})

test('detached: nothing is sent and the queue is dropped, unless it waits for the next page', () => {
  const dropping = new WebviewChannel<In, Out>('a', fakeLog().log)
  dropping.send({ type: 'show', n: 1 })
  const w1 = fakeWebview()
  dropping.attach(w1.webview, () => undefined)
  dropping.send({ type: 'show', n: 2 })
  dropping.detach()
  assert.equal(dropping.attached, false)
  const w2 = fakeWebview()
  dropping.attach(w2.webview, () => undefined)
  w2.say({ type: 'ready' })
  assert.deepEqual(w2.posted, [])

  const keeping = new WebviewChannel<In, Out>('b', fakeLog().log, { queueWithoutPage: true })
  keeping.send({ type: 'show', n: 1 })
  const w3 = fakeWebview()
  keeping.attach(w3.webview, () => undefined)
  w3.say({ type: 'ready' })
  assert.deepEqual(w3.posted, [{ type: 'show', n: 1 }])
})
