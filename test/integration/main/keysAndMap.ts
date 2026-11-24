// The chord keys (Ctrl+< / Ctrl+' with D A V), the tutorial's extension side, and the whole map: step numbers,
// function boxes and the "‹ Journeys" home list. Source: package.json (keybindings), src/tour/ (next/previous),
// the panel's message handlers (src/journeys/panel/features/), src/tour/tutorialSpot.ts, media/journey-map.js and
// media/journey-tutorial.js (driven through their own click/key handlers).
// The tutorial's webview side (bar and card texts, where the cards sit, clicks blocked under it) is checked in the
// panel harness, test/journey-map/shoot.mjs (`tutorial`); here: what the extension does with it.
import * as vscode from 'vscode'
import assert from 'assert'
import { appendMessage, now, quiet, settle, test } from '../helpers'
import { agentNote, writeNote } from '../fixtures'
import { at, closeAllEditors, ctx, noteById, notePath, tour, until } from './context'
import { UNREAD_FINDING } from './shared'

const mapClosed = () => until('map closed', () => tour().map === undefined)

/**
 * What the reader does on the page, through the page's own click and key handlers (the page's elements:
 * media/journey-map.js, journey-tutorial.js, journey-home.js). One place for the selectors this file relies on.
 */
const click = (selector: string) => ctx.api.mapSend({ type: 'test', click: selector })
const press = (key: string) => ctx.api.mapSend({ type: 'test', key })
const onPage = {
  skipTutorial: () => click('.tbar .tskip'),
  nextCard: () => press('ArrowRight'),
  tutorialDone: () => click('.tcard .tnext'),
  stepNumber: (n: number) => click(`.gnum[data-n="${n}"]`),
  functionBox: (id: string) => click(`.gbox.leaf[data-id="${id}"]`),
  journeysList: () => click('.homeb'),
  firstRow: () => click('.jrow'),
  enter: () => press('Enter'),
}

/** UNREAD_FINDING with a reply not read yet: written the first time, a reply added after that. */
async function anUnreadNote(): Promise<void> {
  if (!noteById(UNREAD_FINDING)) writeNote(ctx.notesDir, UNREAD_FINDING, agentNote('src/flow2.ts', 1, 'Unread finding'))
  else if (noteById(UNREAD_FINDING).unread !== 1) appendMessage(notePath(UNREAD_FINDING), { author: 'claude', role: 'agent', body: 'One more thing', at: now() })
  await until('an unread note', () => noteById(UNREAD_FINDING)?.unread === 1)
}

export const keysAndMapTests = [
  // The chords themselves are package.json's (test/keybindings.test.ts); here: VS Code takes the scan-code chord.
  test('VS Code accepts the scan-code chord Ctrl+< D', async () => {
    await closeAllEditors()
    await vscode.commands.executeCommand('workbench.action.openDefaultKeybindingsFile')
    const shown = await until('default keybindings shown', () => vscode.window.activeTextEditor?.document.getText().includes('codeNotes.next') && vscode.window.activeTextEditor.document.getText())
    assert.ok(shown.includes('"key": "ctrl+[IntlBackslash] d"'), 'VS Code lists the scan-code chord')
    await closeAllEditors()
  }),

  test('D with a map but no tour reads the unread note; V shows the map; hints use the prefix pressed', async () => {
    await closeAllEditors()
    await mapClosed()
    await anUnreadNote()
    await vscode.commands.executeCommand('codeNotes.showMap', { prefix: '<' }) // V, pressed as Ctrl+< V
    await until('map open, no tour', () => tour().map === 'demo' && tour().step === 0 && tour().mapBoxes === 5, 10000)
    assert.equal(tour().key, 'Ctrl+<', 'hints follow the prefix used')
    // D with a map open but no tour: the next unread reply, as the status bar says, never a silent resume.
    await vscode.commands.executeCommand('codeNotes.next', { prefix: "'" })
    await until('D: the unread note with the map open', () => noteById(UNREAD_FINDING).unread === 0)
    assert.equal(tour().touring, false, 'D after End does not restart the tour')
    assert.equal(tour().key, "Ctrl+'")
    await settle(600, 'the reveal\'s own cursor move (it reads the note at the cursor)')
  }),

  test('D outside a journey and its map reads the unread note, never starts a journey', async () => {
    await closeAllEditors()
    await mapClosed()
    await anUnreadNote()
    await vscode.commands.executeCommand('codeNotes.next', { prefix: "'" })
    await until('D: the unread note, not a step', () => at() === 'src/flow2.ts:1' && noteById(UNREAD_FINDING).unread === 0)
    assert.equal(tour().touring, false, 'D outside a journey and its map never starts one')
  }),

  test('D/A walk the steps of a journey', async () => {
    await closeAllEditors()
    await vscode.commands.executeCommand('codeNotes.startJourney', 'demo')
    await until('step 1', () => tour().step === 1 && at() === 'src/flow.ts:4')
    await vscode.commands.executeCommand('codeNotes.next')
    await until('D: step 2', () => tour().step === 2 && at() === 'src/flow.ts:8')
    await vscode.commands.executeCommand('codeNotes.previous')
    await until('A: step 1', () => tour().step === 1)
    await vscode.commands.executeCommand('codeNotes.endJourney')
  }),

  test('tutorial: offered once, Skip persists, replay command, its cards (one boxes the step in the editor), Done finishes and walks the steps', async () => {
    // Card 2 boxes the step in the editor; Done walks the tour from step 1. Driven through the webview's own handlers.
    await ctx.api.resetTutorial()
    await closeAllEditors()
    await mapClosed()
    await vscode.commands.executeCommand('codeNotes.showMap')
    await until('the bar is offered', () => tour().tutorial.bar === 1 && tour().mapBoxes === 5, 10000)
    onPage.skipTutorial()
    await until('Skip remembered', () => tour().tutorial.seen && tour().tutorial.skip === 1)
    await closeAllEditors()
    await mapClosed()
    await vscode.commands.executeCommand('codeNotes.showMap')
    await until('map again', () => tour().mapBoxes === 5, 10000)
    await quiet(800, 'the bar offered again')
    assert.equal(tour().tutorial.bar, 1, 'not offered again after Skip')
    await vscode.commands.executeCommand('codeNotes.tutorial')
    await until('card 1', () => tour().tutorial.card === 1)
    // Three cards here (the storyline, the card in the editor, the map); journeys with links and animations have two more.
    onPage.nextCard()
    // The card about the step card: a step is open in the editor and its lines are boxed there.
    await until('card 2: a step open in the editor, its lines boxed', () => tour().tutorial.card === 2 && tour().touring && tour().step === 1 && !!tour().tutorial.spot && tour().tutorial.mark === 'card' && /findMatchHighlightBackground\);">Next ›<\/span>/.test(tour().card?.body ?? ''), 10000)
    onPage.nextCard()
    await until('the map card: the box in the editor is gone, the card as usual', () => tour().tutorial.card > 2 && !tour().tutorial.spot && !/findMatchHighlightBackground/.test(tour().card?.body ?? ''))
    // The last card's Done finishes; the walk goes on where it was left.
    onPage.tutorialDone()
    await until('Done finishes the tutorial and walks from where it was left', () => tour().tutorial.done === 1 && tour().touring && tour().step === 1, 8000)
    await vscode.commands.executeCommand('codeNotes.endJourney')
  }),

  test('whole map: step numbers walk, boxes open code; home lists journeys and walks one', async () => {
    // Home: "‹ Journeys" lists the journeys over the walk (it keeps its place, card and status item); a row walks that one.
    await vscode.commands.executeCommand('codeNotes.startJourney', 'demo')
    await until('touring demo', () => tour().touring && tour().step === 1 && tour().mapFocus === 'fa', 8000)
    onPage.stepNumber(3)
    await until('a step number walks there, the map follows', () => tour().step === 3 && tour().mapFocus === 'fc', 8000)
    await closeAllEditors()
    await vscode.commands.executeCommand('codeNotes.showMap')
    await until('map shown', () => tour().mapBoxes === 5, 10000)
    onPage.functionBox('fb')
    await until('a function box opens its code', () => /^src\/flow\.ts:/.test(at() ?? ''), 8000)
    onPage.journeysList()
    await until('the list opens over the map', () => tour().mapTitle === 'Journeys', 8000)
    await quiet(300, 'the walk losing its place under the list')
    assert.ok(tour().touring && tour().step === 3, 'the walk keeps its place under the list')
    // 0.24: a click selects (and previews); Enter walks.
    onPage.firstRow()
    await quiet(300, 'a click on a row walking it')
    assert.ok(tour().mapTitle === 'Journeys' && tour().step === 3, 'a click on a row only selects it')
    onPage.enter()
    await until('a journey from home walks again where it was left', () => tour().touring && tour().journey === 'demo' && tour().step === 3 && tour().mapTitle !== 'Journeys', 8000)
    await vscode.commands.executeCommand('codeNotes.endJourney')
  }),
]
