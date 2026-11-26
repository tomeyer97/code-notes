// Asking Claude about a note: the labelled Ask Claude button beside Reply (the command given the thread's reply box),
// never an empty run on a note Claude answered last, an answer that says its model and seconds, an answer read in
// the open thread that is not new, Stop keeping what was written, and runs stopped with the window.
// Source: src/ask/commands.ts, src/ask/run.ts, src/ask/prompts.ts, src/platform/agent/runner.ts.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import assert from 'assert'
import { AgentRunner } from '../../../src/platform/agent/runner'
import { claudeRuns, flag, now, quiet, readJson, test } from '../helpers'
import { fixturePath, writeNote } from '../fixtures'
import { bodyOf, ctx, noteById, setting, snap, until, useFakeClaude, wsPath } from './context'

/* eslint-disable @typescript-eslint/no-explicit-any */
/** A note id in the note-ID format; only `tag` matters (a unique name). */
const noteId = (tag: string) => `20261126-100000-${tag}`

/** A note with the person's question on src/app.ts line 2, read by the window with its thread. */
async function question(tag: string, body: string): Promise<{ id: string; file: string }> {
  const id = noteId(tag)
  const file = writeNote(ctx.notesDir, id, {
    file: 'src/app.ts', range: { start: 2, end: 2 }, status: 'open', messages: [{ author: snap().me, role: 'human', body, at: now() }],
  })
  await until(`${id} read, with its thread`, () => noteById(id) && ctx.api.thread(id))
  return { id, file }
}

/** The thread's reply box as VS Code hands it to a button beside Reply. */
const replyBox = (id: string, text = '') => ({ thread: ctx.api.thread(id), text })
const lastSaved = (file: string): any => readJson(file).messages.at(-1)

/** A stand-in for `claude` in a folder of its own: a node script (`body`, after the stream helpers) or a shell one. */
function standIn(name: string, script: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-stand-in-'))
  const p = path.join(dir, name)
  fs.writeFileSync(p, script, { mode: 0o755 })
  return p
}

/** Writes its first words, then keeps thinking (never ends on its own). */
const firstWordsThenThinking = () => standIn('claude', [
  '#!/usr/bin/env node',
  `const s = require(${JSON.stringify(fixturePath('streamJson.js'))})`,
  's.init()',
  "s.textDelta('The envelope has six fields. ')",
  'setInterval(() => {}, 1000)',
].join('\n'))

/** Writes nothing and keeps running (a Claude still thinking). */
const silent = () => standIn('claude', '#!/bin/sh\nexec sleep 600\n')

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

export const askTests = [
  test('the Ask Claude button beside Reply asks about that thread\'s note; the answer says its model and seconds', async () => {
    await useFakeClaude()
    await setting('claude.model', 'sonnet')
    try {
      const n = await question('button', 'Why is the token read here?')
      const before = claudeRuns().length
      await vscode.commands.executeCommand('codeNotes.askClaude', replyBox(n.id))
      const answer = await until('answered', () => lastSaved(n.file)?.author === 'Claude' && lastSaved(n.file), 10000)
      const run = claudeRuns().slice(before)
      assert.equal(run.length, 1, 'one run')
      assert.match(flag(run[0], '-p') ?? '', /Why is the token read here\?/, 'about that note')
      assert.equal(answer.model, 'sonnet')
      assert.equal(typeof answer.took, 'number')
      assert.equal(noteById(n.id).messages.at(-1).extra?.model, 'sonnet', 'kept on the message the thread shows')
    } finally {
      await setting('claude.model', undefined)
    }
  }),

  test('Ask Claude on a note Claude answered last starts no run', async () => {
    await useFakeClaude()
    const n = await question('answered', 'Where is it written?')
    await vscode.commands.executeCommand('codeNotes.askClaude', n.id)
    await until('answered', () => noteById(n.id)?.messages.at(-1)?.author === 'Claude' && !noteById(n.id).asking, 10000)
    await quiet(1200, 'past the second after an answer')
    const runs = claudeRuns().length
    const messages = readJson(n.file).messages.length
    await vscode.commands.executeCommand('codeNotes.askClaude', n.id)
    await vscode.commands.executeCommand('codeNotes.askClaude', replyBox(n.id))
    await quiet(1500, 'a run started')
    assert.equal(claudeRuns().length, runs, 'no process spawned')
    assert.equal(readJson(n.file).messages.length, messages, 'nothing added')
    assert.ok(!noteById(n.id).asking)
  }),

  test('an answer to a reply sent from the note\'s open thread is not new', async () => {
    await useFakeClaude()
    const n = await question('thread', 'First question')
    await vscode.window.showTextDocument(vscode.Uri.file(wsPath('src', 'app.ts')))
    const thread = await until('thread', () => ctx.api.thread(n.id))
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded
    await vscode.commands.executeCommand('codeNotes.askClaude', replyBox(n.id, 'And where is it used?'))
    await until('answered', () => lastSaved(n.file)?.author === 'Claude', 10000)
    await until('read', () => noteById(n.id)?.unread === 0)
  }),

  test('Stop after Claude wrote its first words keeps them, marked stopped; Ask asks again', async () => {
    const n = await question('stopped', 'Explain every field of the request envelope')
    await setting('claude.path', firstWordsThenThinking())
    try {
      void vscode.commands.executeCommand('codeNotes.askClaude', n.id)
      await until('first words streamed', () => ctx.api.thread(n.id)?.comments.some((c) => bodyOf(c).includes('six fields')), 10000)
      await vscode.commands.executeCommand('codeNotes.cancelClaude', n.id)
      const saved = await until('kept, marked', () => lastSaved(n.file)?.stopped && lastSaved(n.file), 10000)
      assert.equal(saved.author, 'Claude')
      assert.match(saved.body, /^The envelope has six fields\.\s+_\(stopped\)_$/)
      await until('not new to the person who stopped it', () => noteById(n.id)?.unread === 0)
    } finally {
      await useFakeClaude()
    }
    // The note still awaits its answer: Ask runs (once the second after the stop is over).
    await quiet(1200, 'past the second after the stop')
    const before = claudeRuns().length
    await vscode.commands.executeCommand('codeNotes.askClaude', n.id)
    await until('asked again', () => lastSaved(n.file)?.author === 'Claude' && !lastSaved(n.file).stopped, 10000)
    assert.equal(claudeRuns().length, before + 1)
  }),

  test('the window closing stops note and journey runs (no orphan); the check\'s writer keeps running', async () => {
    const runner = new AgentRunner()
    const hang = silent()
    const o = { cwd: ctx.ws, prompt: 'p' }
    const note = runner.start(hang, { key: 'note:x', purpose: 'note', label: 'x' }, o)
    const journey = runner.start(hang, { key: 'journey:x', purpose: 'journey', label: 'x' }, o)
    const check = runner.start(hang, { key: 'check:x', purpose: 'check', label: 'x' }, o)
    const pids = [note.pid, journey.pid, check.pid] as number[]
    try {
      await until('running', () => pids.every((p) => p && alive(p)))
      runner.dispose()
      await until('note and journey runs gone', () => !alive(pids[0]) && !alive(pids[1]))
      assert.ok(alive(pids[2]), 'the check writer is tracked by its pid: it goes on')
    } finally {
      check.cancel()
    }
  }),
]
