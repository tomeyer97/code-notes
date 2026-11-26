import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import { BANNER_COMMANDS, clickedLink, Cmd, cmdLink, commandUri, HiddenCmd, linkCall, linkKey, MESSAGE_COMMANDS, shortLinks, SYSTEM_COMMANDS } from '../src/platform/commands'

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

test('shortLinks: a link with arguments runs through a short key (no percent-encoded JSON for a screen reader to read)', () => {
  const folder = 'file:///work/shop'
  const md = `See ${cmdLink('redeemGiftCard', Cmd.openAt, folder, 'api/giftcards.js', 1)} · ${cmdLink('Next', HiddenCmd.nextCheckQuestion)}`
  const short = shortLinks(md, [Cmd.openAt, HiddenCmd.nextCheckQuestion])
  const m = /^See \[redeemGiftCard\]\(command:codeNotes\.link\?(\d{6})\) · \[Next\]\(command:codeNotes\.nextCheckQuestion\)$/.exec(short)
  assert.ok(m, short)
  assert.deepEqual(linkCall(Number(m[1])), { command: Cmd.openAt, args: [folder, 'api/giftcards.js', 1] })
  assert.deepEqual(clickedLink(HiddenCmd.link, [Number(m[1])]), { command: Cmd.openAt, args: [folder, 'api/giftcards.js', 1] })
  assert.equal(shortLinks(md, [Cmd.openAt, HiddenCmd.nextCheckQuestion]), short, 'the same link keeps its key (a redraw is a no-op)')
  assert.doesNotMatch(short, /%/)
  // A command the text may not run is left as it is (the short key would let it run).
  assert.equal(shortLinks(md, []), md)
  // A link to another note gets another key.
  assert.notEqual(linkKey(Cmd.openAt, [folder, 'b.js', 1]), Number(m[1]))
  assert.equal(linkCall(1), undefined)
  assert.equal(linkCall('123456'), undefined, 'only a number is a key')
})
