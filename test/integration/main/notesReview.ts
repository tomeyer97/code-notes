// Notes as review findings: R (resolve and next), severity order and icons, grouping by session or file, the
// history of resolves and reopens, suggestions with Apply, file and folder notes, Add Note without commenting ranges.
// Source: src/notes/ (commands, suggestions), src/threads/, src/sidebar/ (the tree), src/noteModel.ts (events,
// unknown fields kept).
import * as vscode from 'vscode'
import * as fs from 'fs'
import assert from 'assert'
import { appendMessage, now, quiet, readJson, settle, test } from '../helpers'
import { agentNote, writeNote } from '../fixtures'
import { at, bodyOf, tour, closeAllEditors, ctx, journeysTree, noteById, notePath, notesTree, snap, until, wsPath } from './context'
import { UNREAD_FINDING } from './shared'

/* eslint-disable @typescript-eslint/no-explicit-any */
const SECOND_UNREAD = '20261111-200001-unr2'
/** A finding R goes to after resolving UNREAD_FINDING; later the note whose history is checked. */
const HIGH = '20261111-200101-sv2'
const CRITICAL = '20261111-200103-sv4'
const SUGGESTION = '20261111-200200-sug1'

/** HIGH's file as the agent resolved it (restored later as "an older version"). */
let resolvedByAgent: any

export const notesReviewTests = [
  test('R resolves the note at the cursor (recorded in "events") and opens the next unread note', async () => {
    await vscode.commands.executeCommand('codeNotes.markAllRead') // earlier tests left unread notes elsewhere
    await until('all read', () => snap().notes.every((x: any) => x.unread === 0))
    writeNote(ctx.notesDir, SECOND_UNREAD, agentNote('src/flow.ts', 1, 'Second unread'))
    await until('second unread', () => noteById(SECOND_UNREAD)?.unread === 1)
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(wsPath('src', 'flow2.ts')))
    editor.selection = new vscode.Selection(0, 0, 0, 0)
    // Settled where it is (a file opened over the journey panel moves to the code group, and takes the focus with it).
    await until('flow2 in front', () => vscode.window.activeTextEditor?.document.uri.path.endsWith('/src/flow2.ts') && vscode.window.tabGroups.activeTabGroup.viewColumn !== tour().mapColumn)
    vscode.window.activeTextEditor!.selection = new vscode.Selection(0, 0, 0, 0)
    void vscode.commands.executeCommand('codeNotes.resolveNext')
    await until('R resolved it', () => readJson(notePath(UNREAD_FINDING)).status === 'resolved')
    await until('R went on to the next unread', () => at() === 'src/flow.ts:1' && noteById(SECOND_UNREAD).unread === 0)
    const events = readJson(notePath(UNREAD_FINDING)).events
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'resolved')
    assert.equal(events[0].by, snap().me)
  }),

  test('severity: icons, most severe first inside a session; unknown severity and fields survive a rewrite', async () => {
    const finding = (id: string, line: number, severity: string | undefined, extra: object = {}) =>
      writeNote(ctx.notesDir, id, agentNote('src/flow.ts', line, `${severity ?? 'none'} finding`, { session: 'Review', ...(severity ? { severity } : {}), ...extra }))
    finding('20261111-200100-sv1', 2, 'low')
    finding(HIGH, 6, 'high')
    finding('20261111-200102-sv3', 3, undefined)
    finding(CRITICAL, 7, 'critical', { reviewer: { tool: 'x', v: 2 } })
    await until('review loaded', () => snap().notes.filter((x: any) => x.session === 'Review').length === 4)
    await vscode.commands.executeCommand('codeNotes.groupBySession')
    await until('grouped by session', () => snap().groupBy === 'session' && notesTree().some((l: string) => l.startsWith('session:Review')))
    const rows = notesTree()
    const session = rows.findIndex((l) => l.startsWith('session:Review'))
    const kids = rows.slice(session + 1, session + 7).filter((l) => l.startsWith('    note:'))
    assert.deepEqual(kids.map((l) => l.trim().split(' · ')[0]), ['note:high finding', 'note:none finding', 'note:critical finding', 'note:low finding'], `severity order: ${kids.join(' | ')}`)
    assert.match(kids[0], /\[flame\]$/)
    assert.match(kids[3], /\[triangle-down\]$/)
    assert.match(kids[1], /\[circle-filled\]$/, 'no severity, unread: the blue dot')
    await vscode.commands.executeCommand('codeNotes.markAllRead')
    await until('read: who spoke last (an agent)', () => notesTree().some((l) => /none finding.*\[sparkle\]$/.test(l)))
    void vscode.commands.executeCommand('codeNotes.resolve', { thread: await until('thread', () => ctx.api.thread(CRITICAL)) })
    await until('critical resolved', () => readJson(notePath(CRITICAL)).status === 'resolved')
    assert.equal(readJson(notePath(CRITICAL)).severity, 'critical', 'unknown severity kept')
    assert.deepEqual(readJson(notePath(CRITICAL)).reviewer, { tool: 'x', v: 2 }, 'unknown field kept')
    assert.equal(readJson(notePath(CRITICAL)).events.length, 1)
  }),

  test('Group by File / Session toggles; single-note files are one row', async () => {
    // File puts every non-journey note under its file; a file with one note is one row (file:line).
    await vscode.commands.executeCommand('codeNotes.groupByFile')
    await until('grouped by file', () => snap().groupBy === 'file')
    const rows = notesTree()
    assert.ok(!rows.some((l) => l.startsWith('session:Review')), 'no Review session in file mode')
    assert.ok(!rows.some((l) => l.startsWith('journeys:')) && journeysTree().some((l) => l.startsWith('jgroup:All')), 'journeys stay in their own view')
    assert.ok(rows.some((l) => /^file:flow\.ts/.test(l)), 'flow.ts row')
    const solo = rows.find((l) => /^note:.* · .*renamed\.ts:\d+/.test(l)) ?? rows.find((l) => /^note:/.test(l) && /\.ts:\d+/.test(l))
    assert.ok(solo, `a single-note file is one row with file:line:\n${rows.join('\n')}`)
  }),

  test('an agent\'s resolve on disk is recorded and unread; resolve/reopen lines in the thread', async () => {
    // The thread shows it as a grey line.
    const thread = await until('thread', () => ctx.api.thread(HIGH))
    await vscode.commands.executeCommand('codeNotes.reveal', { thread })
    await until('read', () => noteById(HIGH).unread === 0)
    await closeAllEditors()
    await settle(600, 'closing saves the notes\' anchors: the agent\'s write comes after that')
    resolvedByAgent = readJson(notePath(HIGH))
    resolvedByAgent.status = 'resolved'
    fs.writeFileSync(notePath(HIGH), JSON.stringify(resolvedByAgent, null, 2))
    await until('agent resolve recorded and unread', () => noteById(HIGH)?.unread === 1 && noteById(HIGH).events?.at(-1)?.by === 'claude').catch((e) => { console.log(JSON.stringify(noteById(HIGH)), fs.readFileSync(notePath(HIGH), 'utf8')); throw e })
    await until('written to the file', () => readJson(notePath(HIGH)).events?.at(-1)?.type === 'resolved')
    await until('thread still shown', () => ctx.api.thread(HIGH))
    await until('grey line in the thread', () => ctx.api.thread(HIGH)!.comments.some((c: vscode.Comment) => c.contextValue === 'event' && c.author.name === 'claude' && /Resolved/.test(bodyOf(c))))
    // My reply reopens it: a second line.
    await vscode.commands.executeCommand('codeNotes.reply', { thread: ctx.api.thread(HIGH), text: 'Not fixed yet' })
    await until('reopened by me', () => readJson(notePath(HIGH)).status === 'open' && readJson(notePath(HIGH)).events.at(-1).type === 'reopened')
  }),

  test('no avatars in threads', async () => {
    // No placeholder avatars: the name says who.
    const icons = ctx.api.thread(HIGH)!.comments.filter((c: vscode.Comment) => c.contextValue === 'message').map((c: vscode.Comment) => c.author.iconPath)
    assert.deepEqual(icons, [undefined, undefined])
  }),

  test('a restored older note file writes no events', async () => {
    // An older version of the file restored (git checkout): its status comes back, no event is invented.
    const eventsBefore = (resolvedByAgent.events ?? []).length
    fs.writeFileSync(notePath(HIGH), JSON.stringify(resolvedByAgent, null, 2))
    await until('restore read', () => noteById(HIGH)?.status === 'resolved')
    await quiet(700, 'an event written for the restore')
    assert.equal((readJson(notePath(HIGH)).events ?? []).length, eventsBefore, `no event written for a restore: ${JSON.stringify(readJson(notePath(HIGH)).events)}`)
  }),

  test('Apply suggestion replaces the lines, undo restores them, stale notes refuse', async () => {
    const flowDoc = await vscode.workspace.openTextDocument(wsPath('src', 'flow.ts'))
    const line = flowDoc.getText().split('\n').findIndex((l) => l.includes('return 2')) + 1
    writeNote(ctx.notesDir, SUGGESTION, { file: 'src/flow.ts', range: { start: line, end: line }, status: 'open', messages: [{ author: snap().me, role: 'human', body: 'Return 3?' }] })
    await until('suggestion note', () => noteById(SUGGESTION)?.anchor?.text?.includes('return 2'))
    // The extension writes the anchor it took into the file: reply only after that, as an agent re-reading the file would
    // (replying on the copy read before it raced that write and dropped the anchor: the flake of runs 1/2).
    await until('anchor on disk', () => readJson(notePath(SUGGESTION)).anchor?.text?.includes('return 2'))
    appendMessage(notePath(SUGGESTION), { author: 'claude', role: 'agent', body: 'Yes:\n\n```suggestion\n  return 3 // three\n```', at: now() })
    await until('suggestion loaded', () => noteById(SUGGESTION)?.messages.length === 2)
    const thread = await until('suggestion thread', () => ctx.api.thread(SUGGESTION))
    const body = await until('apply link', () => thread.comments.map(bodyOf).find((b: string) => b.includes('command:codeNotes.applySuggestion')))
    const args = JSON.parse(decodeURIComponent(/command:codeNotes\.applySuggestion\?([^ )]+)/.exec(body)![1]))
    await vscode.commands.executeCommand('codeNotes.applySuggestion', ...args) // the link's click
    await until('applied', () => flowDoc.lineAt(line - 1).text === '  return 3 // three')
    await quiet(600, 'the note marked stale by its own suggestion')
    assert.equal(noteById(SUGGESTION).stale, false, 'not stale after its own suggestion')
    await vscode.window.showTextDocument(flowDoc)
    await vscode.commands.executeCommand('undo')
    await until('undone', () => flowDoc.lineAt(line - 1).text === '  return 2')
    await until('undone: the note is back on the old code, not stale', () => noteById(SUGGESTION)?.stale === false && noteById(SUGGESTION).anchor.text === '  return 2')
    await flowDoc.save()
    // Stale: refused, nothing changed.
    const editor = await vscode.window.showTextDocument(flowDoc)
    await editor.edit((b) => b.replace(flowDoc.lineAt(line - 1).range, '  return 22'))
    await until('stale', () => noteById(SUGGESTION)?.stale === true)
    const applied = await ctx.api.applySuggestion(SUGGESTION, args[1], args[2])
    assert.equal(applied, false, 'refused on stale code')
    assert.equal(flowDoc.lineAt(line - 1).text, '  return 22')
    await vscode.commands.executeCommand('undo')
    await flowDoc.save()
  }),

  test('file and folder notes: added from the explorer, by agents, listed, threads on line 1 / a folder page, replies work', async () => {
    await closeAllEditors()
    const fileNoteUri = (await vscode.commands.executeCommand<any>('codeNotes.addPathNote', vscode.Uri.file(wsPath('src', 'flow2.ts')), 'Is this file still used?')).uri
    const folderNoteUri = (await vscode.commands.executeCommand<any>('codeNotes.addPathNote', vscode.Uri.file(wsPath('src')), 'Split this folder?')).uri
    const fileNote = readJson(fileNoteUri.fsPath), folderNote = readJson(folderNoteUri.fsPath)
    assert.equal(fileNote.target, 'file'); assert.equal(folderNote.target, 'folder')
    assert.ok(fileNote.range === undefined && fileNote.anchor === undefined, 'no range/anchor in a file note')
    assert.equal(folderNote.file, 'src')
    const fileThread = await until('file note thread', () => ctx.api.thread(fileNote.id))
    assert.equal(fileThread.range?.start.line, 0, 'the file note sits on line 1')
    assert.match(fileThread.label ?? '', /File note/)
    const folderThread = await until('folder note thread', () => ctx.api.thread(folderNote.id))
    assert.equal(folderThread.uri.scheme, 'code-notes-folder')
    assert.ok(vscode.window.activeTextEditor?.document.getText().includes('flow.ts'), 'the folder page lists the folder')
    await vscode.commands.executeCommand('codeNotes.reply', { thread: folderThread, text: 'Yes: api and storage' })
    await until('reply on a folder note', () => readJson(folderNoteUri.fsPath).messages.length === 2)
    writeNote(ctx.notesDir, '20261111-200300-agf1', agentNote('src', undefined, 'Agent folder note'))
    writeNote(ctx.notesDir, '20261111-200301-agf2', agentNote('src/flow2.ts', undefined, 'Agent file note', { target: 'file' }))
    await until('agent folder/file notes', () => noteById('20261111-200300-agf1')?.target === 'folder' && noteById('20261111-200301-agf2')?.target === 'file')
    assert.equal(snap().broken, 0, 'not reported as broken')
    const rows = notesTree()
    console.log(rows.map((l) => `      | ${l}`).join('\n'))
    assert.ok(rows.some((l) => /^file:src · 2\b.*\[folder\]$/.test(l)), 'a folder row holding the two folder notes')
    assert.ok(rows.some((l) => /Agent file note.*flow2\.ts|flow2\.ts/.test(l)), 'file note listed')
    // A file note survives edits to the file (stays on line 1, never stale).
    const flow2 = await vscode.window.showTextDocument(vscode.Uri.file(wsPath('src', 'flow2.ts')))
    await flow2.edit((b) => b.insert(new vscode.Position(0, 0), '// new first line\n'))
    await flow2.document.save()
    await quiet(800, 'the file note moving off line 1 or going stale')
    assert.equal(noteById(fileNote.id).range.start, 1)
    assert.equal(noteById(fileNote.id).stale, false)
  }),

  test('Add Note opens its box with no always-on commenting range', async () => {
    // Ctrl+' C still opens the comment box and saves, with no commenting range on every line.
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(wsPath('src', 'flow2.ts')))
    editor.selection = new vscode.Selection(2, 0, 2, 0)
    const notesBefore = snap().notes.length
    await vscode.commands.executeCommand('codeNotes.add')
    await settle(600, 'the comment box opening and taking the keyboard')
    await vscode.commands.executeCommand('type', { text: 'Typed into the box' })
    await vscode.commands.executeCommand('editor.action.submitComment')
    await until('Add Note saved a note', () => snap().notes.length === notesBefore + 1 && snap().notes.some((x: any) => x.messages[0].body === 'Typed into the box'), 8000)
    assert.equal(vscode.workspace.getConfiguration('comments').get('maxHeight'), false, 'More grows the card: no nested scroll')
  }),
]
