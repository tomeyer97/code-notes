// The one way a part writes the check file (src/check/state.ts updateCheck), and whether a fix was applied
// (CheckState.fixApplied).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type * as vscode from 'vscode'
import type { ScopedRecord } from '../src/platform/state'
import { CheckState, updateCheck } from '../src/check/state'
import type { HostCli } from '../src/check/cliApi'
import type { BranchStatus, Check } from '../src/check/types'
import { checkIn } from './checkFixtures'

const folder = { uri: { fsPath: '/repo', scheme: 'file' } } as unknown as vscode.WorkspaceFolder
const record = <T>(data: Record<string, Record<string, T>> = {}): ScopedRecord<T> => ({
  get: (scope) => (scope === undefined ? {} : data[scope] ?? {}),
  set: async () => undefined,
  replace: async () => undefined,
})
const stateOn = (fixes: Record<string, Record<string, string>> = {}) => {
  const s = new CheckState(folder, { drafts: record(), fixes: record(fixes), todos: record() })
  s.read({ branch: 'feat', file: 'understanding/feat.json', exists: true } as BranchStatus, undefined)
  return s
}
/** A check file in memory: what was read, and each write. */
const fileWith = (check: Check) => {
  const writes: Check[] = []
  const cli = { readCheck: () => structuredClone(check) } as unknown as HostCli
  return { cli, writes, save: (_abs: string, c: Check) => { writes.push(c) } }
}

test('updateCheck: the change written', () => {
  const f = fileWith(checkIn())
  assert.ok(updateCheck({ state: stateOn(), ...f }, (c) => { c.questions[0].text = 'Changed?' }))
  assert.equal(f.writes[0].questions[0].text, 'Changed?')
})

test('updateCheck: a change that says false writes nothing', () => {
  const f = fileWith(checkIn())
  assert.equal(updateCheck({ state: stateOn(), ...f }, () => false), false)
  assert.deepEqual(f.writes, [])
})

test('updateCheck: no check file here, nothing read or written', () => {
  const f = fileWith(checkIn())
  const s = new CheckState(folder, { drafts: record(), fixes: record(), todos: record() })
  assert.equal(updateCheck({ state: s, ...f }, () => assert.fail('not read')), false)
})

test('fixApplied: a fix applied for the question on this branch', () => {
  const s = stateOn({ feat: { q2: 'api/a.js' }, other: { q1: 'b.js' } })
  assert.deepEqual([s.fixApplied('q2'), s.fixApplied('q1')], [true, false])
})
