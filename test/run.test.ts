import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fireAndForget, run, showError, useWindow } from '../src/platform/run'
import { SaveFailures } from '../src/platform/saveFailures'
import type * as vscode from 'vscode'

/** A window that records what the extension logs and shows. */
function fakeWindow() {
  const lines: string[] = []
  const shown: string[] = []
  useWindow({
    log: { error: (m: string) => { lines.push(`error ${m}`) }, warn: (m: string) => { lines.push(`warn ${m}`) }, debug: (m: string) => { lines.push(`debug ${m}`) } },
    showErrorMessage: (text: string) => { shown.push(text); return Promise.resolve(undefined) },
  })
  return { lines, shown }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

test('showError: shown as an error with the Code Notes prefix, logged without it', async () => {
  const w = fakeWindow()
  await showError("the file can't be read")
  assert.deepEqual(w.shown, ["Code Notes: the file can't be read"])
  assert.deepEqual(w.lines, ["error the file can't be read"])
})

test('run: the value, or undefined and a log line with what was being done', async () => {
  const w = fakeWindow()
  assert.equal(await run(Promise.resolve(3), { what: 'x' }), 3)
  assert.equal(await run(() => 4, { what: 'x' }), 4)
  assert.equal(await run(() => Promise.reject(new Error('gone')), { what: 'map: save width' }), undefined)
  assert.equal(await run(() => { throw new Error('thrown') }, { what: 'sync' }), undefined)
  assert.deepEqual(w.lines, ['error map: save width: gone', 'error sync: thrown'])
  assert.deepEqual(w.shown, [])
})

test('run: silent goes to the debug log, toast is also shown as an error', async () => {
  const w = fakeWindow()
  await run(Promise.reject(new Error('closed')), { what: 'panel', surface: 'silent' })
  await run(Promise.reject('no'), { what: 'push', surface: 'toast' })
  assert.deepEqual(w.lines, ['debug panel: closed', 'error push: no'])
  assert.deepEqual(w.shown, ['Code Notes: push: no'])
})

test('fireAndForget: a rejection is logged, never unhandled', async () => {
  const w = fakeWindow()
  const unhandled: unknown[] = []
  const on = (e: unknown) => unhandled.push(e)
  process.on('unhandledRejection', on)
  try {
    fireAndForget(Promise.reject(new Error('late')), 'tour: step')
    fireAndForget(undefined, 'nothing')
    await tick()
    await tick()
  } finally { process.off('unhandledRejection', on) }
  assert.deepEqual(unhandled, [])
  assert.deepEqual(w.lines, ['error tour: step: late'])
})

/** A file: URI as SaveFailures reads it. */
const uri = (p: string) => ({ path: p, fsPath: p, toString: () => `file://${p}` }) as unknown as vscode.Uri
const coded = (message: string, code?: string) => Object.assign(new Error(message), { code })

test('save failures: one error message per batch, permission errors by their code, each file once', async () => {
  const w = fakeWindow()
  const logged: string[] = []
  const f = new SaveFailures({ error: (m: string) => { logged.push(m) } }, () => '.code-notes')
  f.report(uri('/w/.code-notes/a.json'), coded('EACCES: permission denied, open', 'EACCES'))
  f.report(uri('/w/.code-notes/b.json'), coded('EACCES: permission denied, open', 'EACCES'))
  f.report(uri('/w/.code-notes/a.json'), coded('again', 'EACCES'))
  await new Promise((r) => setTimeout(r, 600))
  assert.deepEqual(w.shown, ["Code Notes: couldn't save 2 notes in .code-notes/: permission denied (written by another user?)"])
  assert.equal(logged.length, 3, 'every failure is in the log')
  f.saved(uri('/w/.code-notes/a.json'))
  f.report(uri('/w/.code-notes/a.json'), coded('ENOSPC: no space left on device', 'ENOSPC'))
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(w.shown[1], "Code Notes: couldn't save .code-notes/a.json: ENOSPC: no space left on device")
  f.report(uri('/w/.code-notes/c.json'), coded('No permission', 'NoPermissions'))
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(w.shown[2], "Code Notes: couldn't save .code-notes/c.json: permission denied (written by another user?)")
})
