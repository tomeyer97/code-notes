// Golden tests (test/README.md): the understanding check end to end on a fixture repository, byte for byte. The
// skill's script writing a check (its output and the file it writes), the CLI's commands and their JSON, the check's
// status at each stage, the Check view the extension builds from it (src/check/viewModel.ts, what the view is sent),
// each question's thread, grading replies, the CI job, and the validation errors of broken check files.
// Temporary paths, ISO times and commit ids change from run to run: they are replaced by stable names (normalise).
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import * as U from '../../cli/understanding.mjs'
import { root, FAKE, SCRIPT, gitIn, run, script, commitAll, gitlabEnv, ci, repo as smallChange, writeQuestions, answerAll } from './helpers.mjs'

const require = createRequire(import.meta.url)
const { expectGolden, normalise } = require('../../out/test/golden.js')
const VM = require('../../out/src/check/viewModel.js')
const TT = require('../../out/src/check/threadText.js')
const CS = require('../../out/src/check/concernState.js')

const AREA = 'check'
// The commits' dates are fixed: the same repository gets the same commit ids (the check file's own times still vary).
process.env.GIT_AUTHOR_DATE = process.env.GIT_COMMITTER_DATE = '2026-01-05T09:00:00Z'

/** Each repository made here, named for normalise. */
const repos = {}
const names = () => ({ ...Object.fromEntries(Object.entries(repos).flatMap(([n, d]) => [[fs.realpathSync(d), `<${n}>`], [d, `<${n}>`]])), [root]: '<root>', [os.tmpdir()]: '<tmp>' })
/** `v` (any value) with temporary paths, times and commit ids replaced. */
const stable = (v) => {
  const t = normalise(typeof v === 'string' ? v : JSON.stringify(v), names())
  return typeof v === 'string' ? t : JSON.parse(t)
}
const golden = (name, v) => expectGolden(AREA, name, stable(v))

/** examples/shop on main; the refunds change of test/fixtures/grader-cases on feat/refunds (test/grader/eval.mjs). */
function refundsRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-'))
  repos.refunds = d
  const fx = path.join(root, 'test/fixtures/grader-cases')
  fs.cpSync(path.join(root, 'examples/shop'), d, { recursive: true })
  fs.cpSync(path.join(fx, 'base'), d, { recursive: true })
  gitIn(d, 'init', '-q', '-b', 'main')
  gitIn(d, 'config', 'user.name', 'Ada')
  gitIn(d, 'config', 'user.email', 'ada@example.com')
  commitAll(d, 'shop')
  gitIn(d, 'checkout', '-qb', 'feat/refunds')
  fs.cpSync(path.join(fx, 'change'), d, { recursive: true })
  commitAll(d, 'refunds')
  return d
}

/** Where the check stands as the extension reads it, and what it shows: status, words, the view, the status bar. */
function stage(d, o = {}) {
  const st = U.localStatus(d)
  const w = U.stateWords(st.state, st)
  return {
    status: st, words: w, view: VM.checkView(st, w, o), bar: VM.statusText(st, w) ?? null,
    run: VM.runAction(st, { unpushed: o.unpushed, commit: o.commit }),
  }
}

test('golden: a check written, answered, graded and passed on the refunds change', async () => {
  const d = refundsRepo()
  const file = path.join(d, 'understanding/feat-refunds.json')
  const out = {}
  const say = (k, r) => { out[k] = r }

  // Before: nothing written yet (the CLI's words and the view's Start).
  say('help', (await run(d, ['help'])).out.split('\n')[0])
  say('status.none.text', await run(d, ['status']))
  say('status.none.json', JSON.parse((await run(d, ['status', '--json'])).out))
  golden('refunds.stage.none', { ...stage(d), uncommitted: VM.checkView(U.localStatus(d), U.stateWords(U.localStatus(d).state, U.localStatus(d)), { uncommitted: true }) })

  // The skill's script, as the agent runs it: start, adds (some refused), finish.
  fs.mkdirSync(path.join(d, 'understanding'), { recursive: true })
  fs.writeFileSync(path.join(d, 'understanding/config.json'), JSON.stringify({ questions: { min: 1, max: 6 } }))
  const steps = [
    ['start', '--base', 'main'],
    ['add', '--kind', 'failure', '--file', 'worker/notify.js', '--lines', '33-39', '--text', 'If sendMail throws in refundNotice after the mail server already accepted the message, what happens to the job?'],
    ['add', '--kind', 'edge', '--file', 'api/refunds.js', '--lines', '11-13', '--text', 'What happens when two refund requests with the same Idempotency-Key for one order arrive at the same time?'],
    ['add', '--kind', 'why', '--file', 'api/refunds.js', '--lines', '18-20', '--text', 'Why is the order row locked before the remaining refundable amount is checked?'],
    ['add', '--kind', 'failure', '--file', 'worker/alerts.js', '--lines', '5-12', '--text', 'Where do the low-stock alerts end up once this runs in production?'],
    ['add', '--kind', 'why', '--file', 'api/restock.js', '--lines', '3-6', '--text', 'Why does every refunded unit go back into product stock, even when staff refund without a return?'],
    // Refused: an unknown kind, lines outside the file, a file not in the change, a text too short, no text.
    ['add', '--kind', 'trivia', '--file', 'api/refunds.js', '--lines', '1-2', '--text', 'What is this file about, in one sentence please?'],
    ['add', '--kind', 'how', '--file', 'api/refunds.js', '--lines', '500-510', '--text', 'How does the refund handler respond when the order is missing?'],
    ['add', '--kind', 'how', '--file', 'README.md', '--lines', '1-2', '--text', 'How does the readme describe the refunds that were added here?'],
    ['add', '--kind', 'how', '--file', 'api/refunds.js', '--lines', '11-13', '--text', 'Why?'],
    ['add', '--kind', 'how', '--file', 'api/refunds.js', '--lines', '11-13'],
    ['add', '--kind', 'edge', '--file', 'api/refunds.js', '--whole-file', '--text', 'What does the refund handler answer for an order that was never paid at all?'],
    ['finish'],
  ]
  say('script', steps.map((a) => ({ args: a, ...script(d, ...a) })))
  golden('refunds.check-file.written', fs.readFileSync(file, 'utf8'))
  golden('refunds.stage.written', stage(d, { selected: 'q2', draft: 'Both requests', me: { name: 'Bo', email: 'bo@example.com' } }))

  // Without VS Code: the next question, the grader's instructions, grades written elsewhere (no model call).
  const env = { UNDERSTANDING_CLAUDE: FAKE, ANTHROPIC_API_KEY: '' }
  say('next.1', await run(d, ['next'], env))
  const prompt = await run(d, ['grade', '--question', 'q2', '--answer', 'The second one waits on the row lock.', '--prompt'], env)
  golden('refunds.grader-prompt', prompt.out)
  const replies = [
    ['q1', 'tick() catches it and retries the job, so the mail may go out twice.', '{"verdict":"pass","feedback":"Right: the retry sends it again.","links":[{"phrase":"retries the job","file":"worker/notify.js","start":33,"end":39}]}'],
    ['q2', 'Both get refunded.', '{"verdict":"retry","feedback":"Look at what the lookup does before the lock.","hint":"What does the UNIQUE key do to the second insert?"}'],
    ['q2', 'No idea.', '```json\n{"verdict":"retry","feedback":"The lookup runs before the lock, so both miss it; the second insert then fails on the UNIQUE key.","topic":"idempotency","concern":"The second request gets a 500 instead of the first refund."}\n```'],
    ['q2', 'Both miss the lookup; the unique key makes the second one fail.', '{"verdict":"pass","feedback":"Yes."}'],
    ['q3', 'So two refunds for one order run one after the other.', '{"verdict":"pass","feedback":"Right.","partial":true}'],
    ['q4', 'They are emailed to OPS_EMAIL.', '{"verdict":"pass","feedback":"That is what the code does.","concern":"OPS_EMAIL is never set in the worker chart: the alerts go nowhere."}'],
    ['q5', 'x', 'not json'],
    ['q5', 'x', '{"verdict":"maybe"}'],
    ['q9', 'x', '{"verdict":"pass"}'],
  ]
  const graded = []
  for (const [q, answer, reply] of replies) graded.push({ q, answer, reply, ...(await run(d, ['grade', '--question', q, '--answer', answer, '--reply', reply], env)) })
  say('graded', graded)
  say('flag', [await run(d, ['flag', '--question', 'q4'], env), await run(d, ['flag', '--question', 'q1'], env), await run(d, ['flag'], env)])
  say('next.2', await run(d, ['next'], env))
  say('status.answering.text', await run(d, ['status']))
  golden('refunds.stage.answering', stage(d, { selected: 'q5', grading: new Set(['q5']), error: "Claude couldn't check it; your answer is saved." }))

  await run(d, ['grade', '--question', 'q5', '--answer', 'Restock is called for every unit.', '--reply', '{"verdict":"pass","feedback":"Right."}'], env)
  await run(d, ['grade', '--question', 'q6', '--answer', 'It answers 409.', '--reply', '{"verdict":"retry","feedback":"Not quite."}'], env)
  await run(d, ['grade', '--question', 'q6', '--answer', 'I am not sure.', '--reply', '{"verdict":"retry","feedback":"It answers 404: the order lookup finds nothing paid."}'], env)
  say('next.done', await run(d, ['next'], env))
  say('validate', await run(d, ['validate', 'understanding/feat-refunds.json']))
  golden('refunds.check-file.answered', fs.readFileSync(file, 'utf8'))
  say('status.done.json', JSON.parse((await run(d, ['status', '--json'])).out))
  golden('refunds.stage.done', {
    dirty: stage(d),
    commitPlan: stage(d, { unpushed: true, commit: { files: ['understanding/feat-refunds.json', '.gitattributes'], todos: ['api/refunds.js'], include: new Set(), fixes: ['worker/alerts.js'], applied: ['q4'], fold: true } }),
  })

  // Each question's thread: the question, the grades as the thread shows them, their links, the concern.
  const c = U.readCheck(file)
  golden('refunds.threads', c.questions.map((q) => {
    const shown = TT.gradedAttempts(q)
    const roles = ['agent', ...shown.flatMap(() => ['human', 'agent'])]
    return {
      id: q.id, body: TT.questionBody(q), also: TT.alsoLinks(q),
      grades: shown.map((a, k) => ({ body: TT.gradeBody(a), restatement: TT.gradeBody(a, { restatement: true }), links: TT.linksAt(q, roles, 2 * k + 2), message: TT.gradeMessageAt(roles, k + 1) })),
      questionLinks: TT.linksAt(q, roles, 0),
      concern: CS.concernOf(q) ?? null,
      answerBox: VM.answerBox(q, 1, U.stateOf(q), { draft: 'draft', others: true }),
    }
  }))

  // Committed: what CI says on the merge request (no model call, no comment posted).
  commitAll(d, 'check')
  say('status.committed.text', await run(d, ['status']))
  golden('refunds.stage.committed', stage(d, { unpushed: false, mr: 'https://example.com/mr/1', pushed: 'Pushed.' }))
  const res = await ci(d, gitlabEnv(d, undefined, { CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: 'feat/refunds' }))
  say('ci.pass', res)
  say('ci.advisory-other-branch', await ci(d, gitlabEnv(d, undefined, { CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: 'feat/other', UNDERSTANDING_MODE: 'advisory' })))
  golden('refunds.commands', out)
})

/** The written check file with one thing broken: what `validate` says. */
test('golden: broken check files: what validate says', async () => {
  const d = smallChange()
  repos.small = d
  const f = writeQuestions(d)
  answerAll(f, [{ text: 'a', verdict: 'pass' }, { text: 'b', verdict: 'retry' }])
  const good = JSON.parse(fs.readFileSync(f, 'utf8'))
  const broken = {
    'as written': (c) => c,
    'version 2': (c) => { c.version = 2 },
    'no questions': (c) => { c.questions = [] },
    'a question id used twice': (c) => { c.questions[1].id = 'q1' },
    'an unknown kind': (c) => { c.questions[0].kind = 'trivia' },
    'lines backwards': (c) => { c.questions[0].start = 9; c.questions[0].end = 3 },
    'no text': (c) => { delete c.questions[2].text },
    'a verdict changed after grading': (c) => { c.questions[0].attempts[0].verdict = 'explained' },
    'an answer changed after grading': (c) => { c.questions[0].attempts[0].answer = 'changed' },
    'an unknown verdict': (c) => { c.questions[1].attempts[0].verdict = 'maybe' },
    'a missing file': (c) => { c.questions[0].file = 'src/gone.js' },
    'eleven questions': (c) => { c.questions = Array.from({ length: 11 }, (_, i) => ({ ...c.questions[2], id: `q${i + 1}` })) },
    'no branch or head': (c) => { delete c.branch; delete c.head },
  }
  const out = []
  for (const [name, change] of Object.entries(broken)) {
    const c = structuredClone(good)
    change(c)
    const p = path.join(d, `understanding/broken.json`)
    fs.writeFileSync(p, `${JSON.stringify(c, null, 2)}\n`)
    out.push({ name, validate: await run(d, ['validate', 'understanding/broken.json']), errors: U.validateCheck(c, { repo: d }), hashes: U.hashProblems(c) })
  }
  fs.writeFileSync(path.join(d, 'understanding/broken.json'), '{ "version": 1, ')
  out.push({ name: 'not json', validate: await run(d, ['validate', 'understanding/broken.json']) })
  out.push({ name: 'no file', validate: await run(d, ['validate', 'understanding/none.json']) })
  golden('validate.broken', out)
})

test('golden: where a check stands: drift, conflicts, a stash, the default branch', async () => {
  const d = smallChange()
  repos.drift = d
  const f = writeQuestions(d)
  answerAll(f, [{ text: 'a', verdict: 'pass' }, { text: 'b', verdict: 'pass' }, { text: 'c', verdict: 'explained' }])
  commitAll(d, 'answers')
  const out = { passed: stage(d) }
  // 60 more lines on the branch, committed: over the drift limit (a top-up).
  fs.appendFileSync(path.join(d, 'src/app.js'), Array.from({ length: 60 }, (_, i) => `export const late${i} = ${i}`).join('\n') + '\n')
  out.uncommittedDrift = stage(d)
  commitAll(d, 'more')
  out.drift = stage(d)
  // A conflict in the check file.
  const text = fs.readFileSync(f, 'utf8')
  fs.writeFileSync(f, `<<<<<<< HEAD\n${text}=======\n${text.replace('"a"', '"b"')}>>>>>>> other\n`)
  out.conflict = stage(d)
  out.conflictText = await run(d, ['status'])
  fs.writeFileSync(f, '{ "version": 1,\n  "branch": }\n')
  out.invalid = stage(d, { invalidAt: 'Line 2: unexpected token.' })
  fs.writeFileSync(f, text)
  gitIn(d, 'checkout', '-q', 'main')
  out.onMain = stage(d)
  out.onMainText = await run(d, ['status'])
  golden('states', out)
})

test('golden: the CLI\'s pure helpers', () => {
  const words = U.KINDS.map((k) => [k, VM.KIND_LABEL[k]])
  golden('helpers', {
    files: ['feat/x', 'Feat/Ünïcode branch', 'a//b', 'release/1.2', 'HEAD'].map((b) => [b, U.fileFor(b), U.cachedFor(b), U.slugOf(b)]),
    sizes: [0, 1, 20, 40, 79, 80, 150, 400, 2000].map((n) => [n, U.questionsFor(n, U.DEFAULTS), U.minutesFor(n), U.sizeText(n)]),
    args: [['status', '--json'], ['grade', 'f.json', '--question', 'q2', '--answer', 'x y', '--write'], ['ci', '--base=abc', '--no-comment'], ['add', '--text', '--kind']].map((a) => [a, U.parseArgs(a)]),
    words,
    stateWords: [
      { phase: 'nothing' }, { phase: 'none', changed: 120 }, { phase: 'answering', done: 1, total: 3, passed: 1, needed: 2 },
      { phase: 'short', done: 3, total: 3, passed: 1, needed: 2 }, { phase: 'done', done: 3, total: 3, passed: 3, needed: 2 },
      { phase: 'drift', grew: 60, maxDrift: 40, total: 3, needed: 2, passed: 3, done: 3 }, { phase: 'drift', grew: 60, maxDrift: 40, commitFirst: true },
      { phase: 'invalid', why: 'not JSON' }, { phase: 'invalid', conflict: { line: 3, mergeable: true } }, { phase: 'stashed', stash: 'stash@{0}' }, { phase: 'unknown' },
    ].map((s) => [s, U.stateWords(s, { branch: 'feat/x', file: 'understanding/feat-x.json' })]),
    verdicts: ['{"verdict":"pass","feedback":"ok"}', 'not json', '```\n{"verdict":"retry"}\n```', '{"verdict":"explained","feedback":"x","hint":"y","topic":"t","concern":"c"}', 'Sure! {"verdict":"pass"} hope that helps'].map((r) => { try { return [r, U.parseVerdict(r)] } catch (e) { return [r, `throws: ${e.message}`] } }),
    settled: [CS.settledConcern(undefined, 'May be a bug.', { reason: 'by design' }, { name: 'Ada' }, 't1'), CS.settledConcern({ text: 'x', flagged: true }, 'y', { fixed: true }, undefined, 't2')],
  })
})
