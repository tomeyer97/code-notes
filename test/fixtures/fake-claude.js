#!/usr/bin/env node
// A stand-in for the `claude` CLI in integration tests: records its arguments, then plays the scenario its prompt asks
// for (below) and streams a canned answer. The stream format: streamJson.js.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const stream = require('./streamJson')

const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG || path.join(os.tmpdir(), 'fake-claude.log'), JSON.stringify(args) + '\n')
const prompt = args[args.indexOf('-p') + 1] || ''
const resumed = args.includes('--resume')
/** The staging folder the prompt names (`--dir <folder>`), relative to the repository. */
const dirArg = /--dir (\S+?)`/.exec(prompt)?.[1]
/** "Use the code-journey skill to answer: <question>". */
const question = /code-journey skill to answer: (.*)/.exec(prompt)?.[1]

/** A question with "unclear" in it: no journey, a clarifying question instead (its answer resumes the session). */
const clarify = question !== undefined && /unclear/.test(question) && !resumed
/** A question with "already" in it: no new journey; the answer names the one that exists. */
const exists = question !== undefined && /already/.test(question) && !resumed

/** Scenario "journey": a journey file written into the staging folder, as journey.py would (also after a clarify). */
function writeJourney() {
  const dir = dirArg ? path.join(process.cwd(), dirArg) : path.join(process.cwd(), '.code-notes', 'journeys')
  fs.mkdirSync(dir, { recursive: true })
  const j = {
    version: 2, id: 'written', question: question ? question.trim() : 'How is a note saved?',
    title: 'Written by the agent', summary: '', model: 'fake-model', createdAt: new Date().toISOString(),
    nodes: [
      { id: 'app', kind: 'system', label: 'App', summary: '' },
      { id: 'f', kind: 'function', label: 'main', parent: 'app', summary: '' },
    ],
    edges: [],
    steps: [{ id: 'm', title: 'main reads the token', node: 'f', file: 'src/renamed.ts', range: { start: 1, end: 1 }, lead: 'Here.', refs: [] }],
  }
  fs.writeFileSync(path.join(dir, '.written.json.tmp'), JSON.stringify(j, null, 2))
  fs.renameSync(path.join(dir, '.written.json.tmp'), path.join(dir, 'written.json'))
}

/**
 * Scenario "refresh" ("The journey "<slug>" is out of date: …"): its steps re-pointed in the staged copy, as
 * `restep … range` does (here: every step's range kept, its anchor taken from the code there now).
 */
function refreshJourney(slug) {
  const j = JSON.parse(fs.readFileSync(path.join(process.cwd(), dirArg, `${slug}.json`), 'utf8'))
  const py = /by their full path \((\S+)\/scripts\//.exec(prompt)[1] + '/scripts/journey.py'
  j.steps.forEach((st, i) => {
    const restep = [py, '--dir', dirArg, 'restep', process.cwd(), slug, String(i + 1), 'range', st.file, String(st.range.start), String(st.range.end)]
    execFileSync('python3', restep, { cwd: process.cwd(), stdio: 'ignore' })
  })
}

/** The answer, word by word. */
const ANSWERS = {
  exists: 'The journey you need is already in `journeys/saving.json`.',
  clarify: 'Which part do you mean: **saving** or loading?',
  answer: 'The token is read once in `src/renamed.ts:3`.',
}
const words = (text) => text.split(/(?<= )/)

if ((question !== undefined || (resumed && dirArg)) && !clarify && !exists) writeJourney()
const refresh = /The journey "([\w.-]+)" is out of date/.exec(prompt)
if (refresh && dirArg) refreshJourney(refresh[1])

stream.init()
stream.toolUse('Read', { file_path: '/repo/src/renamed.ts' })
const answer = words(exists ? ANSWERS.exists : clarify ? ANSWERS.clarify : ANSWERS.answer)
// "slow" in the prompt: a run long enough to cancel.
const delay = /slow/.test(prompt) ? 30000 : 150
let i = 0
const tick = setInterval(() => {
  if (i < answer.length) { stream.textDelta(answer[i++]); return }
  clearInterval(tick)
  stream.result(answer.join(''), { session: clarify ? 'sess-clarify' : 'sess-123', cost: 0.01 })
}, delay)
