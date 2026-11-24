// What the journey files' loader decides without a file (src/journeys/fileStates.ts): why a file is not listed, and
// waiting for one to be listed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseJourney } from '../src/core/format/journeyModel'
import { classifyUnreadable, invalidRow, whenThere } from '../src/journeys/fileStates'

const why = (raw: string) => {
  const r = parseJourney(raw, 'j')
  assert.ok(!r.ok)
  return r.why
}

test('classifyUnreadable: the old format (steps as notes) needs migrating; anything else is broken', () => {
  assert.equal(classifyUnreadable(why(JSON.stringify({ title: 'Old', steps: [] }))), 'oldFormat')
  assert.equal(classifyUnreadable(why('{ "version": 2, "steps": [')), 'broken')
  assert.equal(classifyUnreadable(why(JSON.stringify({ version: 99, steps: [] }))), 'broken', 'a newer format is not an old one')
})

test('invalidRow: what the list says about a file never readable', () => {
  assert.equal(invalidRow('oldFormat', 'format v1 (steps as notes)'), 'Old format (v1): migrate it with journey.py migrate.')
  assert.equal(invalidRow('broken', 'not JSON'), "Can't read it: not JSON.")
})

/** An event source in memory: `fire` calls the listeners still subscribed. */
function events() {
  const listeners = new Set<() => void>()
  return {
    on: (f: () => void) => { listeners.add(f); return { dispose: () => listeners.delete(f) } },
    fire: () => { for (const f of [...listeners]) f() },
    get count() { return listeners.size },
  }
}

test('whenThere: now when it is there; else at the change that brings it; else undefined after the wait', async () => {
  const e = events()
  assert.equal(await whenThere(() => 'now', e.on, 1000), 'now')
  const file: { read?: string } = {}
  const later = whenThere(() => file.read, e.on, 1000)
  e.fire()
  file.read = 'read'
  e.fire()
  assert.equal(await later, 'read')
  assert.equal(e.count, 0, 'unsubscribed once there')
  assert.equal(await whenThere(() => undefined, e.on, 10), undefined)
  assert.equal(e.count, 0, 'unsubscribed after the wait')
})
