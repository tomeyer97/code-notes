// Notes, from the first one to the trash: adding, agent replies and unread counts, following the code (edits, renames,
// deletes), resolving, sessions, invalid files, Ask Claude, paths outside the workspace, .gitignore.
// Source: src/notes/ (commands; following code: notes/location.ts), src/threads/ (threads), src/store.ts (files,
// trash), src/seen.ts (unread), src/anchor.ts (finding lines), src/ask/ and src/claude.ts (Ask Claude).
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'
import { appendMessage, fakeCalls, linesOf, now, pkg, quiet, readJson, readJsonOr, sleep, test } from '../helpers'
import { agentNote, writeNote } from '../fixtures'
import { caretAt, closeAllEditors, ctx, noteAtPath, setting, snap, until, useFakeClaude, wsPath } from './context'

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The first note (the person's question on src/app.ts, the only one at first). */
const first = () => snap().notes[0]
const byBody = (start: string) => snap().notes.find((n: any) => n.messages[0].body.startsWith(start))
const bySession = (s: string) => snap().notes.find((n: any) => n.session === s)

// What earlier tests leave for later ones: each variable names the test that sets it, then the tests that read it.
/** src/app.ts, its document and editor: set by "note created…"; read up to "renaming the file on disk…". */
let appTs: vscode.Uri
let appDoc: vscode.TextDocument
let appEditor: vscode.TextEditor
/** The first note's file: set by "note created…"; read up to "delete moves the note to .code-notes/.trash". */
let firstNotePath = ''
/** src/app.ts after the rename ("renaming the file on disk…"). */
const renamedTs = () => wsPath('src', 'renamed.ts')
/** The partial-selection note, its editor (src/renamed.ts) and line: set by "a partial selection…"; read by "an agent
 *  reply written while typing…" and "a deleted then restored file…". */
let selectionNotePath = ''
let selectionEditor: vscode.TextEditor
let selectionLine = 0
/** Set by "a path with the folder name in front is fixed"; read only there. */
let prefixedPath = ''
/** A note with an absolute path inside the workspace: set by "a note pointing outside…"; read by "your own reply…" and
 *  "Undo as a command…". */
let absolutePath = ''
/** Set by "a string "selection" is kept…"; deleted by "a note deleted on disk is kept in .trash". */
let stringSelectionPath = ''

export const notesTests = [
  test('note created with role and author; README correct for agents', async () => {
    appTs = vscode.Uri.file(wsPath('src', 'app.ts'))
    appDoc = await vscode.workspace.openTextDocument(appTs)
    appEditor = await vscode.window.showTextDocument(appDoc)
    // The inline comment box's "Add Note".
    await vscode.commands.executeCommand('codeNotes.createFromThread', {
      thread: { uri: appTs, range: new vscode.Range(2, 0, 3, 0), dispose() {} }, text: 'Why is the token never removed?',
    })
    const note = await until('note created', () => first())
    assert.deepEqual(note.range, { start: 3, end: 3 }, 'a range ending at column 0 does not include that line')
    assert.equal(note.messages[0].role, 'human')
    assert.equal(note.messages[0].author, snap().me)
    firstNotePath = note.path
    const readme = fs.readFileSync(path.join(ctx.notesDir, 'README.md'), 'utf8')
    assert.ok(readme.includes(`"file": "src/main.ts"`) && readme.includes(`**${snap().me}**`) && !/^\s*"[^"]+":.*\/\//m.test(readme), 'README: right path, names the person, no comments in JSON')
  }),

  test('replies unread whatever their timestamps; a missing "at" is not invented', async () => {
    // Stamped EARLIER than anything (clock skew): still unread.
    appendMessage(firstNotePath, { author: 'claude', role: 'agent', body: 'It is read once in `main`.', at: '2001-01-01T00:00:00Z' })
    await until('past-dated reply unread', () => first()?.unread === 1)
    assert.equal(snap().badge, 1)
    appendMessage(firstNotePath, { author: 'claude', role: 'agent', body: 'And no timestamp on this one.' })
    await until('second reply unread', () => first()?.unread === 2)
    await vscode.commands.executeCommand('codeNotes.refresh')
    await until('still 2 after reload, nothing invented', () => first()?.unread === 2 && first().messages[2].at === undefined)
  }),

  test('Next Unread opens the thread, clears the badge and every "new"', async () => {
    void vscode.commands.executeCommand('codeNotes.nextUnread')
    await until('read after Next Unread', () => first()?.unread === 0 && first().threadExpanded && snap().badge === 0)
    assert.doesNotMatch(first().threadLabel ?? '', /new/, 'read everywhere at once, the thread header too')
  }),

  test('edits above are followed live and saved with the file', async () => {
    await appEditor.edit((b) => b.insert(new vscode.Position(0, 0), '// one\n// two\n'))
    await until('moved by 2 in the editor', () => first()?.range.start === 5)
    await quiet(700, 'the new range written while the file is unsaved')
    assert.equal(readJson(firstNotePath).range.start, 3, 'not written while the file is unsaved')
    await appDoc.save()
    await until('written on save', () => readJson(firstNotePath).range.start === 5)
  }),

  test('re-indent keeps the note; a real change makes it stale; undo clears it', async () => {
    const line = appDoc.lineAt(4).text
    await appEditor.edit((b) => b.replace(appDoc.lineAt(4).range, line.replace(/^\s+/, '        ')))
    await quiet(700, 'the note going stale on a re-indent')
    assert.equal(first().stale, false, 're-indent is not stale')
    await appEditor.edit((b) => b.replace(appDoc.lineAt(4).range, '  const token = readOtherToken()'))
    await until('stale after a real change', () => first()?.stale === true && /The code changed since this note/.test((ctx.api.thread(first().id)?.comments[0]?.body as vscode.MarkdownString | undefined)?.value ?? ''))
    await vscode.commands.executeCommand('undo')
    await vscode.commands.executeCommand('undo')
    await until('stale cleared after undo', () => first()?.stale === false)
    await appDoc.save()
  }),

  test('a reply on a resolved note reopens it and is unread', async () => {
    caretAt(appEditor, 4)
    void vscode.commands.executeCommand('codeNotes.resolve') // shows an Undo toast: not awaited
    await until('resolved on disk', () => readJson(firstNotePath).status === 'resolved')
    appendMessage(firstNotePath, { author: 'claude', role: 'agent', body: 'Actually there is a second caller.', at: now() })
    await until('reopened by the reply', () => readJson(firstNotePath).status === 'open' && first()?.unread === 1)
  }),

  test('a broken file that is restored stops being reported', async () => {
    // Half-written, then restored to the same content.
    const good = fs.readFileSync(firstNotePath, 'utf8')
    fs.writeFileSync(firstNotePath, good.slice(0, 40))
    await until('broken reported', () => snap().broken === 1)
    fs.writeFileSync(firstNotePath, good)
    await until('broken cleared after restore', () => snap().broken === 0)
  }),

  test('a note file named differently from its id is edited in place', async () => {
    // An agent's note whose file name differs from its "id": no duplicate.
    const agentFile = path.join(ctx.notesDir, 'agent-question-1.json')
    fs.writeFileSync(agentFile, JSON.stringify({ ...agentNote('src/app.ts', 1, 'Is **this** header needed?'), id: 'something-else', anchor: { text: appDoc.lineAt(0).text, before: '', after: appDoc.lineAt(1).text } }, null, 2))
    await until('agent note loaded', () => snap().notes.length === 2)
    caretAt(appEditor, 0)
    void vscode.commands.executeCommand('codeNotes.resolve')
    await until('agent note resolved in its own file', () => readJson(agentFile).status === 'resolved')
    await quiet(300, 'a second file written for the note')
    assert.deepEqual(fs.readdirSync(ctx.notesDir).filter((f) => f.endsWith('.json')).length, 2, 'no duplicate file')
  }),

  test('renaming the file on disk moves the note with it', async () => {
    // As `git mv` does.
    await closeAllEditors()
    fs.renameSync(appTs.fsPath, renamedTs())
    await until('note follows the renamed file', () => byBody('Why')?.file === 'src/renamed.ts', 10000)
  }),

  test('delete moves the note to .code-notes/.trash', async () => {
    const question = byBody('Why')
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(renamedTs()))
    caretAt(editor, question!.range.start - 1)
    void vscode.commands.executeCommand('codeNotes.delete')
    await until('moved to trash', () => fs.existsSync(path.join(ctx.notesDir, '.trash', path.basename(firstNotePath))) && !fs.existsSync(firstNotePath))
  }),

  test('a partial selection stores the exact text', async () => {
    const editor = selectionEditor = await vscode.window.showTextDocument(vscode.Uri.file(renamedTs()))
    selectionLine = linesOf(editor.document).findIndex((t) => t.includes('readToken'))
    const col = editor.document.lineAt(selectionLine).text.indexOf('readToken')
    await vscode.commands.executeCommand('codeNotes.createFromThread', {
      thread: { uri: vscode.Uri.file(renamedTs()), range: new vscode.Range(selectionLine, col, selectionLine, col + 'readToken'.length), dispose() {} }, text: 'Why THIS import?',
    })
    const note = await until('selection stored', () => snap().notes.find((x: any) => x.messages[0].body === 'Why THIS import?'))
    assert.deepEqual(note.selection, { text: 'readToken', startCol: col, endCol: col + 9 })
    selectionNotePath = note.path
  }),

  test('an agent reply written while typing survives the save (merged)', async () => {
    const editor = selectionEditor
    await editor.edit((b) => b.insert(new vscode.Position(0, 0), '// typing\n'))
    appendMessage(selectionNotePath, { author: 'claude', role: 'agent', body: 'Because it is the only reader.', at: now() })
    await sleep(150) // the reply lands while the person goes on typing: the race is the test
    await editor.edit((b) => b.insert(new vscode.Position(0, 0), '// more typing\n'))
    await editor.document.save()
    await until('range saved after typing', () => readJson(selectionNotePath).range.start === selectionLine + 3)
    await quiet(500, 'a late write of the note without the reply')
    assert.equal(readJson(selectionNotePath).messages.length, 2, 'agent reply survived the save')
  }),

  test('an agent note without an anchor gets one from the code', async () => {
    const agentNew = writeNote(ctx.notesDir, '20261111-150000-agnt', agentNote('src/renamed.ts', 4, 'Look here'))
    const doc = selectionEditor.document
    await until('anchor backfilled', () => readJsonOr(agentNew)?.anchor?.text === doc.lineAt(3).text)
  }),

  test('a deleted then restored file: its notes recover on their own', async () => {
    // As `git checkout -- file` does.
    await closeAllEditors()
    const content = fs.readFileSync(renamedTs(), 'utf8')
    fs.unlinkSync(renamedTs())
    await until('missing after delete', () => noteAtPath(selectionNotePath)?.missing === true, 10000)
    fs.writeFileSync(renamedTs(), content)
    await until('recovered after restore', () => { const x = noteAtPath(selectionNotePath); return x && !x.missing && !x.stale }, 10000)
  }),

  test('a path with the folder name in front is fixed', async () => {
    // An agent writes the path with the workspace folder's name in front: fixed on load.
    prefixedPath = writeNote(ctx.notesDir, '20261111-150100-pfx1', agentNote(`${ctx.folder.name}/src/renamed.ts`, 2, 'Path test'))
    await until('prefixed path fixed', () => readJsonOr(prefixedPath)?.file === 'src/renamed.ts', 8000)
  }),

  test('one resolve control in the thread; bulk delete is "Purge Resolved Notes…"', async () => {
    const target = noteAtPath(prefixedPath)
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(renamedTs()))
    caretAt(editor, target.range.start - 1)
    void vscode.commands.executeCommand('codeNotes.reveal')
    const menus = pkg.contributes.menus
    assert.ok(!menus['comments/commentThread/context'].some((m: any) => m.command === 'codeNotes.replyResolve'), 'one resolve control in a thread: no Reply & Resolve')
    assert.ok(pkg.contributes.commands.some((c: any) => c.command === 'codeNotes.deleteResolved' && c.title.startsWith('Purge')), 'bulk delete renamed')
    // ISS-1005: a note's own actions stay reachable from the palette when the cursor is on it.
    for (const c of ['codeNotes.moveToSelection', 'codeNotes.copyNotePrompt', 'codeNotes.delete']) assert.ok(menus.commandPalette.some((m: any) => m.command === c && m.when === 'codeNotes.cursorOnNote'), `${c} in the palette on a note`)
    // No grab-bag: Reopen / Keep Note Here live in the thread; Show Map while walking; ask a question.
    for (const c of ['codeNotes.reopen', 'codeNotes.acceptCode']) assert.ok(menus.commandPalette.some((m: any) => m.command === c && m.when === 'false'), `${c} not in the palette`)
    assert.ok(menus.commandPalette.some((m: any) => m.command === 'codeNotes.showMap' && m.when === 'codeNotes.journeyActive'), 'Show Journey Map while walking')
    assert.ok(pkg.contributes.commands.some((c: any) => c.command === 'codeNotes.askQuestion'), 'Ask a Question About the Code…')
  }),

  test('sessions: hide, show only, show all', async () => {
    // Notes grouped by "session"; hiding one removes its threads from the editor; "show only" hides the rest.
    writeNote(ctx.notesDir, '20261111-160000-sesa', agentNote('src/renamed.ts', 1, 'Visual review note', { session: 'Visual review' }))
    writeNote(ctx.notesDir, '20261111-160001-sesb', agentNote('src/renamed.ts', 2, 'Classic review note', { session: 'Classic review' }))
    await until('session notes loaded with threads', () => bySession('Visual review')?.hasThread && bySession('Classic review')?.hasThread)
    await vscode.commands.executeCommand('codeNotes.hideSession', { kind: 'session', name: 'Visual review', notes: [] })
    await until('hidden session has no thread', () => bySession('Visual review')?.hasThread === false && bySession('Classic review')?.hasThread)
    await vscode.commands.executeCommand('codeNotes.showOnlySession', { kind: 'session', name: 'Visual review', notes: [] })
    await until('show only flips them', () => bySession('Visual review')?.hasThread && bySession('Classic review')?.hasThread === false)
    await vscode.commands.executeCommand('codeNotes.showAllSessions')
    await until('all shown', () => bySession('Visual review')?.hasThread && bySession('Classic review')?.hasThread)
  }),

  test('invalid ranges, statuses and empty notes are reported as unreadable', async () => {
    // Reported, not shown as normal notes.
    const brokenBefore = snap().broken
    const invalid: Record<string, object> = {
      '20261111-170000-bad1': { file: 'src/renamed.ts', range: { start: 0, end: 0 }, status: 'open', messages: [{ author: 'claude', body: 'zero' }] },
      '20261111-170001-bad2': { file: 'src/renamed.ts', range: { start: 3, end: 1 }, status: 'open', messages: [{ author: 'claude', body: 'reversed' }] },
      '20261111-170002-bad3': { file: 'src/renamed.ts', range: { start: 1, end: 1 }, status: 'wontfix', messages: [{ author: 'claude', body: 'status' }] },
      '20261111-170003-bad4': { file: 'src/renamed.ts', range: { start: 1, end: 1 }, status: 'open', messages: [] },
    }
    for (const [id, note] of Object.entries(invalid)) writeNote(ctx.notesDir, id, note)
    await until('4 invalid files reported', () => snap().broken === brokenBefore + 4)
    assert.ok(!snap().notes.some((x: any) => ['zero', 'reversed', 'status'].includes(x.messages[0]?.body)), 'not listed as notes')
    for (const id of Object.keys(invalid)) fs.unlinkSync(path.join(ctx.notesDir, `${id}.json`))
  }),

  test('Mark as Unread', async () => {
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(renamedTs()))
    caretAt(editor, bySession('Visual review')!.range.start - 1)
    await vscode.commands.executeCommand('codeNotes.reveal')
    await until('read', () => bySession('Visual review')?.unread === 0)
    await vscode.commands.executeCommand('codeNotes.markUnread')
    await until('unread again', () => bySession('Visual review')?.unread === 1)
  }),

  test('notes folder "." refused; nothing written to the repo root', async () => {
    // A folder setting of "." would put a .gitignore in the repo root.
    await setting('folder', '.')
    await quiet(1500, 'a .gitignore written to the workspace root')
    assert.ok(!fs.existsSync(wsPath('.gitignore')), 'no .gitignore in the workspace root')
    assert.ok(snap().notes.length > 0, 'still reading .code-notes')
    await setting('folder', undefined)
  }),

  test('Ask Claude: streams, answers, resumes the session on follow-ups, read-only, cancel', async () => {
    // From here on Claude is the fake CLI, for this test and every one after it.
    await useFakeClaude()
    const id = bySession('Classic review')!.id
    const asked = () => snap().notes.find((y: any) => y.id === id)
    const file = path.join(ctx.notesDir, `${id}.json`)
    void vscode.commands.executeCommand('codeNotes.askClaude', id)
    await until('Claude is answering', () => asked()?.asking)
    await until('Claude answered', () => { const x = asked(); return x && !x.asking && x.messages.at(-1)?.author === 'Claude' }, 10000)
    const answered = await until('answer saved with its session', () => { const x = readJson(file); return x.claudeSession && x.messages.at(-1)?.author === 'Claude' && x })
    assert.equal(answered.claudeSession, 'sess-123')
    assert.match(answered.messages.at(-1).body, /src\/renamed\.ts:3/)
    assert.ok(!fakeCalls()[0].includes('--resume'), 'first ask starts a session')
    // A follow-up resumes the session, read-only.
    appendMessage(file, { author: snap().me, role: 'human', body: 'Where is it written?', at: now() })
    await until('follow-up loaded', () => asked()?.messages.length === answered.messages.length + 1)
    void vscode.commands.executeCommand('codeNotes.askClaude', id)
    await until('follow-up answered', () => readJson(file).messages.at(-1)?.author === 'Claude' && readJson(file).messages.length === answered.messages.length + 2, 10000)
    const followUp = fakeCalls().at(-1)!
    assert.ok(followUp.includes('--resume') && followUp.includes('sess-123'), 'follow-up resumes the session')
    assert.ok(followUp.includes('--disallowedTools') && followUp.includes('Edit'), 'read-only')
    // Cancel.
    appendMessage(file, { author: snap().me, role: 'human', body: 'slow question', at: now() })
    await until('loaded', () => readJson(file).messages.at(-1).body === 'slow question' && asked()?.messages.at(-1)?.body === 'slow question')
    void vscode.commands.executeCommand('codeNotes.askClaude', id)
    await until('asking slow', () => asked()?.asking)
    await vscode.commands.executeCommand('codeNotes.cancelClaude', id)
    await until('cancelled, no answer added', () => { const x = asked(); return x && !x.asking && x.messages.at(-1)?.body === 'slow question' })
  }),

  test('mode "always": new notes are answered without a click', async () => {
    await setting('claude.mode', 'always')
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(renamedTs()))
    await vscode.commands.executeCommand('codeNotes.createFromThread', { thread: { uri: doc.uri, range: new vscode.Range(0, 0, 0, 5), dispose() {} }, text: 'Auto question' })
    await until('auto-answered', () => snap().notes.find((x: any) => x.messages[0]?.body === 'Auto question')?.messages.at(-1)?.author === 'Claude', 10000)
    await setting('claude.mode', undefined)
  }),

  test('a note pointing outside the workspace is refused; an absolute path inside works', async () => {
    const outside = writeNote(ctx.notesDir, '20261111-180000-trv1', agentNote('../../../../../../etc/hostname', 1, 'outside'))
    absolutePath = writeNote(ctx.notesDir, '20261111-180001-abs1', agentNote(renamedTs(), 1, 'absolute'))
    await until('absolute path read as relative', () => noteAtPath(absolutePath)?.file === 'src/renamed.ts' && !noteAtPath(absolutePath).missing)
    await quiet(1500, 'the outside note loaded, or its file read')
    assert.ok(!noteAtPath(outside), 'outside note not loaded')
    assert.ok(!readJson(outside).anchor, 'nothing read from outside the workspace')
    fs.unlinkSync(outside)
  }),

  test('an orphan without an anchor stays put when another file appears', async () => {
    // An anchor-less note on a missing file is not adopted by an unrelated new file.
    const orphan = writeNote(ctx.notesDir, '20261111-180002-hij1', agentNote('src/gone.ts', 1, 'orphan'))
    await until('orphan missing', () => noteAtPath(orphan)?.missing)
    fs.writeFileSync(wsPath('src', 'unrelated.ts'), 'export const x = 1\nexport const y = 2\n')
    await quiet(2500, 'the orphan moved to the new file (a rename is looked for over ~2 s)')
    assert.equal(readJson(orphan).file, 'src/gone.ts', 'not moved to an unrelated file')
  }),

  test('a string "selection" is kept as the exact text', async () => {
    stringSelectionPath = writeNote(ctx.notesDir, '20261111-180003-sel1', agentNote('src/renamed.ts', 1, 'string selection', { selection: 'export' }))
    await until('string selection kept', () => noteAtPath(stringSelectionPath)?.selection?.text === 'export')
  }),

  test('your own reply does not count as new', async () => {
    const own = noteAtPath(absolutePath)
    const thread = await until('thread', () => ctx.api.thread(own.id))
    await vscode.commands.executeCommand('codeNotes.reveal', { thread })
    await until('own note read', () => noteAtPath(absolutePath)?.unread === 0)
    await vscode.commands.executeCommand('codeNotes.reply', { thread, text: 'my own reply' })
    await until('reply saved', () => readJson(absolutePath).messages.length === 2)
    await quiet(300, 'my reply counted as new')
    assert.ok(!/2 new/.test(noteAtPath(absolutePath).threadLabel ?? ''), `own reply not new: ${noteAtPath(absolutePath).threadLabel}`)
  }),

  test('Undo as a command; undoing a resolve keeps the reply unread', async () => {
    // Resolve, then "Code Notes: Undo" after the toast: open again and still unread.
    appendMessage(absolutePath, { author: 'claude', role: 'agent', body: 'unread answer', at: now() })
    await until('unread answer', () => noteAtPath(absolutePath)?.unread === 1)
    const note = noteAtPath(absolutePath)
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(renamedTs()))
    caretAt(editor, note.range.start - 1)
    await vscode.commands.executeCommand('codeNotes.resolve', { thread: ctx.api.thread(note.id) })
    await until('resolved', () => readJson(absolutePath).status === 'resolved')
    await vscode.commands.executeCommand('codeNotes.undo')
    await until('undone: open and unread', () => readJson(absolutePath).status === 'open' && noteAtPath(absolutePath)?.unread === 1)
  }),

  test('a note deleted on disk is kept in .trash', async () => {
    // An agent deletes a note file: its last version lands in .trash.
    fs.unlinkSync(stringSelectionPath)
    await until('copied to trash', () => fs.existsSync(path.join(ctx.notesDir, '.trash', path.basename(stringSelectionPath))))
  }),

  test('ignoreInGit off still ignores .trash', async () => {
    // Notes shared through git: the trash stays ignored.
    const gitignore = path.join(ctx.notesDir, '.gitignore')
    await setting('ignoreInGit', false)
    await until('.gitignore keeps the trash out', () => { try { return fs.readFileSync(gitignore, 'utf8') === '.trash/\n' } catch { return false } })
    await setting('ignoreInGit', undefined)
    await until('.gitignore back to everything', () => fs.readFileSync(gitignore, 'utf8') === '*\n')
  }),
]
