import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'))
const keys: { command: string; key: string; when?: string }[] = pkg.contributes.keybindings

test('no Alt keys are left', () => {
  assert.deepEqual(keys.filter((k) => /alt\+/.test(k.key)), [])
})

test('one chord scheme on two prefixes: Ctrl+< by scan code (ISO key) and Ctrl+\'', () => {
  const want: Record<string, string> = { c: 'codeNotes.add', r: 'codeNotes.resolveNext', d: 'codeNotes.next', a: 'codeNotes.previous', v: 'codeNotes.showMap', p: 'codeNotes.toggleAnimation' }
  for (const prefix of ['ctrl+[IntlBackslash]', "ctrl+'"]) {
    for (const [k, command] of Object.entries(want)) {
      // With Ctrl released or still held for the second key.
      for (const second of [k, `ctrl+${k}`]) {
        const b = keys.find((x) => x.key === `${prefix} ${second}`)
        assert.ok(b, `${prefix} ${second} is bound`)
        assert.equal(b.command, command)
        assert.equal(b.when, undefined, 'always consumed: a chord never types into the code')
        assert.deepEqual((b as any).args, { prefix: prefix.startsWith("ctrl+'") ? "'" : '<' }, 'says which prefix was pressed')
      }
    }
  }
  assert.equal(keys.length, 2 * 6 * 2 + 1, 'nothing else but escape')
  // VS Code shows the last binding of a command: the plain chord, "Ctrl+' D".
  for (const command of Object.values(want)) assert.equal(keys.filter((k) => k.command === command).pop()!.key.replace(/^\S+ /, ''), Object.keys(want).find((k) => want[k] === command))
  assert.ok(keys.some((k) => k.key === 'escape' && k.command === 'codeNotes.cancelMove'))
})

test('every bound command is contributed', () => {
  const cmds = new Set(pkg.contributes.commands.map((c: { command: string }) => c.command))
  for (const k of keys) assert.ok(cmds.has(k.command), k.command)
})
