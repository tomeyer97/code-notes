// Marks on a walked step (src/tour/stepMarks.ts, src/marks/lights.ts, src/tour/card.ts, src/beats.ts): opening the
// step lights its marks, each beat its own as the focus with the ones before dimmer; while there are marks the step's
// lines get the thin grey bar and the beat's line no box; a mark not found near its lines lights nothing; marks follow
// the step when code is inserted above it; a step without marks looks as it always did. CODE_NOTES_SHOTS: the step
// at beat 1 without marks (before) and with them (after), dark and light.
import * as vscode from 'vscode'
import assert from 'assert'
import { test, windowShot } from '../helpers'
import { journey, step, writeJourney, writeLines } from '../fixtures'
import { ctx, journeysDir, snap, tour, until, wsPath } from './context'

/* eslint-disable @typescript-eslint/no-explicit-any */
const LINES = [
  '// Placing an order: checked, reserved, stored.',
  'export async function place(cart, user) {',
  '  const total = sum(cart.items)',
  "  if (total <= 0) throw new Error('empty cart')",
  '  const stock = await reserve(cart, { hold: 30 })',
  '  return save(cart, stock, user.id)',
  '}',
  '',
  'export function plain() { return 1 }',
]
const fileUri = () => vscode.Uri.file(wsPath('src', 'marked.js')).toString()

function writeMarksJourney(withMarks: boolean) {
  const m = (o: object) => (withMarks ? { marks: [o] } : {})
  const actors = [{ id: 'svc', type: 'service', col: 0, label: 'Orders', fn: 'place()', checks: ['check', 'reserve', 'store'] }]
  const beats = [
    { focus: 'svc', caption: 'It reserves the stock for 30 s.', code: { file: 'src/marked.js', line: 5, text: LINES[4].trim() }, ...m({ lines: [5, 5], match: '{ hold: 30 }' }) },
    { focus: 'svc', caption: 'It stores the order.', code: { file: 'src/marked.js', line: 6, text: LINES[5].trim() },
      ...(withMarks ? { marks: [{ lines: [6, 6], match: 'save(cart, stock' }, { lines: [6, 6], match: 'not in the code' }] } : {}) },
    { focus: 'svc', caption: 'It sums the cart.', code: { file: 'src/marked.js', line: 3, text: LINES[2].trim() } },
  ]
  writeJourney(journeysDir(), journey('jmarks', [
    step('src/marked.js', 2, 7, { id: 'm1', title: 'An empty cart is refused first', lead: 'If the total is not above zero it throws before reserving anything.',
      ...m({ lines: [4, 4], match: 'total <= 0' }), scene: { actors, wires: [], beats } }),
    step('src/marked.js', 9, 9, { id: 'm2', title: 'plain returns one', lead: 'Nothing to mark.' }),
  ], { title: 'Marks' }))
}

const marks = () => (tour().marks as any[]).map((x) => `${x.text}${x.style === 'focus' ? '*' : ''}`).sort().join(' | ')
const beat = (i: number) => ctx.api.mapMessage({ type: 'beat', n: 1, i })

async function shots(state: string) {
  // The code at its width: the chat side bar closed.
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar')
  await windowShot(`journey-marks-${state}-dark`, { wait: 800 })
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Default Light Modern', vscode.ConfigurationTarget.Global)
  await windowShot(`journey-marks-${state}-light`, { wait: 1200 })
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', undefined, vscode.ConfigurationTarget.Global)
}

export const journeyMarksTests = [
  test('step marks: the step lights its marks, each beat its own as the focus (earlier ones dim), the step\'s lines a thin bar, the beat no box; a step without marks is unchanged', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    writeLines(wsPath('src', 'marked.js'), LINES)
    // Before: the same step without marks (as every journey looked until now).
    writeMarksJourney(false)
    await until('the journey is read', () => snap().journeys.some((x: any) => x.id === 'jmarks'), 10000)
    await vscode.commands.executeCommand('codeNotes.openJourney', 'jmarks')
    await until('step 1, its lines tinted, no marks', () => tour().journey === 'jmarks' && tour().step === 1 && tour().stepLook === 'tint', 10000)
    assert.deepEqual(tour().marks, [])
    beat(0)
    await until('beat 1: its line boxed', () => tour().beat?.uri === fileUri() && tour().beat!.line === 4 && tour().beatBoxed, 10000)
    assert.equal(tour().stepLook, 'tint')
    await shots('before')

    // After: the same journey with marks. Rewritten under the walk: the same step; the step's own mark, the focus.
    beat(-1)
    writeMarksJourney(true)
    await until('step 1: its mark lit, to the character, the focus; the step a thin bar', () => marks() === 'total <= 0*' && tour().stepLook === 'quiet', 10000)
    const own = tour().marks[0]
    assert.deepEqual([own.file, own.line, own.col, own.endLine, own.endCol], ['src/marked.js', 3, 6, 3, 16], 'only "total <= 0" of line 4')
    // Beat 1: its mark the focus, the step's dim; the beat's line known but not boxed.
    beat(0)
    await until('beat 1: its mark the focus, the step\'s dim', () => marks() === 'total <= 0 | { hold: 30 }*' && tour().beat?.line === 4, 10000)
    assert.equal(tour().beatBoxed, false, 'a beat with marks: no box on its line')
    assert.equal(tour().stepLook, 'quiet')
    await shots('after')
    // Beat 2: its found mark the focus, the earlier two dim; the one whose match isn't there lights nothing.
    beat(1)
    await until('beat 2', () => marks() === 'save(cart, stock* | total <= 0 | { hold: 30 }' && tour().beat?.line === 5, 10000)
    // Beat 3 has no marks: its line boxed as always; beat 2's marks stay the focus (the newest).
    beat(2)
    await until('beat 3: boxed, the newest marks still the focus', () => tour().beat?.line === 2 && tour().beatBoxed && marks() === 'save(cart, stock* | total <= 0 | { hold: 30 }', 10000)
    // The scene stops: back to the step's own marks.
    beat(-1)
    await until('no beat: the step\'s mark alone', () => marks() === 'total <= 0*', 10000)

    // Code inserted above the step: the step moves, its marks with it.
    const edit = new vscode.WorkspaceEdit()
    edit.insert(vscode.Uri.parse(fileUri()), new vscode.Position(0, 0), '// one\n// two\n// three\n')
    await vscode.workspace.applyEdit(edit)
    await until('the mark moved with the code', () => (tour().marks as any[]).length === 1 && tour().marks[0].line === 6 && tour().marks[0].text === 'total <= 0', 10000)
    const back = new vscode.WorkspaceEdit()
    back.delete(vscode.Uri.parse(fileUri()), new vscode.Range(0, 0, 3, 0))
    await vscode.workspace.applyEdit(back)
    await until('and back', () => tour().marks[0]?.line === 3, 10000)
    await vscode.workspace.textDocuments.find((d) => d.uri.toString() === fileUri())?.save()

    // Step 2 has no marks: its lines tinted as always, nothing marked.
    await vscode.commands.executeCommand('codeNotes.nextStep')
    await until('step 2: tinted, no marks', () => tour().step === 2 && tour().stepLook === 'tint' && (tour().marks as any[]).length === 0, 10000)
    await vscode.commands.executeCommand('codeNotes.endJourney')
    await until('ended: nothing lit', () => !tour().touring && (tour().marks as any[]).length === 0, 10000)
  }),
]
