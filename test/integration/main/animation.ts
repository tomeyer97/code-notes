// A step with code links, value hints and an animation (prototype): phrases of the card link to their lines; a
// value hint shows what a variable holds in the example run; the row's toggle plays the scene in place of the map and
// each beat lights the line that does it; back, forward and "Map" all work. Then: files opened over the panel move to
// the code group. Source: src/codeLinks.ts, src/codeLinkText.ts, src/valueHints.ts, src/beats.ts, src/beatLine.ts,
// src/tour/card.ts; the panel's side in media/journey-scene.js (test/journey-scene/check.mjs).
import * as vscode from 'vscode'
import assert from 'assert'
import { focusGroup, quiet, settle, test, windowShot } from '../helpers'
import { journey, step, writeJourney, writeLines } from '../fixtures'
import { ctx, journeysDir, lenses, snap, tour, until, wsPath } from './context'

/* eslint-disable @typescript-eslint/no-explicit-any */
const animUri = () => vscode.Uri.file(wsPath('src', 'anim.ts')).toString()
const tokUri = () => vscode.Uri.file(wsPath('src', 'tok.ts')).toString()
/** The code group's editor (never the map's). */
const codeGroupEditor = () => vscode.window.visibleTextEditors.find((e) => e.viewColumn !== tour().mapColumn && e.document.uri.scheme === 'file')
const onScreen = (line: number) => !!codeGroupEditor()?.visibleRanges.some((r) => r.start.line <= line && r.end.line >= line)
const codeLink = (i: number) => vscode.commands.executeCommand('codeNotes.codeLink', tour().codeLinks.key, i)
/** CODE_NOTES_ANIM_SHOTS=<dir>: pictures of this block's states, for a person to look at. */
const shot = (name: string) => windowShot(name, { dirVar: 'CODE_NOTES_ANIM_SHOTS', wait: 1500 })
const LONG_VALUE = 'a value far longer than forty characters, so it is cut short'

/** src/anim.ts (save, store) and src/tok.ts, and the journey "anim": step 1 with a scene, links and values, step 2 a scene. */
function writeAnimJourney() {
  writeLines(wsPath('src', 'tok.ts'), ['import { readToken, use } from "./lib"', 'export function main() {', '  const token = readToken()', '  use(token)', '  return 0', '}'])
  writeLines(wsPath('src', 'anim.ts'), ['export function save(run: object) {', '  const body = JSON.stringify(run)', '  return store(body)', '}', 'function store(b: string) { return b.length }'])
  const scene = {
    actors: [{ id: 'svc', type: 'service', col: 0, label: 'Server', fn: 'save()', checks: ['encode', 'store'] }, { id: 'db', type: 'table', col: 1, label: 'Database', rows: [{ id: 'run 1', chips: ['queued'] }] }],
    wires: [['svc', 'db']],
    beats: [
      { focus: 'svc', caption: 'It encodes the run.', set: { svc: { done: 1 } }, code: { file: 'src/anim.ts', line: 2, text: 'const body = JSON.stringify(run)' } },
      // written for line 9: the code moved, the line is found by what it says
      { focus: 'db', caption: 'It stores it.', set: { svc: { done: 2 }, db: { show: 1, hi: 0 } }, packet: { from: 'svc', to: 'db', label: 'insert' }, code: { file: 'src/anim.ts', line: 9, text: 'return store(body)' } },
      // in another file than the step's: the card is out of sight while it is lit
      { focus: 'svc', caption: 'It uses the token.', code: { file: 'src/tok.ts', line: 4, text: 'use(token)' } },
      { focus: 'all', caption: 'Done.' },
    ],
  }
  const scene2 = { actors: scene.actors, wires: scene.wires, beats: [{ focus: 'svc', caption: 'It reads the token.', code: { file: 'src/tok.ts', line: 3, text: 'const token = readToken()' } }] }
  const value = (name: string, v: string, file: string, line: number, text: string, note?: string) => ({ name, value: v, ...(note ? { note } : {}), file, line, text })
  const link = (phrase: string, file: string, line: number, text: string) => ({ phrase, file, start: line, end: line, text })
  writeJourney(journeysDir(), journey('anim', [
    step('src/anim.ts', 1, 4, {
      id: 'a1', title: 'save stores the run', lead: 'It encodes the run, then stores it <fast>, with the token.', details: 'Afterwards it reports the length.',
      // tok.ts:3 repeats the "with the token" link: not listed under More; tok.ts:5 is listed
      refs: ['src/tok.ts:3', 'src/tok.ts:5'], scene,
      values: [value('body', '{ "id": 1 }', 'src/anim.ts', 2, 'const body = JSON.stringify(run)'), value('stored', '11', 'src/anim.ts', 8, 'return store(body)', 'the length of the body'), value('gone', '1', 'src/anim.ts', 1, 'no such line'),
        value('token', LONG_VALUE, 'src/tok.ts', 3, 'const token = readToken()', 'from the env')],
      links: [link('encodes the run', 'src/anim.ts', 2, 'const body = JSON.stringify(run)'), link('stores it', 'src/anim.ts', 7, 'return store(body)'), link('never said', 'src/anim.ts', 1, ''), link('reports the length', 'src/anim.ts', 5, 'function store(b: string) { return b.length }'),
        link('with the token', 'src/tok.ts', 3, 'const token = readToken()')],
    }),
    step('src/anim.ts', 5, 5, { id: 'a2', title: 'store measures it', lead: 'It returns the length.', scene: scene2 }),
  ], {
    question: 'How is a run saved?', title: 'Anim', summary: 'save stores it.',
    nodes: [{ id: 'app', kind: 'system', label: 'App', summary: '' }, { id: 'm', kind: 'module', label: 'anim', summary: '', parent: 'app' }, { id: 'f', kind: 'function', label: 'save', summary: '', parent: 'm' }],
  }))
}

/** Inserts `text` at the top of src/anim.ts, or deletes its first `lines` lines (as a WorkspaceEdit: unsaved). */
async function editAnim(change: { insert: string } | { deleteLines: number }) {
  const edit = new vscode.WorkspaceEdit()
  if ('insert' in change) edit.insert(vscode.Uri.parse(animUri()), new vscode.Position(0, 0), change.insert)
  else edit.delete(vscode.Uri.parse(animUri()), new vscode.Range(0, 0, change.deleteLines, 0))
  await vscode.workspace.applyEdit(edit)
}
const saveAnim = () => vscode.workspace.textDocuments.find((d) => d.uri.toString() === animUri())?.save()

export const animationTests = [
  test('code links: the card\'s phrases link to their lines, found where they moved; the phrase behind More marks its lines only while More is open', async () => {
    writeAnimJourney()
    await until('the journey with a scene is read', () => snap().journeys.some((x: any) => x.id === 'anim'), 10000)
    await vscode.commands.executeCommand('codeNotes.openJourney', 'anim')
    await until('walking it, map drawn', () => tour().journey === 'anim' && tour().step === 1 && tour().mapBoxes > 0, 10000)
    assert.equal(tour().beat, undefined, 'nothing lit before the animation is on')
    // Phrases of the card's text link to their lines (own colour), marked faintly while the step is open; a click lights one.
    await until('the card has the two phrases as code links, the linked lines found (one had moved)', () => /\[<span style="color:var\(--vscode-foreground\);background-color:var\(--vscode-toolbar-hoverBackground\);">encodes <\/span><wbr><span [^>]*>the <\/span><wbr><span [^>]*>run<\/span>\]\(command:codeNotes\.codeLink/.test(tour().card?.body ?? '') && tour().codeLinks.at[0]?.start === 1 && tour().codeLinks.at[1]?.start === 2, 10000)
    const body = () => tour().card!.body as string
    assert.ok(/>stores <\/span><wbr><span [^>]*>it<\/span>\]\(command:codeNotes\.codeLink/.test(body()) && !/said<\/span>/.test(body()), `a phrase not in the text is no link: ${body()}`)
    assert.ok(body().includes('\\<fast\\>'), 'other tags in the text stay text')
    assert.ok(!body().includes('​'), 'no zero-width spaces in the card (copied text must match a search)')
    assert.equal(tour().codeLinks.active, -1, 'none lit before a click')
    // Only phrases on the card have their lines marked: the one behind More only while it is open.
    assert.deepEqual(tour().codeLinks.visible, [0, 1, 4], 'More closed: the phrase in the details marks nothing')
    await vscode.commands.executeCommand('codeNotes.stepDetails', true)
    await until('More open: its phrase is a link and its lines are marked', () => />reports <\/span><wbr><span [^>]*>the <\/span><wbr><span [^>]*>length<\/span>/.test(tour().card?.body ?? '') && tour().codeLinks.visible.join() === '0,1,3,4', 10000)
    // A file:line under More that a code link already points at is not listed again.
    assert.ok(/\[tok\.ts:5\]/.test(body()) && !/\[tok\.ts:3\]/.test(body()), `the ref repeating a link is dropped: ${body()}`)
    await vscode.commands.executeCommand('codeNotes.stepDetails', false)
    await until('More closed again: no longer marked', () => tour().codeLinks.visible.join() === '0,1,4', 10000)
  }),

  test('a code link lights its lines with the caret left where it was; a second click turns it off; Back, or the caret leaving the lines, ends it', async () => {
    await codeLink(1)
    const caretBefore = codeGroupEditor()?.selection.active.line
    await until('clicked: that phrase\'s lines lit, the caret left where it was (typing next never lands in the code)', () => tour().codeLinks.active === 1 && /anim\.ts$/.test(codeGroupEditor()?.document.uri.path ?? '') && codeGroupEditor()?.selection.active.line === caretBefore, 10000)
    assert.equal(tour().step, 1, 'still on the step')
    // A link into the card's file, on screen with the card: no scroll away from it, no way back needed.
    await quiet(300, 'a scroll away from the card, or a Back row')
    assert.equal(tour().codeLinks.back, false, 'the card is on screen with the lit lines: no Back row')
    assert.ok(onScreen(tour().card!.line!) && onScreen(2), 'card and lit lines both on screen')
    assert.ok(!(await lenses()).some((x) => /Back/.test(x)), `no Back lens: ${await lenses()}`)
    await shot('anim-1-link-same-file')
    // A second click on the lit phrase turns it off.
    await codeLink(1)
    await until('second click: off', () => tour().codeLinks.active === -1, 10000)
    await codeLink(1)
    await until('lit again', () => tour().codeLinks.active === 1, 10000)
    await vscode.commands.executeCommand('codeNotes.codeLinkBack')
    await until('"Back to step 1": at the step again, no phrase lit, the faint marks stay', () => tour().codeLinks.active === -1 && tour().codeLinks.at[1]?.start === 2 && vscode.window.activeTextEditor?.selection.active.line === 0 && !!tour().card, 10000)
    // Moving away from the lit lines (VS Code's Go Back, a click elsewhere) ends the link.
    await codeLink(0)
    await until('another phrase', () => tour().codeLinks.active === 0, 10000)
    await settle(600, 'the link\'s own reveal placing the caret first')
    vscode.window.activeTextEditor!.selection = new vscode.Selection(4, 0, 4, 0)
    await until('the caret left the lit lines: nothing lit', () => tour().codeLinks.active === -1, 10000)
  }),

  test('a code link into another file shows the way back as a control; value hints are capped, sit above their lines and follow edits with the links', async () => {
    // A link into another file: the card is out of sight, so the way back is shown, as a control, alone on its row.
    await codeLink(4)
    await until('the other file\'s line lit, the way back shown', () => tour().codeLinks.active === 4 && tour().codeLinks.back && vscode.window.activeTextEditor?.document.uri.toString() === tokUri(), 10000)
    // Lenses count lines from 1, as the editor does; tour().values from 0 ("tok.ts:2" is the lens on line 3).
    const tokLenses = await lenses(vscode.Uri.parse(tokUri()))
    assert.ok(tokLenses.includes('3:$(arrow-left) Back to step 1'), `the way back reads as a control: ${tokLenses}`)
    assert.ok(!tokLenses.some((x) => x.startsWith('3:token =')), `no value hint on the Back row: ${tokLenses}`)
    await shot('anim-2-link-other-file-back')
    // What VS Code's Go Back does here: the step's file comes back in the code group (navigateBack itself depends on
    // the editor history the earlier tests left, so it is not driven here).
    await settle(300, 'the Back row drawn before the step\'s file comes back')
    await vscode.window.showTextDocument(vscode.Uri.parse(animUri()), { viewColumn: codeGroupEditor()!.viewColumn, preserveFocus: false })
    await until('back in the step\'s file: the link is no longer lit, and its hint is back', async () => tour().codeLinks.active === -1 && (await lenses(vscode.Uri.parse(tokUri()))).some((x) => x.startsWith('3:token =')), 10000)
    // A long value is cut so its note stays visible.
    assert.ok(tour().values.includes(`tok.ts:2: token = ${LONG_VALUE.slice(0, 39).trimEnd()}…  ·  from the env`), `the long value is capped: ${tour().values}`)
    // Value hints: what a variable holds in the example run, faint, above its line (found again when the line moved), while the step is open.
    assert.deepEqual(tour().values.filter((x: string) => x.startsWith('anim.ts')), ['anim.ts:1: body = { "id": 1 }', 'anim.ts:2: stored = 11  ·  the length of the body'], 'the step\'s values, at their lines')
    await vscode.commands.executeCommand('codeNotes.codeLinkBack')
    await until('back at the step', () => vscode.window.activeTextEditor?.document.uri.toString() === animUri() && !!tour().card, 10000)
    assert.ok((await lenses()).includes('2:body = { "id": 1 }') && (await lenses()).includes('3:stored = 11  ·  the length of the body'), `shown above the lines: ${await lenses()}`)
    // Hints and link targets follow edits to the file.
    await editAnim({ insert: '// one\n// two\n' })
    await until('after two lines inserted above: hints and links moved with their lines', () => tour().values.includes('anim.ts:3: body = { "id": 1 }') && tour().codeLinks.at[0]?.start === 3 && tour().codeLinks.at[1]?.start === 4, 10000)
    await editAnim({ deleteLines: 2 })
    await until('and back', () => tour().values.includes('anim.ts:1: body = { "id": 1 }') && tour().codeLinks.at[0]?.start === 1, 10000)
    await saveAnim()
    // A picture of the card with its code links, one lit (CODE_NOTES_ANIM_SHOTS only).
    if (process.env.CODE_NOTES_ANIM_SHOTS) {
      await codeLink(1)
      await windowShot('anim-3-card-link-lit', { dirVar: 'CODE_NOTES_ANIM_SHOTS', wait: 4000 })
      await codeLink(1)
    }
  }),

  test('a step\'s animation: toggle, beats forward and back, each lights its line (found again when moved, following edits); the step comes back when the scene stops; code links stay near the card, toggle, end on Go Back; files opened over the panel move to the code group', async () => {
    // (Code links: the tests above.)
    ctx.api.mapSend({ type: 'test', click: '.animbtn' })
    await until('beat 1: its line lit, the caret on it (one lit line)', () => tour().beat?.uri === animUri() && tour().beat!.line === 1 && codeGroupEditor()?.selection.active.line === 1, 10000)
    // The step's own delayed scrolls do not take beat 1's line away.
    await settle(700, 'the step\'s delayed reveals')
    assert.ok(onScreen(1) && tour().beat?.line === 1, 'beat 1 still lit and on screen after the step\'s reveals')
    // The lit line follows an edit too.
    await editAnim({ insert: '// one\n' })
    await until('the lit beat moved with its line', () => tour().beat?.line === 2, 10000)
    await editAnim({ deleteLines: 1 })
    await until('and back', () => tour().beat?.line === 1, 10000)
    await saveAnim()
    ctx.api.mapSend({ type: 'test', click: '.scn-next' })
    await until('beat 2: the moved line is found by its text; no example, no lens', () => tour().beat?.line === 2, 10000)
    await shot('anim-3-beat-in-step')
    ctx.api.mapSend({ type: 'test', click: '.scn-next' })
    await until('beat 3: a line in another file, the card out of sight', () => tour().beat?.uri === tokUri() && tour().beat!.line === 3 && codeGroupEditor()?.document.uri.toString() === tokUri(), 10000)
    // The panel gets that line with the lines around it, for its own small view of the code.
    const beatCode = tour().beatCode
    assert.ok(beatCode?.line === 4 && beatCode.lines[beatCode.line - beatCode.from]?.length > 0, `the beat's lines for the panel: ${JSON.stringify(beatCode)}`)
    ctx.api.mapSend({ type: 'test', click: '.scn-next' })
    // A beat without code gives the editor back to the step: its file, its lines, its card.
    await until('a beat without code lights nothing, and the step is back', () => !tour().beat && codeGroupEditor()?.document.uri.toString() === animUri() && !!tour().card && onScreen(0), 10000)
    ctx.api.mapSend({ type: 'test', click: '.scn-prev' })
    await until('back: beat 3 again, in the other file', () => tour().beat?.uri === tokUri() && codeGroupEditor()?.document.uri.toString() === tokUri(), 10000)
    assert.equal(tour().step, 1, 'still on the step')
    ctx.api.mapSend({ type: 'test', click: '.scn-close' })
    // "Map" gives the editor back to the step.
    await until('"Map": the animation goes, the line is no longer lit, the step and its card are back', () => !tour().beat && codeGroupEditor()?.document.uri.toString() === animUri() && !!tour().card && onScreen(0), 10000)
    // ▶ then the next step: its beat 1 is what is on screen, not the step's own reveal.
    ctx.api.mapSend({ type: 'test', click: '.animbtn' })
    // The animation comes back at the beat it was left on (kept per step for the walk): beat 3, in the other file.
    await until('the animation again, at the beat it was left on', () => tour().beat?.uri === tokUri() && tour().beat!.line === 3, 10000)
    await vscode.commands.executeCommand('codeNotes.nextStep')
    await until('step 2, the animation on: its beat 1 (another file) lit and on screen', () => tour().step === 2 && tour().beat?.uri === tokUri() && tour().beat!.line === 2 && codeGroupEditor()?.document.uri.toString() === tokUri(), 10000)
    await settle(700, 'the step\'s delayed reveals')
    assert.ok(tour().beat?.line === 2 && codeGroupEditor()?.document.uri.toString() === tokUri() && onScreen(2), 'still the beat after the step\'s delayed reveals')
    // Ctrl+' P: the command exists and runs (the panel's answer to it is the webview's).
    await vscode.commands.executeCommand('codeNotes.toggleAnimation', { prefix: "'" })
    ctx.api.mapSend({ type: 'test', click: '.scn-close' })
    await until('closed: step 2 is back', () => !tour().beat && codeGroupEditor()?.document.uri.toString() === animUri(), 10000)
    // With the panel's group active, a file opened without a group (Ctrl+P) ends up beside it, never over the journey.
    const mapColumn = tour().mapColumn as number
    const flowTabIn = (g: vscode.TabGroup) => g.tabs.some((t) => t.input instanceof vscode.TabInputText && t.input.uri.path.endsWith('/flow.ts'))
    await focusGroup(mapColumn)
    await until('the panel\'s group is active', () => vscode.window.tabGroups.activeTabGroup.viewColumn === mapColumn, 10000)
    await settle(500, 'the focus settling in the panel\'s group')
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(wsPath('src', 'flow.ts')))
    await until('the file opened outside the panel\'s group', () => vscode.window.tabGroups.all.some((g) => g.viewColumn !== mapColumn && flowTabIn(g)), 10000)
    await until('nothing left over the journey panel', () => !vscode.window.tabGroups.all.find((g) => g.viewColumn === mapColumn)!.tabs.some((t) => t.input instanceof vscode.TabInputText), 10000)
    // Only the panel's group: the code's group still takes a file opened from it.
    const groupsBefore = vscode.window.tabGroups.all.length
    const codeColumn = vscode.window.tabGroups.all.find((g) => g.viewColumn !== mapColumn && flowTabIn(g))!.viewColumn
    await focusGroup(codeColumn)
    await until('the code group is active', () => vscode.window.tabGroups.activeTabGroup.viewColumn === codeColumn, 10000)
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(tokUri()))
    await until('tok.ts opened in the code group, not in a new one', () => vscode.window.tabGroups.activeTabGroup.viewColumn === codeColumn && vscode.window.activeTextEditor?.document.uri.toString() === tokUri(), 10000)
    assert.equal(vscode.window.tabGroups.all.length, groupsBefore, 'the code group takes files as before')
    await shot('anim-4-file-kept-off-panel')
  }),
]

