// The bridge: a local program (a controller, here helpers/wsServer.ts) drives the window over a WebSocket. It writes
// the discovery file; the extension dials it, says hello with the token and the window's folders, and answers reveal,
// journey.play, note.add and context.get; it dials again after a drop and hangs up when the file goes.
// Source: src/bridge/ (the requests), src/core/bridge/ (discovery, the connection), src/notes/agentNote.ts.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import assert from 'assert'
import { readJson, test } from '../helpers'
import { FakeController } from '../../helpers/wsServer'
import { closeAllEditors, ctx, journeyById, noteById, notePath, snap, until, wsPath } from './context'
import { savingTs, writeSavingJourney } from './fixtures'

/* eslint-disable @typescript-eslint/no-explicit-any */
const bridge = () => ctx.api.bridge()
const bridgeSettings = () => vscode.workspace.getConfiguration('codeNotes.bridge')
/** The discovery file of this chapter (a machine setting: the user's settings, never the workspace's). */
const discovery = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cn-bridge-')), 'bridge.json')
let ctl: FakeController

const writeDiscovery = (c: FakeController, token = 'bridge-token') =>
  fs.writeFileSync(discovery, JSON.stringify({ url: c.url, token, name: 'Desk' }), { mode: 0o600 })
const savingUri = () => vscode.Uri.file(wsPath('src', 'saving.ts'))

export const bridgeTests = [
  test('a controller\'s discovery file: the extension dials it and says hello with the token and its folders', async () => {
    writeSavingJourney()
    await until('the saving journey', () => journeyById('saving'))
    ctl = await new FakeController().listen()
    await bridgeSettings().update('discovery', discovery, vscode.ConfigurationTarget.Global)
    assert.equal(bridge().connected, false, 'no file: no connection')
    writeDiscovery(ctl)
    const hello: any = await ctl.until('hello', () => ctl.received.find((m) => m.type === 'hello'))
    assert.equal(hello.token, 'bridge-token')
    assert.equal(hello.client, 'code-notes')
    assert.equal(hello.protocol, 1)
    assert.deepEqual(hello.window.folders.map((f: any) => f.path), [ctx.ws])
    assert.equal(hello.window.remoteName, null)
    await until('connected', () => bridge().connected && bridge().file === discovery)
  }),

  test('reveal: the lines open and light, the text shows under them until dismissed', async () => {
    await closeAllEditors()
    const r = await ctl.request('reveal', { file: 'src/saving.ts', start: 3, end: 8, text: 'Writes the note, then logs its id.' })
    assert.deepEqual([r.ok, r.result], [true, { start: 3, end: 8 }])
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, savingUri().fsPath)
    assert.deepEqual(snap().claudeLinks.lit, { uri: savingUri().toString(), start: 2, end: 7 })
    assert.deepEqual(bridge().callout, { uri: savingUri().toString(), start: 2, end: 7, text: 'Writes the note, then logs its id.', author: 'Desk' })
    await vscode.commands.executeCommand('codeNotes.dismissExplanation')
    assert.equal(bridge().callout, undefined, 'dismissed')
    // An absolute path, no text: lit, no callout; lines past the end end at the last line.
    const abs = await ctl.request('reveal', { file: wsPath('src', 'saving.ts'), start: 10, end: 99 })
    assert.equal(abs.ok, true)
    assert.deepEqual(abs.result, { start: 10, end: savingTs.length })
    assert.equal(bridge().callout, undefined)
  }),

  test('reveal: a missing file, bad params and an unknown method are refused with the reason', async () => {
    assert.deepEqual(await pick(ctl.request('reveal', { file: 'src/nope.ts', start: 1 })), { ok: false, error: 'file not found: src/nope.ts' })
    assert.deepEqual(await pick(ctl.request('reveal', { file: 'src/saving.ts', start: 0 })), { ok: false, error: 'start: a line number (1-based) is needed' })
    assert.deepEqual(await pick(ctl.request('file.delete', {})), { ok: false, error: 'unknown method: file.delete' })
  }),

  test('journey.play: the journey walked from the step asked for (by number or id); an unknown one refused', async () => {
    const r = await ctl.request('journey.play', { id: 'saving', step: 2 })
    assert.deepEqual(r.result, { id: 'saving', title: 'Saving a note', step: 2, steps: 2 })
    await until('walking step 2', () => snap().tour.journey === 'saving' && snap().tour.step === 2)
    await ctl.request('journey.play', { id: 'saving', step: 'save' })
    await until('walking step 1', () => snap().tour.step === 1)
    assert.deepEqual(await pick(ctl.request('journey.play', { id: 'nope' })), { ok: false, error: 'no journey with id nope' })
    assert.deepEqual(await pick(ctl.request('journey.play', { id: 'saving', step: 5 })), { ok: false, error: 'saving has no step 5 (it has 2)' })
    await vscode.commands.executeCommand('codeNotes.endJourney')
  }),

  test('note.add: a note on the lines, the controller its author, anchored on the code; its body not sent back', async () => {
    const r = await ctl.request('note.add', { file: 'src/saving.ts', start: 4, end: 5, body: 'Is the write atomic?', session: 'desk review' })
    assert.equal(r.ok, true)
    assert.deepEqual(Object.keys(r.result).sort(), ['file', 'id'])
    assert.equal(r.result.file, 'src/saving.ts')
    await until('the note is listed', () => noteById(r.result.id))
    const n = noteById(r.result.id)
    assert.equal(n.session, 'desk review')
    assert.deepEqual(n.range, { start: 4, end: 5 })
    assert.deepEqual(n.messages.map((m: any) => [m.author, m.role, m.body]), [['Desk', 'agent', 'Is the write atomic?']])
    const onDisk = readJson(notePath(r.result.id))
    assert.equal(onDisk.anchor.text, savingTs.slice(3, 5).join('\n'), 'the text at its lines')
    assert.equal(onDisk.anchor.before, savingTs.slice(1, 3).join('\n'))
    const outside = path.join(path.dirname(discovery), 'outside.ts')
    fs.writeFileSync(outside, 'x\n')
    assert.deepEqual(await pick(ctl.request('note.add', { file: outside, start: 1, body: 'b', session: 's' })),
      { ok: false, error: 'the file is not in an open folder' })
  }),

  test('context.get: the active file, its language, what is visible and the selection; its text only when asked', async () => {
    const ed = await vscode.window.showTextDocument(savingUri())
    ed.selection = new vscode.Selection(3, 2, 4, 5)
    const r = await ctl.request('context.get')
    assert.deepEqual(r.result.file, { relative: 'src/saving.ts', absolute: savingUri().fsPath, folder: ctx.ws })
    assert.equal(r.result.languageId, 'typescript')
    assert.deepEqual(r.result.selection, { start: { line: 4, column: 3 }, end: { line: 5, column: 6 } })
    assert.ok(r.result.visible.start >= 1 && r.result.visible.end >= r.result.visible.start, JSON.stringify(r.result.visible))
    const withText = await ctl.request('context.get', { selectionText: true })
    assert.equal(withText.result.selection.text, ed.document.getText(ed.selection))
    await closeAllEditors()
    assert.deepEqual((await ctl.request('context.get')).result, { file: null })
  }),

  test('dropped: dialled again; the file gone: hung up; disabled: no dial', async () => {
    const before = ctl.connections
    ctl.drop()
    await ctl.until('dialled again', () => ctl.connections > before && ctl.received.filter((m) => m.type === 'hello').length > before)
    fs.rmSync(discovery)
    await ctl.until('hung up', () => !ctl.connected)
    await until('not connected', () => !bridge().connected && !bridge().target)
    await bridgeSettings().update('enabled', false, vscode.ConfigurationTarget.Global)
    writeDiscovery(ctl)
    const dials = bridge().dials
    await new Promise((r) => setTimeout(r, 3000))
    assert.equal(bridge().dials, dials, 'disabled: the file is not read')
    await bridgeSettings().update('enabled', undefined, vscode.ConfigurationTarget.Global)
    await ctl.until('enabled again: connected', () => ctl.connected)
    fs.rmSync(discovery)
    await bridgeSettings().update('discovery', undefined, vscode.ConfigurationTarget.Global)
    await ctl.close()
  }),
]

/** A response's ok and error (its id left out). */
const pick = async (r: Promise<{ ok: boolean; error?: string }>) => { const { ok, error } = await r; return { ok, error } }
