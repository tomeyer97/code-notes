// Calls into the window per user action. Over Remote-SSH the extension host runs on the remote machine and each awaited
// call into the window (show a file, a context key, a stored value) waits one network round trip, so an action that
// awaits six of them in a row takes six round trips. This counts them for the actions people repeat all the time
// (a code link, Back, the next and the previous step, a link from a chat) and checks the counts stay small.
// CODE_NOTES_RTT_MS=<ms>: each such call also waits that long (a slow link), and the time each action takes is printed.
// It writes its own files and journeys (src/trips/), so it needs nothing another test left. The counter: helpers.ts.
import * as vscode from 'vscode'
import * as fs from 'fs'
import assert from 'assert'
import { EXT_ID, callCounter, quiet, settle, test } from '../helpers'
import { journey, step, writeJourney, writeLines } from '../fixtures'
import { ctx, journeysDir, snap, tour, until, wsPath } from './context'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Counter = ReturnType<typeof callCounter>
/** Each action's calls into the window and its time, by a short name. */
type Measured = Record<string, { calls: string[]; ms: number }>

const saveUri = () => vscode.Uri.file(wsPath('src', 'trips', 'save.ts')).toString()
const tokenUri = () => vscode.Uri.file(wsPath('src', 'trips', 'token.ts')).toString()
const activeUri = () => vscode.window.activeTextEditor?.document.uri.toString()

/** What each action may call at most besides storing its place (stored in the background, not waited for). */
const MOST: Record<string, number> = { next: 1, previous: 1, link: 1, back: 1, same: 0, chatBack: 1 }

/** Opening a step (Next, Previous, Back to the step) waits for one more round trip, on purpose: an editor layout read
 *  after the step is shown, so the code beside the journey panel keeps its 80 columns. Counted apart from MOST. */
const LAYOUT_PROBE = 'command vscode.getEditorLayout'
const STEP_ACTIONS = new Set(['next', 'previous', 'back'])

/** The code link that goes into another file than the card's, and the one into the card's own file. */
const TO_OTHER_FILE = 1, TO_CARD_FILE = 0

/** src/trips/save.ts and src/trips/token.ts, and the journey "trips": step 1 links into both files, step 2. */
function writeTrips(): string {
  writeLines(wsPath('src', 'trips', 'token.ts'), ['import { readToken, use } from "./lib"', 'export function main() {', '  const token = readToken()', '  use(token)', '  return 0', '}'])
  writeLines(wsPath('src', 'trips', 'save.ts'), ['export function save(run: object) {', '  const body = JSON.stringify(run)', '  return store(body)', '}', 'function store(b: string) { return b.length }'])
  const link = (phrase: string, file: string, line: number, text: string) => ({ phrase, file, start: line, end: line, text })
  return writeJourney(journeysDir(), journey('trips', [
    step('src/trips/save.ts', 1, 4, {
      id: 't1', title: 'save stores the run', lead: 'It encodes the run, then stores it with the token.',
      links: [link('encodes the run', 'src/trips/save.ts', 2, 'const body = JSON.stringify(run)'), link('with the token', 'src/trips/token.ts', 3, 'const token = readToken()')],
    }),
    step('src/trips/save.ts', 5, 5, { id: 't2', title: 'store measures it', lead: 'It returns the length.' }),
  ], { question: 'How is a run saved?', title: 'Trips' }))
}

/** Step 1 of "trips": Next, Previous, a code link into another file, Back, a code link into the card's own file. */
async function walkTrips(c: Counter, r: Measured): Promise<void> {
  await vscode.commands.executeCommand('codeNotes.openJourney', 'trips')
  await until('walking trips', () => tour().journey === 'trips' && tour().step >= 1, 10000)
  if (tour().step !== 1) await vscode.commands.executeCommand('codeNotes.previousStep')
  await until('step 1', () => tour().step === 1 && !!tour().card, 10000)
  await settle(500, 'step 1\'s own reveals')
  r.next = await c.measure(
    'next step',
    () => vscode.commands.executeCommand('codeNotes.nextStep'),
    () => tour().step === 2 && !!tour().card,
  )
  await settle(300, 'step 2\'s own reveals')
  r.previous = await c.measure(
    'previous step',
    () => vscode.commands.executeCommand('codeNotes.previousStep'),
    () => tour().step === 1 && !!tour().card && activeUri() === saveUri(),
  )
  await settle(300, 'step 1\'s own reveals')
  r.link = await c.measure(
    'code link into another file',
    () => vscode.commands.executeCommand('codeNotes.codeLink', tour().codeLinks.key, TO_OTHER_FILE),
    () => tour().codeLinks.active === TO_OTHER_FILE && tour().codeLinks.back,
  )
  await settle(300, 'the link\'s own reveal')
  r.back = await c.measure(
    'Back to the step',
    () => vscode.commands.executeCommand('codeNotes.codeLinkBack'),
    () => tour().codeLinks.active === -1 && activeUri() === saveUri() && !!tour().card,
  )
  await settle(300, 'the step\'s own reveals')
  r.same = await c.measure(
    'code link into the card\'s file',
    () => vscode.commands.executeCommand('codeNotes.codeLink', tour().codeLinks.key, TO_CARD_FILE),
    () => tour().codeLinks.active === TO_CARD_FILE,
  )
  await vscode.commands.executeCommand('codeNotes.codeLink', tour().codeLinks.key, TO_CARD_FILE)
  await until('off again', () => tour().codeLinks.active === -1, 10000)
}

/**
 * Next, Next, Next before the first has shown anything: the walk ends on the last step asked for, its file and its
 * card (an older step never shows its file or takes the newer card away). Steps in four files.
 */
async function rapidNext(c: Counter, r: Measured): Promise<void> {
  const files = ['hop1.ts', 'hop2.ts', 'hop3.ts', 'hop4.ts']
  for (const f of files) writeLines(wsPath('src', 'trips', f), [`export const at = '${f}'`])
  const hopSteps = files.map((f, k) => step(`src/trips/${f}`, 1, 1, { id: `h${k}`, title: `In ${f}`, lead: `Step ${k + 1}.` }))
  const hopPath = writeJourney(journeysDir(), journey('hop', hopSteps, { question: 'Where does it go?', title: 'Hop' }))
  await until('hop read', () => snap().journeys.some((x: any) => x.id === 'hop'), 10000)
  await vscode.commands.executeCommand('codeNotes.openJourney', 'hop')
  await until('walking hop', () => tour().journey === 'hop' && tour().step === 1 && !!tour().card, 10000)
  await settle(500, 'step 1\'s own reveals')
  const last = files.length
  const onLastStep = () => tour().step === last && !!tour().card && vscode.window.activeTextEditor?.document.uri.path.endsWith(`/src/trips/${files[last - 1]}`) === true
  r.rapid = await c.measure(
    `Next ×${last - 1} at once`,
    async () => { await Promise.all(files.slice(1).map(() => vscode.commands.executeCommand('codeNotes.nextStep'))) },
    onLastStep,
  )
  await quiet(1000, 'an older step taking the editor or the card back')
  const where = `step ${tour().step}, card ${!!tour().card}, editor ${vscode.window.activeTextEditor?.document.uri.path}`
  assert.ok(onLastStep(), `after quick Nexts: ${where}`)
  await vscode.commands.executeCommand('codeNotes.endJourney')
  fs.rmSync(hopPath)
}

/** Sets `ed`'s selection and waits until the chat link watcher has seen it (it reads every selection event). */
async function select(ed: vscode.TextEditor, sel: vscode.Selection, what: string): Promise<void> {
  const seen = snap().claudeLinks.selections
  ed.selection = sel
  await until(what, () => snap().claudeLinks.selections > seen, 10000)
}

/** A link from a chat (its vscode:// link): its lines lit, Back to where the reader was. */
async function chatLinks(c: Counter, r: Measured): Promise<void> {
  await vscode.commands.executeCommand('codeNotes.endJourney')
  await until('the walk ended', () => !tour().journey || !tour().step, 10000)
  // Set up with chat links off (a caret restored at a line start right after a show reads as a link).
  const links = vscode.workspace.getConfiguration('codeNotes')
  await links.update('claudeLinks', false, vscode.ConfigurationTarget.Workspace)
  await until('chat links off', () => snap().claudeLinks.enabled === false, 10000)
  const tok = await vscode.window.showTextDocument(vscode.Uri.parse(tokenUri()), { preview: false })
  await select(tok, new vscode.Selection(3, 2, 3, 2), 'the caret move seen with chat links off')
  await links.update('claudeLinks', undefined, vscode.ConfigurationTarget.Workspace)
  await until('chat links on, nothing lit', () => snap().claudeLinks.enabled && !snap().claudeLinks.lit, 10000)
  // A caret at a line start counts as a link only just after its editor came to the front: wait that out.
  await until('the editor no longer just come to the front', () => !snap().claudeLinks.fresh, 10000)
  // Whole lines selected in an editor that was already in front (a command, an extension): not a link.
  await select(tok, new vscode.Selection(4, 0, 5, 0), 'whole lines selected, seen by the chat link watcher')
  assert.ok(!snap().claudeLinks.lit, 'whole lines selected in the editor in front: not a chat link')
  await select(tok, new vscode.Selection(3, 2, 3, 2), 'the caret back where the reader was, seen')
  // As the chat opens a link: the file shown with its lines selected (VS Code reports no kind up to 1.14x, Command after).
  r.chat = await c.measure(
    'link from a chat',
    () => vscode.window.showTextDocument(vscode.Uri.parse(saveUri()), { preview: true, selection: new vscode.Selection(1, 0, 2, 0) }),
    () => snap().claudeLinks.lit?.start === 1 && snap().claudeLinks.back,
  )
  await until('the chat link\'s own moves over', () => !snap().claudeLinks.moving, 10000)
  r.chatBack = await c.measure(
    'Back from a chat link',
    () => vscode.commands.executeCommand('codeNotes.claudeLinkBack'),
    () => !snap().claudeLinks.lit && activeUri() === tokenUri() && vscode.window.activeTextEditor!.selection.active.line === 3,
  )
  // Its vscode:// link (a terminal) lights the lines too.
  await vscode.env.openExternal(vscode.Uri.parse(`${vscode.env.uriScheme}://${EXT_ID}/link?file=src/trips/save.ts&start=2&end=3`))
  await until('the vscode:// link lit its lines', () => snap().claudeLinks.lit?.start === 1, 10000)
  await vscode.commands.executeCommand('codeNotes.claudeLinkBack')
}

export const roundTripsTests = [
  test('calls into the window per action: within their counts (CODE_NOTES_RTT_MS: their time over a slow link)', async () => {
    const c = callCounter(ctx.api)
    try {
      // Reading every note and journey, as at activation (files: test/workspaceFs.test.ts checks none go through the window).
      await c.measure('reading the notes and journeys', () => vscode.commands.executeCommand('codeNotes.refresh'), () => true)
      const r: Measured = {}
      const tripsPath = writeTrips()
      await until('the journey "trips" is read', () => snap().journeys.some((x: any) => x.id === 'trips'), 10000)
      await walkTrips(c, r)
      await rapidNext(c, r)
      await chatLinks(c, r)
      fs.rmSync(tripsPath)
      for (const [k, n] of Object.entries(MOST)) {
        // The step's layout read is waited for too; it is held to its own limit below, not to MOST.
        const waited = r[k].calls.filter((x) => !x.startsWith('store ') && !(STEP_ACTIONS.has(k) && x === LAYOUT_PROBE))
        assert.ok(waited.length <= n, `${k}: ${waited.length} calls into the window (at most ${n}): ${waited.join(', ')}`)
        const probes = r[k].calls.filter((x) => x === LAYOUT_PROBE).length
        assert.ok(probes <= (STEP_ACTIONS.has(k) ? 1 : 0), `${k}: ${probes} waited layout reads (opening a step: at most one, after the step is shown; other actions: none)`)
      }
    } finally { c.dispose() }
  }),
]
