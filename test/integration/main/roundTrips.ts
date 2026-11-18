// Calls into the window per user action. Over Remote-SSH the extension host runs on the remote machine and each awaited
// call into the window (show a file, a context key, a stored value) waits one network round trip, so an action that
// awaits six of them in a row takes six round trips. This counts them for the actions people repeat all the time
// (a code link, Back, the next and the previous step, a link from a chat) and checks the counts stay small.
// CODE_NOTES_RTT_MS=<ms>: each such call also waits that long (a slow link), and the time each action takes is printed.
// Runs last: on the journey "anim" the animation tests (main/animation.ts) leave open. The counter: helpers.ts.
import * as vscode from 'vscode'
import * as fs from 'fs'
import assert from 'assert'
import { EXT_ID, callCounter, quiet, settle, test } from '../helpers'
import { journey, step, writeJourney } from '../fixtures'
import { ctx, journeysDir, snap, tour, until, wsPath } from './context'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Counter = ReturnType<typeof callCounter>
/** Each action's calls into the window and its time, by a short name. */
type Measured = Record<string, { calls: string[]; ms: number }>

const animUri = () => vscode.Uri.file(wsPath('src', 'anim.ts')).toString()
const tokUri = () => vscode.Uri.file(wsPath('src', 'tok.ts')).toString()
const activeUri = () => vscode.window.activeTextEditor?.document.uri.toString()

/** What each action may call at most besides storing its place (stored in the background, not waited for). */
const MOST: Record<string, number> = { next: 1, previous: 1, link: 1, back: 1, same: 0, chatBack: 1 }

/** Step 1 of "anim": Next, Previous, a code link into another file, Back, a code link into the card's own file. */
async function walkAnim(c: Counter, r: Measured): Promise<void> {
  await vscode.commands.executeCommand('codeNotes.openJourney', 'anim')
  await until('walking anim', () => tour().journey === 'anim' && tour().step >= 1, 10000)
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
    () => tour().step === 1 && !!tour().card && activeUri() === animUri(),
  )
  await settle(300, 'step 1\'s own reveals')
  r.link = await c.measure(
    'code link into another file',
    () => vscode.commands.executeCommand('codeNotes.codeLink', tour().codeLinks.key, 4),
    () => tour().codeLinks.active === 4 && tour().codeLinks.back,
  )
  await settle(300, 'the link\'s own reveal')
  r.back = await c.measure(
    'Back to the step',
    () => vscode.commands.executeCommand('codeNotes.codeLinkBack'),
    () => tour().codeLinks.active === -1 && activeUri() === animUri() && !!tour().card,
  )
  await settle(300, 'the step\'s own reveals')
  r.same = await c.measure(
    'code link into the card\'s file',
    () => vscode.commands.executeCommand('codeNotes.codeLink', tour().codeLinks.key, 1),
    () => tour().codeLinks.active === 1,
  )
  await vscode.commands.executeCommand('codeNotes.codeLink', tour().codeLinks.key, 1)
  await until('off again', () => tour().codeLinks.active === -1, 10000)
}

/**
 * Next, Next, Next before the first has shown anything: the walk ends on the last step asked for, its file and its
 * card (an older step never shows its file or takes the newer card away). Steps in four files.
 */
async function rapidNext(c: Counter, r: Measured): Promise<void> {
  const files = ['anim.ts', 'tok.ts', 'flow.ts', 'flow2.ts'].filter((f) => fs.existsSync(wsPath('src', f)))
  const hopSteps = files.map((f, k) => step(`src/${f}`, 1, 1, { id: `h${k}`, title: `In ${f}`, lead: `Step ${k + 1}.` }))
  const hopPath = writeJourney(journeysDir(), journey('hop', hopSteps, { question: 'Where does it go?', title: 'Hop' }))
  await until('hop read', () => snap().journeys.some((x: any) => x.id === 'hop'), 10000)
  await vscode.commands.executeCommand('codeNotes.openJourney', 'hop')
  await until('walking hop', () => tour().journey === 'hop' && tour().step === 1 && !!tour().card, 10000)
  await settle(500, 'step 1\'s own reveals')
  const last = files.length
  const onLastStep = () => tour().step === last && !!tour().card && vscode.window.activeTextEditor?.document.uri.path.endsWith(`/src/${files[last - 1]}`) === true
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

/** A link from a chat (its vscode:// link): its lines lit, Back to where the reader was. */
async function chatLinks(c: Counter, r: Measured): Promise<void> {
  await vscode.commands.executeCommand('codeNotes.endJourney')
  await until('the walk ended', () => !tour().journey || !tour().step, 10000)
  // Set up with chat links off (a caret restored at a line start right after a show reads as a link).
  const links = vscode.workspace.getConfiguration('codeNotes')
  await links.update('claudeLinks', false, vscode.ConfigurationTarget.Workspace)
  await settle(300, 'the setting reaching the extension')
  const tok = await vscode.window.showTextDocument(vscode.Uri.parse(tokUri()), { preview: false })
  tok.selection = new vscode.Selection(3, 2, 3, 2)
  await settle(300, 'the caret move seen with chat links off')
  await links.update('claudeLinks', undefined, vscode.ConfigurationTarget.Workspace)
  await until('nothing lit', () => snap().claudeLinks && !snap().claudeLinks.lit, 10000)
  await settle(1200, 'the editor\'s own restored caret and selection events, which a chat link watcher reads')
  // Whole lines selected in an editor that was already in front (a command, an extension): not a link.
  tok.selection = new vscode.Selection(4, 0, 5, 0)
  await quiet(400, 'whole lines selected read as a chat link')
  assert.ok(!snap().claudeLinks.lit, 'whole lines selected in the editor in front: not a chat link')
  tok.selection = new vscode.Selection(3, 2, 3, 2)
  await settle(300, 'the caret back where the reader was')
  // As the chat opens a link: the file shown with its lines selected (VS Code reports no kind up to 1.14x, Command after).
  r.chat = await c.measure(
    'link from a chat',
    () => vscode.window.showTextDocument(vscode.Uri.parse(animUri()), { preview: true, selection: new vscode.Selection(1, 0, 2, 0) }),
    () => snap().claudeLinks.lit?.start === 1 && snap().claudeLinks.back,
  )
  await settle(300, 'the chat link\'s own reveal')
  r.chatBack = await c.measure(
    'Back from a chat link',
    () => vscode.commands.executeCommand('codeNotes.claudeLinkBack'),
    () => !snap().claudeLinks.lit && activeUri() === tokUri() && vscode.window.activeTextEditor!.selection.active.line === 3,
  )
  // Its vscode:// link (a terminal) lights the lines too.
  await vscode.env.openExternal(vscode.Uri.parse(`${vscode.env.uriScheme}://${EXT_ID}/link?file=src/anim.ts&start=2&end=3`))
  await until('the vscode:// link lit its lines', () => snap().claudeLinks.lit?.start === 1, 10000)
  await vscode.commands.executeCommand('codeNotes.claudeLinkBack')
}

export const roundTripsTests = [
  test('calls into the window per action: within their counts (CODE_NOTES_RTT_MS: their time over a slow link)', async () => {
    const c = callCounter(ctx.api)
    try {
      // Reading every note and journey, as at activation (files: test/wfs.test.ts checks none go through the window).
      await c.measure('reading the notes and journeys', () => vscode.commands.executeCommand('codeNotes.refresh'), () => true)
      const r: Measured = {}
      await walkAnim(c, r)
      await rapidNext(c, r)
      await chatLinks(c, r)
      for (const [k, n] of Object.entries(MOST)) {
        const waited = r[k].calls.filter((x) => !x.startsWith('store '))
        assert.ok(waited.length <= n, `${k}: ${waited.length} calls into the window (at most ${n}): ${waited.join(', ')}`)
      }
    } finally { c.dispose() }
  }),
]
