import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import type * as vscodeTypes from 'vscode'
import { fakeWebviewView, vscode } from './journey-podcast/fakeVscode'
import { LISTEN_PAGE, ListenView, READY_TIMEOUT_MS } from '../src/podcast/listenView'

// The Listen view's host side (src/podcast/listenView.ts) on a fake VS Code: ensure() shows the view, waits for its
// page, and gives up after READY_TIMEOUT_MS without leaving a waiter behind; the page links LISTEN_PAGE's files.

const log = { warn: () => undefined, error: () => undefined, info: () => undefined } as unknown as vscodeTypes.LogOutputChannel
const root = vscode.Uri.file('/ext') as unknown as vscodeTypes.Uri

/** A Listen view whose focus command makes its page (`ready`: the page says so). */
function listenView(ready: boolean) {
  const lv = new ListenView(root, log, { message: () => undefined, gone: () => undefined })
  const page = fakeWebviewView(() => undefined, 'file:')
  vscode.commands.ran = []
  vscode.commands.handlers = {
    'codeNotes.listen.focus': () => {
      lv.resolveWebviewView(page.view as unknown as vscodeTypes.WebviewView)
      if (ready) page.fromPage({ type: 'ready' })
    },
  }
  return { lv, page }
}

test('ensure: the view shown, the keyboard given back, true once its page is ready', async () => {
  const { lv } = listenView(true)
  assert.equal(await lv.ensure(), true)
  assert.deepEqual(vscode.commands.ran, ['setContext', 'codeNotes.listen.focus', 'workbench.action.focusActiveEditorGroup'])
  assert.equal(lv.alive, true)
  assert.equal(await lv.ensure(), true)
})

test('ensure: a page that never says ready gives false after READY_TIMEOUT_MS, and a later ready still works', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { lv, page } = listenView(false)
    const first = lv.ensure()
    await new Promise<void>((r) => setImmediate(r))
    mock.timers.tick(READY_TIMEOUT_MS - 1)
    let settled = false
    void first.then(() => { settled = true })
    await new Promise<void>((r) => setImmediate(r))
    assert.equal(settled, false, 'still waiting just before the timeout')
    mock.timers.tick(1)
    assert.equal(await first, false)
    // The page comes late: the next ensure() is true at once, and the late ready finds no waiter of the first.
    page.fromPage({ type: 'ready' })
    assert.equal(await lv.ensure(), true)
  } finally {
    mock.timers.reset()
  }
})

test('the page links the files LISTEN_PAGE names, and the bundled listen script', () => {
  const { lv, page } = listenView(true)
  lv.resolveWebviewView(page.view as unknown as vscodeTypes.WebviewView)
  const html = page.view.webview.html
  const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1].replace(/^.*\/media\//, ''))
  assert.deepEqual(links, [...LISTEN_PAGE.css])
  assert.match(html, /<script nonce="\w+" src="[^"]*\/out\/pages\/listen\.js"><\/script>/)
  assert.match(html, /media-src file: blob:/)
})
