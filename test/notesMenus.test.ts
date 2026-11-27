// The notes' menus and Command Palette entries in package.json (static data, no window needed): one resolve control in a
// thread, bulk delete named Purge, a note's own actions reachable from the palette when the cursor is on a note.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'))
const menus: Record<string, { command: string; when?: string }[]> = pkg.contributes.menus
const commands: { command: string; title: string }[] = pkg.contributes.commands
const inPalette = (command: string, when: string) => menus.commandPalette.some((m) => m.command === command && m.when === when)

test('one resolve control in a thread; bulk delete is "Purge Resolved Notes…"', () => {
  assert.ok(!menus['comments/commentThread/context'].some((m) => m.command === 'codeNotes.replyResolve'), 'no Reply & Resolve')
  assert.ok(commands.some((c) => c.command === 'codeNotes.deleteResolved' && c.title.startsWith('Purge')), 'bulk delete is Purge')
})

test('a note\'s own actions are in the palette when the cursor is on a note; the rest stay out of it', () => {
  for (const c of ['codeNotes.moveToSelection', 'codeNotes.copyNotePrompt', 'codeNotes.delete']) assert.ok(inPalette(c, 'codeNotes.cursorOnNote'), `${c} in the palette on a note`)
  // No grab-bag: Reopen / Keep Note Here live in the thread; Show Map while walking; ask a question.
  for (const c of ['codeNotes.reopen', 'codeNotes.acceptCode']) assert.ok(inPalette(c, 'false'), `${c} not in the palette`)
  assert.ok(inPalette('codeNotes.showMap', 'codeNotes.journeyActive'), 'Show Journey Map while walking')
  assert.ok(commands.some((c) => c.command === 'codeNotes.askQuestion'), 'Ask a Question About the Code…')
})
