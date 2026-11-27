// A journey's files changing under it: the journey file deleted mid-walk, a step's file renamed (on disk, with git mv),
// changed on disk with no editor open, refreshed by the journey writer; and a long file: the map follows the step,
// cards stay in view after jumps, arriving at a step reads no note, leaving for another journey says so, a step whose
// file is gone opens no stand-in tab. Source: src/journeys/, src/platform/gitRenames.ts, src/core/anchors/anchor.ts, src/core/anchors/compact.ts.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { execFileSync } from 'child_process'
import { settle, test, Test, untilEqual } from '../helpers'
import { agentNote, journey, step, writeJourney, writeLines, writeNote } from '../fixtures'
import { at, closeAllEditors, ctx, journeyById, journeysDir, lenses, noteById, snap, tour, until, wsPath } from './context'
import { demoPath, writeDemo } from './shared'

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Where step 1 of journey `id` is now ({ file, start, end, stale, removed }). */
const firstStepOf = (id: string) => journeyById(id)?.at[0]

/** git in the workspace, as a test user (its own name and address: no git config needed). */
const git = (...args: string[]) => execFileSync('git', ['-C', ctx.ws, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'pipe' })

/** An unread agent note on the long journey's second step. */
const ON_STEP = '20261111-200300-onstep'

/** The long file: its length, and its three steps low in it (first lines, 1-based), each STEP_LINES long. */
const LONG_FILE_LINES = 220
const STEPS = { l1: 20, l2: 150, l3: 190 }
const STEP_LINES = 3
/** The reference on step 1 into its own file (1-based lines). */
const REF = { start: 100, end: 104 }
/** 0-based editor lines: the card's (two above its step's first line) and the step's last one. */
const cardLine = (step: number) => step - 1 - 2
const lastLine = (step: number) => step - 1 + STEP_LINES - 1

/** Files the tests of this file leave for later tests of it (the long journey, its note): removed by cleanUp. */
const made = new Set<string>()
const keep = (file: string) => { made.add(file); return file }

/** The journeys and the note the tests made are removed, the walk ended. */
async function cleanUp(): Promise<void> {
  if (tour().touring) await vscode.commands.executeCommand('codeNotes.endJourney')
  for (const f of made) fs.rmSync(f, { force: true })
  made.clear()
  await until('cleaned', () => !snap().journeys.some((x: any) => x.id === 'long' || x.id === 'gonefile') && !noteById(ON_STEP))
}

/**
 * `tests`, then `after` as a last step; `after` also runs when one of them fails (the run stops there), so nothing
 * they made is left for the files that run later.
 */
function withAfter(tests: Test[], after: () => Promise<void>): Test[] {
  const always = (t: Test): Test => ({
    ...t,
    fn: async () => {
      try {
        return await t.fn()
      } catch (e) {
        await after().catch((c) => console.log(`  (cleaning up after the failure failed too: ${c})`))
        throw e
      }
    },
  })
  return [...tests.map(always), test('what the journey files tests made is removed', after)]
}

export const journeyFilesTests = withAfter([
  test('a journey deleted mid-tour ends the tour', async () => {
    await vscode.commands.executeCommand('codeNotes.startJourney', 'demo')
    await until('touring', () => tour().touring)
    fs.unlinkSync(demoPath())
    await untilEqual('tour ended', () => ({ touring: !!tour().touring, journey: tour().journey, card: !!tour().card, journeys: snap().journeys.length }), { touring: false, journey: undefined, card: false, journeys: 0 })
    // It comes back when the file does.
    writeDemo()
    await until('back', () => snap().journeys.length === 1)
  }),

  test('a step follows its file through a rename; deleted code makes it stale, never moved to other code', async () => {
    writeLines(wsPath('src', 'mv.ts'), ['// mv', 'export function moved() {', '  return "this line is long enough to recognise"', '}'])
    const mvPath = writeJourney(journeysDir(), journey('mv', [step('src/mv.ts', 2, 3, { id: 'only', title: 'The function', refs: ['src/mv.ts:4'] })],
      { question: 'Where did it go?', title: 'Moves', nodes: [{ id: 'f', kind: 'function', label: 'moved' }] }))
    await until('mv loaded', () => snap().journeys.some((x: any) => x.id === 'mv'))
    await vscode.commands.executeCommand('codeNotes.startJourney', 'mv')
    await until('at the step', () => tour().journey === 'mv' && at() === 'src/mv.ts:2')
    await closeAllEditors()
    fs.renameSync(wsPath('src', 'mv.ts'), wsPath('src', 'mv2.ts'))
    await until('followed the rename', () => firstStepOf('mv').file === 'src/mv2.ts', 8000)
    await ctx.api.reloadJourneys() // a window reload: the step still knows where its file went
    await until('rename kept across a reload', () => firstStepOf('mv')?.file === 'src/mv2.ts' && !firstStepOf('mv').stale)
    await vscode.commands.executeCommand('codeNotes.startJourney', 'mv')
    await until('opens the new file', () => at() === 'src/mv2.ts:2')
    await vscode.commands.executeCommand('codeNotes.stepDetails', true) // the references are inside More
    await until('the ref says where the file went', () => /mv2\.ts:4 \(moved\)/.test(tour().card?.body ?? ''))
    await vscode.commands.executeCommand('codeNotes.stepDetails', false)
    const editor = vscode.window.activeTextEditor!
    await editor.edit((b) => b.delete(new vscode.Range(1, 0, 4, 0)))
    await editor.document.save()
    // Its code deleted: "removed", the card at the top of the file, never on the code now there.
    // Its card goes to the map; nothing in the editor pretends to be the step (no card on line 1).
    await until('stale', () => firstStepOf('mv').stale && !tour().card && /can't find these lines/.test(tour().panelCard?.staleText ?? ''), 8000)
    assert.equal(tour().panelCard!.staleText, "**⚠ Code changed: can't find these lines** · [Ask](ask:update)", 'one line, one Ask, never "gone"')
    await vscode.commands.executeCommand('codeNotes.endJourney')
    fs.unlinkSync(mvPath)
    await until('mv gone', () => !snap().journeys.some((x: any) => x.id === 'mv'))
  }),

  test('a file renamed with git mv: the step follows it from git, in a journey read afterwards', async () => {
    // The `git mv` is made before the journey is read: git says where the file went.
    writeLines(wsPath('src', 'receipt.ts'), ['// receipt', 'export function render() {', '  return "the receipt is rendered here, long enough"', '}'])
    // The workspace is a git repository for this test only: removed whatever happens, so no later test runs in one.
    git('init', '-q')
    let gitMvPath = ''
    try {
      git('add', 'src/receipt.ts'); git('commit', '-qm', 'receipt')
      git('mv', 'src/receipt.ts', 'src/receiptTemplate.ts')
      gitMvPath = writeJourney(journeysDir(), journey('gitmv', [step('src/receipt.ts', 2, 3, { id: 'r1', title: 'Rendered', node: 'r', anchor: { text: 'export function render() {\n  return "the receipt is rendered here, long enough"', before: '// receipt', after: '}' } })],
        { question: 'Where is the receipt rendered?', title: 'Git mv', nodes: [{ id: 'r', kind: 'function', label: 'render' }] }))
      await until('the step follows the git rename', () => { const x = journeyById('gitmv'); return x && x.at[0].file === 'src/receiptTemplate.ts' && !x.at[0].stale }, 8000)
    } finally {
      if (gitMvPath) fs.rmSync(gitMvPath, { force: true })
      fs.rmSync(wsPath('.git'), { recursive: true, force: true })
    }
    await until('gitmv gone', () => !snap().journeys.some((x: any) => x.id === 'gitmv'))
  }),

  test('a step file changed on disk (no editor open): moved stays fresh, an edit is stale, the old code back is fresh; Refresh updates the stale step through the journey writer, no note', async () => {
    // As a checkout or a pull does.
    await closeAllEditors()
    const diskTs = wsPath('src', 'disk.ts')
    const lines = ['// disk', 'export function charge(order) {', '  return gateway.charge(order.total, order.currency)', '}']
    const edited = ['// disk', 'export function charge(order) {', '  return gateway.charge(order.total, "EUR")', '}']
    writeLines(diskTs, lines)
    const diskPath = writeJourney(journeysDir(), journey('disk', [step('src/disk.ts', 2, 3, { id: 'd1', title: 'Charged', node: 'c', anchor: { text: lines.slice(1, 3).join('\n'), before: '// disk', after: '}' } })],
      { question: 'How is an order charged?', title: 'Disk', nodes: [{ id: 'c', kind: 'function', label: 'charge' }] }))
    const diskStep = () => firstStepOf('disk')
    await until('disk loaded, fresh', () => !!diskStep() && !diskStep().stale)
    writeLines(diskTs, ['// disk', '', '// moved down by a comment', ...lines.slice(1)])
    await untilEqual('moved on disk: fresh at its new lines', () => [diskStep().start, !!diskStep().stale], [4, false], 8000)
    writeLines(diskTs, edited)
    await until('edited on disk: stale', () => diskStep().stale, 8000)
    writeLines(diskTs, lines)
    await untilEqual('the old code back on disk: fresh again', () => [diskStep().start, !!diskStep().stale], [2, false], 8000)
    // Refresh: the journey writer updates the stale step in a staged copy, which replaces the file once checked; no note.
    writeLines(diskTs, edited)
    await until('stale again', () => diskStep().stale, 8000)
    const notesBeforeRefresh = snap().notes.length
    await vscode.commands.executeCommand('codeNotes.refreshJourney', vscode.Uri.file(diskPath).toString())
    await until('refreshed: the file rewritten, the step fresh', () => JSON.parse(fs.readFileSync(diskPath, 'utf8')).steps[0].anchor?.v === 3 && !diskStep().stale, 20000)
    assert.equal(snap().notes.length, notesBeforeRefresh, 'Refresh writes no note in the reader\'s name')
    assert.ok(!fs.existsSync(path.join(ctx.notesDir, '.writing')), 'the staging folder is cleaned up, no empty .writing left')
    fs.unlinkSync(diskPath)
    await until('disk gone', () => !snap().journeys.some((x: any) => x.id === 'disk'))
  }),

  test('a long file: one inline card and no marker lens; a ref into the step\'s own file peeks under the card', async () => {
    writeLines(wsPath('src', 'long.ts'), Array.from({ length: LONG_FILE_LINES }, (_, i) => `export const v${i} = ${i} // line ${i + 1} of a long file`))
    const longStep = (id: string, node: string, line: number, over: object = {}) => step('src/long.ts', line, line + STEP_LINES - 1, { id, title: `At line ${line}`, node, lead: `Line ${line}.`, ...over })
    keep(writeJourney(journeysDir(), journey('long', [longStep('l1', 'f1', STEPS.l1, { refs: [`src/long.ts:${REF.start}-${REF.end}`] }), longStep('l2', 'f2', STEPS.l2), longStep('l3', 'f3', STEPS.l3)], {
      question: 'How long is it?', title: 'Long', summary: 'Long.',
      nodes: [{ id: 'A', kind: 'system', label: 'A' }, { id: 'B', kind: 'system', label: 'B' }, { id: 'f1', kind: 'function', label: 'f1', parent: 'A' }, { id: 'f2', kind: 'function', label: 'f2', parent: 'A' }, { id: 'f3', kind: 'function', label: 'f3', parent: 'A' }],
      edges: [{ from: 'A', to: 'B', label: 'uses' }],
    })))
    await until('long loaded', () => snap().journeys.some((x: any) => x.id === 'long'))
    await vscode.commands.executeCommand('codeNotes.openJourney', 'long')
    await until('long map', () => tour().map === 'long' && tour().mapBoxes === 5, 10000)
    await vscode.commands.executeCommand('codeNotes.startJourney', 'long')
    await until('inline card for step 1', () => tour().step === 1 && tour().card?.title === `At line ${STEPS.l1}` && !tour().panelCard, 8000)
    const longUri = vscode.Uri.file(wsPath('src', 'long.ts'))
    assert.ok(!(await lenses(longUri)).some((t) => /Step 1\/3/.test(t)), 'no marker line above the step (it was the panel mode\'s)')
    // A ref from the card (inside More) into the step's own file: a peek of a read-only copy under the card,
    // the step's editor stays.
    await vscode.commands.executeCommand('codeNotes.stepDetails', true)
    await until('More open', () => (tour().card?.body ?? '').includes(`long.ts:${REF.start}`))
    await vscode.commands.executeCommand('codeNotes.openAt', ctx.folder.uri.toString(), 'src/long.ts', REF.start, REF.end, 1)
    await until('ref peeked', () => /^code-notes-ref:.*long\.ts/.test(tour().peek?.uri ?? '') && tour().peek!.start === REF.start - 1 && tour().peek!.end === REF.end - 1 && !tour().ref)
    await vscode.commands.executeCommand('closeReferenceSearch').then(undefined, () => undefined)
    await until('still at the step', () => /^src\/long\.ts:/.test(at()) && tour().card?.title === `At line ${STEPS.l1}`)
  }),

  test('the map follows the step, there and back (0.21: the whole map, centred on the step\'s box)', async () => {
    await vscode.commands.executeCommand('codeNotes.nextStep')
    await until('step 2, the map on f2', () => tour().step === 2 && tour().mapFocus === 'f2')
    await vscode.commands.executeCommand('codeNotes.previousStep')
    await until('step 1', () => tour().step === 1)
    await until('the map followed the step back to f1', () => tour().mapFocus === 'f1' && tour().mapBoxes === 5)
    await until('the card is back on step 1', () => tour().card?.title === `At line ${STEPS.l1}`)
  }),

  test('a jump lower in the file (Next, a storyline row) shows the card and the step; arriving at a step reads no note there', async () => {
    // An unread reply on the next step's lines stays unread when the journey arrives there.
    keep(writeNote(ctx.notesDir, ON_STEP, agentNote('src/long.ts', STEPS.l2, 'Reply on a step')))
    await until('unread on the step', () => noteById(ON_STEP)?.unread === 1)
    // A jump lower in the same file shows the card's line and the step's lines.
    await vscode.commands.executeCommand('codeNotes.nextStep')
    await until('step 2 card', () => tour().step === 2 && tour().card?.title === `At line ${STEPS.l2}`)
    await settle(700, 'the step\'s delayed reveals')
    const shown2 = vscode.window.activeTextEditor!.visibleRanges[0]
    assert.ok(shown2.start.line <= cardLine(STEPS.l2) && shown2.end.line >= lastLine(STEPS.l2), `card line ${cardLine(STEPS.l2)} and step 2 (to ${lastLine(STEPS.l2)}) in view: ${shown2.start.line}-${shown2.end.line}`)
    assert.equal(noteById(ON_STEP).unread, 1, 'arriving at a step is not reading the note there')
    // A step from the storyline: the same.
    ctx.api.mapSend({ type: 'test', click: '.story .st[data-n="3"]' })
    await until('step 3 from the storyline', () => tour().step === 3 && tour().card?.title === `At line ${STEPS.l3}`)
    await settle(700, 'the step\'s delayed reveals')
    const shown3 = vscode.window.activeTextEditor!.visibleRanges[0]
    assert.ok(shown3.start.line <= cardLine(STEPS.l3) && shown3.end.line >= lastLine(STEPS.l3), `storyline jump: card line ${cardLine(STEPS.l3)} and step 3 in view: ${shown3.start.line}-${shown3.end.line}`)
  }),

  test('another journey started mid-way: the first one is left with a way back', async () => {
    await vscode.commands.executeCommand('codeNotes.startJourney', 'demo')
    await until('left long', () => tour().journey === 'demo' && tour().lastLeft?.title === 'Long' && tour().lastLeft?.at === '3/3')
    await vscode.commands.executeCommand('codeNotes.endJourney')
  }),

  test('a step whose file is gone: no stand-in tab; the card (in the map) says so', async () => {
    keep(writeJourney(journeysDir(), journey('gonefile', [step('src/nope_gone.ts', 3, 4, { id: 'g', title: 'Here', node: 'x', lead: 'Was here.' })],
      { question: 'Where?', title: 'Gone file', nodes: [{ id: 'x', kind: 'function', label: 'x' }] })))
    await until('gonefile loaded', () => snap().journeys.some((x: any) => x.id === 'gonefile'))
    await closeAllEditors()
    await vscode.commands.executeCommand('codeNotes.startJourney', 'gonefile')
    await until('file gone card', () => tour().journey === 'gonefile' && tour().fileGone && /File moved or deleted/.test(tour().panelCard?.staleText ?? ''), 8000)
    assert.ok(!vscode.window.tabGroups.all.some((g) => g.tabs.some((x) => /not found/.test(x.label))), 'no "(not found)" tab')
    await vscode.commands.executeCommand('codeNotes.endJourney')
  }),
], cleanUp)
