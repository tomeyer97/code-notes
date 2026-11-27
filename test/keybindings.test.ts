import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import { pathToFileURL } from 'url'

// The keybindings package.json contributes (VS Code reads them from the manifest), generated from the chord table in
// scripts/keymap.mjs (node scripts/keymap.mjs --write).

type Binding = { command: string; key: string; when?: string; args?: { prefix: string } }
type Keymap = { CHORDS: Record<string, string>; PREFIXES: { key: string; arg: string }[]; keybindings(): Binding[] }

const ROOT = path.join(__dirname, '../..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const keys: Binding[] = pkg.contributes.keybindings
// The real import(): module commonjs would compile a written-out import() into require().
const dynamicImport = new Function('u', 'return import(u)') as (u: string) => Promise<Keymap>
const keymap = () => dynamicImport(pathToFileURL(path.join(ROOT, 'scripts/keymap.mjs')).href)

test('package.json\'s keybindings are the ones scripts/keymap.mjs generates (run it with --write)', async () => {
  assert.deepEqual(keys, (await keymap()).keybindings())
})

test('no Alt keys are left', () => {
  assert.deepEqual(keys.filter((k) => /alt\+/.test(k.key)), [])
})

test('one chord scheme on two prefixes: Ctrl+< by scan code (ISO key) and Ctrl+\'', async () => {
  const { CHORDS, PREFIXES } = await keymap()
  assert.deepEqual(PREFIXES.map((p) => p.key), ['ctrl+[IntlBackslash]', "ctrl+'"])
  // Every prefix × letter, with Ctrl released or still held for the second key.
  for (const prefix of PREFIXES) {
    for (const [k, command] of Object.entries(CHORDS)) {
      for (const key of [`${prefix.key} ${k}`, `${prefix.key} ctrl+${k}`]) {
        const b = keys.find((x) => x.key === key)
        assert.ok(b, `${key} is bound`)
        assert.equal(b.command, command)
        assert.equal(b.when, undefined, 'always consumed: a chord never types into the code')
        assert.deepEqual(b.args, { prefix: prefix.key === "ctrl+'" ? "'" : '<' }, 'says which prefix was pressed')
      }
    }
  }
  assert.equal(keys.length, PREFIXES.length * Object.keys(CHORDS).length * 2 + 3, 'nothing else but Esc and Enter (below)')
  // VS Code shows the last binding of a command: the plain chord, "Ctrl+' D".
  for (const command of Object.values(CHORDS)) assert.equal(keys.filter((k) => k.command === command).pop()!.key.replace(/^\S+ /, ''), Object.keys(CHORDS).find((k) => CHORDS[k] === command))
  assert.ok(keys.some((k) => k.key === 'escape' && k.command === 'codeNotes.cancelMove'))
})

test('outside the chords: Esc and Enter only where they belong to Code Notes', () => {
  const others = keys.filter((k) => !k.args)
  assert.deepEqual(others, [
    { command: 'codeNotes.cancelMove', key: 'escape', when: 'codeNotes.moving && editorTextFocus && !suggestWidgetVisible && !findWidgetVisible' },
    // Moving a note: Enter puts it on the selection (the status bar item's action).
    { command: 'codeNotes.moveToSelection', key: 'enter', when: 'codeNotes.moving && editorTextFocus && !suggestWidgetVisible' },
    // Esc in an empty new note box of ours closes it (the draft is kept); other comment boxes keep their Esc.
    { command: 'codeNotes.closeNoteBox', key: 'escape', when: 'commentEditorFocused && commentController == codeNotes && commentThreadIsEmpty' },
  ])
})

test('the chord table is the scheme as documented: letters for notes and journeys, arrows and space for listening', async () => {
  assert.deepEqual((await keymap()).CHORDS, {
    c: 'codeNotes.add',
    r: 'codeNotes.resolveNext',
    d: 'codeNotes.next',
    a: 'codeNotes.previous',
    v: 'codeNotes.showMap',
    p: 'codeNotes.toggleAnimation',
    j: 'codeNotes.searchJourneys',
    space: 'codeNotes.podcastToggle',
    left: 'codeNotes.podcastBack',
    right: 'codeNotes.podcastForward',
    'shift+left': 'codeNotes.podcastPrevStep',
    'shift+right': 'codeNotes.podcastNextStep',
  })
})

test('every bound command is contributed, except closing the note box (a key, not a verb for the palette)', () => {
  const cmds = new Set(pkg.contributes.commands.map((c: { command: string }) => c.command))
  for (const k of keys.filter((x) => x.command !== 'codeNotes.closeNoteBox')) assert.ok(cmds.has(k.command), k.command)
  assert.ok(!cmds.has('codeNotes.closeNoteBox'))
})
