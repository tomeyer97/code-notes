// The pure parts of the notes' commands (src/notes/): where a broken note file is wrong, the folder page's path, the
// rollback of a failed save, the double-submit guard and the polling wait.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { NoteData } from '../src/core/format/noteModel'
import { parseNote } from '../src/core/format/noteModel'
import { brokenOffset } from '../src/notes/brokenAt'
import { folderOfPagePath, folderPagePath } from '../src/notes/pageUri'
import { withRollback } from '../src/notes/rollback'
import { OncePerSubmit } from '../src/notes/submit'
import { waitUntil } from '../src/notes/timing'

const good = { file: 'a.ts', range: { start: 1, end: 2 }, status: 'open', messages: [{ author: 'me', body: 'hi' }] }
const text = (v: unknown) => JSON.stringify(v, null, 2)
/** The field name the offset points at (its quoted name), or what is there. */
const at = (t: string) => t.slice(brokenOffset(t)).match(/^"(\w+)"/)?.[1] ?? (brokenOffset(t) === t.length ? 'end' : 'top')

test('brokenOffset: the cursor goes to the first field the reader refuses, whatever its reason says', () => {
  const cases: [unknown, string][] = [
    [{ ...good, range: { start: 0, end: 2 } }, 'range'],
    [{ ...good, range: { start: 3, end: 2 } }, 'range'],
    [{ ...good, range: 'L3' }, 'range'],
    [{ ...good, status: 'done' }, 'status'],
    [{ ...good, messages: [] }, 'messages'],
    [{ ...good, messages: [{ author: 'x' }] }, 'messages'],
    [{ ...good, file: '' }, 'file'],
    [{ ...good, target: 'dir' }, 'target'],
    [{ ...good, version: 9 }, 'version'],
    // Missing: no name to go to.
    [{ range: good.range, messages: good.messages }, 'top'],
  ]
  for (const [v, want] of cases) {
    const t = text(v)
    assert.equal(parseNote(t, 'x').ok, false, `the reader refuses ${t}`)
    assert.equal(at(t), want, t)
  }
  assert.equal(at('{ "file": "a.ts", '), 'end', 'not JSON: the end, where it was cut off')
  assert.equal(at('[1]'), 'top')
  // A file or folder note has no lines to check.
  assert.equal(at(text({ ...good, target: 'file', range: undefined, status: 'x' })), 'status')
})

test('folder page path: written and read back, any other path is not one', () => {
  for (const f of ['src', 'src/api', 'a (folder)', 'x y']) assert.equal(folderOfPagePath(folderPagePath(f)), f)
  assert.equal(folderPagePath('src/api'), '/src/api (folder)', 'the tab shows the folder and what it is')
  assert.equal(folderOfPagePath('/src/api'), undefined)
  assert.equal(folderOfPagePath('src (folder)'), undefined)
})

function note(): { data: NoteData } {
  return { data: { id: 'n', file: 'a.ts', range: { start: 1, end: 1 }, anchor: { text: '', before: '', after: '' }, status: 'open', messages: [{ author: 'me', body: 'hi' }] } }
}

test('withRollback: a failed save puts the named fields back (an absent one removed); a good one keeps the change', async () => {
  const n = note()
  const ok = await withRollback(n, ['messages', 'status', 'events'], async () => {
    n.data.messages.push({ author: 'me', body: 'more' })
    n.data.status = 'resolved'
    n.data.events = [{ type: 'resolved', by: 'me', at: 't' }]
    n.data.file = 'b.ts' // not named: kept (a change merged in from disk)
    return false
  })
  assert.equal(ok, false)
  assert.deepEqual(n.data.messages, [{ author: 'me', body: 'hi' }])
  assert.equal(n.data.status, 'open')
  assert.ok(!('events' in n.data), 'no events before: none after')
  assert.equal(n.data.file, 'b.ts')
  assert.equal(await withRollback(n, ['status'], async () => { n.data.status = 'resolved'; return true }), true)
  assert.equal(n.data.status, 'resolved')
})

test('OncePerSubmit: a second submit while the first runs does nothing; after it, the key is free again', async () => {
  const guard = new OncePerSubmit<string>()
  let release!: () => void
  const first = guard.run('k', () => new Promise<string>((r) => { release = () => r('saved') }))
  assert.equal(await guard.run('k', async () => 'twice'), undefined)
  assert.equal(await guard.run('other', async () => 'other'), 'other', 'another key is not held up')
  release()
  assert.equal(await first, 'saved')
  assert.equal(await guard.run('k', async () => 'again'), 'again')
  await assert.rejects(guard.run('k', async () => { throw new Error('failed') }))
  assert.equal(await guard.run('k', async () => 'after a failure'), 'after a failure', 'a failed job frees its key')
})

test('waitUntil: stops as soon as it is true; gives up after tries × everyMs', async () => {
  let k = 0
  assert.equal(await waitUntil(() => ++k >= 3, { tries: 10, everyMs: 1 }), true)
  assert.equal(k, 3)
  const t0 = Date.now()
  assert.equal(await waitUntil(() => false, { tries: 3, everyMs: 5 }), false)
  assert.ok(Date.now() - t0 >= 10, 'it waited between the tries')
})
