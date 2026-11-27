// "A push just happened", from the Git view's HEAD each time it reads the repository (src/check/pushSeen.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PushWatch } from '../src/check/pushSeen'

const unpushed = { name: 'feat/x', commit: 'c1', upstream: { name: 'origin/feat/x' }, ahead: 1 }
const pushed = { ...unpushed, ahead: 0 }
const noUpstream = { name: 'feat/x', commit: 'c1' }

test('a branch first seen already pushed (a checkout) is no push', () => {
  const w = new PushWatch()
  assert.deepEqual(w.look(pushed), { branch: 'feat/x', line: 'feat/x pushed (new)', pushedNow: false })
})

test('ahead of its upstream, then nothing ahead: a push', () => {
  const w = new PushWatch()
  assert.equal(w.look(unpushed)?.line, 'feat/x unpushed (new)')
  assert.deepEqual(w.look(pushed), { branch: 'feat/x', line: 'feat/x pushed', pushedNow: true })
  assert.equal(w.look(pushed)?.pushedNow, false, 'seen pushed again: no second push')
})

test('no upstream, then pushed with one: a push', () => {
  const w = new PushWatch()
  w.look(noUpstream)
  assert.equal(w.look(pushed)?.pushedNow, true)
})

test('no branch (a detached HEAD): nothing to say', () => assert.equal(new PushWatch().look({ commit: 'c1' }), undefined))
