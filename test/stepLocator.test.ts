// The step locator (src/journeys/stepLocator.ts) on fixture journeys: files are lines in memory, no watcher, no
// editor. Steps found again, one locate at a time per journey, the reader's edits, renamed files.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type * as vscode from 'vscode'
import { journeyOf } from './formats'
import { compactOf } from '../src/core/anchors/compact'
import { StateStore } from '../src/platform/state'
import { Locatable, StepLocator } from '../src/journeys/stepLocator'
import { writtenAt } from '../src/journeys/steps'

const code = ['import x', '', 'function f() {', '  a()', '  x()', '  y()', '  b()', '}', '', 'function g() {}']
const anchor = compactOf(code, 2, 7)!

/** A journey in the workspace folder /w with one step on f() in src/a.ts. */
function fixture(key = 'file:///w/journeys/j.json'): Locatable {
  const j = journeyOf(JSON.stringify({
    version: 2, nodes: [{ id: 'n', label: 'N' }],
    steps: [{ id: 's1', node: 'n', file: 'src/a.ts', range: { start: 3, end: 8 }, title: 'f', anchor }],
  }), 'j')
  return { key, folder: { uri: { path: '/w', toString: () => 'file:///w' } }, j, at: writtenAt(j) }
}

/** A Memento in memory (the stored state across a reload). */
class MemoryMemento implements vscode.Memento {
  private readonly data = new Map<string, unknown>()
  keys(): readonly string[] { return [...this.data.keys()] }
  get<T>(key: string, fallback?: T): T { return (this.data.has(key) ? this.data.get(key) : fallback) as T }
  async update(key: string, v: unknown): Promise<void> {
    if (v === undefined) this.data.delete(key)
    else this.data.set(key, v)
  }
}

/** A locator over `files` (path -> lines); `read` may hold a read back. */
function locator(files: Map<string, string[]>, o: { stored?: StateStore; read?: (file: string) => Promise<void> } = {}) {
  const moved: Locatable[] = []
  const logged: string[] = []
  const loc = new StepLocator<Locatable>({
    lines: async (_lj, file) => {
      await o.read?.(file)
      return files.get(file)
    },
    gitFollow: async () => undefined,
    moved: (lj) => moved.push(lj),
    log: { info: (m: string) => logged.push(m) } as Pick<vscode.LogOutputChannel, 'info'>,
  }, o.stored)
  return { loc, moved, logged }
}

test('locate: a step found where its code moved; stale once its code is gone, and says so in the log', async () => {
  const files = new Map([['src/a.ts', ['// new', ...code]]])
  const { loc, logged } = locator(files)
  const lj = fixture()
  assert.equal(await loc.locate(lj), true)
  assert.deepEqual(lj.at, [{ start: 4, end: 9, stale: false }])
  assert.equal(await loc.locate(lj), false, 'nothing moved: no change')
  files.set('src/a.ts', ['other'])
  await loc.locate(lj)
  assert.deepEqual(lj.at, [{ start: 1, end: 1, stale: true, removed: true }])
  assert.match(logged.join('\n'), /step 1: stale/)
})

test('locate: one at a time per journey; a later locate (newer lines) is never overwritten by an earlier one', async () => {
  const files = new Map([['src/a.ts', ['// disk, older', ...code]]])
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  const { loc } = locator(files, { read: () => held })
  const lj = fixture()
  const before = lj.at
  const older = loc.locate(lj)
  // The document as typed now: f() three lines lower.
  const newer = loc.locate(lj, undefined, { file: 'src/a.ts', lines: ['', '', '', ...code] })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(lj.at, before, 'nothing written while the first locate waits for its file')
  release()
  await Promise.all([older, newer])
  assert.deepEqual(lj.at, [{ start: 6, end: 11, stale: false }], 'the newer lines win')
  assert.notEqual(lj.at, before, 'the places were replaced as a whole')
})

test('reader edits: a step whose lines the reader edited stays on them, not stale, and keeps them on a later locate', async () => {
  const files = new Map([['src/a.ts', code]])
  const { loc, moved } = locator(files, { stored: new StateStore(new MemoryMemento(), new MemoryMemento()) })
  const lj = fixture()
  await loc.locate(lj)
  // The reader replaces `  x()` (0-based line 4) with `  z()`: inside the step's lines.
  loc.followEdits(lj, 'src/a.ts', [{ startLine: 4, startChar: 2, endLine: 4, endChar: 5, newLines: 0 }])
  const edited = [...code.slice(0, 4), '  z()', ...code.slice(5)]
  await loc.relocateDocument(lj, 'src/a.ts', edited, false)
  assert.deepEqual(lj.at, [{ start: 3, end: 8, stale: false }], 'on the edited lines, not out of date')
  assert.equal(moved.length, 0, 'it did not move')
  files.set('src/a.ts', ['// above', ...edited])
  await loc.locate(lj)
  assert.deepEqual(lj.at, [{ start: 4, end: 9, stale: false }], 'the reader\'s version is its code now')
})

test('reader edits: a document reloaded from disk is not the reader\'s edit', async () => {
  const files = new Map([['src/a.ts', code]])
  const { loc, moved } = locator(files)
  const lj = fixture()
  await loc.locate(lj)
  loc.followEdits(lj, 'src/a.ts', [{ startLine: 4, startChar: 2, endLine: 4, endChar: 5, newLines: 0 }])
  const changed = [...code.slice(0, 4), '  z()', ...code.slice(5)]
  await loc.relocateDocument(lj, 'src/a.ts', changed, true)
  assert.equal(lj.at[0].stale, true, 'changed on disk: out of date')
  assert.deepEqual(moved, [lj])
})

test('moveStep: the step follows its file; another load of the journey starts in the new file', async () => {
  const files = new Map([['src/b.ts', code]])
  const stored = new StateStore(new MemoryMemento(), new MemoryMemento())
  const { loc, moved } = locator(files, { stored })
  const lj = fixture()
  await loc.moveStep(lj, 1, 'src/b.ts')
  assert.deepEqual(lj.at, [{ start: 3, end: 8, stale: false, file: 'src/b.ts' }])
  assert.deepEqual([...loc.renames(lj)], [['src/a.ts', 'src/b.ts']])
  assert.deepEqual(moved, [lj])
  const again = fixture()
  await locator(files, { stored }).loc.track(again)
  assert.equal(again.at[0].file, 'src/b.ts', 'the rename is kept across a reload')
})

test('relocateOnDisk: only the journeys with steps in the changed files', async () => {
  const files = new Map([['src/a.ts', ['// new', ...code]]])
  const { loc, moved } = locator(files)
  const a = fixture('file:///w/journeys/a.json'), b = fixture('file:///w/journeys/b.json')
  await loc.relocateOnDisk([a, b], new Set(['/w/src/other.ts']))
  assert.equal(moved.length, 0)
  await loc.relocateOnDisk([a, b], new Set(['/w/src/a.ts']))
  assert.deepEqual(moved, [a, b])
})
