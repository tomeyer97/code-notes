import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import { COMMENT_CONTEXT, shownBecause, THREAD_WORD, threadContextValue, type ShownFacts } from '../src/threads/context'

const root = path.join(__dirname, '..', '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

/** Words the menus test that no note thread writes: `stepAsk` (no code writes it today). */
const NOT_WRITTEN = ['stepAsk']

test('every word the menus look for in a thread\'s or a comment\'s contextValue is one the threads write', () => {
  const whens: string[] = Object.values(pkg.contributes.menus as Record<string, { when?: string }[]>).flat().map((m) => m.when ?? '')
  const words = { commentThread: new Set<string>(), comment: new Set<string>() }
  for (const w of whens) {
    for (const m of w.matchAll(/\b(commentThread|comment)\s*(?:=~\s*\/((?:[^/\\]|\\.)*)\/|[!=]=\s*([\w.-]+))/g)) {
      for (const word of (m[2] ?? m[3]).split(/[^A-Za-z]+/).filter(Boolean)) words[m[1] as keyof typeof words].add(word)
    }
  }
  assert.ok(words.commentThread.size > 0, 'the menus test thread words')
  const thread = new Set<string>([...Object.values(THREAD_WORD), ...NOT_WRITTEN])
  for (const w of words.commentThread) assert.ok(thread.has(w), `commentThread word "${w}" is not in THREAD_WORD`)
  const comment = new Set<string>(Object.values(COMMENT_CONTEXT))
  for (const w of words.comment) assert.ok(comment.has(w), `comment word "${w}" is not in COMMENT_CONTEXT`)
})

test('a thread\'s contextValue: note, status, stale, then the features\' words', () => {
  assert.equal(threadContextValue('open', true, [THREAD_WORD.asking, THREAD_WORD.check]), 'note;open;stale;asking;check')
  assert.equal(threadContextValue('resolved', false, []), 'note;resolved')
})

test('why a thread is shown: listed (unless its session is hidden), else a feature at work or failed', () => {
  const no: ShownFacts = { open: false, showResolved: false, unread: false, revealed: false, pinned: false, hidden: false, working: false, failed: false }
  assert.equal(shownBecause(no), undefined)
  assert.equal(shownBecause({ ...no, open: true }), 'open')
  assert.equal(shownBecause({ ...no, unread: true }), 'unread')
  assert.equal(shownBecause({ ...no, pinned: true }), 'pinned')
  assert.equal(shownBecause({ ...no, open: true, hidden: true }), undefined)
  assert.equal(shownBecause({ ...no, open: true, hidden: true, working: true }), 'working')
  assert.equal(shownBecause({ ...no, failed: true }), 'failed')
})
