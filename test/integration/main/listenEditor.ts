// The editor while it plays (src/tour/card.ts, instances.ts, src/codeLinks/beats.ts, src/podcast/marks.ts, src/notes/decorations.ts):
// the step card is its header line only, above the function the step is in; the marks are the only coloured thing on
// the code (no step tint, no beat box, no note bars, no value hints, no ruler ticks). On pause all of it comes back and
// the card is the full one above the step's first line. CODE_NOTES_SHOTS: pictures, playing and paused, dark and light.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { sleep, test, waiter, windowShot } from '../helpers'
import { agentNote, journey, step, writeJourney, writeLines, writeNote } from '../fixtures'
import { ctx, journeysDir, snap, tour, wsPath } from './context'
import { ui } from '../devtools'

/* eslint-disable @typescript-eslint/no-explicit-any */
const pod = () => ctx.api.podcast() as any
const until = waiter({ dump: () => ({ podcast: pod(), step: tour().step, card: tour().card, values: tour().values }) })
const toggle = () => vscode.commands.executeCommand('codeNotes.podcastToggle')

/** src/order.ts: a function (line 4-13) whose middle (7-10) is the step. */
const LINES = [
  '// Orders: checked, reserved, stored, told.',
  "import { db, notify, reject, sum } from './db'",
  '',
  'export async function placeOrder(cart: Cart, user: User) {',
  '  const total = sum(cart.items)',
  "  if (total <= 0) throw new Error('empty cart')",
  '  const stock = await db.reserve(cart.items)',
  '  if (!stock.ok) return reject(409)',
  '  const order = await db.insert({ user: user.id, total })',
  '  await notify(user, order)',
  '  return order',
  '}',
  ...Array.from({ length: 30 }, (_, i) => `export const pad${i + 1} = ${i + 1}`),
]

function writeOrderJourney() {
  writeLines(wsPath('src', 'order.ts'), LINES)
  const actors = [{ id: 'svc', type: 'service', col: 0, label: 'Orders', fn: 'placeOrder()', checks: ['a'] }]
  writeJourney(journeysDir(), journey('podorder', [
    step('src/order.ts', 7, 10, { id: 'O1', title: 'reserve, then store', lead: 'The stock is reserved before the order is stored.',
      values: [{ name: 'stock', value: '{ ok: true }', file: 'src/order.ts', line: 7, text: LINES[6] }],
      scene: { actors, wires: [], beats: [{ focus: 'svc', caption: 'Reserve.', code: { file: 'src/order.ts', line: 8, text: LINES[7] } }] } }),
  ], { title: 'Pod order' }))
  writeNote(ctx.notesDir, '20261118-120000-ordr', agentNote('src/order.ts', 9, 'Is the insert idempotent?'))
  const mp3 = path.join(journeysDir(), 'podorder.mp3')
  if (!fs.existsSync(mp3)) fs.copyFileSync(path.join(__dirname, '../../../../test/fixtures/podcast/tone.mp3'), mp3)
  fs.writeFileSync(path.join(journeysDir(), 'podorder.podcast.json'), JSON.stringify({
    version: 1, title: 'Pod order', journey: { id: 'podorder' }, audio: 'podorder.mp3', duration: 40,
    segments: [
      { id: 'intro', at: null, speaker: 'host', text: 'Hello.', start: 0, end: 3.8 },
      { id: 'o1', at: { step: 'O1', beat: 1 }, speaker: 'host', text: 'It reserves the stock, and if that fails it rejects; then it stores the order.', start: 4, end: 30, marks: [
        { phrase: 'reserves the stock', at: 0.5, lines: [7, 7], match: 'db.reserve' },
        { phrase: 'it rejects', at: 1.5, lines: [8, 8], match: 'reject(409)' },
        { phrase: 'stores the order', at: 2.5, lines: [9, 9] },
      ] },
      { id: 'outro', at: null, speaker: 'host', text: 'Bye.', start: 30.5, end: 40 },
    ],
  }))
}

/** The notes' and the step's decorations on order.ts, as the snapshot has them. */
const orderEditor = () => vscode.window.visibleTextEditors.find((e) => /order\.ts$/.test(e.document.uri.path))

async function shots(state: string) {
  await windowShot(`listen-editor-${state}-dark`, { wait: 600 })
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Default Light Modern', vscode.ConfigurationTarget.Global)
  await windowShot(`listen-editor-${state}-light`, { wait: 1200 })
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', undefined, vscode.ConfigurationTarget.Global)
}

export const listenEditorTests = [
  test('the editor while it plays: the card is its header above the function, the marks the only colour; paused, all of it is back', async () => {
    const c = vscode.workspace.getConfiguration('codeNotes.listen')
    await c.update('readBeforeMove', 0, vscode.ConfigurationTarget.Global)
    await c.update('settleAfterMove', 0, vscode.ConfigurationTarget.Global)
    writeOrderJourney()
    await until('its podcast is found', () => pod().journeys.includes('podorder'), 10000)
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => !(t.input instanceof vscode.TabInputWebview && /codeNotes\.journey/.test(t.input.viewType)))
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true)
    await vscode.commands.executeCommand('codeNotes.playPodcast', 'podorder')
    await until('the panel shows it', () => tour().map === 'podorder' && pod().mapVisible, 10000)
    // Nothing clicked yet in this window: the panel holds the audio, paused; one real click on its ▶ plays it.
    if (!(await until('playing on its own', () => pod().playing && pod().session === 'podorder', 3000).catch(() => false))) {
      const page = await ui()
      const editor = await page.locator('.part.editor').boundingBox()
      const f = await until('the panel\'s frame', async () => {
        for (const x of page.frames()) {
          const outer = x.parentFrame()
          if (!outer || !outer.parentFrame()) continue
          const b = await (await outer.frameElement()).boundingBox().catch(() => null)
          if (b && b.height > 50 && b.x >= editor!.x - 1) return x
        }
        return undefined
      }, 10000)
      const b = await f.locator('.pod-b.play').boundingBox()
      await sleep(5500)
      await page.mouse.click(b!.x + b!.width / 2, b!.y + b!.height / 2)
    }
    await until('playing', () => pod().playing && pod().session === 'podorder', 10000)
    // Played into step 1 until its three marks are lit, then paused: the full card under the step's first line, the
    // value hint, the note's bar, the step's tint.
    await until('step 1, three marks lit', () => tour().step === 1 && pod().marks.length === 3 && !!orderEditor(), 15000)
    await toggle()
    await until('paused', () => !pod().playing)
    await until('the full card above the step', () => tour().card?.line === 5 && /The stock is reserved/.test(tour().card?.body ?? ''), 5000)
    await until('its value hint', () => (tour().values as string[]).some((v) => v.startsWith('order.ts:6: stock')), 5000)
    await shots('paused')
    // Playing: the header only, above the function's signature; no value hints.
    await toggle()
    await until('playing', () => pod().playing)
    await shots('playing')
    await until('the header card above the function', () => tour().card?.line === 2 && tour().card?.label === '1/1 · reserve, then store', 5000)
    assert.equal(tour().card!.body ?? '', '', 'nothing under the header while it follows')
    await until('no value hints', () => (tour().values as string[]).length === 0, 3000)
    assert.ok(snap().tour.beat, 'the beat is still known (not drawn)')
    await toggle()
    await until('paused', () => !pod().playing)
    await until('the full card again', () => tour().card?.line === 5 && /The stock is reserved/.test(tour().card?.body ?? ''), 5000)
    await until('its value hint again', () => (tour().values as string[]).length === 1, 5000)
    await c.update('readBeforeMove', undefined, vscode.ConfigurationTarget.Global)
    await c.update('settleAfterMove', undefined, vscode.ConfigurationTarget.Global)
  }),
]
