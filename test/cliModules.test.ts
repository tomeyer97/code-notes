// The CLI's pure policies, tested without a repository or a forge: who can bypass the check (skipDecision), the
// verdict that counts (normalizeVerdict), the phase from a branch's facts (checkState, statusOf), the phase table,
// the bot's markers, the flag table, the forges' diff links. The scenarios with git and a fake forge are in test/cli/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { skipDecision } from '../cli/understanding/ci'
import { normalizeVerdict, stripCourtesy } from '../cli/understanding/grading'
import { checkState, statusOf, stateWords } from '../cli/understanding/state'
import { PHASE, PHASES } from '../cli/understanding/phases'
import { closedIdOf, closedMarker, concernIdOf, concernMarker, isConcernThread, isOwnComment, MARKER } from '../cli/understanding/markers'
import { BOOLEAN_FLAGS, parseArgs } from '../cli/understanding/main'
import { forgeOf, refLink } from '../cli/understanding/platform'
import { DEFAULTS, STATE } from '../cli/understanding/constants'
import type { Summary, Verdict } from '../cli/understanding/types'

test('skipDecision: labels set, approvers × author → waived or what is missing', () => {
  const gitlab = forgeOf({ platform: 'gitlab' })
  const github = forgeOf({ platform: 'github' })
  const cases: [string[] | undefined, string | undefined, typeof gitlab, unknown][] = [
    [undefined, 'ann', gitlab, { waived: false, glyph: '✗', head: 'Label "skip-understanding" is set, but this job can\'t see approvals (no GITLAB_TOKEN).' }],
    [undefined, 'ann', github, { waived: false, glyph: '✗', head: 'Label "skip-understanding" is set, but this job can\'t see approvals (no GITHUB_TOKEN).' }],
    [['bob'], 'ann', gitlab, { waived: true, by: ['bob'] }],
    [['ann', 'bob', 'cid'], 'ann', github, { waived: true, by: ['bob', 'cid'] }],
    // The author's own approval never counts, whoever else is missing.
    [['ann'], 'ann', gitlab, {
      waived: false, glyph: '✗', head: 'Approved only by ann (the author). Ask a reviewer to approve, then re-run this job.',
      body: `${MARKER}\nYour own approval doesn't count: ask a reviewer to approve, then re-run this job.`,
    }],
    [['ann'], 'ann', github, {
      waived: false, glyph: '✗', head: 'Approved only by ann (the author). Ask a reviewer to approve.',
      body: `${MARKER}\nYour own approval doesn't count: ask a reviewer to approve.`,
    }],
    [[], 'ann', gitlab, {
      waived: false, glyph: '', head: 'Skip requested: an approval from a reviewer waives the understanding check, then re-run this job.',
      body: `${MARKER}\nSkip requested: an approval from a reviewer waives the understanding check, then re-run this job.`,
    }],
    // No author known (no API): any approval waives.
    [['ann'], undefined, gitlab, { waived: true, by: ['ann'] }],
  ]
  for (const [approved, author, forge, want] of cases) {
    assert.deepEqual(skipDecision({ approved, author, skipLabel: DEFAULTS.skipLabel, forge }), want, `${JSON.stringify(approved)} by ${author}`)
  }
})

test('normalizeVerdict: the attempt decides retry vs explained; a restatement is restated or explained', () => {
  const table: [Verdict, Verdict, Verdict, Verdict][] = [
    // raw          first try    later try     restatement
    ['pass', 'pass', 'pass', 'restated'],
    ['restated', 'pass', 'pass', 'restated'],
    ['retry', 'retry', 'explained', 'explained'],
    ['explained', 'retry', 'explained', 'explained'],
  ]
  for (const [raw, first, later, restate] of table) {
    assert.equal(normalizeVerdict(raw, { attempt: 1, restate: false }), first, `${raw} first`)
    assert.equal(normalizeVerdict(raw, { attempt: 2, restate: false }), later, `${raw} later`)
    assert.equal(normalizeVerdict(raw, { attempt: 3, restate: false }), later, `${raw} third`)
    assert.equal(normalizeVerdict(raw, { attempt: 2, restate: true }), restate, `${raw} restated`)
  }
})

test('stripCourtesy: one opener rule for the comment and the concern check', () => {
  assert.equal(stripCourtesy('Right: tick() re-queues it.'), 'tick() re-queues it.')
  assert.equal(stripCourtesy('Mostly right. The lock is per row.'), 'The lock is per row.')
  assert.equal(stripCourtesy('correct, and it retries.'), 'and it retries.')
  assert.equal(stripCourtesy('Rightly so.'), 'Rightly so.')
  assert.equal(stripCourtesy(undefined), '')
})

const summary = (over: Partial<Summary>): Summary => ({ total: 3, passed: 0, done: 0, explained: 0, restated: 0, retry: 0, todo: 3, ungraded: 0, open: 3, needed: 2, met: false, states: [], ...over })

test('checkState decides from the facts alone (no repository)', () => {
  assert.deepEqual(checkState(undefined), { phase: 'none', changed: 0 })
  assert.deepEqual(checkState({ exists: false, stashed: 'stash@{0}' }), { phase: 'stashed', stash: 'stash@{0}' })
  assert.deepEqual(checkState({ exists: false, changed: 0 }), { phase: 'nothing', changed: 0, exemptOnly: false })
  assert.equal(checkState({ exists: false, changed: 12 }).phase, 'none')
  assert.deepEqual(checkState({ exists: true, errors: ['x.json has a merge conflict'], conflict: { line: 3, mergeable: true } }),
    { phase: 'invalid', why: 'x.json has a merge conflict', conflict: { line: 3, mergeable: true } })
  const answering = summary({ done: 1 })
  assert.equal(checkState({ exists: true, summary: answering }).phase, 'answering')
  assert.equal(checkState({ exists: true, summary: summary({ done: 3, passed: 1 }) }).phase, 'short')
  assert.equal(checkState({ exists: true, summary: summary({ done: 3, passed: 2, met: true }) }).phase, 'done')
  const over = DEFAULTS.maxDrift + 1
  assert.deepEqual(checkState({ exists: true, summary: answering, drift: { lines: over, approx: false } }),
    { passed: 0, done: 1, total: 3, needed: 2, maxDrift: DEFAULTS.maxDrift, grew: over, phase: 'drift', commitFirst: false })
  assert.equal(checkState({ exists: true, summary: answering, drift: { lines: 0, approx: false }, pending: { lines: over, approx: false } }).commitFirst, true)
})

test('statusOf: the facts with their position and next step', () => {
  const s = statusOf({ branch: 'feat/x', file: 'understanding/feat-x.json', changed: 12, exists: false })
  assert.equal(s.state.phase, 'none')
  assert.equal(s.next, stateWords(s.state, s).line)
  assert.equal(s.next, '12 code lines changed · 1 question, ~1 min.')
})

test('the phase table has every phase, and CI words exactly for the phases CI reports from a check', () => {
  assert.deepEqual(Object.keys(PHASE).sort(), [...PHASES].sort())
  const withCi = PHASES.filter((p) => 'ci' in PHASE[p])
  assert.deepEqual(withCi.sort(), ['answering', 'done', 'drift', 'short'])
})

test('markers: written and found again', () => {
  assert.equal(concernIdOf(`${concernMarker('q2')}\n⚠ **May be a bug**`), 'q2')
  assert.equal(concernIdOf(closedMarker('q2')), undefined)
  assert.equal(closedIdOf(`${closedMarker('q2')}\nNo longer flagged.`), 'q2')
  assert.equal(isConcernThread(`${concernMarker('q2')}\n⚠ **May be a bug**`), true)
  assert.equal(isConcernThread(`${concernMarker('q2')}\n💬 **Worth discussing**`), false)
  assert.equal(isOwnComment(`${MARKER}\n**✓ Understanding check done**`), true)
  assert.equal(isOwnComment(undefined), false)
})

test('parseArgs: the boolean flags take no value; any other flag takes the next word', () => {
  assert.deepEqual(parseArgs(['grade', '--question', 'q2', '--answer', '-1 when empty', '--write']), { _: ['grade'], question: 'q2', answer: '-1 when empty', write: true })
  assert.deepEqual(parseArgs(['status', '--json', 'extra']), { _: ['status', 'extra'], json: true })
  assert.deepEqual(parseArgs(['--base', '--json']), { _: [], base: true, json: true })
  assert.deepEqual(parseArgs(['--reply={"verdict": "pass"}']), { _: [], reply: '{"verdict": "pass"}' })
  for (const flag of Object.keys(BOOLEAN_FLAGS)) assert.equal(parseArgs([`--${flag}`, 'word'])[flag], true, flag)
})

test('refLink: each forge its own diff anchors; none outside CI', () => {
  const q = { file: 'src/a.ts', start: 3, end: 5 }
  assert.match(refLink({ platform: 'github', web: 'https://github.com/o/r', mr: '7' }, q)!, /^https:\/\/github\.com\/o\/r\/pull\/7\/files#diff-[0-9a-f]{64}R3-R5$/)
  assert.equal(refLink({ platform: 'gitlab', web: 'https://gl/o/r', mr: '7', head: 'abc' }, q, ''), 'https://gl/o/r/-/blob/abc/src/a.ts#L3-5')
  assert.equal(refLink({ platform: 'local', web: 'https://x', mr: '7' }, q), undefined)
  assert.equal(refLink({ platform: 'github', mr: '7' }, q), undefined)
})

test('STATE names every question state once', () => {
  assert.deepEqual(Object.keys(STATE).sort(), Object.values(STATE).sort())
})
