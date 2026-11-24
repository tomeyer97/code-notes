// The editor while it plays (src/tour/card.ts, instances.ts, src/codeLinks/beats.ts, src/podcast/markLights.ts, src/notes/decorations.ts):
// the step card is its header line only, above the function the step is in; the marks are the only coloured thing on
// the code (no step tint, no beat box, no note bars, no value hints, no ruler ticks). On pause all of it comes back and
// the card is the full one above the step's first line. CODE_NOTES_SHOTS: pictures, playing and paused, dark and light.
import * as vscode from 'vscode'
import assert from 'assert'
import { windowShot } from '../helpers'
import { agentNote, journey, step, writeJourney, writeLines, writeNote } from '../fixtures'
import { ctx, journeysDir, snap, tour, wsPath } from './context'
import { writePodcast } from './podcast/fixtures'
import { closeAllButPanel, pause, play, podTest, startPlaying, withSettings } from './podcast/player'
import { LOAD_MS, pod, podUntil, QUICK_MS } from './podcast/state'

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
  writePodcast('podorder', 'Pod order', [
    { id: 'intro', at: null, text: 'Hello.', start: 0, end: 3.8 },
    { id: 'o1', at: { step: 'O1', beat: 1 }, text: 'It reserves the stock, and if that fails it rejects; then it stores the order.', start: 4, end: 30, marks: [
      { phrase: 'reserves the stock', at: 0.5, lines: [7, 7], match: 'db.reserve' },
      { phrase: 'it rejects', at: 1.5, lines: [8, 8], match: 'reject(409)' },
      { phrase: 'stores the order', at: 2.5, lines: [9, 9] },
    ] },
    { id: 'outro', at: null, text: 'Bye.', start: 30.5, end: 40 },
  ])
}

/** The notes' and the step's decorations on order.ts, as the snapshot has them. */
const orderEditor = () => vscode.window.visibleTextEditors.find((e) => /order\.ts$/.test(e.document.uri.path))

/** Pictures (CODE_NOTES_SHOTS) of the window in the dark theme, then the light one (put back after). */
async function shots(state: string) {
  await windowShot(`listen-editor-${state}-dark`, { wait: 600 })
  await withSettings('workbench', { colorTheme: 'Default Light Modern' }, () => windowShot(`listen-editor-${state}-light`, { wait: 1200 }))
}

export const listenEditorTests = [
  // Playing, the step card is its header line above the function, and the marks are the only colour on the code;
  // paused, the full card, the value hint, the note's bar and the step's tint are back. The camera's waits off.
  podTest('listening › the editor while it plays', async () => {
    writeOrderJourney()
    await podUntil('its podcast is found', () => pod().journeys.includes('podorder'), LOAD_MS)
    await closeAllButPanel()
    await startPlaying('podorder')
    // Played into step 1 until its three marks are lit, then paused: the full card under the step's first line, the
    // value hint, the note's bar, the step's tint.
    await podUntil('step 1, three marks lit', () => tour().step === 1 && pod().marks.length === 3 && !!orderEditor(), 15000)
    await pause()
    await podUntil('the full card above the step', () => tour().card?.line === 5 && /The stock is reserved/.test(tour().card?.body ?? ''), QUICK_MS)
    await podUntil('its value hint', () => (tour().values as string[]).some((v) => v.startsWith('order.ts:6: stock')), QUICK_MS)
    await shots('paused')
    // Playing: the header only, above the function's signature; no value hints.
    await play()
    await shots('playing')
    await podUntil('the header card above the function', () => tour().card?.line === 2 && tour().card?.label === '1/1 · reserve, then store', QUICK_MS)
    assert.equal(tour().card!.body ?? '', '', 'nothing under the header while it follows')
    await podUntil('no value hints', () => (tour().values as string[]).length === 0, 3000)
    assert.ok(snap().tour.beat, 'the beat is still known (not drawn)')
    await pause()
    await podUntil('the full card again', () => tour().card?.line === 5 && /The stock is reserved/.test(tour().card?.body ?? ''), QUICK_MS)
    await podUntil('its value hint again', () => (tour().values as string[]).length === 1, QUICK_MS)
  }),
]
