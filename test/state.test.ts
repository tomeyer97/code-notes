import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import type * as vscode from 'vscode'
import { MIGRATIONS, runMigrations, seenCountsFromTimes, STATE, STATE_FAMILIES, StateStore } from '../src/platform/state'

/** A Memento in memory, with the writes it got. */
function memento(init: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(init))
  const writes: string[] = []
  const m = {
    keys: () => [...data.keys()],
    get: (k: string, d?: unknown) => (data.has(k) ? data.get(k) : d),
    update: async (k: string, v: unknown) => { writes.push(k); if (v === undefined) data.delete(k); else data.set(k, v) },
  }
  return { m: m as unknown as vscode.Memento, data, writes }
}

// Users' stored state is under these strings: a key renamed loses it (a change here needs a migration).
const KEY_STRINGS = {
  workspace: [
    'codeNotes.askErrors', 'codeNotes.groupBy', 'codeNotes.hiddenSessions', 'codeNotes.journeyFollowed', 'codeNotes.journeyPos',
    'codeNotes.journeyRenames', 'codeNotes.journeySort', 'codeNotes.journeysSeen', 'codeNotes.legendHidden', 'codeNotes.mapColumn',
    'codeNotes.mapJourney', 'codeNotes.pastNames', 'codeNotes.podcastPos', 'codeNotes.seen', 'codeNotes.seenCount', 'codeNotes.seenEvents',
    'codeNotes.tour', 'codeNotes.understanding.backgroundHeads', 'codeNotes.understanding.drafts', 'codeNotes.understanding.fixFiles',
    'codeNotes.understanding.todoFiles', 'codeNotes.understanding.writing',
  ],
  global: [
    'codeNotes.chordPrefix', 'codeNotes.journeyOpened', 'codeNotes.listenHintShown', 'codeNotes.mapWidth', 'codeNotes.panelShare',
    'codeNotes.podcastMuted', 'codeNotes.podcastRate', 'codeNotes.tutorialSeen',
  ],
}

test('state registry: every key once, with the key strings and scopes users\' state is stored under', () => {
  const all = Object.values(STATE)
  const keys = all.map((k) => k.key)
  assert.equal(new Set(keys).size, keys.length, 'no key twice')
  const byScope = (s: string) => all.filter((k) => k.scope === s).map((k) => k.key).sort()
  assert.deepEqual(byScope('workspace'), [...KEY_STRINGS.workspace].sort())
  assert.deepEqual(byScope('global'), [...KEY_STRINGS.global].sort())
  assert.deepEqual([true, false].map((on) => STATE_FAMILIES.gitSaid(on)), [
    { key: 'codeNotes.gitSaid.true', scope: 'global', fallback: false },
    { key: 'codeNotes.gitSaid.false', scope: 'global', fallback: false },
  ])
})

test('state registry: no stored key outside it (no Memento read or written by a key string)', () => {
  const src = path.join(__dirname, '../../src')
  const files = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : []))
  const bad: string[] = []
  for (const f of files(src)) {
    const rel = path.relative(src, f).replace(/\\/g, '/')
    if (rel === 'platform/state.ts') continue
    const text = fs.readFileSync(f, 'utf8')
    for (const m of text.matchAll(/\.(get|update)(<[^>]*>)?\(\s*['`]codeNotes\.|vscode\.Memento|(workspace|global)State\b/g)) {
      // activate hands both Mementos to the one StateStore.
      if (rel === 'extension.ts' && /^(workspace|global)State$/.test(m[0])) continue
      bad.push(`${rel}: ${m[0]}`)
    }
  }
  assert.deepEqual(bad, [])
})

test('StateStore: the fallback when nothing is stored (a copy), the stored value, a removal', async () => {
  const w = memento({ 'codeNotes.journeySort': 'newest' })
  const g = memento()
  const s = new StateStore(w.m, g.m)
  assert.equal(s.get(STATE.journeySort), 'newest')
  assert.equal(s.get(STATE.legendHidden), true, 'the legend is hidden until asked for')
  assert.equal(s.get(STATE.podcastRate), 1)
  assert.equal(s.get(STATE.tour), undefined)
  const pos = s.get(STATE.journeyPos)
  pos.x = { step: 1, at: '' }
  assert.deepEqual(s.get(STATE.journeyPos), {}, 'changing what get gave does not change the fallback')
  await s.set(STATE.podcastRate, 1.5)
  assert.deepEqual([g.writes, w.writes], [['codeNotes.podcastRate'], []], 'a global key goes to the global state')
  assert.equal(s.get(STATE.podcastRate), 1.5)
  assert.equal(s.has(STATE.tour), false)
  await s.set(STATE.journeySort, undefined)
  assert.equal(s.has(STATE.journeySort), false)
  assert.equal(s.get(STATE.journeySort), 'area')
  assert.deepEqual(new StateStore().get(STATE.hiddenSessions), [], 'no Mementos (unit tests): the fallbacks')
  assert.deepEqual(s.mementos(), [w.m, g.m])
})

test('StateStore.record: a value per id; undefined drops it; dropping a missing id writes nothing', async () => {
  const w = memento()
  const r = new StateStore(w.m).record(STATE.journeyRenames)
  await r.set('a', 'b.ts')
  await r.set('c', 'd.ts')
  assert.equal(r.get('a'), 'b.ts')
  await r.set('a', undefined)
  assert.deepEqual(r.all(), { c: 'd.ts' })
  await r.set('zzz', undefined)
  assert.equal(w.writes.length, 3)
})

test('StateStore.scoped: a record per scope (a branch), each a value per id', async () => {
  const w = memento()
  const fixes = new StateStore(w.m).scoped(STATE.checkFixes)
  assert.deepEqual(fixes.get(undefined), {})
  await fixes.set('main', 'q1', 'a.ts')
  await fixes.set('feat', 'q1', 'b.ts')
  await fixes.set('main', 'q2', 'c.ts')
  await fixes.set('main', 'q1', undefined)
  assert.deepEqual(fixes.get('main'), { q2: 'c.ts' })
  await fixes.replace('feat', { q9: 'z.ts' })
  assert.deepEqual(w.data.get('codeNotes.understanding.fixFiles'), { main: { q2: 'c.ts' }, feat: { q9: 'z.ts' } })
})

const note = (id: string, ...at: (string | undefined)[]) => ({ id, messages: at.map((a) => ({ at: a })) })

test('migration (v0.1 seen times): a count of the messages by then; counted or unseen notes left alone', () => {
  const notes = [
    note('a', '2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z', '2026-01-01T12:00:00Z'),
    note('b', '2026-01-01T10:00:00Z'),
    note('c', undefined, '2026-01-02T00:00:00Z'),
    note('d', '2026-01-01T10:00:00Z'),
  ]
  const times = { a: '2026-01-01T11:30:00Z', b: '2026-01-01T10:00:00Z', c: '2026-01-01T00:00:00Z', d: 'not a time', e: '2026-01-01T00:00:00Z' }
  assert.deepEqual(seenCountsFromTimes(times, notes, { b: 5 }), [['a', 2], ['c', 1]])
})

test('migrations run while their old key is stored, and remove it', async () => {
  const w = memento({ 'codeNotes.seen': { a: '2026-01-01T11:30:00Z' }, 'codeNotes.seenCount': { z: 4 } })
  const s = new StateStore(w.m)
  const ctx = { notes: () => [note('a', '2026-01-01T10:00:00Z', '2026-01-01T12:00:00Z')] }
  assert.deepEqual(await runMigrations(s, ctx), [MIGRATIONS[0].what])
  assert.deepEqual(s.get(STATE.seenCount), { z: 4, a: 1 })
  assert.equal(s.has(STATE.seenTimes), false)
  assert.deepEqual(await runMigrations(s, ctx), [], 'once only')
})
