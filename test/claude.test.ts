import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import { foldEvent } from '../src/claude'

test('folds a real `claude -p --output-format stream-json` transcript', () => {
  const lines = fs.readFileSync(path.join(__dirname, '../../test/fixtures/claude-stream.jsonl'), 'utf8').split('\n').filter(Boolean)
  const state: { text: string; activity?: string; result?: any } = { text: '' }
  const activities: string[] = []
  for (const l of lines) { foldEvent(state, l); if (state.activity) activities.push(state.activity) }
  assert.ok(state.result, 'result seen')
  assert.match(state.result.text, /firstNonEmpty/)
  assert.ok(state.result.sessionId)
  assert.ok(state.text.includes('firstNonEmpty'), 'streamed text accumulated')
  assert.ok(activities.some((a) => /Using|Reading|Searching|Looking/.test(a)), `tool activity shown: ${activities.join(' | ')}`)
})

test('ignores junk lines', () => {
  const state = { text: '' }
  assert.equal(foldEvent(state, 'not json'), false)
  assert.equal(foldEvent(state, '{"type":"system","subtype":"init"}'), false)
})
