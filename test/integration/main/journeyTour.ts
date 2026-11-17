// Walking a journey (format v2): it loads (steps are never notes), opens as a map with step cards in the editor,
// follows edits, takes questions, survives reloads and edits of its file, and leaves "◇ Step n" lenses behind.
// Source: src/journeys.ts (loading, the tour), src/journeyModel.ts (parsing), src/extension.ts (cards, lenses, commands).
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { appendMessage, now, quiet, settle, test, windowShot } from '../helpers'
import { StepFixture, journey, step, writeLines } from '../fixtures'
import { at, bodyOf, ctx, journeysDir, journeysTree, lenses, notesTree, setting, snap, tabOpen, tour, until, wsPath } from './context'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A step of the demo journey: its lead is "<title>: the lead.". */
const demoStep = (id: string, title: string, node: string, file: string, line: number, extra: object = {}) =>
  step(file, line, line, { id, title, node, lead: `${title}: the lead.`, ...extra })

/** a() calls b() in src/flow.ts, then c in src/flow2.ts. Step 1's details and refs are what the card's tests read. */
export const demoSteps: StepFixture[] = [
  demoStep('s-a', 'a calls b', 'fa', 'src/flow.ts', 2, { details: 'More about **a**: see src/flow.ts:5 (and src/flow.ts:6-7). Charges card <name>.', refs: ['src/flow.ts:5', 'src/gone.ts:3', 'Recipients builds the list of addresses a receipt goes to in lib/mail/address.go:31-54.'] }),
  demoStep('s-b', 'b returns', 'fb', 'src/flow.ts', 6),
  demoStep('s-c', 'Then c', 'fc', 'src/flow2.ts', 2),
]

/** The demo journey: five boxes (App > flow > a, b, c), `steps` (the three demo steps by default). */
export const demoJourney = (steps: StepFixture[] = demoSteps) => journey('demo', steps, {
  question: 'How does a get to c?', title: 'Demo', summary: 'a, b, then c.',
  nodes: [{ id: 'app', kind: 'system', label: 'App', summary: '' }, { id: 'm', kind: 'module', label: 'flow', summary: '', parent: 'app' },
    { id: 'fa', kind: 'function', label: 'a', summary: '', parent: 'm' }, { id: 'fb', kind: 'function', label: 'b', summary: '', parent: 'm' },
    { id: 'fc', kind: 'function', label: 'c', summary: '', parent: 'm' }],
  edges: [{ from: 'fa', to: 'fb', label: 'calls' }, { from: 'fb', to: 'fc', label: 'later', async: true }],
})
export const demoPath = () => path.join(journeysDir(), 'demo.json')
export const writeDemo = (steps?: StepFixture[]) => fs.writeFileSync(demoPath(), JSON.stringify(demoJourney(steps), null, 2))

/** The demo journey's three steps after one inserted before them (step 3 is then "b returns"). */
const withStepBefore = () => [demoStep('s-0', 'Before a', 'fa', 'src/flow.ts', 3), ...demoSteps]

// What the first tests leave for the later ones.
let notesBefore = 0
let mapColumn: vscode.ViewColumn | undefined
let flowDoc: vscode.TextDocument
let flowEditor: vscode.TextEditor
/** The note asked from step 2. */
let stepQuestion: any

/** The step's tint in light and dark, a selection and find matches on top (CODE_NOTES_SHOTS only: pictures). */
async function tintShots() {
  const editor = vscode.window.activeTextEditor!
  editor.selection = new vscode.Selection(1, 2, 1, 8)
  await vscode.commands.executeCommand('editor.actionFindWithSelection').then(undefined, () => undefined)
  await windowShot('step-tint-dark')
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Default Light Modern', vscode.ConfigurationTarget.Global)
  await windowShot('step-tint-light')
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', undefined, vscode.ConfigurationTarget.Global)
  await vscode.commands.executeCommand('closeFindWidget').then(undefined, () => undefined)
  editor.selection = new vscode.Selection(1, 0, 1, 0)
}

export const journeyTourTests = [
  test('v2 journeys load (v1 and broken files skipped); steps are not notes; the group lists titles, new ones marked', async () => {
    writeLines(wsPath('src', 'flow.ts'), ['export function a() {', '  return b()', '}', '', 'export function b() {', '  return 2', '}'])
    writeLines(wsPath('src', 'flow2.ts'), ['// two', 'export const c = 3'])
    writeLines(wsPath('lib', 'mail', 'address.go'), Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`))
    // One step card, inline (the panel mode and its setting are gone).
    assert.equal(vscode.workspace.getConfiguration('codeNotes').get('journeys.stepCard'), undefined, 'no step-card setting')
    notesBefore = snap().notes.length
    const badgeBefore = snap().badge
    const brokenBefore = snap().broken
    fs.mkdirSync(journeysDir(), { recursive: true })
    writeDemo()
    fs.writeFileSync(path.join(journeysDir(), 'old-v1.json'), JSON.stringify({ version: 1, id: 'old', nodes: [{ id: 'x' }], steps: [{ node: 'x', note: 'n1' }] }))
    fs.writeFileSync(path.join(journeysDir(), 'half-written.json'), '{"version": 2, "nodes": [')
    await until('journey loaded', () => snap().journeys.length === 1, 8000)
    await quiet(500, 'the v1 or the half-written file listed')
    assert.equal(snap().journeys.length, 1, 'v1 and broken files are not shown')
    assert.equal(snap().notes.length, notesBefore, 'steps are not notes')
    assert.equal(snap().broken, brokenBefore, 'journey files are not read as notes')
    assert.equal(snap().badge, badgeBefore, 'steps never count as unread')
    // 0.24: journeys have their own view (Journeys), grouped by area; the Notes view lists notes only.
    const rows = journeysTree()
    assert.ok(!notesTree().some((l) => /^journeys:|journey:/.test(l)), 'no journeys in the Notes view')
    const demoRow = rows.findIndex((l) => /journey:Demo · new$/.test(l))
    assert.ok(demoRow > 0 && /^\s+jgroup:src · 1$/.test(rows[demoRow - 1]), `Demo under its area (not said again), "new":\n${rows.join('\n')}`)
    assert.ok(rows.some((l) => /^jgroup:All · 1$/.test(l)), `an "All" group:\n${rows.join('\n')}`)
    // Files that never were valid journeys: one dimmed row each, after the groups.
    assert.deepEqual(rows.slice(-2), ['badJourney: · ⚠ half-written.json', 'badJourney: · ⚠ old-v1.json'], `never-valid files are dimmed rows:\n${rows.join('\n')}`)
  }),

  test('Open Journey → Next: one preview tab beside the map, a read-only step card above the lines; details fold; refs link', async () => {
    // The tour opens each step's code as one preview tab in the group beside the map, with a read-only step card above
    // the lines.
    await vscode.commands.executeCommand('codeNotes.openJourney', 'demo')
    // Opening a journey walks it (there is no Start): the map, and step 1's code with its card.
    await until('map open and drawn, walking at step 1', () => tour().map === 'demo' && tour().journey === 'demo' && tour().mapBoxes === 5 && tour().mapFocus === 'fa' && tour().step === 1 && at() === 'src/flow.ts:2' && tour().card?.title === 'a calls b', 10000)
    await until('opened: no longer new', () => !journeysTree().some((l: string) => /· new/.test(l)))
    assert.equal(tour().touring, true, 'walking')
    // The panel beside the code: at most 40 % (the code keeps ~80 characters).
    const layout = await vscode.commands.executeCommand<{ groups: { size: number }[] }>('vscode.getEditorLayout')
    console.log(`  (editor layout: ${JSON.stringify(layout)})`)
    await settle(500, 'the panel group taking its size')
    const settled = await vscode.commands.executeCommand<{ groups: { size: number }[] }>('vscode.getEditorLayout')
    if (settled.groups.length === 2) { const total = settled.groups[0].size + settled.groups[1].size; assert.ok(settled.groups[1].size / total <= 0.41, `the panel takes ${JSON.stringify(settled)}`) }
    mapColumn = tour().mapColumn
    const card1 = tour().card
    assert.equal(card1.label, '1/3 · a calls b', 'the card\'s first line is "1/3 · title"')
    assert.equal(card1.canReply, false, 'no reply box on a step')
    assert.ok(card1.expanded)
    assert.equal(card1.line, 0, 'the card right above the step\'s first line')
    assert.match(card1.body, /a calls b: the lead\./)
    assert.match(card1.body, /\[More\]\(command:codeNotes\.stepDetails/)
    assert.ok(!card1.body.includes('More about'), 'details folded')
    assert.ok(!/flow\.ts:5|gone\.ts/.test(card1.body), 'no bare link row: the references are inside More')
    assert.match(card1.body, /\[Ask\]\(command:codeNotes\.askStep\)/, 'one word, a command without arguments')
    assert.ok(!/Previous/.test(card1.body), 'no Previous on step 1')
    assert.equal(snap().notes.length, notesBefore, 'touring creates no notes')
    assert.equal(tour().statusShown, true)
    assert.equal(tour().status, '$(map) 1/3', 'the position only')
    // More: the details and the refs.
    await vscode.commands.executeCommand('codeNotes.stepDetails', true)
    await until('details open', () => tour().card?.body.includes('More about'))
    const body = () => tour().card.body as string
    assert.match(body(), /~~gone\.ts:3~~ \(file gone\)/, 'a ref to a missing file says so, inside More')
    assert.match(body(), /\n\nRecipients builds the list of addresses a receipt goes to in \[address\.go:31-54\]\(command:codeNotes\.openAt[^)]* "lib\/mail\/address\.go:31-54"\)\./, `a ref may be a sentence: its token (a file in another directory) a link inside it: ${body()}`)
    assert.ok(!/address\.go[^\n]*gone/.test(body()), `an existing file in another directory is never "gone": ${body()}`)
    assert.match(body(), /\(and \[flow\.ts:6-7\]\(command:codeNotes\.openAt[^)]* "src\/flow\.ts:6-7"\)/, `a ref in parentheses, with a range, is a link named by its file, the path on hover: ${body()}`)
    assert.notEqual(tour().codeColumn, mapColumn, 'the code opens beside the map, never over it')
    await windowShot('inline-card-more-open')
    if (process.env.CODE_NOTES_SHOTS) await tintShots()
    assert.match(body(), /card \\<name\\>/, `<name> stays text, not an HTML tag the renderer drops: ${body()}`)
    const body1 = body()
    const next = '[Next ›](command:codeNotes.nextStep)'
    assert.ok(body1.indexOf('a calls b: the lead') < body1.indexOf(next) && body1.indexOf(next) < body1.indexOf('More about'), `the lead, then ‹ › Ask, then what More opened: ${body1}`)
    assert.equal(body().split('[flow.ts:5]').length, 2, `a ref the details already link is not listed again: ${body()}`)
    // A ref opens as a peek; the step's tab, its code and the card stay.
    const folderUri = ctx.folder.uri.toString()
    await vscode.commands.executeCommand('codeNotes.openAt', folderUri, 'src/flow2.ts', 2, 2, 1)
    await until('ref peeked', () => /flow2\.ts$/.test(tour().peek?.uri ?? ''))
    assert.equal(tour().peek.under, tour().card.line, 'the peek opens right under the step card, not under the step\'s code')
    await quiet(300, 'the ref taking the editor or opening a tab')
    assert.match(vscode.window.activeTextEditor?.document.uri.path ?? '', /\/flow\.ts$/, 'the step stays the editor')
    assert.ok(!tabOpen(/\/flow2\.ts$/), 'no tab replaced or added for the ref')
    assert.equal(tour().card?.title, 'a calls b', 'the card is still there')
    await windowShot('inline-ref-peek')
    await vscode.commands.executeCommand('closeReferenceSearch').then(undefined, () => undefined)
    // A ref into the step's own file is a peek too, of a read-only copy (closing a peek of the file itself took the
    // card with it).
    await vscode.commands.executeCommand('codeNotes.openAt', folderUri, 'src/flow.ts', 5, 5, 1)
    await until('same-file ref peeked (a copy)', () => /^code-notes-ref:.*\/flow\.ts/.test(tour().peek?.uri ?? '') && tour().peek.start === 4)
    assert.ok(/^src\/flow\.ts:/.test(at()) && !tour().ref, `the step's editor stays, nothing jumped: ${at()}`)
    await windowShot('inline-ref-peek-same-file')
    await vscode.commands.executeCommand('closeReferenceSearch').then(undefined, () => undefined)
    await quiet(300, 'the card going with the peek')
    assert.equal(tour().card?.title, 'a calls b', 'the card stays')
    assert.ok(tour().card?.expanded, 'the card stays open after the peek closes')
    await windowShot('inline-ref-peek-same-file-closed')
    await vscode.commands.executeCommand('codeNotes.backToStep')
    await until('back at step 1', () => at() === 'src/flow.ts:2')
    // The step's tab replaced by another file, then Go Back: the card and the marker are back.
    await vscode.window.showTextDocument(vscode.Uri.file(wsPath('src', 'flow2.ts')), { preview: true, viewColumn: tour().codeColumn })
    await until('away from the step', () => /flow2\.ts$/.test(vscode.window.activeTextEditor?.document.uri.path ?? ''))
    await settle(300, 'VS Code\'s editor history taking the step\'s place')
    await vscode.commands.executeCommand('workbench.action.navigateBack')
    await until('Go Back: on the step, card and marker shown', () => at() === 'src/flow.ts:2' && /\/flow\.ts$/.test(tour().card?.file ?? '') && tour().card?.expanded && (tour().marked as string[]).some((x) => /\/flow\.ts$/.test(x)), 8000)
    await vscode.commands.executeCommand('codeNotes.nextStep')
    await until('step 2', () => tour().step === 2 && at() === 'src/flow.ts:6' && tour().card?.label === '2/3 · b returns')
    assert.equal(tour().card.line, 4, 'step 2: the card right above its first line')
    await windowShot('inline-card-above-function')
    await vscode.commands.executeCommand('codeNotes.nextStep')
    await until('step 3, another file', () => tour().step === 3 && at() === 'src/flow2.ts:2')
    const codeGroup = vscode.window.tabGroups.all.find((g) => g.viewColumn === tour().codeColumn)!
    const textTabs = codeGroup.tabs.filter((x) => x.input instanceof vscode.TabInputText && /\/flow2?\.ts$/.test(x.input.uri.path))
    assert.equal(textTabs.length, 1, `one reused preview tab for the tour's files, no pile-up: ${textTabs.map((x) => x.label)}`)
    assert.ok(textTabs[0].isPreview)
    assert.equal(tour().mapColumn, mapColumn, 'the map kept its group')
    assert.match(tour().card.body, /\[Finish\]\(command:codeNotes\.nextStep/, 'the last step offers Finish')
    assert.ok(!/How does a get to c/.test(tour().card.body), 'no recap on the last step')
    await vscode.commands.executeCommand('codeNotes.nextStep')
    await until('Next on the last step finishes', () => !tour().touring && tour().map === 'demo' && snap().journeys[0].resume === 0)
    await until('Finish closes the step tab the walk opened', () => !tabOpen(/\/flow2?\.ts$/))
    // Next again right after finishing is not step 1.
    await vscode.commands.executeCommand('codeNotes.nextStep')
    await quiet(400, 'Next starting the walk over')
    assert.ok(!tour().touring && tour().step === 0, 'Next after Finish does not start over at step 1')
    await vscode.commands.executeCommand('codeNotes.startJourney', 'demo')
    await until('started again', () => tour().step === 1)
    await vscode.commands.executeCommand('codeNotes.nextStep')
    await until('2 again', () => tour().step === 2)
    await vscode.commands.executeCommand('codeNotes.nextStep')
    await until('3 again', () => tour().step === 3)
  }),

  test('steps follow edits in memory; the journey file is untouched', async () => {
    const demoBytes = fs.readFileSync(demoPath(), 'utf8')
    flowDoc = await vscode.workspace.openTextDocument(wsPath('src', 'flow.ts'))
    flowEditor = await vscode.window.showTextDocument(flowDoc, { viewColumn: tour().codeColumn })
    await flowEditor.edit((b) => b.insert(new vscode.Position(0, 0), '// added\n// added\n'))
    await flowDoc.save()
    await until('step 2 followed the code', () => snap().journeys[0].at[1].start === 8)
    assert.equal(fs.readFileSync(demoPath(), 'utf8'), demoBytes, 'the journey file is not rewritten')
    await vscode.commands.executeCommand('codeNotes.previousStep')
    await until('back to step 2 at its new line', () => tour().step === 2 && at() === 'src/flow.ts:8')
  }),

  test('my own edit of a step\'s lines keeps the step on them, not stale', async () => {
    // The reader's own edit on a step's lines (typing, an applied fix): never "out of date".
    const step2 = () => [snap().journeys[0].at[1].start, snap().journeys[0].at[1].stale]
    await flowEditor.edit((b) => b.replace(flowDoc.lineAt(7).range, '  return 2 + 0'))
    await quiet(700, 'the step marked stale by my edit')
    assert.deepEqual(step2(), [8, false], 'an edit of mine on the step\'s line: not stale')
    await flowDoc.save()
    await quiet(700, 'the step marked stale once saved')
    assert.deepEqual(step2(), [8, false], 'nor once saved')
    await flowEditor.edit((b) => b.replace(flowDoc.lineAt(7).range, '  return 2'))
    await flowDoc.save()
    await until('the code as the journey has it: fresh', () => !snap().journeys[0].at[1].stale && snap().journeys[0].at[1].start === 8)
  }),

  test('Ask about this step: a normal note on the step\'s lines, listed under its journey with its step, linking back', async () => {
    const asked = (await vscode.commands.executeCommand('codeNotes.askStep', 'Why does b return 2?')) as any
    await until('note created', () => snap().notes.length === notesBefore + 1)
    stepQuestion = snap().notes.find((x: any) => x.messages[0].body.startsWith('Why does b return 2?'))
    assert.ok(stepQuestion && asked, 'the note exists')
    assert.equal(stepQuestion.file, 'src/flow.ts')
    assert.deepEqual(stepQuestion.range, { start: 8, end: 8 })
    assert.match(stepQuestion.messages[0].body, /About the step “b returns” \(id `s-b`\) of the journey “Demo”/, 'the step by id and title, not its number')
    assert.deepEqual(stepQuestion.extra?.journey ?? stepQuestion.journey, { id: 'demo', step: 's-b', n: 2 }, 'the note carries the journey field the skill reads')
    assert.equal(stepQuestion.session, undefined, 'a normal private note')
    assert.equal(stepQuestion.unread, 0)
    const rows = journeysTree()
    const row = rows.findIndex((l) => /^ {6}note:Step 2 · Why does b return 2\?/.test(l))
    assert.ok(row > 0 && /^ {4}journey:Demo\b/.test(rows[row - 1]) && !/question/.test(rows[row - 1]), `listed right under its journey, with its step; no count on the row:\n${rows.join('\n')}`)
    assert.ok(!rows.some((l) => /^note:Why does b return 2/.test(l)), 'not a loose row too')
    const askedThread = await until('the asked note\'s thread', () => ctx.api.thread(stepQuestion.id))
    assert.ok(!/openStepLink|About the step/.test(bodyOf(askedThread.comments[0])), 'on that very step: no back-link')
  }),

  test('a reply to a step question: "1 reply" on the journey row, "1 asked · new reply" on the card', async () => {
    appendMessage(stepQuestion.path, { author: 'claude', role: 'agent', body: 'Because it is the answer.', at: now() })
    await until('the journey row says 1 reply ("new" is only a new journey)', () => journeysTree().some((l) => /journey:Demo · .*1 reply/.test(l)))
    await until('the card lists the question', () => /1 asked · new reply ›\]\(command:codeNotes\.openNoteId/.test(tour().card?.body ?? ''))
    await vscode.commands.executeCommand('codeNotes.markAllRead')
  }),

  test('a step inserted before the current one: card, status bar and position follow the step by id', async () => {
    // The journey is edited mid-tour: the tour stays on the same step.
    writeDemo(withStepBefore())
    await until('the tour followed the step by id', () => tour().step === 3 && tour().card?.label === '3/4 · b returns' && tour().card?.title === 'b returns' && tour().status === '$(map) 3/4', 8000)
  }),

  test('a re-anchored current step: the editor goes to its new lines, the card says so', async () => {
    // The agent re-anchors the step you are on: the editor follows the card.
    writeDemo([demoStep('s-0', 'Before a', 'fa', 'src/flow.ts', 3), demoSteps[0], demoStep('s-b', 'b returns', 'fb', 'src/flow2.ts', 2), demoSteps[2]])
    await until('the editor followed the re-anchored step', () => tour().step === 3 && at() === 'src/flow2.ts:2' && /This step was updated: its code is now at flow2\.ts:2/.test(tour().card?.body ?? ''), 8000)
    writeDemo(withStepBefore())
    await until('and back', () => tour().step === 3 && at() === 'src/flow.ts:8' && tour().card?.title === 'b returns', 8000)
  }),

  test('the tour survives a reload (restored from workspace state)', async () => {
    await ctx.api.reloadTour()
    await until('restored', () => tour().step === 3 && tour().touring && tour().card?.title === 'b returns')
  }),

  test('"◇ Step n of Demo" once per function outside a walk; click opens it; setting turns it off; none while walking', async () => {
    // End: the place is kept (resume), the card and the preview tab go, the status bar hides.
    await vscode.commands.executeCommand('codeNotes.endJourney')
    await until('ended', () => !tour().touring && !tour().card && !tour().statusShown)
    assert.equal(snap().journeys[0].resume, 3)
    // Outside a walk, at most one quiet line per function: "◇ Step n of <journey>" (its first step there); click = that step.
    const flowUri = vscode.Uri.file(wsPath('src', 'flow.ts'))
    const flowNow = await vscode.workspace.openTextDocument(flowUri)
    const fnLine = (name: string) => flowNow.getText().split('\n').findIndex((x) => x.startsWith(`export function ${name}(`)) + 1
    const stepLenses = async (u: vscode.Uri) => (await lenses(u)).filter((x) => x.includes('◇'))
    // Steps 1 and 2 are both in a(): one lens there, for step 1; step 3 in b().
    await until('one lens per function', async () => { const l = await stepLenses(flowUri); return l.length === 2 && l.includes(`${fnLine('a')}:◇ Step 1 of Demo`) && l.includes(`${fnLine('b')}:◇ Step 3 of Demo`) }, 15000)
    await vscode.window.showTextDocument(flowUri, { viewColumn: vscode.ViewColumn.One })
    await windowShot('step-lens')
    // A file's top consts share one lens; a function gets one lens however its steps sit in it (a destructuring, a
    // callback, a step on the comment above it).
    writeLines(wsPath('src', 'top.ts'), ["import { get, connect, makePool } from './lib'", '', 'const pool = makePool({', "  url: 'postgres://db',", '})', "const HOST = 'mail'", 'const PORT = 25', '',
      '// Sends one mail.', 'export async function send(to: string) {', '  const { a } = await get(to, pool)', '  return new Promise((ok) => {', '    connect(PORT, HOST, a, ok)', '  })', '}'])
    const topLine = (id: string, a: number, b = a) => step('src/top.ts', a, b, { id })
    const topPath = path.join(journeysDir(), 'top.json')
    fs.writeFileSync(topPath, JSON.stringify(journey('top', [topLine('t1', 4), topLine('t2', 6), topLine('t3', 7), topLine('t4', 9, 10), topLine('t5', 11), topLine('t6', 13)],
      { question: 'How is a mail sent?', title: 'Top', nodes: [{ id: 'f', kind: 'function', label: 'send' }] })))
    const topUri = vscode.Uri.file(wsPath('src', 'top.ts'))
    await vscode.workspace.openTextDocument(topUri)
    await until('top: one lens for the consts, one for send()', async () => (await stepLenses(topUri)).join('|') === '3:◇ Step 1 of Top|10:◇ Step 4 of Top', 15000)
    fs.unlinkSync(topPath)
    await until('top gone', () => !snap().journeys.some((x: any) => x.id === 'top'))
    await setting('journeys.codeLens', false)
    await until('the setting turns them off', async () => !(await stepLenses(flowUri)).length)
    await setting('journeys.codeLens', undefined)
    const step3Lens = ((await vscode.commands.executeCommand('vscode.executeCodeLensProvider', flowUri)) as vscode.CodeLens[]).find((l) => l.command?.title === '◇ Step 3 of Demo')!
    await vscode.commands.executeCommand(step3Lens.command!.command, ...(step3Lens.command!.arguments ?? []))
    await until('the lens opened that step', () => tour().touring && tour().step === 3)
    assert.ok(!(await stepLenses(flowUri)).length, 'no step lenses while walking')
    await vscode.commands.executeCommand('codeNotes.endJourney')
    await until('ended again', () => !tour().touring)
  }),

  test('End keeps a resumable place; Next resumes; the sidebar marks the running tour', async () => {
    // Not walking: the step question links back to its step, with the journey's name.
    await until('the back-link', () => /\[↩ Step 3 · Demo\]\(command:codeNotes\.openStepLink/.test(bodyOf(ctx.api.thread(stepQuestion.id)!.comments[0])))
    assert.ok(tabOpen(/flow\.ts$/), 'End keeps the code you were reading')
    assert.ok(journeysTree().some((l: string) => /journey:Demo · step 3\/4$/.test(l)), `the sidebar row: its title and, after End, where it was left:\n${journeysTree().join('\n')}`)
    await vscode.commands.executeCommand('codeNotes.notes.focus')
    await windowShot('sidebar')
    await vscode.commands.executeCommand('codeNotes.nextStep') // resumes
    await until('resumed at 3', () => tour().touring && tour().step === 3)
    assert.ok(journeysTree().some((l: string) => /journey:Demo · step 3\/4( · [^[]*)? \[play-circle\]/.test(l)), `the sidebar marks the running journey and shows its step:\n${journeysTree().join('\n')}`)
    await vscode.commands.executeCommand('codeNotes.endJourney')
    // The demo journey as the later tests know it: three steps.
    writeDemo()
    await until('back to 3 steps', () => snap().journeys[0]?.steps === 3)
  }),
]
