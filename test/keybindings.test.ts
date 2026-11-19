import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'

// The keybindings package.json contributes (there is no src/keys.ts: VS Code reads them from the manifest).

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'))
const keys: { command: string; key: string; when?: string }[] = pkg.contributes.keybindings

test('no Alt keys are left', () => {
  assert.deepEqual(keys.filter((k) => /alt\+/.test(k.key)), [])
})

test('one chord scheme on two prefixes: Ctrl+< by scan code (ISO key) and Ctrl+\'', () => {
  const want: Record<string, string> = {
    c: 'codeNotes.add',
    r: 'codeNotes.resolveNext',
    d: 'codeNotes.next',
    a: 'codeNotes.previous',
    v: 'codeNotes.showMap',
    p: 'codeNotes.toggleAnimation',
    j: 'codeNotes.searchJourneys',
    // Listening (the journey podcast): play / pause, back and forward 15 s, previous and next step (src/podcast/player.ts).
    space: 'codeNotes.podcastToggle',
    left: 'codeNotes.podcastBack',
    right: 'codeNotes.podcastForward',
    'shift+left': 'codeNotes.podcastPrevStep',
    'shift+right': 'codeNotes.podcastNextStep',
  }
  const prefixes = ['ctrl+[IntlBackslash]', "ctrl+'"]
  // Every prefix × letter, with Ctrl released or still held for the second key.
  const chords = prefixes.flatMap((prefix) => Object.entries(want).flatMap(([k, command]) => [k, `ctrl+${k}`].map((second) => ({ prefix, key: `${prefix} ${second}`, command }))))
  for (const { prefix, key, command } of chords) {
    const b = keys.find((x) => x.key === key)
    assert.ok(b, `${key} is bound`)
    assert.equal(b.command, command)
    assert.equal(b.when, undefined, 'always consumed: a chord never types into the code')
    assert.deepEqual((b as any).args, { prefix: prefix.startsWith("ctrl+'") ? "'" : '<' }, 'says which prefix was pressed')
  }
  assert.equal(keys.length, prefixes.length * Object.keys(want).length * 2 + 1 /* escape */, 'nothing else but escape')
  // VS Code shows the last binding of a command: the plain chord, "Ctrl+' D".
  for (const command of Object.values(want)) assert.equal(keys.filter((k) => k.command === command).pop()!.key.replace(/^\S+ /, ''), Object.keys(want).find((k) => want[k] === command))
  assert.ok(keys.some((k) => k.key === 'escape' && k.command === 'codeNotes.cancelMove'))
})

test('every bound command is contributed', () => {
  const cmds = new Set(pkg.contributes.commands.map((c: { command: string }) => c.command))
  for (const k of keys) assert.ok(cmds.has(k.command), k.command)
})
