// The Check view's messages: the page (media/check.js, media/checkAnswer.js, type-checked against
// src/protocol/check.ts by scripts/build/pages.mjs) and the extension use the same types. These tests tie those types to
// the names the extension handles: src/check/viewMessages.ts CHECK_VIEW_REQUESTS (the controller has one handler per
// request: its handler table is typed by them) and CHECK_VIEW_REPORTS (src/check/view.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHECK_VIEW_REPORTS, CHECK_VIEW_REQUESTS, REQUEST_FIELDS, isCheckViewReport, type CheckViewReport, type CheckViewRequest,
} from '../src/check/viewMessages'
import { decodeViewRequest } from '../src/check/viewRequests'
import type { FromCheck, ToCheck } from '../src/protocol/check'

/** True when A and B are the same type (else the assignment below does not compile). */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

// Every type the page may post is a request or a report, and each of those is a type the page may post.
const postsAreHandled: Same<FromCheck['type'], CheckViewRequest | CheckViewReport> = true

/** Every type the page may post, once: the compiler says when one is missing or unknown. */
const POSTED: Record<FromCheck['type'], true> = {
  // The one button (src/check/checkWords.ts ACTIONS).
  start: true, topUp: true, scm: true, commitPush: true, openFile: true, merge: true, pull: true,
  // The view's other requests.
  ready: true, open: true, select: true, answer: true, draft: true, link: true, next: true, regrade: true, escape: true,
  concern: true, include: true, retry: true, modelSetting: true, pathSetting: true, install: true, tour: true,
  writeTour: true, openMr: true,
  // What the page reports about itself.
  rendered: true, error: true, focused: true,
}

/** Every type the extension sends the page (the page has one handler each: media/check.js `handlers`). */
const SENT: Record<ToCheck['type'], true> = { check: true, focus: true, test: true }

test('the Check view page posts exactly the requests and reports the extension handles', () => {
  assert.equal(postsAreHandled, true)
  assert.deepEqual(Object.keys(POSTED).sort(), [...CHECK_VIEW_REQUESTS, ...CHECK_VIEW_REPORTS].sort())
})

test('the requests and reports are named once each', () => {
  const all = [...CHECK_VIEW_REQUESTS, ...CHECK_VIEW_REPORTS]
  assert.equal(new Set(all).size, all.length)
})

test('the extension sends the Check view three kinds of message', () => {
  assert.deepEqual(Object.keys(SENT).sort(), ['check', 'focus', 'test'])
})

test('reports and requests are told apart by name (src/check/view.ts routes them)', () => {
  for (const type of CHECK_VIEW_REPORTS) assert.equal(isCheckViewReport({ type }), true, type)
  for (const type of CHECK_VIEW_REQUESTS) assert.equal(isCheckViewReport({ type }), false, type)
})

test('each request carries the fields its table names: with them it is taken, without any one of them it is not', () => {
  const sample = { string: 'q1', number: 0, boolean: true, concernAction: 'dismiss' }
  for (const type of CHECK_VIEW_REQUESTS) {
    const fields: Record<string, keyof typeof sample> = REQUEST_FIELDS[type]
    const full = { type, ...Object.fromEntries(Object.entries(fields).map(([k, t]) => [k, sample[t]])) } as FromCheck
    assert.deepEqual(decodeViewRequest(full), full, type)
    for (const k of Object.keys(fields)) {
      // A missing boolean reads as false (an unticked file); every other field is required.
      if (fields[k] === 'boolean') continue
      const without = { ...full } as Record<string, unknown>
      delete without[k]
      assert.equal(decodeViewRequest(without as FromCheck), undefined, `${type} without ${k}`)
    }
  }
})
