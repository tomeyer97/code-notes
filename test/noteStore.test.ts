// The notes store (src/notes/store.ts) on a real folder, outside VS Code (its API faked): a save never loses what an
// agent wrote (a file being written is waited for, else the save fails and says so), and Undo of a delete never
// overwrites a note written under the same id since.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { pathToFileURL } from 'node:url'
import type * as vscodeTypes from 'vscode'
import { vscode } from './journey-podcast/fakeVscode'

/** A file URI as VS Code's: joinPath resolves `..`. */
class Uri {
  readonly scheme = 'file'
  constructor(readonly path: string) {}
  static file(p: string): Uri { return new Uri(p) }
  static joinPath(u: Uri, ...parts: string[]): Uri { return new Uri(path.posix.join(u.path, ...parts)) }
  get fsPath(): string { return this.path }
  toString(): string { return pathToFileURL(this.path).href }
}
class FileSystemError extends Error {
  constructor(readonly code: string, u: Uri) { super(`${code}: ${u.path}`) }
  static FileNotFound = (u: Uri) => new FileSystemError('FileNotFound', u)
  static FileExists = (u: Uri) => new FileSystemError('FileExists', u)
  static FileIsADirectory = (u: Uri) => new FileSystemError('FileIsADirectory', u)
  static FileNotADirectory = (u: Uri) => new FileSystemError('FileNotADirectory', u)
  static NoPermissions = (u: Uri) => new FileSystemError('NoPermissions', u)
}
Object.assign(vscode, { Uri, FileSystemError, FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 } })

type Store = import('../src/notes/store').Store
type Note = import('../src/notes/store').Note
const loaded = import('../src/notes/store')

const said: string[] = []
const log = {
  appendLine: (m: string) => said.push(m), info: (m: string) => said.push(m), warn: (m: string) => said.push(`warn ${m}`),
  error: (m: string) => said.push(`error ${m}`), debug: () => undefined,
} as unknown as vscodeTypes.LogOutputChannel

/** A workspace folder with src/a.ts and an empty notes folder; its store, and a note file's content. */
async function setUp() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-store-'))
  fs.mkdirSync(path.join(ws, 'src'))
  fs.writeFileSync(path.join(ws, 'src/a.ts'), 'a\nb\nc\n')
  const dir = path.join(ws, '.code-notes')
  fs.mkdirSync(dir)
  const folder = { uri: Uri.file(ws), name: 'ws', index: 0 } as unknown as vscodeTypes.WorkspaceFolder
  const store: Store = new (await loaded).Store(log, () => 'Ann')
  store.writingWaitMs = 600
  const file = (id: string) => path.join(dir, `${id}.json`)
  const json = (body: string, o: object = {}) => JSON.stringify({ file: 'src/a.ts', range: { start: 1, end: 1 }, status: 'open', messages: [{ author: 'claude', role: 'agent', body }], ...o }, null, 2)
  /** The note `id` as the store reads it from its file (the file written first). */
  const read = async (id: string, text = json(`note ${id}`)): Promise<Note> => {
    fs.writeFileSync(file(id), text)
    const uri = Uri.file(file(id)) as unknown as vscodeTypes.Uri
    const raw = fs.readFileSync(file(id), 'utf8')
    const { parseNote } = await import('../src/core/format/noteModel')
    const r = parseNote(raw, id)
    assert.ok(r.ok)
    return { data: r.value, folder, uri, raw, base: structuredClone(r.value) }
  }
  const onDisk = (id: string) => JSON.parse(fs.readFileSync(file(id), 'utf8'))
  return { ws, dir, store, file, json, read, onDisk, cleanUp: () => { store.dispose(); fs.rmSync(ws, { recursive: true, force: true }) } }
}

test('save: a note file half-written by an agent is waited for; their change and ours are both saved', async () => {
  const s = await setUp()
  try {
    const n = await s.read('n1')
    const agent = s.json('note n1', { messages: [{ author: 'claude', role: 'agent', body: 'note n1' }, { author: 'claude', role: 'agent', body: 'theirs' }] })
    fs.writeFileSync(s.file('n1'), agent.slice(0, 40)) // the agent half-way
    setTimeout(() => fs.writeFileSync(s.file('n1'), agent), 200)
    n.data.messages.push({ author: 'Ann', role: 'human', body: 'mine' })
    assert.equal(await s.store.save(n), true)
    assert.deepEqual(s.onDisk('n1').messages.map((m: { body: string }) => m.body), ['note n1', 'theirs', 'mine'])
  } finally { s.cleanUp() }
})

test('save: a note file that stays unreadable is not overwritten; the save fails and says so', async () => {
  const s = await setUp()
  try {
    const n = await s.read('n1')
    fs.writeFileSync(s.file('n1'), '{ "file": "src/a.ts", "messa')
    n.data.messages.push({ author: 'Ann', role: 'human', body: 'mine' })
    said.length = 0
    assert.equal(await s.store.save(n), false)
    assert.equal(fs.readFileSync(s.file('n1'), 'utf8'), '{ "file": "src/a.ts", "messa', 'the file is left as it is')
    assert.ok(said.some((l) => l.startsWith('error') && l.includes("couldn't save") && l.includes("can't be read")), said.join('\n'))
  } finally { s.cleanUp() }
})

test('restore: a note written under the same id since the delete stays; the deleted one comes back under a new id, the trash is empty', async () => {
  const s = await setUp()
  try {
    const n = await s.read('same-1', s.json('the deleted note'))
    await s.store.trash(n)
    assert.ok(fs.existsSync(path.join(s.dir, '.trash/same-1.json')) && !fs.existsSync(s.file('same-1')))
    fs.writeFileSync(s.file('same-1'), s.json('the agent\'s new note'))
    said.length = 0
    await s.store.restore(n)
    assert.equal(s.onDisk('same-1').messages[0].body, 'the agent\'s new note', 'the agent\'s note is not overwritten')
    assert.equal(n.data.id, 'same-1-restored')
    assert.equal(s.onDisk('same-1-restored').messages[0].body, 'the deleted note')
    assert.equal(s.store.get('same-1-restored'), n)
    assert.deepEqual(fs.readdirSync(path.join(s.dir, '.trash')), [], 'no stale copy in the trash')
    assert.ok(said.some((l) => l.startsWith('warn') && l.includes('same-1-restored')), said.join('\n'))
    // Again, with that name taken too.
    const m = await s.read('same-2', s.json('deleted two'))
    await s.store.trash(m)
    fs.writeFileSync(s.file('same-2'), s.json('agent two'))
    fs.writeFileSync(s.file('same-2-restored'), s.json('agent two again'))
    await s.store.restore(m)
    assert.deepEqual([s.onDisk('same-2'), s.onDisk('same-2-restored'), s.onDisk('same-2-restored-2')].map((x) => x.messages[0].body), ['agent two', 'agent two again', 'deleted two'])
  } finally { s.cleanUp() }
})

test('restore: with its id free, the note\'s own file comes back from the trash as it was', async () => {
  const s = await setUp()
  try {
    const n = await s.read('back-1', s.json('back', { custom: 1 }))
    const before = fs.readFileSync(s.file('back-1'), 'utf8')
    await s.store.trash(n)
    await s.store.restore(n)
    assert.equal(fs.readFileSync(s.file('back-1'), 'utf8'), before)
    assert.equal(n.data.id, 'back-1')
    assert.deepEqual(fs.readdirSync(path.join(s.dir, '.trash')), [])
    // Its trash copy gone meanwhile: written again from memory.
    await s.store.trash(n)
    fs.rmSync(path.join(s.dir, '.trash/back-1.json'))
    await s.store.restore(n)
    assert.equal(s.onDisk('back-1').custom, 1)
  } finally { s.cleanUp() }
})
