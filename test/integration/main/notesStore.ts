// Saving a note never loses anyone's words: a reply sent while an agent is half-way through writing the note's file
// (saved once the file is whole, else the box keeps the text and an error says why), Undo of a delete when an agent
// has written a note under the same id since (both kept), and a reply with Claude: Mode "always" (the box is cleared
// once the reply is saved, not when Claude has answered).
// Source: src/notes/store.ts (save, restore), src/notes/reply.ts. VS Code clears a thread's box when the reply command
// returns and keeps the text when it fails: the command's promise is what these tests watch.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { readJson, test } from '../helpers'
import { agentNote, writeNote } from '../fixtures'
import { cdp, ui } from '../devtools'
import { ctx, noteById, notePath, setting, until } from './context'

/* eslint-disable @typescript-eslint/no-explicit-any */
/** A note id in the note-ID format; only `tag` matters (a unique name). */
const noteId = (tag: string) => `20261126-090000-${tag}`

/** An agent's note on src/app.ts line 1, read by the window and with its thread; its id and file. */
async function agentsNote(tag: string, body: string): Promise<{ id: string; file: string; text: string }> {
  const id = noteId(tag)
  const file = writeNote(ctx.notesDir, id, agentNote('src/app.ts', 1, body))
  await until(`${id} read, with its thread`, () => noteById(id) && ctx.api.thread(id))
  return { id, file, text: fs.readFileSync(file, 'utf8') }
}

const reply = (id: string, text: string) => vscode.commands.executeCommand('codeNotes.reply', { thread: ctx.api.thread(id), text })
const bodies = (file: string): string[] => readJson(file).messages.map((m: any) => m.body)

export const notesStoreTests = [
  test('a reply sent while an agent is half-way through writing the note file is saved once the file is whole', async () => {
    const n = await agentsNote('half', 'Half-written target')
    fs.writeFileSync(n.file, n.text.slice(0, 60))
    const sent = reply(n.id, 'typed while the file was half-written')
    // The agent finishes its write, with a reply of its own.
    setTimeout(() => appendWhole(n.file, n.text, 'the agent\'s reply'), 500)
    await sent
    assert.deepEqual(bodies(n.file), ['Half-written target', 'the agent\'s reply', 'typed while the file was half-written'])
  }),

  test('a reply to a note file that stays unreadable: the command fails (the box keeps the text), an error says why, the file is untouched', async () => {
    const n = await agentsNote('broken', 'Broken target')
    const broken = n.text.slice(0, 60)
    fs.writeFileSync(n.file, broken)
    const failed = await Promise.resolve(reply(n.id, 'typed while the file was broken')).then(() => undefined, (e: Error) => e)
    assert.equal(failed?.name, 'Canceled', 'the reply command fails quietly: VS Code leaves the text in the box')
    assert.equal(fs.readFileSync(n.file, 'utf8'), broken, 'not overwritten')
    assert.ok(!noteById(n.id).messages.some((m: any) => m.body === 'typed while the file was broken'), 'not shown as sent')
    if (cdp) await until('the error toast', async () => (await (await ui()).locator('.notification-toast', { hasText: /couldn't save .*can't be read/ }).count()) > 0)
    fs.writeFileSync(n.file, n.text)
  }),

  test('Undo of a delete when an agent has written a note under the same id since: both notes kept, the trash empty', async () => {
    const n = await agentsNote('undo', 'The note deleted')
    await vscode.commands.executeCommand('codeNotes.delete', n.id)
    await until('in the trash', () => !fs.existsSync(n.file) && !noteById(n.id))
    writeNote(ctx.notesDir, n.id, agentNote('src/app.ts', 1, 'The agent\'s new note, same id'))
    await until('the agent\'s note read', () => noteById(n.id)?.messages[0].body === 'The agent\'s new note, same id')
    await vscode.commands.executeCommand('codeNotes.undo')
    const restored = `${n.id}-restored`
    await until('the deleted note back under a new id', () => noteById(restored)?.messages[0].body === 'The note deleted')
    assert.equal(readJson(n.file).messages[0].body, 'The agent\'s new note, same id', 'the agent\'s note is not overwritten')
    assert.equal(readJson(notePath(restored)).messages[0].body, 'The note deleted')
    assert.ok(!fs.existsSync(path.join(ctx.notesDir, '.trash', `${n.id}.json`)), 'no stale copy in the trash')
  }),

  test('Claude: Mode "always": the reply command returns once the reply is saved, while Claude still answers; one human message', async () => {
    const n = await agentsNote('always', 'Always mode target')
    await setting('claude.mode', 'always')
    try {
      const t0 = Date.now()
      await reply(n.id, 'a slow question')
      assert.ok(Date.now() - t0 < 2000, `returned after ${Date.now() - t0} ms: the box is cleared then`)
      await until('Claude asked', () => noteById(n.id)?.asking)
      assert.equal(bodies(n.file).filter((b) => b === 'a slow question').length, 1)
    } finally {
      await vscode.commands.executeCommand('codeNotes.cancelClaude', n.id)
      await setting('claude.mode', undefined)
      await until('Claude stopped', () => !noteById(n.id)?.asking)
    }
    assert.equal(noteById(n.id).messages.filter((m: any) => m.body === 'a slow question').length, 1)
  }),
]

/** The note file written whole again, with `body` appended as an agent's message (the end of the agent's write). */
function appendWhole(file: string, text: string, body: string): void {
  const v = JSON.parse(text)
  v.messages.push({ author: 'claude', role: 'agent', body, at: new Date().toISOString() })
  fs.writeFileSync(file, JSON.stringify(v, null, 2))
}
