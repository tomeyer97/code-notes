// The Check view's requests checked once (src/check/viewRequests.ts decodeViewRequest): what the controller's
// handlers get, and what never reaches them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeViewRequest } from '../src/check/viewRequests'
import type { FromCheck } from '../src/protocol/check'

const decode = (m: unknown) => decodeViewRequest(m as FromCheck)

test('a request with its fields is passed on as it is', () => {
  assert.deepEqual(decode({ type: 'open', id: 'q1' }), { type: 'open', id: 'q1' })
  assert.deepEqual(decode({ type: 'answer', id: 'q1', text: '' }), { type: 'answer', id: 'q1', text: '' })
  assert.deepEqual(decode({ type: 'link', id: 'q1', i: 0 }), { type: 'link', id: 'q1', i: 0 })
  assert.deepEqual(decode({ type: 'concern', id: 'q1', action: 'todo' }), { type: 'concern', id: 'q1', action: 'todo' })
  assert.deepEqual(decode({ type: 'include', file: 'a.js' }), { type: 'include', file: 'a.js', on: false })
  assert.deepEqual(decode({ type: 'retry', extra: 1 }), { type: 'retry' })
})

test('a missing or mistyped field: no request', () => {
  assert.equal(decode({ type: 'open' }), undefined)
  assert.equal(decode({ type: 'select', id: '' }), undefined)
  assert.equal(decode({ type: 'draft', id: 'q1' }), undefined)
  assert.equal(decode({ type: 'link', id: 'q1', i: '2' }), undefined)
  assert.equal(decode({ type: 'include' }), undefined)
})

test('a concern action the view has no button for (fixed comes with a push) is not taken', () => {
  assert.equal(decode({ type: 'concern', id: 'q1', action: 'fixed' }), undefined)
  assert.equal(decode({ type: 'concern', id: 'q1' }), undefined)
})

test('reports and unknown types are not requests', () => {
  assert.equal(decode({ type: 'rendered', rows: 3 }), undefined)
  assert.equal(decode({ type: 'focused', id: 'q1' }), undefined)
  assert.equal(decode({ type: 'nope' }), undefined)
  assert.equal(decode({ type: 'constructor' }), undefined)
})
