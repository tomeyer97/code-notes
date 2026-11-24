import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import { BANNER_COMMANDS, Cmd, commandUri, HiddenCmd, MESSAGE_COMMANDS, SYSTEM_COMMANDS } from '../src/platform/commands'

const ROOT = path.join(__dirname, '../..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const contributed: string[] = pkg.contributes.commands.map((c: { command: string }) => c.command)
const hidden = Object.values(HiddenCmd) as string[]
const known = new Set([...Object.values(Cmd), ...hidden])

test('Cmd is exactly package.json\'s contributes.commands, each named after its id', () => {
  assert.deepEqual(Object.values(Cmd).sort(), [...contributed].sort())
  for (const [name, id] of Object.entries(Cmd)) assert.equal(id, `codeNotes.${name}`)
})

test('HiddenCmd: none in the palette; the focus commands are the views\'', () => {
  assert.deepEqual(hidden.filter((id) => contributed.includes(id)), [])
  const views = Object.values(pkg.contributes.views as Record<string, { id: string }[]>).flat().map((v) => `${v.id}.focus`)
  for (const id of hidden.filter((h) => h.endsWith('.focus'))) assert.ok(views.includes(id), id)
})

test('menus, keys and the Markdown allow-lists name known commands', () => {
  const menus = Object.values(pkg.contributes.menus as Record<string, { command?: string }[]>).flat().map((m) => m.command)
  const keys = (pkg.contributes.keybindings as { command: string }[]).map((k) => k.command.replace(/^-/, ''))
  const ours = [...menus, ...keys].filter((c): c is string => !!c && c.startsWith('codeNotes.'))
  assert.deepEqual(ours.filter((c) => !known.has(c)), [])
  for (const c of [...SYSTEM_COMMANDS, ...MESSAGE_COMMANDS, ...BANNER_COMMANDS]) assert.ok(known.has(c), c)
})

test('the code names commands through the table, not by string', () => {
  const src = path.join(ROOT, 'src')
  const files = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : []))
  const bad: string[] = []
  for (const f of files(src)) {
    if (f.endsWith(path.join('platform', 'commands.ts'))) continue
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/(setCtx\(|'setContext', )?'(codeNotes\.[\w.]+)'/g)) {
      if (!m[1] && known.has(m[2])) bad.push(`${path.relative(src, f)}: ${m[2]}`) // a context key may share a command's name
    }
  }
  assert.deepEqual(bad, [])
})

test('commandUri: the arguments as JSON in the query', () => {
  assert.equal(commandUri(Cmd.openAt), 'command:codeNotes.openAt')
  assert.equal(commandUri(Cmd.openAt, 'a b', 2), `command:codeNotes.openAt?${encodeURIComponent('["a b",2]')}`)
})
