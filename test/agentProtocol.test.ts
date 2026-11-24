// The request envelope scripts use (src/platform/agent/protocol.ts, docs/agent-protocol.md) and the version order
// behind its `needs` (src/platform/agent/versions.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readEnvelope, readRequest, REQUEST_MAX_AGE_MS, resultText } from '../src/platform/agent/protocol'
import { compareVersions, olderThan, parseVersion } from '../src/platform/agent/versions'

const NOW = Date.parse('2026-11-24T12:00:00Z')
const at = (msAgo = 0) => new Date(NOW - msAgo).toISOString()
const read = (v: unknown, version = '0.24.0') => readEnvelope(typeof v === 'string' ? v : JSON.stringify(v), { version, now: NOW })

test('versions in semver order, a pre-release before its release', () => {
  const order = ['0.9.9', '0.24.0-alpha', '0.24.0-alpha.2', '0.24.0-alpha.10', '0.24.0-beta', '0.24.0', '0.24.1', '1.0.0']
  for (let i = 1; i < order.length; i++) {
    assert.ok(compareVersions(parseVersion(order[i - 1])!, parseVersion(order[i])!) < 0, `${order[i - 1]} < ${order[i]}`)
    assert.ok(olderThan(order[i - 1], order[i]) && !olderThan(order[i], order[i - 1]))
  }
  assert.deepEqual(parseVersion('2.1.322 (Claude Code)'), { core: [2, 1, 322] })
  assert.deepEqual(parseVersion('v0.24.0-quiz'), { core: [0, 24, 0], pre: 'quiz' })
  assert.equal(olderThan('0.24.0', '0.24.0'), false)
  assert.equal(olderThan('no version', '0.0.1'), true, 'no version reads as 0.0.0')
})

test('a request to handle: its fields, the old links\' `q`', () => {
  assert.deepEqual(read({ action: 'ask', question: 'How?', model: ' opus ', id: 'r1', at: at() }),
    { kind: 'request', request: { action: 'ask', question: 'How?', model: 'opus', id: 'r1' } })
  assert.deepEqual(readRequest({ action: 'ask', q: 'old' }), { action: 'ask', question: 'old' })
  assert.deepEqual(readRequest({ action: 'overview', model: '', id: '' }), { action: 'overview', question: '' })
})

test('a request for a newer extension is left for it', () => {
  assert.deepEqual(read({ action: 'ask', question: 'How?', needs: '99.0.0', at: at() }),
    { kind: 'too-new', needs: '99.0.0', action: 'ask', question: 'How?' })
  assert.equal(read({ action: 'ask', needs: '0.24.0', at: at() }).kind, 'request')
  assert.equal(read({ action: 'ask', needs: '0.24.0', at: at() }, '0.24.0-quiz').kind, 'too-new', 'a pre-release is older')
})

test('every request that can\'t be used is refused, with the reason its result carries', () => {
  assert.deepEqual(read('{not json'), { kind: 'refused', reason: 'the request is not a JSON object' })
  assert.deepEqual(read({ action: 'ask', id: 'r2' }), { kind: 'refused', reason: 'the request has no time ("at")', id: 'r2' })
  assert.deepEqual(read({ action: 'ask', id: 'r3', at: at(REQUEST_MAX_AGE_MS + 1) }), { kind: 'refused', reason: 'the request is older than 2 minutes', id: 'r3' })
  assert.deepEqual(read({ action: 'delete', id: 'r4', at: at() }), { kind: 'refused', reason: 'unknown action "delete"', id: 'r4' })
})

test('the result file: the id and the result, flat', () => {
  assert.equal(resultText('r1', { outcome: 'opened', title: 'Saving a note' }), '{"id":"r1","outcome":"opened","title":"Saving a note"}\n')
})
