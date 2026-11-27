// "Ask the agent to write a journey" when nothing matches: the fake claude CLI (test/fixtures/fake-claude.js) plays
// the code-journey skill's journey.py; the journey is staged, checked, moved into journeys/, and its map opens.
// Claude's question before writing is a notification; a refresh says what its check still finds on the refreshed
// step; a link no journey answers says so; a script's bad request is not shown to the person.
// Source: src/write/ (claudeRun.ts, writeJourney.ts, staging.ts, clarify.ts, refreshJourney.ts, journeyAnswer.ts);
// what Claude may run is unit-tested in test/writing.test.ts (runOptions.ts through claude.ts's claudeArgs), so here
// it is enough that the CLI was called.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { EXT_ID, fakeCalls, flag, quiet, readJson, readJsonOr, test } from '../helpers'
import { journey, readResult, step, writeJourney, writeLines, writeRequest, writeSkillStandIn } from '../fixtures'
import { STAGING } from '../../../src/write/staging'
import { told } from '../../../src/write/told'
import { NO_JOURNEYS } from '../../../src/write/refreshJourney'
import { notAnsweredLine } from '../../../src/write/journeyAnswer'
import { asksLine } from '../../../src/write/clarify'
import { ctx, journeyById, journeysDir, setting, snap, until, wsPath } from './context'
import { repoJourneysDir } from './shared'

/** The journey file `name` in a staging folder of the notes folder (`.writing/<id>/<name>`), once there is one. */
function stagedFile(notesDir: string, name: string): string | undefined {
  const root = path.join(notesDir, STAGING)
  if (!fs.existsSync(root)) return undefined
  return fs.readdirSync(root).map((id) => path.join(root, id, name)).find((f) => fs.existsSync(f))
}

/** No staging root left, or an empty one (the run's own folder is gone either way). */
const noStaging = (notesDir: string) => {
  const root = path.join(notesDir, STAGING)
  return !fs.existsSync(root) || !fs.readdirSync(root).length
}

/** What writing journeys says from now on: take it before, read it after. */
function newTold(): () => string[] {
  const n = told.length
  return () => told.slice(n)
}

/** The journey folders moved aside (and the list read again) until `restore`. */
async function journeysAside(): Promise<{ restore: () => Promise<void> }> {
  const dirs = [journeysDir(), repoJourneysDir()].filter((d) => fs.existsSync(d))
  dirs.forEach((d) => fs.renameSync(d, `${d}.aside`))
  await ctx.api.reloadJourneys()
  await until('no journeys', () => !snap().journeys.length)
  return {
    restore: async () => {
      dirs.forEach((d) => fs.renameSync(`${d}.aside`, d))
      await ctx.api.reloadJourneys()
    },
  }
}

/** The person's error messages while `fn` runs (the window's own, watched). */
async function errorsShownDuring(fn: () => Promise<void>): Promise<string[]> {
  const win = vscode.window as { showErrorMessage: (...a: any[]) => Thenable<unknown> }
  const shown = win.showErrorMessage
  const errors: string[] = []
  win.showErrorMessage = (text: string, ...rest: any[]) => { errors.push(text); return shown.call(vscode.window, text, ...rest) }
  try { await fn() } finally { win.showErrorMessage = shown }
  return errors
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export const writeJourneyTests = [
  // Before the repository's stand-in skill is written (below): a refresh runs the extension's own journey.py.
  test('Refresh Journey with no journeys says there are none, not that every journey matches', async () => {
    await vscode.commands.executeCommand('codeNotes.endJourney')
    const aside = await journeysAside()
    try {
      const said = newTold()
      await vscode.commands.executeCommand('codeNotes.refreshJourney')
      assert.deepEqual(said(), [NO_JOURNEYS])
    } finally { await aside.restore() }
  }),

  test('a refresh whose rewritten step still points at code that is gone says so; no staging folder is left', async () => {
    const file = wsPath('src', 'rf.ts')
    const was = '  return gateway.charge(order.total, order.currency)'
    writeLines(file, ['// rf', 'export function charge(order) {', was, '}'])
    // Its link reads line 3 as it was: the refresh re-anchors the step (fake-claude's restep) but leaves the link.
    const link = { phrase: 'charges', file: 'src/rf.ts', start: 3, end: 3, text: was }
    const p = writeJourney(journeysDir(), journey('rf', [step('src/rf.ts', 2, 3, {
      id: 'r1', title: 'Charged', node: 'c', lead: 'It charges the card.', links: [link],
      anchor: { text: ['export function charge(order) {', was].join('\n'), before: '// rf', after: '}' },
    })], { title: 'Rf', nodes: [{ id: 'c', kind: 'function', label: 'charge' }] }))
    const rf = () => journeyById('rf')?.at[0]
    await until('rf loaded, fresh', () => !!rf() && !rf().stale)
    writeLines(file, ['// rf', 'export function charge(order) {', '  return gateway.pay(order.total, "EUR")', '}'])
    await until('rf stale', () => rf()?.stale, 8000)
    const said = newTold()
    await vscode.commands.executeCommand('codeNotes.refreshJourney', vscode.Uri.file(p).toString())
    await until('the refreshed copy replaced the journey', () => readJsonOr(p)?.steps[0].anchor?.v === 3, 20000)
    await until('said', () => said().length)
    assert.deepEqual(said(), ['Refreshed “Rf” · step 1 still fails its check'], 'said, not shown as fresh')
    assert.ok(!fs.existsSync(path.join(ctx.notesDir, STAGING)), 'no empty staging folder left')
    fs.unlinkSync(p)
    await until('rf gone', () => !journeyById('rf'))
  }),

  test('"Ask the agent to write a journey": claude with the code-journey skill writes it, its map opens', async () => {
    // The repository's own copy of the skill is used (a teammate has none in their home folder).
    const repoSkill = writeSkillStandIn(ctx.ws)
    const callsBefore = fakeCalls().length
    const writing = ctx.api.writeJourney('How is a note saved?')
    // Written into a staging folder; not listed (nor "new") until it is checked and moved; one "Writing:" row meanwhile.
    await until('staged file written', () => stagedFile(ctx.notesDir, 'written.json'), 8000)
    assert.ok(!snap().journeys.some((x: any) => x.id === 'written'), 'a journey being written is not listed')
    assert.ok(!fs.existsSync(wsPath('journeys', 'written.json')), 'not in the journeys folder yet')
    assert.match(ctx.api.writing()[0]?.label ?? '', /^Writing: How is a note saved\? · \d:\d\d$/, 'one "Writing: <question> · m:ss" row')
    const wrote = await writing
    assert.equal(wrote, 'written', 'the new journey opened')
    assert.equal(ctx.api.writing().length, 0, 'no row once written')
    const writtenFile = wsPath('journeys', 'written.json')
    assert.equal(readJson(writtenFile).model, 'Claude Code default', 'the model is stamped')
    assert.ok(!fs.existsSync(path.join(ctx.notesDir, STAGING)), 'the staging folder is cleaned up, its root too')
    await until('its map is open', () => snap().tour.map === 'written')
    const cli = fakeCalls()[callsBefore]
    assert.ok(cli, 'the claude CLI was called')
    const prompt = flag(cli, '-p')!
    assert.match(prompt, /^Use the code-journey skill to answer: How is a note saved\?/)
    assert.ok(cli.includes(`Bash(${repoSkill}/scripts/*)`), 'the repo\'s skill scripts are the ones allowed')
    assert.ok(prompt.includes(`${repoSkill}/scripts/`), 'the prompt points at the repo\'s skill')
    assert.match(prompt, /a request, not the journey's question/, 'the person\'s words are a request')
    fs.unlinkSync(writtenFile)
    await until('written gone', () => !snap().journeys.some((x: any) => x.id === 'written'))
  }),

  test('Claude\'s question is a notification with Answer; the job goes on under the question as you answered it', async () => {
    const said = newTold()
    assert.equal(await ctx.api.writeJourney('Something unclear about things'), undefined, 'no journey yet')
    const asked = await until('Claude\'s question', () => ctx.api.clarify())
    assert.deepEqual(said(), [asksLine('Something unclear about things', asked.text)])
    assert.match(said()[0], /^Claude asks about “Something unclear about things”: Which part do you mean: saving or loading\?$/)
    const resumed = ctx.api.answerClarify('The saving part')
    await until('listed under the answered question', () => /^Writing: Something unclear about things: The saving part · \d:\d\d$/.test(ctx.api.writing()[0]?.label ?? ''))
    assert.equal(await resumed, 'written')
    fs.unlinkSync(wsPath('journeys', 'written.json'))
    await until('written gone', () => !snap().journeys.some((x: any) => x.id === 'written'))
  }),

  test('a link no journey answers: the Journeys list and one line naming the question; it starts nothing', async () => {
    const q = 'How are sprockets teleported?'
    const said = newTold()
    const runs = fakeCalls().length
    await vscode.env.openExternal(vscode.Uri.parse(`${vscode.env.uriScheme}://${EXT_ID}/explain?action=ask&q=${encodeURIComponent(q)}&repo=${encodeURIComponent(ctx.ws)}`))
    await until('the line', () => said().includes(notAnsweredLine(q)), 8000)
    assert.equal(notAnsweredLine(q), 'No journey answers “How are sprockets teleported?”')
    await until('the Journeys list', () => snap().tour.mapTitle === 'Journeys')
    await quiet(500, 'a Claude run after the link')
    assert.equal(fakeCalls().length, runs, 'no Claude run')
  }),

  test('a request file\'s unknown model goes to its result and the log, not to the person', async () => {
    const errors = await errorsShownDuring(async () => {
      writeRequest(ctx.notesDir, { action: 'ask', question: 'How are doohickeys frobnicated?', model: 'gpt-9', id: 'req-gpt9' })
      await until('result: error', () => readResult(ctx.notesDir)?.id === 'req-gpt9' && readResult(ctx.notesDir).outcome === 'error', 8000)
      assert.match(readResult(ctx.notesDir).message, /Unknown model 'gpt-9'/)
      // The person's own run with that model is still told (the watch works).
      await setting('journeys.model', 'gpt-9')
      try { assert.equal(await ctx.api.writeJourney('How are doohickeys frobnicated?'), undefined) } finally { await setting('journeys.model', undefined) }
    })
    assert.equal(errors.length, 1, `only the person's own run: ${JSON.stringify(errors)}`)
    assert.match(errors[0], /Unknown model 'gpt-9'/)
    assert.ok(noStaging(ctx.notesDir))
  }),
]
