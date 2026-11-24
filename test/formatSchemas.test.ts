// The published schemas (src/core/format/schema/*.schema.json) against the files the extension reads: every fixture
// and example conforms, the readers accept what the schema allows, and both refuse the same broken parts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import { checkSchema, SchemaFiles, unknownKeywords } from '../src/core/format/schemaCheck'
import { readJourney } from '../src/core/format/journeyModel'
import { parseNote, serialize } from '../src/core/format/noteModel'
import { readMarks } from '../src/core/format/marks'
import { VERSIONS } from '../src/core/format/versions'
import { validatePodcast } from '../src/core/format/podcast/validate'

const root = path.join(__dirname, '../..')
const SCHEMAS = path.join(root, 'src/core/format/schema')
const files: SchemaFiles = Object.fromEntries(fs.readdirSync(SCHEMAS).filter((f) => f.endsWith('.schema.json'))
  .map((f) => [f, JSON.parse(fs.readFileSync(path.join(SCHEMAS, f), 'utf8'))]))
const json = (f: string) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'))
/** The problems of `value` against `schema`, one line each (empty: it conforms). */
const problems = (value: unknown, schema: string) => checkSchema(value, schema, files).map((p) => `${p.path.join('.')}: ${p.message}`)
const jsonIn = (dir: string) => fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.json') && !f.endsWith('.podcast.json')).map((f) => `${dir}/${f}`)

const JOURNEYS = [...jsonIn('test/fixtures/journey/journeys'), ...jsonIn('examples/shop/journeys'), 'test/journey-scene/sample.json']
const NOTES = jsonIn('test/fixtures/journey/legacy/v1-step-notes')

test('schemas: one per format, each with the version of VERSIONS, only keywords the checker knows', () => {
  assert.deepEqual(Object.keys(files).sort(), ['check.schema.json', 'journey.schema.json', 'marks.schema.json', 'note.schema.json', 'podcast.schema.json'])
  for (const [f, s] of Object.entries(files)) assert.deepEqual(unknownKeywords(s), [], f)
  const version = (f: string) => (files[f] as any).properties.version
  assert.deepEqual(version('journey.schema.json'), { ...version('journey.schema.json'), const: VERSIONS.journey })
  assert.deepEqual(version('podcast.schema.json'), { ...version('podcast.schema.json'), const: VERSIONS.podcast })
  assert.deepEqual(version('note.schema.json'), { ...version('note.schema.json'), const: VERSIONS.note })
  assert.deepEqual(version('check.schema.json'), { ...version('check.schema.json'), const: VERSIONS.check })
})

test('journeys: every fixture and example conforms, and the reader keeps all of it', () => {
  for (const f of JOURNEYS) {
    assert.deepEqual(problems(json(f), 'journey.schema.json'), [], f)
    const r = readJourney(json(f), f)
    assert.ok(r.ok && !r.value.stepsLeftOut.length, f)
  }
})

test('journeys: what the reader refuses or leaves out, the schema refuses too', () => {
  const good = json('test/fixtures/journey/journeys/order-lifecycle.json')
  const step = good.steps[0]
  const broken: [string, object][] = [
    ['version 3', { ...good, version: 3 }],
    ['no version', { ...good, version: undefined }],
    ['no nodes', { ...good, nodes: [] }],
    ['steps not a list', { ...good, steps: {} }],
    ['a step without a file', { ...good, steps: [{ ...step, file: undefined }] }],
    ['a step without lines', { ...good, steps: [{ ...step, range: { end: 3 } }] }],
    ['a step on line 0', { ...good, steps: [{ ...step, range: { start: 0, end: 2 } }] }],
  ]
  for (const [name, doc] of broken) {
    const v = JSON.parse(JSON.stringify(doc))
    const r = readJourney(v, 'x')
    assert.ok(!r.ok || r.value.stepsLeftOut.length > 0, `${name}: the reader takes it`)
    assert.notDeepEqual(problems(v, 'journey.schema.json'), [], `${name}: the schema takes it`)
  }
})

test('marks: a mark the reader drops, the schema refuses; a usable one conforms', () => {
  // `lines` ending before they start can't be said with the schema's keywords: only the reader refuses it.
  const marks: unknown[] = [{ lines: [2, 2] }, { lines: [1, 3], file: 'a.ts', match: 'x', nth: 2 }, { lines: [0, 1] }, { lines: [1] },
    { lines: [1, 2], file: '' }, { lines: [1, 2], match: '' }, { lines: [1, 2], nth: 0 }, { lines: [1.5, 2] }, 'x', null]
  const mark = { $ref: 'marks.schema.json#/$defs/mark' }
  const withMark = { ...files, 'one-mark.json': mark }
  for (const m of marks) {
    const dropped = readMarks([m]).problems.length > 0
    assert.equal(checkSchema(m, 'one-mark.json', withMark).length > 0, dropped, JSON.stringify(m))
  }
})

test('podcasts: the sample conforms and plays', () => {
  const f = 'test/fixtures/podcast/sample.podcast.json'
  assert.deepEqual(problems(json(f), 'podcast.schema.json'), [])
  assert.ok(!validatePodcast(fs.readFileSync(path.join(root, f), 'utf8')).problems.some((p) => p.level === 'error'))
  assert.notDeepEqual(problems({ ...json(f), version: 2 }, 'podcast.schema.json'), [])
})

test('notes: files agents wrote conform, and what the extension writes conforms (with its version)', () => {
  for (const f of NOTES) {
    assert.deepEqual(problems(json(f), 'note.schema.json'), [], f)
    const r = parseNote(fs.readFileSync(path.join(root, f), 'utf8'), 'n')
    assert.ok(r.ok, f)
    const written = JSON.parse(serialize(r.value))
    assert.equal(written.version, VERSIONS.note)
    assert.deepEqual(problems(written, 'note.schema.json'), [], `${f} as written`)
  }
  const note = { file: 'a.ts', range: { start: 1, end: 2 }, status: 'open', messages: [{ author: 'ann', role: 'human', body: 'Why?' }] }
  for (const broken of [{ ...note, version: 2 }, { ...note, file: '' }, { ...note, messages: [] }, { ...note, range: { start: 0, end: 1 } }, { ...note, status: 'done' }]) {
    assert.equal(parseNote(JSON.stringify(broken), 'n').ok, false, JSON.stringify(broken))
    assert.notDeepEqual(problems(broken, 'note.schema.json'), [], JSON.stringify(broken))
  }
})

test('checks: a check the CLI accepts conforms; its tour is a journey', async () => {
  const U = await import(path.join(root, 'cli/understanding.mjs'))
  const tour = json('test/check-tour/refunds.json').journey
  const sha = 'a'.repeat(40)
  const check = {
    version: 1, branch: 'feat-x', head: sha, base: sha,
    questions: [{ id: 'q1', kind: 'how', text: 'How does a refund reach the bank?', file: 'src/refund.ts', start: 3, end: 9 }],
    journey: tour,
  }
  assert.deepEqual(U.validateCheck(check), [])
  assert.deepEqual(problems(check, 'check.schema.json'), [])
  assert.notDeepEqual(U.validateCheck({ ...check, version: 2 }), [])
  assert.notDeepEqual(problems({ ...check, version: 2 }, 'check.schema.json'), [])
})
