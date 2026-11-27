// What the understanding check knows now (src/check/state.ts CheckState), its records written one at a time
// (serialScoped), the arguments of the check's thread commands (src/check/query.ts), and its settings' names.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import type * as vscode from 'vscode'
import type { Note } from '../src/notes/store'
import type { ScopedRecord } from '../src/platform/state'
import { CheckState, serialScoped } from '../src/check/state'
import { checkConcernArgs, parseCheckConcernArgs, parseNoteIdArg } from '../src/check/query'
import type { BranchStatus } from '../src/check/types'
import { SETTINGS, settingId, VIEW_ID } from '../src/check/constants'

/** A scoped record whose writes read, wait, then write (as a slow store would): two at once lose one without a queue. */
function slowRecord<T>(): ScopedRecord<T> & { data: Record<string, Record<string, T>> } {
  const r = {
    data: {} as Record<string, Record<string, T>>,
    get: (scope: string | undefined) => (scope === undefined ? {} : r.data[scope] ?? {}),
    async set(scope: string, id: string, v: T | undefined) {
      const mine = { ...(r.data[scope] ?? {}) }
      await new Promise((ok) => setTimeout(ok, 5))
      if (v === undefined) delete mine[id]
      else mine[id] = v
      r.data = { ...r.data, [scope]: mine }
    },
    async replace(scope: string, record: Record<string, T>) { r.data = { ...r.data, [scope]: record } },
  }
  return r
}

test('two quick writes to one record both stay', async () => {
  const raw = slowRecord<string>()
  const rec = serialScoped(raw)
  await Promise.all([rec.set('main', 'q1', 'a.js'), rec.set('main', 'q2', 'b.js')])
  assert.deepEqual(rec.get('main'), { q1: 'a.js', q2: 'b.js' })
})

test('a write with none waiting starts at once; a failed write does not stop the next', async () => {
  const calls: string[] = []
  const rec = serialScoped<string>({
    get: () => ({}),
    set: async (_s, id) => { calls.push(id); if (id === 'bad') throw new Error('no') },
    replace: async () => undefined,
  })
  const first = rec.set('s', 'bad', 'x')
  assert.deepEqual(calls, ['bad'])
  const second = rec.set('s', 'good', 'y')
  await assert.rejects(first)
  await second
  assert.deepEqual(calls, ['bad', 'good'])
})

const folder = { uri: { fsPath: '/repo', scheme: 'file' } } as unknown as vscode.WorkspaceFolder
const records = () => ({ drafts: slowRecord<string>(), fixes: slowRecord<string>(), todos: slowRecord<{ file: string; line: number }>() })
const status = (o: Partial<BranchStatus>) => ({ branch: 'feat', file: 'understanding/feat.json', exists: true, ...o }) as BranchStatus
const note = (extra: Record<string, unknown>) => ({ data: { extra } }) as unknown as Note

test('the check file, the TODO files and a thread\'s question, from the state', async () => {
  const s = new CheckState(folder, records())
  assert.equal(s.abs, undefined)
  const q = { id: 'q1', text: 'Why?' }
  s.read(status({ check: { questions: [q] } as unknown as BranchStatus['check'] }), undefined)
  assert.equal(s.repo, '/repo')
  assert.equal(s.abs, '/repo/understanding/feat.json')
  await s.todos.set('feat', 'q1', { file: 'a.js', line: 3 })
  await s.todos.set('feat', 'q2', { file: 'a.js', line: 9 })
  assert.deepEqual(s.todoFiles(), ['a.js'])
  assert.equal(s.questionOf(note({ check: { file: 'understanding/feat.json', q: 'q1' } })), q)
  assert.equal(s.questionOf(note({})), undefined)
})

test('another branch\'s check thread, or a note made from one, is off the branch; so is this one\'s while its file is gone', () => {
  const s = new CheckState(folder, records())
  s.read(status({}), undefined)
  assert.equal(s.offBranch(note({ check: { file: 'understanding/other.json', q: 'q1' } })), true)
  assert.equal(s.offBranch(note({ checkFile: 'understanding/other.json' })), true)
  assert.equal(s.offBranch(note({ check: { file: 'understanding/feat.json', q: 'q1' } })), false)
  assert.equal(s.offBranch(note({})), false)
  s.read(status({ exists: false }), undefined)
  assert.equal(s.offBranch(note({ check: { file: 'understanding/feat.json', q: 'q1' } })), true)
  assert.deepEqual(s.branchOf(note({ check: { file: 'understanding/feat.json', q: 'q1' } })), { checkFile: 'understanding/feat.json' })
})

test('offBranchKey changes exactly when offBranch can answer otherwise: another check file, or its file gone', () => {
  const s = new CheckState(folder, records())
  const keys = [s.offBranchKey]
  s.read(status({}), undefined)
  keys.push(s.offBranchKey)
  s.read(status({ branch: 'feat', head: 'other commit' } as Partial<BranchStatus>), undefined)
  assert.equal(s.offBranchKey, keys[1], 'the same check file: nothing hidden changes')
  s.read(status({ branch: 'main', file: 'understanding/main.json', exists: false }), undefined)
  keys.push(s.offBranchKey)
  s.read(status({ exists: false }), undefined)
  keys.push(s.offBranchKey)
  assert.equal(new Set(keys).size, keys.length, `each a key of its own: ${JSON.stringify(keys)}`)
})

test('a branch left: nothing selected, nothing said', () => {
  const s = new CheckState(folder, records())
  s.select('q1')
  s.say('Both answers kept.')
  s.branchLeft()
  assert.equal(s.selected, undefined)
  assert.equal(s.said, undefined)
})

test('codeNotes.checkConcern\'s arguments: built and read back; anything else is not taken', () => {
  const a = { id: 'n1', action: 'dismiss' as const, reason: 'not a bug' }
  assert.deepEqual(parseCheckConcernArgs(...(checkConcernArgs(a) as [unknown, unknown, unknown])), a)
  assert.deepEqual(parseCheckConcernArgs('n1', 'fixed', undefined), { id: 'n1', action: 'fixed' })
  assert.equal(parseCheckConcernArgs(1, 'fix', undefined), undefined)
  assert.equal(parseCheckConcernArgs('n1', 'burn', undefined), undefined)
  assert.equal(parseNoteIdArg('n1'), 'n1')
  assert.equal(parseNoteIdArg({}), undefined)
})

test('the check\'s settings and view are the ones package.json declares', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'))
  const conf = pkg.contributes.configuration
  const props = Object.assign({}, ...(Array.isArray(conf) ? conf : [conf]).map((c: { properties: object }) => c.properties))
  for (const key of Object.values(SETTINGS)) assert.ok(settingId(key) in props, settingId(key))
  const views = Object.values(pkg.contributes.views as Record<string, { id: string }[]>).flat().map((v) => v.id)
  assert.ok(views.includes(VIEW_ID))
})
