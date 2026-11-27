// Notes as review findings: R (resolve and next), severity order and icons, grouping by session or file, the
// history of resolves and reopens, suggestions with Apply, file and folder notes, Add Note without commenting ranges.
// Source: src/notes/ (commands, suggestions), src/threads/, src/sidebar/ (the tree), src/core/format/noteModel.ts (events,
// unknown fields kept).
import * as vscode from 'vscode'
import * as fs from 'fs'
import assert from 'assert'
import { appendMessage, now, quiet, readJson, settle, sleep, test } from '../helpers'
import { agentNote, writeNote } from '../fixtures'
import { at, bodyOf, commandLinksIn, tour, closeAllEditors, ctx, journeysTree, noteById, notePath, notesTree, snap, until, wsPath } from './context'
import { UNREAD_FINDING } from './shared'

/* eslint-disable @typescript-eslint/no-explicit-any */
/** A note id in the note-ID format; only `tag` matters to these tests (a unique name). */
const noteId = (time: string, tag: string) => `20261111-${time}-${tag}`

// The notes several tests here look at, by id.
const SECOND_UNREAD = noteId('200001', 'unr2')
/** A finding R goes to after resolving UNREAD_FINDING; later the note whose history is checked. */
const HIGH = noteId('200101', 'sv2')
const CRITICAL = noteId('200103', 'sv4')
const SUGGESTION = noteId('200200', 'sug1')

/** HIGH's file as the agent resolved it, as written ("an agent's resolve on disk…"; restored later as "an older
 *  version" by "a restored older note file…"). */
let resolvedByAgent: string | undefined

/** A row of the Notes or Journeys view as the test API prints it (`kind:label · description [icon]`, two spaces per
 *  level): parsed here once, so the tests compare fields. The label is what comes before the first " · ". */
interface Row { depth: number; kind: string; label: string; description: string; icon?: string; text: string }
function rowsOf(lines: string[]): Row[] {
  return lines.map((text) => {
    const depth = (text.length - text.trimStart().length) / 2
    const iconAt = /\s\[([^\]]+)\](?: \{collapsed\})?$/.exec(text)
    const body = (iconAt ? text.slice(0, iconAt.index) : text).trimStart()
    const colon = body.indexOf(':')
    const [label, ...rest] = body.slice(colon + 1).split(' · ')
    return { depth, kind: body.slice(0, colon), label, description: rest.join(' · '), icon: iconAt?.[1], text }
  })
}
const notesRows = () => rowsOf(notesTree())

/** The command links in a comment's markdown, as VS Code runs them when clicked: the command and its arguments. */
const commandLinks = (markdown: string) => commandLinksIn(markdown)

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
    const rows = notesRows()
    const session = rows.findIndex((r) => r.kind === 'session' && r.label.startsWith('Review'))
    // Under the session, its notes as one list (no file rows inside a session).
    const kids = rows.slice(session + 1, session + 5).filter((r) => r.kind === 'note' && r.depth === 1)
    const shown = kids.map((r) => r.text).join(' | ')
    assert.deepEqual(kids.map((r) => r.label), ['high finding', 'none finding', 'critical finding', 'low finding'], `severity order: ${shown}`)
    assert.deepEqual(kids.map((r) => r.icon), ['flame', 'circle-filled', kids[2]?.icon, 'triangle-down'], `icons (no severity, unread: the blue dot): ${shown}`)
    await vscode.commands.executeCommand('codeNotes.markAllRead')
    await until('read: who spoke last (an agent)', () => notesRows().some((r) => r.label.includes('none finding') && r.icon === 'sparkle'))
    void vscode.commands.executeCommand('codeNotes.resolve', { thread: await until('thread', () => ctx.api.thread(CRITICAL)) })
    await until('critical resolved', () => readJson(notePath(CRITICAL)).status === 'resolved')
    assert.equal(readJson(notePath(CRITICAL)).severity, 'critical', 'unknown severity kept')
    assert.deepEqual(readJson(notePath(CRITICAL)).reviewer, { tool: 'x', v: 2 }, 'unknown field kept')
    assert.equal(readJson(notePath(CRITICAL)).events.length, 1)
  }),

  test('two review sessions of 9 findings: 2 + 18 rows, each a flat list, most severe first, "file:line"', async () => {
    // The same 3 files in both sessions: no file rows repeated per session.
    const sevs = ['low', 'high', 'nit', 'medium', 'high', 'low', 'medium', 'nit', 'high']
    const files = ['src/flow.ts', 'src/flow2.ts', 'src/renamed.ts']
    const written: string[] = []
    for (const s of ['Perf A', 'Perf B']) {
      sevs.forEach((severity, i) => written.push(writeNote(ctx.notesDir, noteId(`2005${s.endsWith('A') ? 0 : 1}${i}`, `prf${s.at(-1)!.toLowerCase()}${i}`),
        agentNote(files[i % 3], 1 + Math.floor(i / 3), `${s} finding ${i}`, { session: s, severity }))))
    }
    await until('both reviews listed', () => notesRows().filter((r) => /^Perf [AB] finding/.test(r.label)).length === 18)
    const rows = notesRows()
    const all = rows.map((r) => r.text).join('\n')
    for (const name of ['Perf A', 'Perf B']) {
      const at = rows.findIndex((r) => r.kind === 'session' && r.label === name)
      assert.ok(at >= 0 && rows[at].depth === 0, `a session row for ${name}:\n${all}`)
      assert.match(rows[at].description, /^9 notes · 9 new\b/, `the session's counts say what they count:\n${all}`)
      const kids = rows.slice(at + 1, at + 10)
      assert.ok(kids.every((r) => r.kind === 'note' && r.depth === 1), `9 note rows right under the session:\n${all}`)
      assert.deepEqual(kids.map((r) => r.icon), ['flame', 'flame', 'flame', 'triangle-up', 'triangle-up', 'triangle-down', 'triangle-down', 'dash', 'dash'], `most severe first:\n${all}`)
      assert.ok(kids.every((r) => /\b(flow|flow2|renamed)\.ts:\d+\b/.test(r.description)), `each row names its file and line:\n${all}`)
    }
    for (const p of written) fs.unlinkSync(p)
    await until('reviews gone', () => !notesRows().some((r) => r.kind === 'session' && /^Perf [AB]$/.test(r.label)))
  }),

  test('Resolve Session: the notes others resolved are read too, so the session leaves the list', async () => {
    writeNote(ctx.notesDir, noteId('200600', 'dno1'), agentNote('src/flow.ts', 2, 'Done open finding', { session: 'Done review' }))
    await until('loaded', () => notesRows().some((r) => r.label === 'Done open finding'))
    await vscode.commands.executeCommand('codeNotes.markAllRead') // one read open note: Resolve Session asks nothing
    await until('read', () => snap().notes.every((x: any) => x.unread === 0))
    const byAgent = { status: 'resolved', events: [{ type: 'resolved', by: 'claude', role: 'agent', at: now() }] }
    writeNote(ctx.notesDir, noteId('200601', 'dnr1'), agentNote('src/flow.ts', 3, 'Done by agent 1', { session: 'Done review', ...byAgent }))
    writeNote(ctx.notesDir, noteId('200602', 'dnr2'), agentNote('src/flow2.ts', 1, 'Done by agent 2', { session: 'Done review', ...byAgent }))
    await until('the agent\'s resolved notes listed as new', () => notesRows().filter((r) => /^Done by agent/.test(r.label) && /^1 new · resolved by claude\b/.test(r.description)).length === 2)
    void vscode.commands.executeCommand('codeNotes.resolveSession', { kind: 'session', name: 'Done review', notes: [] }) // an Undo toast: not awaited
    await until('no row of the session left', () => !notesRows().some((r) => /^Done (open finding|by agent)|^Done review$/.test(r.label)))
    assert.ok(snap().notes.filter((x: any) => x.session === 'Done review').every((x: any) => x.unread === 0 && x.status === 'resolved'), 'none counts as new')
  }),

  test('Group by File: every file is a file row, also with one note; files by path', async () => {
    const lone = writeNote(ctx.notesDir, noteId('200700', 'lon1'), agentNote('src/flow2.ts', 2, 'Lone note'))
    await vscode.commands.executeCommand('codeNotes.groupByFile')
    await until('grouped by file, the lone note listed', () => snap().groupBy === 'file' && notesRows().some((r) => r.label === 'Lone note'))
    const rows = notesRows()
    const all = rows.map((r) => r.text).join('\n')
    const top = rows.filter((r) => r.depth === 0)
    assert.ok(!rows.some((r) => r.kind === 'session' && r.label.startsWith('Review')), 'no Review session in file mode')
    assert.ok(!rows.some((r) => r.kind === 'journeys') && rowsOf(journeysTree()).some((r) => r.kind === 'jgroup' && r.label.startsWith('All')), 'journeys stay in their own view')
    assert.ok(top.every((r) => r.kind === 'file' || r.kind === 'broken'), `only file rows at the top:\n${all}`)
    assert.ok(rows.filter((r) => r.kind === 'note').every((r) => r.depth === 1 && !/\.ts:\d+/.test(r.description)), `every note under its file row, by its lines:\n${all}`)
    const files = top.filter((r) => r.kind === 'file')
    const flow = files.find((r) => r.label === 'flow.ts'), renamed = files.find((r) => r.label === 'renamed.ts')
    assert.ok(flow && /^\d+ notes?\b/.test(flow.description), `flow.ts row with its count:\n${all}`)
    assert.ok(renamed && files.indexOf(flow!) < files.indexOf(renamed), `files by path (src/flow.ts before src/renamed.ts):\n${all}`)
    const at = rows.findIndex((r) => r.kind === 'file' && r.label === 'flow2.ts')
    assert.ok(at >= 0 && rows[at].description.startsWith('1 note · 1 new') && rows[at + 1]?.label === 'Lone note' && rows[at + 1].description === '1 new · L2', `a one-note file is a file row of one:\n${all}`)
    fs.unlinkSync(lone)
    await until('lone note gone', () => !notesRows().some((r) => r.label === 'Lone note'))
  }),

  test('an agent\'s resolve on disk is recorded and unread; resolve/reopen lines in the thread', async () => {
    // The thread shows it as a grey line.
    const thread = await until('thread', () => ctx.api.thread(HIGH))
    await vscode.commands.executeCommand('codeNotes.reveal', { thread })
    await until('read', () => noteById(HIGH).unread === 0)
    await closeAllEditors()
    await settle(600, 'closing saves the notes\' anchors: the agent\'s write comes after that')
    const resolved = { ...readJson(notePath(HIGH)), status: 'resolved' }
    resolvedByAgent = JSON.stringify(resolved, null, 2)
    fs.writeFileSync(notePath(HIGH), resolvedByAgent)
    await until('agent resolve recorded and unread', () => noteById(HIGH)?.unread === 1 && noteById(HIGH).events?.at(-1)?.by === 'claude').catch((e) => { console.log(JSON.stringify(noteById(HIGH)), fs.readFileSync(notePath(HIGH), 'utf8')); throw e })
    await until('written to the file', () => readJson(notePath(HIGH)).events?.at(-1)?.type === 'resolved')
    await until('thread still shown', () => ctx.api.thread(HIGH))
    await until('grey line in the thread', () => ctx.api.thread(HIGH)!.comments.some((c: vscode.Comment) => c.contextValue === 'event' && c.author.name === 'claude' && /Resolved/.test(bodyOf(c))))
    // Mark All Read takes the unread resolve with it; its Undo brings it back.
    await vscode.commands.executeCommand('codeNotes.markAllRead')
    await until('resolve read', () => noteById(HIGH).unread === 0)
    await vscode.commands.executeCommand('codeNotes.undo')
    await until('resolve unread again after Undo', () => noteById(HIGH).unread === 1)
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
    assert.ok(resolvedByAgent !== undefined, 'needs the test "an agent\'s resolve on disk is recorded…" to have passed first')
    const eventsBefore = (JSON.parse(resolvedByAgent).events ?? []).length
    fs.writeFileSync(notePath(HIGH), resolvedByAgent)
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
    const apply = await until('the Apply link', () => thread.comments.flatMap((c: vscode.Comment) => commandLinks(bodyOf(c))).find((l) => l.command === 'codeNotes.applySuggestion'))
    const args = apply.args as [unknown, number, number]
    await vscode.commands.executeCommand(apply.command, ...args) // the link's click
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
    const rows = notesRows()
    const all = rows.map((r) => r.text).join('\n')
    assert.ok(rows.some((r) => r.depth === 0 && r.kind === 'file' && r.label === 'src' && /^2\b/.test(r.description) && r.icon === 'folder'), `a folder row holding the two folder notes:\n${all}`)
    assert.ok(rows.some((r) => r.text.includes('flow2.ts')), `file note listed:\n${all}`)
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
    // Typed 600 ms later, as a person would, and not scaled with the other waits: in the test window the keyboard
    // leaves the box after a second or two (to an open thread's Reply above it), and what is typed then is lost.
    await sleep(600)
    await vscode.commands.executeCommand('type', { text: 'Typed into the box' })
    await vscode.commands.executeCommand('editor.action.submitComment')
    await until('Add Note saved a note', () => snap().notes.length === notesBefore + 1 && snap().notes.some((x: any) => x.messages[0].body === 'Typed into the box'), 8000)
    assert.equal(vscode.workspace.getConfiguration('comments').get('maxHeight'), false, 'More grows the card: no nested scroll')
  }),
]
