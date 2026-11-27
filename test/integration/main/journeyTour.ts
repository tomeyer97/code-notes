// Walking a journey (format v2): it loads (steps are never notes), opens as a map with step cards in the editor,
// follows edits, takes questions, survives reloads and edits of its file, and leaves "◇ Step n" lenses behind.
// Source: src/journeys/ (loading, where the steps are), src/core/format/journeyModel.ts (parsing), src/tour/ (the walk, cards,
// lenses, commands).
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { appendMessage, now, quiet, settle, test, windowShot } from '../helpers'
import { shotsInBothThemes } from './themeShots'
import { journey, step, writeLines } from '../fixtures'
import { at, bodyOf, codeLenses, ctx, journeysDir, journeysTree, lenses, notesTree, setting, snap, tabOpen, tour, until, wsPath } from './context'
import { demoPath, demoStep, demoSteps, writeDemo } from './shared'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The editor groups' sizes, left to right. */
const editorLayout = () => vscode.commands.executeCommand<{ groups: { size: number }[] }>('vscode.getEditorLayout')

/** The demo journey's three steps after one inserted before them (step 3 is then "b returns"). */
const withStepBefore = () => [demoStep('s-0', 'Before a', 'fa', 'src/flow.ts', 3), ...demoSteps]

/** The editor showing src/flow.ts (the steps' file), outside the map. */
const flowEditor = () => vscode.window.visibleTextEditors.find((e) => /\/src\/flow\.ts$/.test(e.document.uri.path) && e.viewColumn !== tour().mapColumn)!

/** The note asked from step 2 ("Ask about this step"), once it is there. */
const stepQuestion = (): any => snap().notes.find((x: any) => x.messages[0].body.startsWith('Why does b return 2?'))

/** The card's buttons, in order (their labels): what a reader can do from the step. */
const cardActions = (body: string) =>
  [...body.matchAll(/\[([^\]]+)\]\(command:codeNotes\.(?:previousStep|nextStep|askStep|askStepUpdate|stepDetails|openNoteId)\b/g)].map((m) => m[1])

/** The step's tint in light and dark, a selection and find matches on top (CODE_NOTES_SHOTS only: pictures). */
async function tintShots() {
  const editor = vscode.window.activeTextEditor!
  editor.selection = new vscode.Selection(1, 2, 1, 8)
  await vscode.commands.executeCommand('editor.actionFindWithSelection').then(undefined, () => undefined)
  try {
    await shotsInBothThemes('step-tint')
  } finally {
    await vscode.commands.executeCommand('closeFindWidget').then(undefined, () => undefined)
    editor.selection = new vscode.Selection(1, 0, 1, 0)
  }
}

/** A file whose steps sit in top-level consts and in one function (a destructuring, a callback, a comment above it),
 *  and its journey "Top": the lenses' grouping. Returns the journey file (delete it when done). */
function writeTopJourney(): string {
  writeLines(wsPath('src', 'top.ts'), [
    "import { get, connect, makePool } from './lib'",
    '',
    'const pool = makePool({',
    "  url: 'postgres://db',",
    '})',
    "const HOST = 'mail'",
    'const PORT = 25',
    '',
    '// Sends one mail.',
    'export async function send(to: string) {',
    '  const { a } = await get(to, pool)',
    '  return new Promise((ok) => {',
    '    connect(PORT, HOST, a, ok)',
    '  })',
    '}',
  ])
  const line = (id: string, a: number, b = a) => step('src/top.ts', a, b, { id })
  const steps = [line('t1', 4), line('t2', 6), line('t3', 7), line('t4', 9, 10), line('t5', 11), line('t6', 13)]
  const topPath = path.join(journeysDir(), 'top.json')
  fs.writeFileSync(topPath, JSON.stringify(journey('top', steps, { question: 'How is a mail sent?', title: 'Top', nodes: [{ id: 'f', kind: 'function', label: 'send' }] })))
  return topPath
}

/** The step lenses ("◇ Step n of …") on a file, as "line:title". */
const stepLenses = async (u: vscode.Uri) => (await lenses(u)).filter((x) => x.includes('◇'))
const flowUri = () => vscode.Uri.file(wsPath('src', 'flow.ts'))

export const journeyTourTests = [
  test('v2 journeys load (v1 and broken files skipped); steps are not notes; the group lists titles, new ones marked', async () => {
    writeLines(wsPath('src', 'flow.ts'), ['export function a() {', '  return b()', '}', '', 'export function b() {', '  return 2', '}'])
    writeLines(wsPath('src', 'flow2.ts'), ['// two', 'export const c = 3'])
    writeLines(wsPath('lib', 'mail', 'address.go'), Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`))
    // One step card, inline (the panel mode and its setting are gone).
    assert.equal(vscode.workspace.getConfiguration('codeNotes').get('journeys.stepCard'), undefined, 'no step-card setting')
    const notesBefore = snap().notes.length
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

  test('Open Journey: the map and step 1\'s code, the panel at most 40 %; a read-only step card above the lines, details folded', async () => {
    // The tour opens each step's code as one preview tab in the group beside the map, with a read-only step card above
    // the lines.
    const notesBefore = snap().notes.length
    await vscode.commands.executeCommand('codeNotes.openJourney', 'demo')
    // Opening a journey walks it (there is no Start): the map, and step 1's code with its card.
    await until('map open and drawn, walking at step 1', () => tour().map === 'demo' && tour().journey === 'demo' && tour().mapBoxes === 5 && tour().mapFocus === 'fa' && tour().step === 1 && at() === 'src/flow.ts:2' && tour().card?.title === 'a calls b', 10000)
    await until('opened: no longer new', () => !journeysTree().some((l: string) => /· new/.test(l)))
    assert.equal(tour().touring, true, 'walking')
    // The panel beside the code: at most 40 % (the code keeps ~80 characters).
    console.log(`  (editor layout: ${JSON.stringify(await editorLayout())})`)
    await settle(500, 'the panel group taking its size')
    const settled = await editorLayout()
    if (settled.groups.length === 2) {
      // The panel's own group: beside the code, or the first one when nothing was open (this chapter run alone).
      const panel = settled.groups[(tour().mapColumn ?? 0) - 1]
      assert.ok(panel, `the map's group in the layout: ${JSON.stringify(settled)}`)
      const panelShare = panel.size / (settled.groups[0].size + settled.groups[1].size)
      assert.ok(panelShare <= 0.41, `the panel takes ${JSON.stringify(settled)}`)
    }
    const card1 = tour().card!
    const cardBody = card1.body ?? ''
    assert.equal(card1.label, '1/3 · a calls b', 'the card\'s first line is "1/3 · title"')
    assert.equal(card1.canReply, false, 'no reply box on a step')
    assert.ok(card1.expanded)
    assert.equal(card1.line, 0, 'the card right above the step\'s first line')
    assert.match(cardBody, /a calls b: the lead\./)
    assert.deepEqual(cardActions(cardBody), ['Next ›', 'Ask', 'More'], 'step 1: no Previous; More for the details')
    assert.ok(cardBody.includes('[Ask](command:codeNotes.askStep)'), 'Ask: a command without arguments')
    assert.ok(!cardBody.includes('More about'), 'details folded')
    assert.ok(!/flow\.ts:5|gone\.ts/.test(cardBody), 'no bare link row: the references are inside More')
    assert.equal(snap().notes.length, notesBefore, 'touring creates no notes')
    assert.equal(tour().statusShown, true)
    assert.equal(tour().status, '$(map) 1/3', 'the position only')
  }),

  test('More: the details and the refs (a missing file says so, a sentence keeps its link, a ref is listed once)', async () => {
    await vscode.commands.executeCommand('codeNotes.stepDetails', true)
    await until('details open', () => tour().card?.body?.includes('More about'))
    const body = () => tour().card!.body as string
    assert.match(body(), /~~gone\.ts:3~~ \(file gone\)/, 'a ref to a missing file says so, inside More')
    assert.match(body(), /\n\nRecipients builds the list of addresses a receipt goes to in \[address\.go:31-54\]\(command:codeNotes\.openAt[^)]* "lib\/mail\/address\.go:31-54"\)\./, `a ref may be a sentence: its token (a file in another directory) a link inside it: ${body()}`)
    assert.ok(!/address\.go[^\n]*gone/.test(body()), `an existing file in another directory is never "gone": ${body()}`)
    assert.match(body(), /\(and \[flow\.ts:6-7\]\(command:codeNotes\.openAt[^)]* "src\/flow\.ts:6-7"\)/, `a ref in parentheses, with a range, is a link named by its file, the path on hover: ${body()}`)
    assert.notEqual(tour().codeColumn, tour().mapColumn, 'the code opens beside the map, never over it')
    await windowShot('inline-card-more-open')
    if (process.env.CODE_NOTES_SHOTS) await tintShots()
    assert.match(body(), /card \\<name\\>/, `<name> stays text, not an HTML tag the renderer drops: ${body()}`)
    const body1 = body()
    assert.deepEqual(cardActions(body1), ['Next ›', 'Ask', 'Less'], 'More open: Less folds it again')
    const next = '[Next ›](command:codeNotes.nextStep)'
    assert.ok(body1.indexOf('a calls b: the lead') < body1.indexOf(next) && body1.indexOf(next) < body1.indexOf('More about'), `the lead, then ‹ › Ask, then what More opened: ${body1}`)
    assert.equal(body().split('[flow.ts:5]').length, 2, `a ref the details already link is not listed again: ${body()}`)
  }),

  test('a ref opens as a peek under the card, of a read-only copy for the step\'s own file; the step\'s tab, code and card stay', async () => {
    const folderUri = ctx.folder.uri.toString()
    await vscode.commands.executeCommand('codeNotes.openAt', folderUri, 'src/flow2.ts', 2, 2, 1)
    await until('ref peeked', () => /flow2\.ts$/.test(tour().peek?.uri ?? ''))
    assert.equal(tour().peek!.under, tour().card!.line, 'the peek opens right under the step card, not under the step\'s code')
    await quiet(300, 'the ref taking the editor or opening a tab')
    assert.match(vscode.window.activeTextEditor?.document.uri.path ?? '', /\/flow\.ts$/, 'the step stays the editor')
    assert.ok(!tabOpen(/\/flow2\.ts$/), 'no tab replaced or added for the ref')
    assert.equal(tour().card?.title, 'a calls b', 'the card is still there')
    await windowShot('inline-ref-peek')
    await vscode.commands.executeCommand('closeReferenceSearch').then(undefined, () => undefined)
    // A ref into the step's own file is a peek too, of a read-only copy (closing a peek of the file itself took the
    // card with it).
    await vscode.commands.executeCommand('codeNotes.openAt', folderUri, 'src/flow.ts', 5, 5, 1)
    await until('same-file ref peeked (a copy)', () => /^code-notes-ref:.*\/flow\.ts/.test(tour().peek?.uri ?? '') && tour().peek!.start === 4)
    assert.ok(/^src\/flow\.ts:/.test(at()) && !tour().ref, `the step's editor stays, nothing jumped: ${at()}`)
    await windowShot('inline-ref-peek-same-file')
    await vscode.commands.executeCommand('closeReferenceSearch').then(undefined, () => undefined)
    await quiet(300, 'the card going with the peek')
    assert.equal(tour().card?.title, 'a calls b', 'the card stays')
    assert.ok(tour().card?.expanded, 'the card stays open after the peek closes')
    await windowShot('inline-ref-peek-same-file-closed')
    await vscode.commands.executeCommand('codeNotes.backToStep')
    await until('back at step 1', () => at() === 'src/flow.ts:2')
  }),

  test('the step\'s tab replaced by another file, then Go Back: the card and the marker are back', async () => {
    await vscode.window.showTextDocument(vscode.Uri.file(wsPath('src', 'flow2.ts')), { preview: true, viewColumn: tour().codeColumn })
    await until('away from the step', () => /flow2\.ts$/.test(vscode.window.activeTextEditor?.document.uri.path ?? ''))
    await settle(300, 'VS Code\'s editor history taking the step\'s place')
    await vscode.commands.executeCommand('workbench.action.navigateBack')
    await until('Go Back: on the step, card and marker shown', () => at() === 'src/flow.ts:2' && /\/flow\.ts$/.test(tour().card?.file ?? '') && tour().card?.expanded && (tour().marked as string[]).some((x) => /\/flow\.ts$/.test(x)), 8000)
  }),

  test('Next to steps 2 and 3: the card above each step, one reused preview tab, the map keeps its group; the last step offers Finish', async () => {
    const mapColumn = tour().mapColumn
    await vscode.commands.executeCommand('codeNotes.nextStep')
    await until('step 2', () => tour().step === 2 && at() === 'src/flow.ts:6' && tour().card?.label === '2/3 · b returns')
    assert.equal(tour().card!.line, 4, 'step 2: the card right above its first line')
    await windowShot('inline-card-above-function')
    await vscode.commands.executeCommand('codeNotes.nextStep')
    await until('step 3, another file', () => tour().step === 3 && at() === 'src/flow2.ts:2')
    const codeGroup = vscode.window.tabGroups.all.find((g) => g.viewColumn === tour().codeColumn)!
    const textTabs = codeGroup.tabs.filter((x) => x.input instanceof vscode.TabInputText && /\/flow2?\.ts$/.test(x.input.uri.path))
    assert.equal(textTabs.length, 1, `one reused preview tab for the tour's files, no pile-up: ${textTabs.map((x) => x.label)}`)
    assert.ok(textTabs[0].isPreview)
    assert.equal(tour().mapColumn, mapColumn, 'the map kept its group')
    assert.deepEqual(cardActions(tour().card!.body!).slice(0, 2), ['‹ Previous', 'Finish'], 'the last step offers Finish')
    assert.ok(!/How does a get to c/.test(tour().card!.body!), 'no recap on the last step')
  }),

  test('Finish closes the step tab the walk opened; Next right after finishing is not step 1', async () => {
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
    const flowDoc = await vscode.workspace.openTextDocument(wsPath('src', 'flow.ts'))
    const editor = await vscode.window.showTextDocument(flowDoc, { viewColumn: tour().codeColumn })
    await editor.edit((b) => b.insert(new vscode.Position(0, 0), '// added\n// added\n'))
    await flowDoc.save()
    await until('step 2 followed the code', () => snap().journeys[0].at[1].start === 8)
    assert.equal(fs.readFileSync(demoPath(), 'utf8'), demoBytes, 'the journey file is not rewritten')
    await vscode.commands.executeCommand('codeNotes.previousStep')
    await until('back to step 2 at its new line', () => tour().step === 2 && at() === 'src/flow.ts:8')
  }),

  test('my own edit of a step\'s lines keeps the step on them, not stale', async () => {
    // The reader's own edit on a step's lines (typing, an applied fix): never "out of date".
    const step2 = () => [snap().journeys[0].at[1].start, snap().journeys[0].at[1].stale]
    const editor = flowEditor()
    const flowDoc = editor.document
    await editor.edit((b) => b.replace(flowDoc.lineAt(7).range, '  return 2 + 0'))
    await quiet(700, 'the step marked stale by my edit')
    assert.deepEqual(step2(), [8, false], 'an edit of mine on the step\'s line: not stale')
    await flowDoc.save()
    await quiet(700, 'the step marked stale once saved')
    assert.deepEqual(step2(), [8, false], 'nor once saved')
    await editor.edit((b) => b.replace(flowDoc.lineAt(7).range, '  return 2'))
    await flowDoc.save()
    await until('the code as the journey has it: fresh', () => !snap().journeys[0].at[1].stale && snap().journeys[0].at[1].start === 8)
  }),

  test('Ask about this step: a normal note on the step\'s lines, listed under its journey with its step, linking back', async () => {
    const notesBefore = snap().notes.length
    const asked = (await vscode.commands.executeCommand('codeNotes.askStep', 'Why does b return 2?')) as any
    await until('note created', () => snap().notes.length === notesBefore + 1)
    const question = stepQuestion()
    assert.ok(question && asked, 'the note exists')
    assert.equal(question.file, 'src/flow.ts')
    assert.deepEqual(question.range, { start: 8, end: 8 })
    assert.match(question.messages[0].body, /About the step “b returns” \(id `s-b`\) of the journey “Demo”/, 'the step by id and title, not its number')
    assert.deepEqual(question.extra?.journey ?? question.journey, { id: 'demo', step: 's-b', n: 2 }, 'the note carries the journey field the skill reads')
    assert.equal(question.session, undefined, 'a normal private note')
    assert.equal(question.unread, 0)
    const rows = journeysTree()
    const row = rows.findIndex((l) => /^ {6}note:Step 2 · Why does b return 2\?/.test(l))
    assert.ok(row > 0 && /^ {4}journey:Demo\b/.test(rows[row - 1]) && !/question/.test(rows[row - 1]), `listed right under its journey, with its step; no count on the row:\n${rows.join('\n')}`)
    assert.ok(!rows.some((l) => /^note:Why does b return 2/.test(l)), 'not a loose row too')
    const askedThread = await until('the asked note\'s thread', () => ctx.api.thread(question.id))
    assert.ok(!/openStepLink|About the step/.test(bodyOf(askedThread.comments[0])), 'on that very step: no back-link')
  }),

  test('a reply to a step question: "1 reply" on the journey row, "1 asked · new reply" on the card', async () => {
    appendMessage(stepQuestion()!.path, { author: 'claude', role: 'agent', body: 'Because it is the answer.', at: now() })
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

  test('End: the place is kept, the card and the status item go; then "◇ Step n of Demo" once per function', async () => {
    await vscode.commands.executeCommand('codeNotes.endJourney')
    await until('ended', () => !tour().touring && !tour().card && !tour().statusShown)
    assert.equal(snap().journeys[0].resume, 3)
    // Outside a walk, at most one quiet line per function: "◇ Step n of <journey>" (its first step there).
    const flowNow = await vscode.workspace.openTextDocument(flowUri())
    const fnLine = (name: string) => flowNow.getText().split('\n').findIndex((x) => x.startsWith(`export function ${name}(`)) + 1
    // Steps 1 and 2 are both in a(): one lens there, for step 1; step 3 in b().
    await until('one lens per function', async () => {
      const l = await stepLenses(flowUri())
      return l.length === 2 && l.includes(`${fnLine('a')}:◇ Step 1 of Demo`) && l.includes(`${fnLine('b')}:◇ Step 3 of Demo`)
    }, 15000)
    await vscode.window.showTextDocument(flowUri(), { viewColumn: vscode.ViewColumn.One })
    await windowShot('step-lens')
  }),

  test('step lenses: a file\'s top consts share one; a function gets one however its steps sit in it', async () => {
    const topPath = writeTopJourney()
    const topUri = vscode.Uri.file(wsPath('src', 'top.ts'))
    await vscode.workspace.openTextDocument(topUri)
    try {
      await until('top: one lens for the consts, one for send()', async () => (await stepLenses(topUri)).join('|') === '3:◇ Step 1 of Top|10:◇ Step 4 of Top', 15000)
    } finally {
      fs.unlinkSync(topPath)
    }
    await until('top gone', () => !snap().journeys.some((x: any) => x.id === 'top'))
  }),

  test('the journeys.codeLens setting turns the step lenses off', async () => {
    await setting('journeys.codeLens', false)
    try {
      await until('the setting turns them off', async () => !(await stepLenses(flowUri())).length)
    } finally {
      await setting('journeys.codeLens', undefined)
    }
    await until('back on', async () => (await stepLenses(flowUri())).length === 2, 15000)
  }),

  test('a step lens opens its step; none while walking', async () => {
    const step3Lens = (await codeLenses(flowUri())).find((l) => l.command?.title === '◇ Step 3 of Demo')!
    await vscode.commands.executeCommand(step3Lens.command!.command, ...(step3Lens.command!.arguments ?? []))
    await until('the lens opened that step', () => tour().touring && tour().step === 3)
    assert.ok(!(await stepLenses(flowUri())).length, 'no step lenses while walking')
    await vscode.commands.executeCommand('codeNotes.endJourney')
    await until('ended again', () => !tour().touring)
  }),

  test('End keeps a resumable place; Next resumes; the sidebar marks the running tour', async () => {
    // Not walking: the step question links back to its step, with the journey's name.
    await until('the back-link', () => /\[↩ Step 3 · Demo\]\(command:codeNotes\.openStepLink/.test(bodyOf(ctx.api.thread(stepQuestion()!.id)!.comments[0])))
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
