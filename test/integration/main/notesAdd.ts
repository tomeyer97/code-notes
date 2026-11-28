// Adding a note: the box keeps the keyboard (chord and palette), a saved note stays open, Esc closes the box and keeps
// its draft, file and folder notes ask for their text, an untitled file offers Save As….
// Source: src/notes/create.ts, src/notes/commentRanges.ts.
import * as vscode from 'vscode'
import * as fs from 'fs'
import assert from 'assert'
import { settle, test } from '../helpers'
import { cdp, ui } from '../devtools'
import { closeAllEditors, ctx, snap, until, wsPath } from './context'

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Tests that type for real in the workbench page; skipped without the DevTools connection. */
const devtools = { when: () => cdp, whenNot: 'no DevTools' }

/** The file these tests add notes to (written by the first test). */
const ADDING = () => wsPath('src', 'adding.ts')
const LINES = Array.from({ length: 40 }, (_, i) => `export const line${i + 1} = ${i + 1}`).join('\n') + '\n'

/** Not wired to a key here: the manifest's Esc runs it (src/notes/index.ts). */
const CLOSE_NOTE_BOX = 'codeNotes.closeNoteBox'

// VS Code's own DOM (read off VS Code 1.147): the comment box is a .review-widget, its input in a .comment-form.
/** The keyboard is in a comment box's input. */
const boxFocused = async () => (await ui()).evaluate(() => !!(globalThis as any).document.activeElement?.closest?.('.review-widget .comment-form'))
/** What the comment box that has the keyboard holds ('' for none). */
const boxText = async () => (await ui()).evaluate(() => {
  const form = (globalThis as any).document.activeElement?.closest?.('.review-widget .comment-form')
  return (form?.querySelector('.view-lines')?.textContent ?? '').replace(/ /g, ' ')
})
/** Where the keyboard is and which comment boxes are drawn (for a failing wait's message). */
const whereNow = async () => (await ui()).evaluate(() => {
  const d = (globalThis as any).document, a = d.activeElement
  const forms = [...d.querySelectorAll('.review-widget .comment-form')].map((f: any) => `${f.offsetParent ? 'shown' : 'hidden'}:${f.className}`)
  return `focus: ${a?.tagName}.${String(a?.className).slice(0, 80)} in review-widget: ${!!a?.closest?.('.review-widget')}; widgets: ${d.querySelectorAll('.review-widget').length}; forms: ${forms.join(' | ')}`
})
/** Waits for the keyboard in a comment box's input; says where it is instead on a timeout. */
async function untilBoxFocused(): Promise<void> {
  try { await until('the keyboard in the note box', () => boxFocused()) } catch (e) { throw new Error(`${(e as Error).message} (${await whereNow()})`, { cause: e }) }
}
/** Any comment box input on screen holds `text`. */
const boxShows = async (text: string) => (await ui()).evaluate((t) =>
  [...(globalThis as any).document.querySelectorAll('.review-widget .comment-form .view-lines')].some((v: any) => (v.textContent ?? '').replace(/ /g, ' ').includes(t)), text)

async function openAdding(line: number, selectTo?: number): Promise<vscode.TextEditor> {
  if (!fs.existsSync(ADDING())) fs.writeFileSync(ADDING(), LINES)
  const editor = await vscode.window.showTextDocument(vscode.Uri.file(ADDING()))
  editor.selection = new vscode.Selection(line, 0, selectTo ?? line, selectTo === undefined ? 0 : 10)
  return editor
}

/** Types into the box that has the keyboard after `ms` (as a person would), and checks it landed there. */
async function typeLater(editor: vscode.TextEditor, text: string, ms: number): Promise<void> {
  const page = await ui()
  await untilBoxFocused()
  await settle(ms, 'a person reads the box before typing')
  assert.ok(await boxFocused(), 'the box still has the keyboard')
  await page.keyboard.type(text)
  await until(`"${text}" in the box`, async () => (await boxText()).includes(text))
  assert.ok(!editor.document.isDirty, 'nothing typed into the code')
}

/** Add Code Note…'s input box on screen, empty, with the keyboard in it. */
async function pathBoxReady(): Promise<boolean> {
  return (await ui()).evaluate(() => {
    const doc = (globalThis as any).document
    const box = doc.querySelector('.quick-input-widget')
    const shown = !!box && box.style.display !== 'none' && /Note on (file|folder) /.test(box.querySelector('.quick-input-title')?.textContent ?? '')
    const el = doc.activeElement
    return shown && el?.tagName === 'INPUT' && !!el.closest('.quick-input-widget') && el.value === ''
  })
}

const noteWith = (body: string) => snap().notes.find((n: any) => n.messages[0].body === body)

export const notesAddTests = [
  test('Ctrl+\' C: the box keeps the keyboard; typed text lands in it; the saved note stays open', async () => {
    const editor = await openAdding(4)
    const page = await ui()
    await page.keyboard.press("Control+'")
    await page.keyboard.press('c')
    await typeLater(editor, 'zz', 2000)
    await settle(3000, 'five seconds after the chord')
    assert.ok(await boxFocused(), 'the box has the keyboard five seconds on')
    await page.keyboard.press('Control+Enter')
    const n = await until('the note saved', () => noteWith('zz'))
    await until('its thread open with the posted note', () => ctx.api.thread(n.id)?.collapsibleState === vscode.CommentThreadCollapsibleState.Expanded)
  }, devtools),

  test('Add Note from the palette on a selection: typing goes into the box, not over the selected code', async () => {
    const editor = await openAdding(10, 12)
    await vscode.commands.executeCommand('codeNotes.add')
    await typeLater(editor, 'zz2', 2000)
    await (await ui()).keyboard.press('Control+Enter')
    await until('the note saved', () => noteWith('zz2'))
    assert.ok(!editor.document.isDirty, 'the selected code is untouched')
  }, devtools),

  test('Esc on an empty new note box closes it, with VS Code\'s default settings and no question asked', async () => {
    const editor = await openAdding(30)
    await vscode.commands.executeCommand('codeNotes.add')
    await untilBoxFocused()
    await vscode.commands.executeCommand(CLOSE_NOTE_BOX)
    await until('the box closed', async () => !(await boxFocused()))
    assert.equal(await (await ui()).locator('.monaco-dialog-box').count(), 0, 'no "discard?" dialog')
    assert.ok(!editor.document.isDirty)
  }, devtools),

  test('closing a new note box with a draft asks nothing and keeps it: Add Note on that line puts it back', async () => {
    // VS Code's default settings: folding a box that holds text would ask to discard it.
    const editor = await openAdding(20)
    await vscode.commands.executeCommand('codeNotes.add')
    await typeLater(editor, 'draft kept', 500)
    await vscode.commands.executeCommand(CLOSE_NOTE_BOX)
    await until('the box closed', async () => !(await boxShows('draft kept')))
    assert.equal(await (await ui()).locator('.monaco-dialog-box').count(), 0, 'no "discard?" dialog')
    editor.selection = new vscode.Selection(20, 0, 20, 0)
    await vscode.commands.executeCommand('codeNotes.add')
    await until('the draft back in the box', async () => (await boxText()).includes('draft kept'))
    assert.ok(!noteWith('draft kept'), 'a closed box saves nothing')
    await (await ui()).keyboard.press('Control+Enter')
    await until('the draft saved as the note', () => noteWith('draft kept'))
    assert.ok(!editor.document.isDirty)
    await closeAllEditors()
  }, devtools),

  test('Add Code Note… from an editor tab or the Explorer asks for the text; Esc saves nothing', async () => {
    await openAdding(0)
    const file = vscode.Uri.file(ADDING())
    const folder = vscode.Uri.file(wsPath('src'))
    const noteFiles = () => (fs.existsSync(ctx.notesDir) ? fs.readdirSync(ctx.notesDir).length : 0)
    const before = noteFiles()
    // What VS Code passes from an editor tab's menu, then from the Explorer's (the selected uris).
    for (const [uri, arg] of [[file, { groupId: 0, editorIndex: 1 }], [folder, [folder]]] as const) {
      const done = vscode.commands.executeCommand('codeNotes.addPathNote', uri, arg)
      if (cdp) await until('the input box is shown, with the keyboard', pathBoxReady)
      else await settle(500, 'the input box opens')
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen')
      assert.equal(await done, undefined, 'no note')
    }
    assert.equal(noteFiles(), before, 'no note file written')
    if (!cdp) return
    const done = vscode.commands.executeCommand<any>('codeNotes.addPathNote', file, { groupId: 0, editorIndex: 1 })
    // The box just closed can still be on screen: wait for the new one to have the keyboard, and the text to be in it.
    await until('the input box, with the keyboard', pathBoxReady)
    await (await ui()).keyboard.type('Is this file needed?')
    await until('the text in the box', async () => (await (await ui()).locator('.quick-input-widget input').first().inputValue()) === 'Is this file needed?')
    await (await ui()).keyboard.press('Enter')
    const n = await done
    assert.equal(n?.data.messages[0].body, 'Is this file needed?', 'the typed text is the note')
  }),

  test('Add Note on an untitled file offers Save As…, not an error', async () => {
    const doc = await vscode.workspace.openTextDocument({ content: 'one\ntwo\n' })
    const editor = await vscode.window.showTextDocument(doc)
    editor.selection = new vscode.Selection(0, 0, 1, 3)
    void vscode.commands.executeCommand('codeNotes.add')
    const page = await ui()
    const toast = page.locator('.notification-toast', { hasText: /save the file inside the open folder/i }).first()
    await until('the message', () => toast.isVisible())
    assert.ok(await toast.locator('.monaco-button', { hasText: 'Save As…' }).isVisible(), 'a Save As… button')
    assert.ok(!(await toast.locator('.codicon-error').count()), 'not an error')
    await vscode.commands.executeCommand('notifications.clearAll')
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor')
  }, devtools),
]
