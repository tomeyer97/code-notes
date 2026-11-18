// The Check view's page (media/check.js, media/checkAnswer.js) and the extension name the same messages: each page's
// "Out" list and every type it posts are src/check/viewMessages.ts CHECK_VIEW_REQUESTS and CHECK_VIEW_REPORTS.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import { CHECK_VIEW_REPORTS, CHECK_VIEW_REQUESTS } from '../src/check/viewMessages'

const page = (f: string) => fs.readFileSync(path.join(__dirname, '../../media', f), 'utf8')
const PAGES = ['check.js', 'checkAnswer.js']
const quoted = (s: string) => [...s.matchAll(/'(\w+)'/g)].map((m) => m[1])

/** The message types a page's header lists under "Out:" (up to the code). */
function outList(text: string): string[] {
  const lines = text.split('\n')
  const from = lines.findIndex((l) => /^\/\/ Out:/.test(l))
  const out: string[] = []
  for (const l of lines.slice(from + 1)) {
    if (!l.startsWith('//')) break
    // `{ type: 'a' | 'b' }`, and the button's ids after `{ type: <the action's id> }`.
    for (const m of l.matchAll(/\{ type: ((?:'\w+'(?: \| )?)+)/g)) out.push(...quoted(m[1]))
    if (l.includes("<the action's id>")) out.push(...quoted(l.split("<the action's id>")[1]))
  }
  return out
}

test('the Check view pages list under "Out" exactly the requests and reports the extension handles', () => {
  const listed = new Set(PAGES.flatMap((f) => outList(page(f))))
  assert.deepEqual([...listed].sort(), [...CHECK_VIEW_REQUESTS, ...CHECK_VIEW_REPORTS].sort())
})

test('every type the Check view pages post by name is a request or a report', () => {
  const known = new Set<string>([...CHECK_VIEW_REQUESTS, ...CHECK_VIEW_REPORTS])
  const posted = PAGES.flatMap((f) => [...page(f).matchAll(/post\(\{ type: '(\w+)'/g)].map((m) => m[1]))
  assert.ok(posted.length > 10, `found ${posted.length} posts`)
  assert.deepEqual(posted.filter((t) => !known.has(t)), [])
})
