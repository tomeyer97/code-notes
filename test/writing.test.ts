// Writing a journey with Claude, the parts without VS Code: the clock (core/clock.ts), the plain phase read from
// journey.py's command lines (write/journeyPhases.ts), what Claude may run (write/runOptions.ts through claudeArgs),
// the line of its reply that names a journey that already answers (write/prompts.ts), and the message when the
// skill is nowhere (platform/skillDir.ts); a question too vague to write for, the job's name once Claude's question is
// answered and the check's problems on refreshed steps (write/questions.ts); no empty staging root (write/staging.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { clarified, problemsIn, stepProblems, stepsOf, vagueQuestion } from '../src/write/questions'
import { STAGING, stagingFolder } from '../src/write/staging'
import { elapsed as clock, minutes } from '../src/core/clock'
import { NO_PHASE, PHASES, phaseOf } from '../src/write/journeyPhases'
import { answeredBy } from '../src/write/prompts'
import { journeyRunOptions } from '../src/write/runOptions'
import { claudeArgs } from '../src/platform/agent/claude'
import { missingSkill } from '../src/platform/skillDir'
import { bashCall } from './toolCalls'

test('elapsed time and a plain phase from journey.py commands', () => {
  assert.equal(clock(80_500), '1:20')
  assert.equal(clock(5_000), '0:05')
  assert.equal(minutes(130_000), '2 min')
  assert.equal(minutes(20_000), 'under a minute')
  assert.equal(phaseOf({ name: 'Read', input: { file_path: 'a.ts' } }, 'starting'), 'reading the code')
  assert.equal(phaseOf(bashCall('/s/scripts/journey.py --dir .code-notes/.writing/x new . slug "Q?" "T"'), 'reading the code'), 'drawing the map')
  assert.equal(phaseOf(bashCall('/s/scripts/journey.py node . slug a function "x"'), 'reading the code'), 'drawing the map')
  assert.equal(phaseOf(bashCall('/s/scripts/journey.py --dir=x step . slug a src/a.ts 1 2 "t"'), 'drawing the map'), 'writing the steps')
  assert.equal(phaseOf(bashCall('/s/scripts/journey.py --dir x link . slug 2 "stores it" src/a.ts 4'), 'writing the steps'), 'adding links and animations')
  assert.equal(phaseOf(bashCall('/s/scripts/journey.py --dir x scene . slug 2'), 'adding links and animations'), 'adding links and animations')
  assert.equal(phaseOf(bashCall('/s/scripts/journey.py --dir x check . slug quiet'), 'writing the steps'), 'checking')
  assert.equal(phaseOf({ name: 'Read', input: {} }, 'writing the steps'), 'writing the steps', 'reading more while writing steps stays there')
  assert.equal(phaseOf(bashCall('ls'), 'checking'), 'checking')
  assert.equal(phaseOf(undefined, 'starting'), 'starting')
})

test('every journey.py subcommand starts a phase or is listed as starting none', () => {
  // The subcommands as journey.py declares them (one `@command('new', …)` per command).
  const py = fs.readFileSync(path.join(__dirname, '../../skills/code-journey/scripts/journey.py'), 'utf8')
  const subs = [...py.matchAll(/^@command\('([a-z-]+)'/gm)].map((m) => m[1])
  assert.ok(subs.length > 20, `journey.py's commands are found (${subs.length})`)
  const placed = new Set([...Object.values(PHASES).flat(), ...NO_PHASE])
  assert.deepEqual(subs.filter((s) => !placed.has(s)), [], 'a new subcommand gets a phase in write/journeyPhases.ts')
  assert.deepEqual([...placed].filter((s) => !subs.includes(s)), [], 'no phase for a subcommand journey.py does not have')
})

test('Claude may read, run the skill\'s own scripts and nothing else', () => {
  const spec = { repo: '/r', prompt: 'p', skill: '/r/.claude/skills/code-journey', bundled: false, modelLabel: 'Claude Code default' }
  const options = journeyRunOptions(spec)
  // Beyond claude.ts's read-only tools (READ_ONLY_TOOLS, and Edit/Write blocked: test/claude.test.ts), only these.
  assert.deepEqual(options.extraTools, ['Skill', 'Bash(/r/.claude/skills/code-journey/scripts/*)'])
  assert.deepEqual(options.addDirs, [], 'an installed skill needs no folder of its own')
  assert.deepEqual(options.env, { JOURNEY_MODEL: 'Claude Code default' }, 'journey.py stamps the model')
  const args = claudeArgs(options)
  assert.ok(['Read', 'Grep', 'Glob'].every((t) => args.includes(t)), 'the code can be read')
  assert.ok(['Edit', 'Write'].every((t) => args.includes(t)) && !args.includes('Bash'), 'edits blocked; Bash only for the skill')
  const bundled = journeyRunOptions({ ...spec, skill: '/ext/skills/code-journey', bundled: true, cache: '/c', resume: 's1', model: 'opus' })
  assert.deepEqual(bundled.addDirs, ['/c', '/ext/skills/code-journey'], 'the cache and the bundled skill are readable')
  assert.deepEqual([bundled.resume, bundled.model], ['s1', 'opus'])
})

test('the journey that already answers: the ANSWERED_BY line of the reply', () => {
  assert.equal(answeredBy('It is covered.\nANSWERED_BY: journeys/saving.json'), 'journeys/saving.json')
  assert.equal(answeredBy('It is covered.\n`ANSWERED_BY: ./docs/journeys/saving.json`\n'), 'docs/journeys/saving.json')
  assert.equal(answeredBy('The journey you need is already in `journeys/saving.json`.'), undefined, 'prose is not the line')
  assert.equal(answeredBy('ANSWERED_BY:'), undefined)
})

test('missingSkill: names the places the lookup tried, in its order', () => {
  assert.equal(missingSkill('code-journey', { repo: '/r', bundled: '/ext/skills' }),
    "the code-journey skill isn't in this repository (.claude/skills/code-journey), in ~/.claude/skills or in the extension")
  assert.equal(missingSkill('s', { bundled: '/ext/skills' }), "the s skill isn't in ~/.claude/skills or in the extension")
})

test('a question under three words is asked again, with an example; a real one passes', () => {
  const again = 'Ask how something works, e.g. How does a note get saved?'
  assert.equal(vagueQuestion('stuff'), again)
  assert.equal(vagueQuestion('  saving notes '), again)
  assert.equal(vagueQuestion('How does saving work?'), undefined)
  assert.equal(vagueQuestion('loadNote parses what?'), undefined)
  assert.equal(vagueQuestion(''), undefined, 'an empty box is Esc, not a mistake')
})

test('the job answered: listed by the question with your answer', () => {
  assert.equal(clarified('stuff', '  The saving\npart '), 'stuff: The saving part')
})

test('a refresh: new problems masked by number; code gone under the refreshed steps found even when it was before', () => {
  const out = [
    'PROBLEM: box validate: its code changed',
    'PROBLEM: step 2 scene: beat 2 ("x"): api/validate.js:22 no longer reads "const product = CATALOG[item.sku]"',
    'PROBLEM: step 2: link "total": api/validate.js:27 no longer reads "total += product.price"',
    'PROBLEM: step 12: link "a": a.js:1 no longer reads "a"',
    'PROBLEM: step 2: title "Saved" is a name, not a fact: say what happens',
    'WARNING: step 2: no code links',
    'ok: 3 steps, 4 problems',
  ].join('\n')
  assert.ok(problemsIn(out).has('PROBLEM: step # scene: beat # ("x"): api/validate.js:# no longer reads "const product = CATALOG[item.sku]"'))
  assert.equal(problemsIn(out).size, 5)
  const failing = stepProblems(out, [2])
  assert.equal(failing.length, 2, 'step 2\'s code gone only (not step 12, the box, its title\'s wording or a warning)')
  assert.deepEqual(stepsOf(failing), [2])
  assert.deepEqual(stepsOf(stepProblems(out, [12, 2])), [2, 12])
  assert.deepEqual(stepProblems(out, [1]), [])
})

test('a staging folder\'s cleanup leaves no empty staging root; another run\'s folder keeps it', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-'))
  const root = path.join(repo, '.code-notes', STAGING)
  const a = stagingFolder(repo, '.code-notes')
  const b = stagingFolder(repo, '.code-notes')
  a.cleanup()
  assert.deepEqual(fs.readdirSync(root), [b.id])
  b.cleanup()
  assert.ok(!fs.existsSync(root), 'no empty .writing left')
  assert.ok(fs.existsSync(path.join(repo, '.code-notes')), 'the notes folder stays')
  fs.rmSync(repo, { recursive: true })
})
