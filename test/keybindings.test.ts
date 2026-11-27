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
  assert.equal(keys.length, PREFIXES.length * Object.keys(CHORDS).length * 2 + 1 /* escape */, 'nothing else but escape')
  // VS Code shows the last binding of a command: the plain chord, "Ctrl+' D".
  for (const command of Object.values(CHORDS)) assert.equal(keys.filter((k) => k.command === command).pop()!.key.replace(/^\S+ /, ''), Object.keys(CHORDS).find((k) => CHORDS[k] === command))
  assert.ok(keys.some((k) => k.key === 'escape' && k.command === 'codeNotes.cancelMove'))
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

test('every bound command is contributed', () => {
  const cmds = new Set(pkg.contributes.commands.map((c: { command: string }) => c.command))
  for (const k of keys) assert.ok(cmds.has(k.command), k.command)
})
