// Runs inside a real VS Code (see run.ts): drives the extension the way a person and an agent would.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import assert from 'assert'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Waits are tuned for a fast machine; CI (or CODE_NOTES_TIMEOUT_SCALE=n) gives every wait n times longer. */
const SCALE = Number(process.env.CODE_NOTES_TIMEOUT_SCALE) || (process.env.CI ? 3 : 1)
async function until<T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 6000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms * SCALE) throw new Error(`timed out waiting for: ${what}`)
    await sleep(100)
  }
}

// The extension's id, from package.json (publisher.name).
const pkgJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'))
const EXT_ID = `${pkgJson.publisher}.${pkgJson.name}`

const linesOfDoc = (d: vscode.TextDocument) => Array.from({ length: d.lineCount }, (_, i) => d.lineAt(i).text)

export async function run(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders![0]
  const ws = folder.uri.fsPath
  const notesDir = path.join(ws, '.code-notes')
  const api = (await vscode.extensions.getExtension(EXT_ID)!.activate()) as { writeJourney: (q: string) => Promise<string | undefined>; snapshot: () => any; thread: (id: string) => vscode.CommentThread | undefined; reloadTour: () => Promise<void>; mapSend: (m: unknown) => void; resetTutorial: () => Promise<void> }
  const snap = () => api.snapshot()
  const first = () => snap().notes[0]
  const ok = (m: string) => console.log(`  ✓ ${m}`)
  const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'))
  const reply = (p: string, msg: object) => { const d = readJson(p); d.messages.push(msg); fs.writeFileSync(p, JSON.stringify(d, null, 2)) }

  // 1. A person adds a note (the inline comment box's "Add Note").
  const file = vscode.Uri.file(path.join(ws, 'src', 'app.ts'))
  const doc = await vscode.workspace.openTextDocument(file)
  const editor = await vscode.window.showTextDocument(doc)
  await vscode.commands.executeCommand('codeNotes.createFromThread', {
    thread: { uri: file, range: new vscode.Range(2, 0, 3, 0), dispose() {} }, text: 'Why is the token never removed?',
  })
  const note = await until('note created', () => first())
  assert.deepEqual(note.range, { start: 3, end: 3 }, 'a range ending at column 0 does not include that line')
  assert.equal(note.messages[0].role, 'human')
  assert.equal(note.messages[0].author, snap().me)
  const jsonPath = note.path as string
  const readme = fs.readFileSync(path.join(notesDir, 'README.md'), 'utf8')
  assert.ok(readme.includes(`"file": "src/main.ts"`) && readme.includes(`**${snap().me}**`) && !/^\s*"[^"]+":.*\/\//m.test(readme), 'README: right path, names the person, no comments in JSON')
  ok('note created with role and author; README correct for agents')

  // 2. Agent reply stamped EARLIER than anything (clock skew) still counts as unread; missing "at" stays missing.
  reply(jsonPath, { author: 'claude', role: 'agent', body: 'It is read once in `main`.', at: '2001-01-01T00:00:00Z' })
  await until('past-dated reply unread', () => first()?.unread === 1)
  assert.equal(snap().badge, 1)
  reply(jsonPath, { author: 'claude', role: 'agent', body: 'And no timestamp on this one.' })
  await until('second reply unread', () => first()?.unread === 2)
  await vscode.commands.executeCommand('codeNotes.refresh')
  await until('still 2 after reload, nothing invented', () => first()?.unread === 2 && first().messages[2].at === undefined)
  ok('replies unread whatever their timestamps; a missing "at" is not invented')

  // 3. Opening the note: its thread opens, it is read, and the "new" labels stay for the visit.
  vscode.commands.executeCommand('codeNotes.nextUnread')
  await until('read after Next Unread', () => first()?.unread === 0 && first().threadExpanded && snap().badge === 0)
  assert.doesNotMatch(first().threadLabel, /new/, 'read everywhere at once, the thread header too')
  ok('Next Unread opens the thread, clears the badge and every "new"')

  // 4. Lines inserted above: followed live, written to disk only when the file is saved.
  await editor.edit((b) => b.insert(new vscode.Position(0, 0), '// one\n// two\n'))
  await until('moved by 2 in the editor', () => first()?.range.start === 5)
  await sleep(700)
  assert.equal(readJson(jsonPath).range.start, 3, 'not written while the file is unsaved')
  await doc.save()
  await until('written on save', () => readJson(jsonPath).range.start === 5)
  ok('edits above are followed live and saved with the file')

  // 5. Reformatting is not a change; a real change is stale; undo clears it.
  const line = doc.lineAt(4).text
  await editor.edit((b) => b.replace(doc.lineAt(4).range, line.replace(/^\s+/, '        ')))
  await sleep(700)
  assert.equal(first().stale, false, 're-indent is not stale')
  await editor.edit((b) => b.replace(doc.lineAt(4).range, '  const token = readOtherToken()'))
  await until('stale after a real change', () => first()?.stale === true && /The code changed since this note/.test((api.thread(first().id)?.comments[0]?.body as vscode.MarkdownString | undefined)?.value ?? ''))
  await vscode.commands.executeCommand('undo')
  await vscode.commands.executeCommand('undo')
  await until('stale cleared after undo', () => first()?.stale === false)
  await doc.save()
  ok('re-indent keeps the note; a real change makes it stale; undo clears it')

  // 6. Resolve, then an agent reply reopens it.
  editor.selection = new vscode.Selection(4, 0, 4, 0)
  void vscode.commands.executeCommand('codeNotes.resolve') // shows an Undo toast: not awaited
  await until('resolved on disk', () => readJson(jsonPath).status === 'resolved')
  reply(jsonPath, { author: 'claude', role: 'agent', body: 'Actually there is a second caller.', at: new Date().toISOString() })
  await until('reopened by the reply', () => readJson(jsonPath).status === 'open' && first()?.unread === 1)
  ok('a reply on a resolved note reopens it and is unread')

  // 7. A half-written file, then restored to the same content: the error clears.
  const good = fs.readFileSync(jsonPath, 'utf8')
  fs.writeFileSync(jsonPath, good.slice(0, 40))
  await until('broken reported', () => snap().broken === 1)
  fs.writeFileSync(jsonPath, good)
  await until('broken cleared after restore', () => snap().broken === 0)
  ok('a broken file that is restored stops being reported')

  // 8. An agent's note whose file name differs from its "id": edited in place, no duplicate.
  const agentFile = path.join(notesDir, 'agent-question-1.json')
  fs.writeFileSync(agentFile, JSON.stringify({ id: 'something-else', file: 'src/app.ts', range: { start: 1, end: 1 }, anchor: { text: doc.lineAt(0).text, before: '', after: doc.lineAt(1).text }, status: 'open', messages: [{ author: 'claude', role: 'agent', body: 'Is **this** header needed?' }] }, null, 2))
  await until('agent note loaded', () => snap().notes.length === 2)
  editor.selection = new vscode.Selection(0, 0, 0, 0)
  void vscode.commands.executeCommand('codeNotes.resolve')
  await until('agent note resolved in its own file', () => readJson(agentFile).status === 'resolved')
  await sleep(300)
  assert.deepEqual(fs.readdirSync(notesDir).filter((f) => f.endsWith('.json')).length, 2, 'no duplicate file')
  ok('a note file named differently from its id is edited in place')

  // 9. The code file is renamed on disk (git mv): the note follows.
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  const moved = path.join(ws, 'src', 'renamed.ts')
  fs.renameSync(file.fsPath, moved)
  await until('note follows the renamed file', () => snap().notes.find((n: any) => n.messages[0].body.startsWith('Why'))?.file === 'src/renamed.ts', 10000)
  ok('renaming the file on disk moves the note with it')

  // 10. Delete (moves to .trash) and the folder stays clean.
  const n = snap().notes.find((x: any) => x.messages[0].body.startsWith('Why'))
  const ed2 = await vscode.window.showTextDocument(vscode.Uri.file(moved))
  ed2.selection = new vscode.Selection(n.range.start - 1, 0, n.range.start - 1, 0)
  void vscode.commands.executeCommand('codeNotes.delete')
  await until('moved to trash', () => fs.existsSync(path.join(notesDir, '.trash', path.basename(jsonPath))) && !fs.existsSync(jsonPath))
  ok('delete moves the note to .code-notes/.trash')

  // 11. Partial-line selection keeps the exact text.
  const ed3 = await vscode.window.showTextDocument(vscode.Uri.file(moved))
  const ln = linesOfDoc(ed3.document).findIndex((t) => t.includes('readToken'))
  const tok = ed3.document.lineAt(ln).text.indexOf('readToken')
  await vscode.commands.executeCommand('codeNotes.createFromThread', {
    thread: { uri: vscode.Uri.file(moved), range: new vscode.Range(ln, tok, ln, tok + 'readToken'.length), dispose() {} }, text: 'Why THIS import?',
  })
  const sel = await until('selection stored', () => snap().notes.find((x: any) => x.messages[0].body === 'Why THIS import?'))
  assert.deepEqual(sel.selection, { text: 'readToken', startCol: tok, endCol: tok + 9 })
  ok('a partial selection stores the exact text')

  // 12. An agent reply lands while the person is typing in the same file: kept.
  const selPath = sel.path as string
  await ed3.edit((b) => b.insert(new vscode.Position(0, 0), '// typing\n'))
  reply(selPath, { author: 'claude', role: 'agent', body: 'Because it is the only reader.', at: new Date().toISOString() })
  await sleep(150)
  await ed3.edit((b) => b.insert(new vscode.Position(0, 0), '// more typing\n'))
  await ed3.document.save()
  await until('range saved after typing', () => readJson(selPath).range.start === ln + 3)
  await sleep(500)
  assert.equal(readJson(selPath).messages.length, 2, 'agent reply survived the save')
  ok('an agent reply written while typing survives the save (merged)')

  // 13. An agent creates a note without an anchor: filled in from the code.
  const agentNew = path.join(notesDir, '20261111-150000-agnt.json')
  fs.writeFileSync(agentNew, JSON.stringify({ file: 'src/renamed.ts', range: { start: 4, end: 4 }, status: 'open', messages: [{ author: 'claude', role: 'agent', body: 'Look here' }] }))
  await until('anchor backfilled', () => { try { return readJson(agentNew).anchor?.text === ed3.document.lineAt(3).text } catch { return false } })
  ok('an agent note without an anchor gets one from the code')

  // 14. The file is deleted, then restored (git checkout -- file): notes recover.
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  const content = fs.readFileSync(moved, 'utf8')
  fs.unlinkSync(moved)
  await until('missing after delete', () => snap().notes.find((x: any) => x.path === selPath)?.missing === true, 10000)
  fs.writeFileSync(moved, content)
  await until('recovered after restore', () => { const x = snap().notes.find((y: any) => y.path === selPath); return x && !x.missing && !x.stale }, 10000)
  ok('a deleted then restored file: its notes recover on their own')

  // 15. An agent writes the path with the workspace folder's name in front: fixed on load.
  const prefixed = path.join(notesDir, '20261111-150100-pfx1.json')
  fs.writeFileSync(prefixed, JSON.stringify({ file: `${folder.name}/src/renamed.ts`, range: { start: 2, end: 2 }, status: 'open', messages: [{ author: 'claude', role: 'agent', body: 'Path test' }] }))
  await until('prefixed path fixed', () => { try { return readJson(prefixed).file === 'src/renamed.ts' } catch { return false } }, 8000)
  ok('a path with the folder name in front is fixed')

  // 16. Reply & Resolve from the thread.
  const target = snap().notes.find((x: any) => x.path === prefixed)
  const thread = { uri: vscode.Uri.file(moved), range: new vscode.Range(target.range.start - 1, 0, target.range.start - 1, 0) }
  // The command takes the comment widget's reply; find the real thread through the note at that line.
  const ed4 = await vscode.window.showTextDocument(vscode.Uri.file(moved))
  ed4.selection = new vscode.Selection(target.range.start - 1, 0, target.range.start - 1, 0)
  void vscode.commands.executeCommand('codeNotes.reveal')
  void thread
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'))
  assert.ok(!pkg.contributes.menus['comments/commentThread/context'].some((m: any) => m.command === 'codeNotes.replyResolve'), 'one resolve control in a thread: no Reply & Resolve')
  assert.ok(pkg.contributes.commands.some((c: any) => c.command === 'codeNotes.deleteResolved' && c.title.startsWith('Purge')), 'bulk delete renamed')
  // ISS-1005: a note's own actions stay reachable from the palette when the cursor is on it.
  for (const c of ['codeNotes.moveToSelection', 'codeNotes.copyNotePrompt', 'codeNotes.delete']) assert.ok(pkg.contributes.menus.commandPalette.some((m: any) => m.command === c && m.when === 'codeNotes.cursorOnNote'), `${c} in the palette on a note`)
  // No grab-bag: Reopen / Keep Note Here live in the thread; Show Map while walking; ask a question.
  for (const c of ['codeNotes.reopen', 'codeNotes.acceptCode']) assert.ok(pkg.contributes.menus.commandPalette.some((m: any) => m.command === c && m.when === 'false'), `${c} not in the palette`)
  assert.ok(pkg.contributes.menus.commandPalette.some((m: any) => m.command === 'codeNotes.showMap' && m.when === 'codeNotes.journeyActive'), 'Show Journey Map while walking')
  assert.ok(pkg.contributes.commands.some((c: any) => c.command === 'codeNotes.askQuestion'), 'Ask a Question About the Code…')
  ok('one resolve control in the thread; bulk delete is "Purge Resolved Notes…"')

  // 17. Sessions: notes grouped by "session"; hiding one removes its threads from the editor; "show only" hides the rest.
  const mk = (id: string, session: string, line: number) => fs.writeFileSync(path.join(notesDir, `${id}.json`), JSON.stringify({ file: 'src/renamed.ts', range: { start: line, end: line }, status: 'open', session, messages: [{ author: 'claude', role: 'agent', body: `${session} note` }] }))
  mk('20261111-160000-sesa', 'Visual review', 1)
  mk('20261111-160001-sesb', 'Classic review', 2)
  const byS = (s: string) => snap().notes.find((x: any) => x.session === s)
  await until('session notes loaded with threads', () => byS('Visual review')?.hasThread && byS('Classic review')?.hasThread)
  await vscode.commands.executeCommand('codeNotes.hideSession', { kind: 'session', name: 'Visual review', notes: [] })
  await until('hidden session has no thread', () => byS('Visual review')?.hasThread === false && byS('Classic review')?.hasThread)
  await vscode.commands.executeCommand('codeNotes.showOnlySession', { kind: 'session', name: 'Visual review', notes: [] })
  await until('show only flips them', () => byS('Visual review')?.hasThread && byS('Classic review')?.hasThread === false)
  await vscode.commands.executeCommand('codeNotes.showAllSessions')
  await until('all shown', () => byS('Visual review')?.hasThread && byS('Classic review')?.hasThread)
  ok('sessions: hide, show only, show all')

  // 18. Invalid note files are reported, not shown as normal notes.
  const before18 = snap().broken
  const bad = (name: string, d: object) => fs.writeFileSync(path.join(notesDir, name), JSON.stringify(d))
  bad('20261111-170000-bad1.json', { file: 'src/renamed.ts', range: { start: 0, end: 0 }, status: 'open', messages: [{ author: 'claude', body: 'zero' }] })
  bad('20261111-170001-bad2.json', { file: 'src/renamed.ts', range: { start: 3, end: 1 }, status: 'open', messages: [{ author: 'claude', body: 'reversed' }] })
  bad('20261111-170002-bad3.json', { file: 'src/renamed.ts', range: { start: 1, end: 1 }, status: 'wontfix', messages: [{ author: 'claude', body: 'status' }] })
  bad('20261111-170003-bad4.json', { file: 'src/renamed.ts', range: { start: 1, end: 1 }, status: 'open', messages: [] })
  await until('4 invalid files reported', () => snap().broken === before18 + 4)
  assert.ok(!snap().notes.some((x: any) => ['zero', 'reversed', 'status'].includes(x.messages[0]?.body)), 'not listed as notes')
  for (const f of ['bad1', 'bad2', 'bad3', 'bad4']) fs.unlinkSync(path.join(notesDir, `20261111-17000${f.slice(-1) === '1' ? 0 : Number(f.slice(-1)) - 1}-${f}.json`))
  ok('invalid ranges, statuses and empty notes are reported as unreadable')

  // 19. Mark as Unread.
  const ed5 = await vscode.window.showTextDocument(vscode.Uri.file(moved))
  const target19 = snap().notes.find((x: any) => x.session === 'Visual review')
  ed5.selection = new vscode.Selection(target19.range.start - 1, 0, target19.range.start - 1, 0)
  await vscode.commands.executeCommand('codeNotes.reveal')
  await until('read', () => snap().notes.find((x: any) => x.session === 'Visual review')?.unread === 0)
  await vscode.commands.executeCommand('codeNotes.markUnread')
  await until('unread again', () => snap().notes.find((x: any) => x.session === 'Visual review')?.unread === 1)
  ok('Mark as Unread')

  // 20. A folder setting of "." is refused: no .gitignore lands in the repo root.
  await vscode.workspace.getConfiguration('codeNotes').update('folder', '.', vscode.ConfigurationTarget.Workspace)
  await sleep(1500)
  assert.ok(!fs.existsSync(path.join(ws, '.gitignore')), 'no .gitignore in the workspace root')
  assert.ok(snap().notes.length > 0, 'still reading .code-notes')
  await vscode.workspace.getConfiguration('codeNotes').update('folder', undefined, vscode.ConfigurationTarget.Workspace)
  ok('notes folder "." refused; nothing written to the repo root')

  // 21. Ask Claude (with a fake CLI): streams, appends Claude's answer, stores the session; a follow-up resumes it; cancel works.
  // Its own log (other test runs on this machine share the temp folder).
  const fakeLog = path.join(ws, '..', `fake-claude-${path.basename(ws)}.log`)
  process.env.FAKE_CLAUDE_LOG = fakeLog
  await vscode.workspace.getConfiguration('codeNotes').update('claude.path', path.join(__dirname, '../../../test/fixtures/fake-claude.js'), vscode.ConfigurationTarget.Workspace)
  const q = snap().notes.find((x: any) => x.session === 'Classic review')
  void vscode.commands.executeCommand('codeNotes.askClaude', q.id)
  await until('Claude is answering', () => snap().notes.find((x: any) => x.id === q.id)?.asking)
  await until('Claude answered', () => { const x = snap().notes.find((y: any) => y.id === q.id); return x && !x.asking && x.messages.at(-1)?.author === 'Claude' }, 10000)
  const answered = await until('answer saved with its session', () => { const x = readJson(path.join(notesDir, `${q.id}.json`)); return x.claudeSession && x.messages.at(-1)?.author === 'Claude' && x })
  assert.equal(answered.claudeSession, 'sess-123')
  assert.match(answered.messages.at(-1).body, /src\/renamed\.ts:3/)
  assert.ok(!JSON.parse(fs.readFileSync(fakeLog, 'utf8').trim().split('\n')[0]).includes('--resume'), 'first ask starts a session')
  // follow-up
  const fp = path.join(notesDir, `${q.id}.json`)
  reply(fp, { author: snap().me, role: 'human', body: 'Where is it written?', at: new Date().toISOString() })
  await until('follow-up loaded', () => snap().notes.find((x: any) => x.id === q.id)?.messages.length === answered.messages.length + 1)
  void vscode.commands.executeCommand('codeNotes.askClaude', q.id)
  await until('follow-up answered', () => readJson(fp).messages.at(-1)?.author === 'Claude' && readJson(fp).messages.length === answered.messages.length + 2, 10000)
  const calls = fs.readFileSync(fakeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(calls.at(-1).includes('--resume') && calls.at(-1).includes('sess-123'), 'follow-up resumes the session')
  assert.ok(calls.at(-1).includes('--disallowedTools') && calls.at(-1).includes('Edit'), 'read-only')
  // cancel
  reply(fp, { author: snap().me, role: 'human', body: 'slow question', at: new Date().toISOString() })
  await until('loaded', () => readJson(fp).messages.at(-1).body === 'slow question' && snap().notes.find((x: any) => x.id === q.id)?.messages.at(-1)?.body === 'slow question')
  void vscode.commands.executeCommand('codeNotes.askClaude', q.id)
  await until('asking slow', () => snap().notes.find((x: any) => x.id === q.id)?.asking)
  await vscode.commands.executeCommand('codeNotes.cancelClaude', q.id)
  await until('cancelled, no answer added', () => { const x = snap().notes.find((y: any) => y.id === q.id); return x && !x.asking && x.messages.at(-1).body === 'slow question' })
  ok('Ask Claude: streams, answers, resumes the session on follow-ups, read-only, cancel')

  // 22. Mode "always": a new note goes to Claude by itself.
  await vscode.workspace.getConfiguration('codeNotes').update('claude.mode', 'always', vscode.ConfigurationTarget.Workspace)
  const docA = await vscode.workspace.openTextDocument(vscode.Uri.file(moved))
  await vscode.commands.executeCommand('codeNotes.createFromThread', { thread: { uri: docA.uri, range: new vscode.Range(0, 0, 0, 5), dispose() {} }, text: 'Auto question' })
  await until('auto-answered', () => snap().notes.find((x: any) => x.messages[0]?.body === 'Auto question')?.messages.at(-1)?.author === 'Claude', 10000)
  await vscode.workspace.getConfiguration('codeNotes').update('claude.mode', undefined, vscode.ConfigurationTarget.Workspace)
  ok('mode "always": new notes are answered without a click')

  // 23. Note files can't point outside the workspace; absolute paths inside it are read as relative.
  const outside = path.join(notesDir, '20261111-180000-trv1.json')
  fs.writeFileSync(outside, JSON.stringify({ file: '../../../../../../etc/hostname', range: { start: 1, end: 1 }, status: 'open', messages: [{ author: 'claude', role: 'agent', body: 'outside' }] }))
  const abs = path.join(notesDir, '20261111-180001-abs1.json')
  fs.writeFileSync(abs, JSON.stringify({ file: path.join(ws, 'src', 'renamed.ts'), range: { start: 1, end: 1 }, status: 'open', messages: [{ author: 'claude', role: 'agent', body: 'absolute' }] }))
  await until('absolute path read as relative', () => snap().notes.find((x: any) => x.path === abs)?.file === 'src/renamed.ts' && !snap().notes.find((x: any) => x.path === abs).missing)
  await sleep(1500)
  assert.ok(!snap().notes.some((x: any) => x.path === outside), 'outside note not loaded')
  assert.ok(!readJson(outside).anchor, 'nothing read from outside the workspace')
  fs.unlinkSync(outside)
  ok('a note pointing outside the workspace is refused; an absolute path inside works')

  // 24. An anchor-less note on a missing file is not adopted by an unrelated new file.
  const orphan = path.join(notesDir, '20261111-180002-hij1.json')
  fs.writeFileSync(orphan, JSON.stringify({ file: 'src/gone.ts', range: { start: 1, end: 1 }, status: 'open', messages: [{ author: 'claude', role: 'agent', body: 'orphan' }] }))
  await until('orphan missing', () => snap().notes.find((x: any) => x.path === orphan)?.missing)
  fs.writeFileSync(path.join(ws, 'src', 'unrelated.ts'), 'export const x = 1\nexport const y = 2\n')
  await sleep(2500)
  assert.equal(readJson(orphan).file, 'src/gone.ts', 'not moved to an unrelated file')
  ok('an orphan without an anchor stays put when another file appears')

  // 25. "selection" as a plain string is kept as the exact text.
  const selStr = path.join(notesDir, '20261111-180003-sel1.json')
  fs.writeFileSync(selStr, JSON.stringify({ file: 'src/renamed.ts', range: { start: 1, end: 1 }, selection: 'export', status: 'open', messages: [{ author: 'claude', role: 'agent', body: 'string selection' }] }))
  await until('string selection kept', () => snap().notes.find((x: any) => x.path === selStr)?.selection?.text === 'export')
  ok('a string "selection" is kept as the exact text')

  // 26. Your own reply is never counted as new.
  const own = snap().notes.find((x: any) => x.path === abs)
  const th = await until('thread', () => api.thread(own.id))
  await vscode.commands.executeCommand('codeNotes.reveal', { thread: th })
  await until('own note read', () => snap().notes.find((x: any) => x.path === abs)?.unread === 0)
  await vscode.commands.executeCommand('codeNotes.reply', { thread: th, text: 'my own reply' })
  await until('reply saved', () => readJson(abs).messages.length === 2)
  await sleep(300)
  assert.ok(!/2 new/.test(snap().notes.find((x: any) => x.path === abs).threadLabel ?? ''), `own reply not new: ${snap().notes.find((x: any) => x.path === abs).threadLabel}`)
  ok('your own reply does not count as new')

  // 27. Resolve, then "Code Notes: Undo" after the toast: open again and still unread.
  reply(abs, { author: 'claude', role: 'agent', body: 'unread answer', at: new Date().toISOString() })
  await until('unread answer', () => snap().notes.find((x: any) => x.path === abs)?.unread === 1)
  const absNote = snap().notes.find((x: any) => x.path === abs)
  const ed6 = await vscode.window.showTextDocument(vscode.Uri.file(moved))
  ed6.selection = new vscode.Selection(absNote.range.start - 1, 0, absNote.range.start - 1, 0)
  await vscode.commands.executeCommand('codeNotes.resolve', { thread: api.thread(absNote.id) })
  await until('resolved', () => readJson(abs).status === 'resolved')
  await vscode.commands.executeCommand('codeNotes.undo')
  await until('undone: open and unread', () => readJson(abs).status === 'open' && snap().notes.find((x: any) => x.path === abs)?.unread === 1)
  ok('Undo as a command; undoing a resolve keeps the reply unread')

  // 28. An agent deletes a note file: its last version lands in .trash.
  fs.unlinkSync(selStr)
  await until('copied to trash', () => fs.existsSync(path.join(notesDir, '.trash', path.basename(selStr))))
  ok('a note deleted on disk is kept in .trash')

  // 29. Notes shared through git: the trash stays ignored.
  await vscode.workspace.getConfiguration('codeNotes').update('ignoreInGit', false, vscode.ConfigurationTarget.Workspace)
  await until('.gitignore keeps the trash out', () => { try { return fs.readFileSync(path.join(notesDir, '.gitignore'), 'utf8') === '.trash/\n' } catch { return false } })
  await vscode.workspace.getConfiguration('codeNotes').update('ignoreInGit', undefined, vscode.ConfigurationTarget.Workspace)
  await until('.gitignore back to everything', () => fs.readFileSync(path.join(notesDir, '.gitignore'), 'utf8') === '*\n')
  ok('ignoreInGit off still ignores .trash')

  // 30. Journeys (format v2): steps are embedded, never notes; the map opens; the tour opens each step's code as one
  // preview tab in the group beside the map, with a read-only step card above the lines; steps follow edits in memory.
  fs.writeFileSync(path.join(ws, 'src', 'flow.ts'), ['export function a() {', '  return b()', '}', '', 'export function b() {', '  return 2', '}', ''].join('\n'))
  fs.writeFileSync(path.join(ws, 'src', 'flow2.ts'), ['// two', 'export const c = 3', ''].join('\n'))
  fs.mkdirSync(path.join(ws, 'lib', 'mail'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'lib', 'mail', 'address.go'), Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`).join('\n') + '\n')
  // One step card, inline (the panel mode and its setting are gone).
  assert.equal(vscode.workspace.getConfiguration('codeNotes').get('journeys.stepCard'), undefined, 'no step-card setting')
  const notesBefore = snap().notes.length
  const badgeBefore = snap().badge
  const brokenBefore = snap().broken
  const jdir = path.join(notesDir, 'journeys')
  fs.mkdirSync(jdir, { recursive: true })
  const step = (id: string, title: string, node: string, file: string, line: number, extra: object = {}) =>
    ({ id, title, node, file, range: { start: line, end: line }, lead: `${title}: the lead.`, refs: [], ...extra })
  const demoSteps = [
    step('s-a', 'a calls b', 'fa', 'src/flow.ts', 2, { details: 'More about **a**: see src/flow.ts:5 (and src/flow.ts:6-7). Charges card <name>.', refs: ['src/flow.ts:5', 'src/gone.ts:3', 'Recipients builds the list of addresses a receipt goes to in lib/mail/address.go:31-54.'] }),
    step('s-b', 'b returns', 'fb', 'src/flow.ts', 6),
    step('s-c', 'Then c', 'fc', 'src/flow2.ts', 2),
  ]
  const demo = (steps: object[]) => ({
    version: 2, id: 'demo', question: 'How does a get to c?', title: 'Demo', summary: 'a, b, then c.',
    nodes: [{ id: 'app', kind: 'system', label: 'App', summary: '' }, { id: 'm', kind: 'module', label: 'flow', summary: '', parent: 'app' },
      { id: 'fa', kind: 'function', label: 'a', summary: '', parent: 'm' }, { id: 'fb', kind: 'function', label: 'b', summary: '', parent: 'm' },
      { id: 'fc', kind: 'function', label: 'c', summary: '', parent: 'm' }],
    edges: [{ from: 'fa', to: 'fb', label: 'calls' }, { from: 'fb', to: 'fc', label: 'later', async: true }],
    steps,
  })
  const demoPath = path.join(jdir, 'demo.json')
  fs.writeFileSync(demoPath, JSON.stringify(demo(demoSteps), null, 2))
  fs.writeFileSync(path.join(jdir, 'old-v1.json'), JSON.stringify({ version: 1, id: 'old', nodes: [{ id: 'x' }], steps: [{ node: 'x', note: 'n1' }] }))
  fs.writeFileSync(path.join(jdir, 'half-written.json'), '{"version": 2, "nodes": [')
  await until('journey loaded', () => snap().journeys.length === 1, 8000)
  await sleep(500)
  assert.equal(snap().journeys.length, 1, 'v1 and broken files are not shown')
  assert.equal(snap().notes.length, notesBefore, 'steps are not notes')
  assert.equal(snap().broken, brokenBefore, 'journey files are not read as notes')
  assert.equal(snap().badge, badgeBefore, 'steps never count as unread')
  const jt = snap().tree() as string[]
  // The first time, the group is open with one quiet line; rows are the short title; a journey written after the
  // list was first seen is "new"; the group comes after the notes.
  const gi = jt.findIndex((l) => /^journeys:Journeys$/.test(l)) // its name only
  assert.ok(gi >= 0, `an open Journeys group the first time:\n${jt.join('\n')}`)
  assert.equal(jt[gi + 1], '  journey:Demo · new', 'the title and "new"; no step count, no info row, no icon but for state')
  assert.ok(!jt.slice(gi + 1).some((l) => /^\S/.test(l)), 'nothing after the journeys at the top level')
  // Files that never were valid journeys: one dimmed row each (the text is the muted description), after the journeys.
  assert.deepEqual(jt.slice(gi + 2, gi + 4), ['  badJourney: · ⚠ half-written.json', '  badJourney: · ⚠ old-v1.json'], `never-valid files are dimmed rows:\n${jt.join('\n')}`)
  ok('v2 journeys load (v1 and broken files skipped); steps are not notes; the group lists titles, new ones marked')

  const at = () => { const e = vscode.window.activeTextEditor; return e ? `${path.relative(ws, e.document.uri.fsPath)}:${e.selection.active.line + 1}` : '' }
  const t = () => snap().tour
  await vscode.commands.executeCommand('codeNotes.openJourney', 'demo')
  // Opening a journey walks it (there is no Start): the map, and step 1's code with its card.
  await until('map open and drawn, walking at step 1', () => t().map === 'demo' && t().journey === 'demo' && t().mapBoxes === 5 && t().mapFocus === 'fa' && t().step === 1 && at() === 'src/flow.ts:2' && t().card?.title === 'a calls b', 10000)
  await until('opened: no longer new', () => (snap().tree() as string[]).some((l: string) => /^journeys:Journeys( {collapsed})?$/.test(l)) && !(snap().tree() as string[]).some((l: string) => /· new/.test(l)))
  assert.ok(!(snap().tree() as string[]).some((l: string) => /· new/.test(l)), 'seen once opened')
  assert.equal(t().touring, true, 'walking')
  const mapCol = t().mapColumn
  const c1 = t().card
  assert.equal(c1.label, '1/3 · a calls b', 'the card\'s first line is "1/3 · title"')
  assert.equal(c1.canReply, false, 'no reply box on a step')
  assert.ok(c1.expanded)
  assert.equal(c1.line, 0, 'the card right above the step\'s first line')
  assert.match(c1.body, /a calls b: the lead\./)
  assert.match(c1.body, /\[More\]\(command:codeNotes\.stepDetails/)
  assert.ok(!c1.body.includes('More about'), 'details folded')
  assert.ok(!/flow\.ts:5|gone\.ts/.test(c1.body), 'no bare link row: the references are inside More')
  assert.match(c1.body, /\[Ask\]\(command:codeNotes\.askStep\)/, 'one word, a command without arguments')
  assert.ok(!/Previous/.test(c1.body), 'no Previous on step 1')
  assert.equal(snap().notes.length, notesBefore, 'touring creates no notes')
  assert.equal(t().statusShown, true)
  assert.equal(t().status, '$(map) 1/3', 'the position only')
  await vscode.commands.executeCommand('codeNotes.stepDetails', true)
  await until('details open', () => t().card?.body.includes('More about'))
  assert.match(t().card.body, /~~gone\.ts:3~~ \(file gone\)/, 'a ref to a missing file says so, inside More')
  assert.match(t().card.body, /\n\nRecipients builds the list of addresses a receipt goes to in \[address\.go:31-54\]\(command:codeNotes\.openAt[^)]* "lib\/mail\/address\.go:31-54"\)\./, `a ref may be a sentence: its token (a file in another directory) a link inside it: ${t().card.body}`)
  assert.ok(!/address\.go[^\n]*gone/.test(t().card.body), `an existing file in another directory is never "gone": ${t().card.body}`)
  assert.match(t().card.body, /\(and \[flow\.ts:6-7\]\(command:codeNotes\.openAt[^)]* "src\/flow\.ts:6-7"\)/, `a ref in parentheses, with a range, is a link named by its file, the path on hover: ${t().card.body}`)
  assert.notEqual(t().codeColumn, mapCol, 'the code opens beside the map, never over it')
  // CODE_NOTES_SHOTS=<dir>: the real window, for the eye (xvfb + ImageMagick's import).
  const shotX = async (name: string) => { const d = process.env.CODE_NOTES_SHOTS; if (!d) return; await sleep(1200); require('child_process').execFileSync('import', ['-window', 'root', path.join(d, `${name}.png`)]) }
  await shotX('inline-card-more-open')
  // The step's tint: faint, in light and dark; a selection and find matches stay visible on top.
  if (process.env.CODE_NOTES_SHOTS) {
    const ed = vscode.window.activeTextEditor!
    ed.selection = new vscode.Selection(1, 2, 1, 8)
    await vscode.commands.executeCommand('editor.actionFindWithSelection').then(undefined, () => undefined)
    await shotX('step-tint-dark')
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Default Light Modern', vscode.ConfigurationTarget.Global)
    await shotX('step-tint-light')
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', undefined, vscode.ConfigurationTarget.Global)
    await vscode.commands.executeCommand('closeFindWidget').then(undefined, () => undefined)
    ed.selection = new vscode.Selection(1, 0, 1, 0)
  }
  assert.match(t().card.body, /card \\<name\\>/, `<name> stays text, not an HTML tag the renderer drops: ${t().card.body}`)
  const body1 = t().card.body as string
  assert.ok(body1.indexOf('a calls b: the lead') < body1.indexOf('[Next ›](command:codeNotes.nextStep)') && body1.indexOf('[Next ›](command:codeNotes.nextStep)') < body1.indexOf('More about'), `the lead, then ‹ › Ask, then what More opened: ${body1}`)
  assert.equal(t().card.body.split('[flow.ts:5]').length, 2, `a ref the details already link is not listed again: ${t().card.body}`)
  // A ref opens as a peek; the step's tab, its code and the card stay.
  const folderUri = vscode.workspace.workspaceFolders![0].uri.toString()
  await vscode.commands.executeCommand('codeNotes.openAt', folderUri, 'src/flow2.ts', 2, 2, 1)
  await until('ref peeked', () => /flow2\.ts$/.test(t().peek?.uri ?? ''))
  assert.equal(t().peek.under, t().card.line, 'the peek opens right under the step card, not under the step\'s code')
  await sleep(300)
  assert.match(vscode.window.activeTextEditor?.document.uri.path ?? '', /\/flow\.ts$/, 'the step stays the editor')
  assert.ok(!vscode.window.tabGroups.all.some((g) => g.tabs.some((x) => x.input instanceof vscode.TabInputText && /\/flow2\.ts$/.test(x.input.uri.path))), 'no tab replaced or added for the ref')
  assert.equal(t().card?.title, 'a calls b', 'the card is still there')
  await shotX('inline-ref-peek')
  await vscode.commands.executeCommand('closeReferenceSearch').then(undefined, () => undefined)
  // A ref into the step's own file is a peek too, of a read-only copy (closing a peek of the file itself took the
  // card with it).
  await vscode.commands.executeCommand('codeNotes.openAt', folderUri, 'src/flow.ts', 5, 5, 1)
  await until('same-file ref peeked (a copy)', () => /^code-notes-ref:.*\/flow\.ts/.test(t().peek?.uri ?? '') && t().peek.start === 4)
  assert.ok(/^src\/flow\.ts:/.test(at()) && !t().ref, `the step's editor stays, nothing jumped: ${at()}`)
  await shotX('inline-ref-peek-same-file')
  await vscode.commands.executeCommand('closeReferenceSearch').then(undefined, () => undefined)
  await sleep(300)
  assert.equal(t().card?.title, 'a calls b', 'the card stays')
  assert.ok(t().card?.expanded, 'the card stays open after the peek closes')
  await shotX('inline-ref-peek-same-file-closed')
  await vscode.commands.executeCommand('codeNotes.backToStep')
  await until('back at step 1', () => at() === 'src/flow.ts:2')
  // The step's tab replaced by another file, then Go Back: the card and the marker are back.
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(ws, 'src', 'flow2.ts')), { preview: true, viewColumn: t().codeColumn })
  await until('away from the step', () => /flow2\.ts$/.test(vscode.window.activeTextEditor?.document.uri.path ?? ''))
  await sleep(300)
  await vscode.commands.executeCommand('workbench.action.navigateBack')
  await until('Go Back: on the step, card and marker shown', () => at() === 'src/flow.ts:2' && /\/flow\.ts$/.test(t().card?.file ?? '') && t().card?.expanded && (t().marked as string[]).some((x) => /\/flow\.ts$/.test(x)), 8000)
  await vscode.commands.executeCommand('codeNotes.nextStep')
  await until('step 2', () => t().step === 2 && at() === 'src/flow.ts:6' && t().card?.label === '2/3 · b returns')
  assert.equal(t().card.line, 4, 'step 2: the card right above its first line')
  await shotX('inline-card-above-function')
  await vscode.commands.executeCommand('codeNotes.nextStep')
  await until('step 3, another file', () => t().step === 3 && at() === 'src/flow2.ts:2')
  const codeGroup = vscode.window.tabGroups.all.find((g) => g.viewColumn === t().codeColumn)!
  const textTabs = codeGroup.tabs.filter((x) => x.input instanceof vscode.TabInputText && /\/flow2?\.ts$/.test(x.input.uri.path))
  assert.equal(textTabs.length, 1, `one reused preview tab for the tour's files, no pile-up: ${textTabs.map((x) => x.label)}`)
  assert.ok(textTabs[0].isPreview)
  assert.equal(t().mapColumn, mapCol, 'the map kept its group')
  assert.match(t().card.body, /\[Finish\]\(command:codeNotes\.nextStep/, 'the last step offers Finish')
  assert.ok(!/How does a get to c/.test(t().card.body), 'no recap on the last step')
  await vscode.commands.executeCommand('codeNotes.nextStep')
  await until('Next on the last step finishes', () => !t().touring && t().map === 'demo' && snap().journeys[0].resume === 0)
  await until('Finish closes the step tab the walk opened', () => !vscode.window.tabGroups.all.some((g) => g.tabs.some((x) => x.input instanceof vscode.TabInputText && /\/flow2?\.ts$/.test(x.input.uri.path))))
  // Next again right after finishing is not step 1.
  await vscode.commands.executeCommand('codeNotes.nextStep')
  await sleep(400)
  assert.ok(!t().touring && t().step === 0, 'Next after Finish does not start over at step 1')
  await vscode.commands.executeCommand('codeNotes.startJourney', 'demo')
  await until('started again', () => t().step === 1)
  await vscode.commands.executeCommand('codeNotes.nextStep')
  await until('2 again', () => t().step === 2)
  await vscode.commands.executeCommand('codeNotes.nextStep')
  await until('3 again', () => t().step === 3)
  ok('Open Journey → Next: one preview tab beside the map, a read-only step card above the lines; details fold; refs link')

  // Steps follow edits in memory; the journey file is never written.
  const demoBytes = fs.readFileSync(demoPath, 'utf8')
  const fdoc = await vscode.workspace.openTextDocument(path.join(ws, 'src', 'flow.ts'))
  const fed = await vscode.window.showTextDocument(fdoc, { viewColumn: t().codeColumn })
  await fed.edit((b) => b.insert(new vscode.Position(0, 0), '// added\n// added\n'))
  await fdoc.save()
  await until('step 2 followed the code', () => snap().journeys[0].at[1].start === 8)
  assert.equal(fs.readFileSync(demoPath, 'utf8'), demoBytes, 'the journey file is not rewritten')
  await vscode.commands.executeCommand('codeNotes.previousStep')
  await until('back to step 2 at its new line', () => t().step === 2 && at() === 'src/flow.ts:8')
  ok('steps follow edits in memory; the journey file is untouched')

  // Ask about this step: a normal note on the step's lines.
  const asked = (await vscode.commands.executeCommand('codeNotes.askStep', 'Why does b return 2?')) as any
  await until('note created', () => snap().notes.length === notesBefore + 1)
  const an = snap().notes.find((x: any) => x.messages[0].body.startsWith('Why does b return 2?'))
  assert.ok(an && asked, 'the note exists')
  assert.equal(an.file, 'src/flow.ts')
  assert.deepEqual(an.range, { start: 8, end: 8 })
  assert.match(an.messages[0].body, /About the step “b returns” \(id `s-b`\) of the journey “Demo”/, 'the step by id and title, not its number')
  assert.deepEqual(an.extra?.journey ?? an.journey, { id: 'demo', step: 's-b', n: 2 }, 'the note carries the journey field the skill reads')
  assert.equal(an.session, undefined, 'a normal private note')
  assert.equal(an.unread, 0)
  const qt = tree0(api) as string[]
  const qi = qt.findIndex((l) => /^ {4}note:Step 2 · Why does b return 2\?/.test(l))
  assert.ok(qi > 0 && /^ {2}journey:Demo\b/.test(qt[qi - 1]) && !/question/.test(qt[qi - 1]), `listed right under its journey, with its step; no count on the row:\n${qt.join('\n')}`)
  assert.ok(!qt.some((l) => /^note:Why does b return 2/.test(l)), 'not a loose row too')
  const askedThread = await until('the asked note\'s thread', () => api.thread(an.id))
  assert.ok(!/openStepLink|About the step/.test((askedThread.comments[0].body as vscode.MarkdownString).value), 'on that very step: no back-link')
  ok('Ask about this step: a normal note on the step\'s lines, listed under its journey with its step, linking back')
  // A reply to it shows on the folded journey row and on the step's card.
  reply(an.path, { author: 'claude', role: 'agent', body: 'Because it is the answer.', at: new Date().toISOString() })
  await until('the journey row says 1 reply ("new" is only a new journey)', () => (tree0(api) as string[]).some((l) => /^ {2}journey:Demo · (\d+\/\d+ · )?1 reply/.test(l)))
  await until('the card lists the question', () => /1 question · new reply ›\]\(command:codeNotes\.openNoteId/.test(t().card?.body ?? ''))
  await vscode.commands.executeCommand('codeNotes.markAllRead')
  ok('a reply to a step question: "1 reply" on the journey row, "1 question · new reply" on the card')

  // The journey is edited mid-tour: a step inserted before the current one; the tour stays on the same step.
  fs.writeFileSync(demoPath, JSON.stringify(demo([step('s-0', 'Before a', 'fa', 'src/flow.ts', 3), ...demoSteps]), null, 2))
  await until('the tour followed the step by id', () => t().step === 3 && t().card?.label === '3/4 · b returns' && t().card?.title === 'b returns' && t().status === '$(map) 3/4', 8000)
  ok('a step inserted before the current one: card, status bar and position follow the step by id')
  // The agent re-anchors the step you are on: the editor follows the card, which says so.
  fs.writeFileSync(demoPath, JSON.stringify(demo([step('s-0', 'Before a', 'fa', 'src/flow.ts', 3), demoSteps[0], step('s-b', 'b returns', 'fb', 'src/flow2.ts', 2), demoSteps[2]]), null, 2))
  await until('the editor followed the re-anchored step', () => t().step === 3 && at() === 'src/flow2.ts:2' && /This step was updated: its code is now at flow2\.ts:2/.test(t().card?.body ?? ''), 8000)
  fs.writeFileSync(demoPath, JSON.stringify(demo([step('s-0', 'Before a', 'fa', 'src/flow.ts', 3), ...demoSteps]), null, 2))
  await until('and back', () => t().step === 3 && at() === 'src/flow.ts:8' && t().card?.title === 'b returns', 8000)
  ok('a re-anchored current step: the editor goes to its new lines, the card says so')

  // Reload: the tour comes back where it was.
  await api.reloadTour()
  await until('restored', () => t().step === 3 && t().touring && t().card?.title === 'b returns')
  ok('the tour survives a reload (restored from workspace state)')

  // End: the place is kept (resume), the card and the preview tab go, the status bar hides.
  await vscode.commands.executeCommand('codeNotes.endJourney')
  await until('ended', () => !t().touring && !t().card && !t().statusShown)
  assert.equal(snap().journeys[0].resume, 3)
  // Outside a walk, one quiet line above each step's code: "◇ Step n of <journey>"; click = that step.
  const flowUri = vscode.Uri.file(path.join(ws, 'src', 'flow.ts'))
  const lenses = async (u: vscode.Uri) => ((await vscode.commands.executeCommand('vscode.executeCodeLensProvider', u)) as vscode.CodeLens[]).map((l) => `${l.range.start.line + 1}:${l.command?.title ?? ''}`)
  await until('step lenses outside a walk', async () => { const l = await lenses(flowUri); return l.includes('4:◇ Step 2 of Demo') && l.includes('8:◇ Step 3 of Demo') })
  await vscode.window.showTextDocument(flowUri, { viewColumn: vscode.ViewColumn.One })
  await shotX('step-lens')
  await vscode.workspace.getConfiguration('codeNotes').update('journeys.codeLens', false, vscode.ConfigurationTarget.Workspace)
  await until('the setting turns them off', async () => !(await lenses(flowUri)).some((x) => x.includes('◇')))
  await vscode.workspace.getConfiguration('codeNotes').update('journeys.codeLens', undefined, vscode.ConfigurationTarget.Workspace)
  const lens2 = ((await vscode.commands.executeCommand('vscode.executeCodeLensProvider', flowUri)) as vscode.CodeLens[]).find((l) => l.command?.title === '◇ Step 3 of Demo')!
  await vscode.commands.executeCommand(lens2.command!.command, ...(lens2.command!.arguments ?? []))
  await until('the lens opened that step', () => t().touring && t().step === 3)
  assert.ok(!(await lenses(flowUri)).some((x) => x.includes('◇')), 'no step lenses while walking')
  await vscode.commands.executeCommand('codeNotes.endJourney')
  await until('ended again', () => !t().touring)
  ok('"◇ Step n of Demo" above step code outside a walk; click opens it; setting turns it off; none while walking')
  // Not walking: the step question links back to its step, with the journey's name.
  await until('the back-link', () => /\[↩ Step 3 · Demo\]\(command:codeNotes\.openStepLink/.test((api.thread(an.id)!.comments[0].body as vscode.MarkdownString).value))
  assert.ok(vscode.window.tabGroups.all.some((g) => g.tabs.some((x) => x.input instanceof vscode.TabInputText && /flow\.ts$/.test(x.input.uri.path))), 'End keeps the code you were reading')
  assert.ok(tree0(api).some((l: string) => /journey:Demo · 3\/4$/.test(l)), `the sidebar row: its title and, after End, where it was left:\n${tree0(api).join('\n')}`)
  await vscode.commands.executeCommand('codeNotes.notes.focus')
  await shotX('sidebar')
  await vscode.commands.executeCommand('codeNotes.nextStep') // resumes
  await until('resumed at 3', () => t().touring && t().step === 3)
  assert.ok(tree0(api).some((l: string) => /journey:Demo( · [^[]*)? \[play-circle\]/.test(l) && !/3\/4/.test(l)), `the sidebar marks the running journey; the position is on the card and status bar:\n${tree0(api).join('\n')}`)
  await vscode.commands.executeCommand('codeNotes.endJourney')
  ok('End keeps a resumable place; Next resumes; the sidebar marks the running tour')
  fs.writeFileSync(demoPath, JSON.stringify(demo(demoSteps), null, 2))
  await until('back to 3 steps', () => snap().journeys[0]?.steps === 3)
  await more(api, ws, notesDir, { at, demoPath, demo: () => JSON.stringify(demo(demoSteps), null, 2) })
}

/** The sidebar with every group opened (the Journeys group is collapsed by default). */
function tree0(api: any): string[] {
  return api.snapshot().tree()
}

/** 0.10.0: chord keys, severity, grouping, history, author icons, suggestions, file and folder notes. */
async function more(api: any, ws: string, notesDir: string, j: { at: () => string; demoPath: string; demo: () => string }): Promise<void> {
  const snap = () => api.snapshot()
  const ok = (m: string) => console.log(`  ✓ ${m}`)
  const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'))
  const note = (id: string) => snap().notes.find((x: any) => x.id === id)
  const write = (id: string, d: object) => fs.writeFileSync(path.join(notesDir, `${id}.json`), JSON.stringify(d, null, 2))
  const jp = (id: string) => path.join(notesDir, `${id}.json`)
  const reply = (id: string, msg: object) => { const d = readJson(jp(id)); d.messages.push(msg); fs.writeFileSync(jp(id), JSON.stringify(d, null, 2)) }
  const now = () => new Date().toISOString()
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')

  // 31. Keys: VS Code took both chord prefixes (the scan-code one too) for our commands; no Alt keys are left.
  await vscode.commands.executeCommand('workbench.action.openDefaultKeybindingsFile')
  const kb = await until('default keybindings shown', () => vscode.window.activeTextEditor?.document.getText().includes('codeNotes.next') && vscode.window.activeTextEditor.document.getText())
  for (const k of ['ctrl+[IntlBackslash] d', 'ctrl+[IntlBackslash] ctrl+d', "ctrl+' d", "ctrl+' ctrl+v", 'ctrl+[IntlBackslash] r', 'ctrl+[IntlBackslash] c']) {
    assert.ok(kb.includes(`"key": "${k}"`), `VS Code lists the binding ${k}`)
  }
  assert.ok(!/"key": "alt\+[^"]*",\s*"command": "codeNotes/.test(kb), 'no Alt key bound to Code Notes')
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  ok('chords Ctrl+< (scan code) and Ctrl+\' with C/R/D/A/V are registered in VS Code')

  // 32. D/A outside a tour go to unread notes only; in a tour, the steps. V shows the map. Hints follow the prefix
  // that was pressed.
  const tr = () => snap().tour
  write('20261111-200000-unr1', { file: 'src/flow2.ts', range: { start: 1, end: 1 }, status: 'open', messages: [{ author: 'claude', role: 'agent', body: 'Unread finding' }] })
  await until('unread note loaded', () => note('20261111-200000-unr1')?.unread === 1)
  await vscode.commands.executeCommand('codeNotes.showMap', { prefix: '<' }) // V, pressed as Ctrl+< V
  await until('map open, no tour', () => tr().map === 'demo' && tr().step === 0 && tr().mapBoxes === 5, 10000)
  assert.equal(tr().key, 'Ctrl+<', 'hints follow the prefix used')
  // D with a map open but no tour: the next unread reply, as the status bar says, never a silent resume.
  await vscode.commands.executeCommand('codeNotes.next', { prefix: "'" })
  await until('D: the unread note with the map open', () => note('20261111-200000-unr1').unread === 0)
  assert.equal(tr().touring, false, 'D after End does not restart the tour')
  assert.equal(tr().key, "Ctrl+'")
  await sleep(600) // the reveal's own cursor move settles first (it reads the note at the cursor)
  reply('20261111-200000-unr1', { author: 'claude', role: 'agent', body: 'One more thing', at: now() })
  await until('unread again', () => note('20261111-200000-unr1')?.unread === 1)
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  await until('map closed', () => tr().map === undefined)
  await vscode.commands.executeCommand('codeNotes.next', { prefix: "'" }) // D with no map: unread
  await until('D: the unread note, not a step', () => j.at() === 'src/flow2.ts:1' && note('20261111-200000-unr1').unread === 0)
  assert.equal(tr().touring, false, 'D outside a journey and its map never starts one')
  await vscode.commands.executeCommand('codeNotes.startJourney', 'demo')
  await until('step 1', () => tr().step === 1 && j.at() === 'src/flow.ts:4')
  await vscode.commands.executeCommand('codeNotes.next')
  await until('D: step 2', () => tr().step === 2 && j.at() === 'src/flow.ts:8')
  await vscode.commands.executeCommand('codeNotes.previous')
  await until('A: step 1', () => tr().step === 1)
  await vscode.commands.executeCommand('codeNotes.endJourney')
  ok('D/A: steps only while a tour runs, unread notes otherwise; V shows the map; hints use the prefix pressed')

  // 32b. The tutorial: offered once (a bar), Skip persists, the command replays it, card 5 waits for the click on a
  // box, Finish starts the tour at step 1. Driven through the webview's own click/key handlers.
  await api.resetTutorial()
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  await until('map closed', () => tr().map === undefined)
  await vscode.commands.executeCommand('codeNotes.showMap')
  await until('the bar is offered', () => tr().tutorial.bar === 1 && tr().mapBoxes === 5, 10000)
  api.mapSend({ type: 'test', click: '.tbar .tskip' })
  await until('Skip remembered', () => tr().tutorial.seen && tr().tutorial.skip === 1)
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  await until('map closed', () => tr().map === undefined)
  await vscode.commands.executeCommand('codeNotes.showMap')
  await until('map again', () => tr().mapBoxes === 5, 10000)
  await sleep(800)
  assert.equal(tr().tutorial.bar, 1, 'not offered again after Skip')
  await vscode.commands.executeCommand('codeNotes.tutorial')
  await until('card 1', () => tr().tutorial.card === 1)
  // Three cards here (the storyline, the card in the editor, the map); journeys with links and animations have two more.
  api.mapSend({ type: 'test', key: 'ArrowRight' })
  // The card about the step card: a step is open in the editor and its lines are boxed there.
  await until('card 2: a step open in the editor, its lines boxed', () => tr().tutorial.card === 2 && tr().touring && tr().step === 1 && !!tr().tutorial.spot && tr().tutorial.mark === 'card' && /findMatchHighlightBackground\);">Next ›<\/span>/.test(tr().card?.body ?? ''), 10000)
  api.mapSend({ type: 'test', key: 'ArrowRight' })
  await until('the map card: the box in the editor is gone, the card as usual', () => tr().tutorial.card > 2 && !tr().tutorial.spot && !/findMatchHighlightBackground/.test(tr().card?.body ?? ''))
  // The last card's Done finishes; the walk goes on where it was left.
  api.mapSend({ type: 'test', click: '.tcard .tnext' })
  await until('Done finishes the tutorial and walks from where it was left', () => tr().tutorial.done === 1 && tr().touring && tr().step === 1, 8000)
  await vscode.commands.executeCommand('codeNotes.endJourney')
  ok('tutorial: offered once, Skip persists, replay command, its cards (one boxes the step in the editor), Done finishes and walks the steps')

  // 32b'. The whole map: a step number walks there; a function box opens its code. Home: "‹ Journeys" ends the
  // walk (its place kept) and lists the journeys; a row walks that one.
  await vscode.commands.executeCommand('codeNotes.startJourney', 'demo')
  await until('touring demo', () => tr().touring && tr().step === 1 && tr().mapFocus === 'fa', 8000)
  api.mapSend({ type: 'test', click: '.gnum[data-n="3"]' })
  await until('a step number walks there, the map follows', () => tr().step === 3 && tr().mapFocus === 'fc', 8000)
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  await vscode.commands.executeCommand('codeNotes.showMap')
  await until('map shown', () => tr().mapBoxes === 5, 10000)
  api.mapSend({ type: 'test', click: '.gbox.leaf[data-id="fb"]' })
  await until('a function box opens its code', () => /^src\/flow\.ts:/.test(j.at() ?? ''), 8000)
  api.mapSend({ type: 'test', click: '.homeb' })
  await until('home ends the walk, its place kept', () => !tr().touring && snap().journeys.find((x: any) => x.id === 'demo').resume === 3, 8000)
  api.mapSend({ type: 'test', click: '.jrow' })
  await until('a journey from home walks again where it was left', () => tr().touring && tr().journey === 'demo' && tr().step === 3, 8000)
  await vscode.commands.executeCommand('codeNotes.endJourney')
  ok('whole map: step numbers walk, boxes open code; home lists journeys and walks one')

  // 32c. The journey file deleted mid-tour: the tour ends; it comes back when the file does.
  await vscode.commands.executeCommand('codeNotes.startJourney', 'demo')
  await until('touring', () => tr().touring)
  fs.unlinkSync(j.demoPath)
  await until('tour ended', () => !tr().touring && tr().journey === undefined && !tr().card && snap().journeys.length === 0)
  fs.writeFileSync(j.demoPath, j.demo())
  await until('back', () => snap().journeys.length === 1)
  ok('a journey deleted mid-tour ends the tour')

  // 32d. A step's file renamed on disk: the step follows it. Its code deleted: stale, nothing highlighted.
  fs.writeFileSync(path.join(ws, 'src', 'mv.ts'), ['// mv', 'export function moved() {', '  return "this line is long enough to recognise"', '}', ''].join('\n'))
  const mvPath = path.join(path.dirname(j.demoPath), 'mv.json')
  fs.writeFileSync(mvPath, JSON.stringify({
    version: 2, id: 'mv', question: 'Where did it go?', title: 'Moves', summary: '',
    nodes: [{ id: 'f', kind: 'function', label: 'moved' }],
    steps: [{ id: 'only', title: 'The function', node: 'f', file: 'src/mv.ts', range: { start: 2, end: 3 }, lead: 'Here.', refs: ['src/mv.ts:4'] }],
  }))
  await until('mv loaded', () => snap().journeys.some((x: any) => x.id === 'mv'))
  await vscode.commands.executeCommand('codeNotes.startJourney', 'mv')
  await until('at the step', () => tr().journey === 'mv' && j.at() === 'src/mv.ts:2')
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  fs.renameSync(path.join(ws, 'src', 'mv.ts'), path.join(ws, 'src', 'mv2.ts'))
  await until('followed the rename', () => snap().journeys.find((x: any) => x.id === 'mv').at[0].file === 'src/mv2.ts', 8000)
  await api.reloadJourneys() // a window reload: the step still knows where its file went
  await until('rename kept across a reload', () => snap().journeys.find((x: any) => x.id === 'mv')?.at[0].file === 'src/mv2.ts' && !snap().journeys.find((x: any) => x.id === 'mv').at[0].stale)
  await vscode.commands.executeCommand('codeNotes.startJourney', 'mv')
  await until('opens the new file', () => j.at() === 'src/mv2.ts:2')
  await vscode.commands.executeCommand('codeNotes.stepDetails', true) // the references are inside More
  await until('the ref says where the file went', () => /mv2\.ts:4 \(moved\)/.test(tr().card?.body ?? ''))
  await vscode.commands.executeCommand('codeNotes.stepDetails', false)
  const ed2 = vscode.window.activeTextEditor!
  await ed2.edit((b) => b.delete(new vscode.Range(1, 0, 4, 0)))
  await ed2.document.save()
  // Its code deleted: "removed", the card at the top of the file, never on the code now there.
  // Its card goes to the map; nothing in the editor pretends to be the step (no card on line 1).
  await until('stale', () => snap().journeys.find((x: any) => x.id === 'mv').at[0].stale && !tr().card && /can't find these lines/.test(tr().panelCard?.staleText ?? ''), 8000)
  assert.equal(tr().panelCard.staleText, "**⚠ Code changed: can't find these lines** · [Ask](ask:update)", 'one line, one Ask, never "gone"')
  await vscode.commands.executeCommand('codeNotes.endJourney')
  fs.unlinkSync(mvPath)
  await until('mv gone', () => !snap().journeys.some((x: any) => x.id === 'mv'))
  ok('a step follows its file through a rename; deleted code makes it stale, never moved to other code')

  // A `git mv` made before the journey was read: git says where the file went, for any journey.
  const { execFileSync } = require('child_process')
  const g = (...a: string[]) => execFileSync('git', ['-C', ws, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' })
  fs.writeFileSync(path.join(ws, 'src', 'receipt.ts'), ['// receipt', 'export function render() {', '  return "the receipt is rendered here, long enough"', '}', ''].join('\n'))
  g('init', '-q'); g('add', 'src/receipt.ts'); g('commit', '-qm', 'receipt')
  g('mv', 'src/receipt.ts', 'src/receiptTemplate.ts')
  const gmPath = path.join(path.dirname(j.demoPath), 'gitmv.json')
  fs.writeFileSync(gmPath, JSON.stringify({ version: 2, id: 'gitmv', question: 'Where is the receipt rendered?', title: 'Git mv', summary: '',
    nodes: [{ id: 'r', kind: 'function', label: 'render' }],
    steps: [{ id: 'r1', title: 'Rendered', node: 'r', file: 'src/receipt.ts', range: { start: 2, end: 3 }, anchor: { text: 'export function render() {\n  return "the receipt is rendered here, long enough"', before: '// receipt', after: '}' }, lead: 'Here.', refs: [] }] }))
  await until('the step follows the git rename', () => { const x = snap().journeys.find((y: any) => y.id === 'gitmv'); return x && x.at[0].file === 'src/receiptTemplate.ts' && !x.at[0].stale }, 8000)
  fs.unlinkSync(gmPath)
  fs.rmSync(path.join(ws, '.git'), { recursive: true, force: true })
  await until('gitmv gone', () => !snap().journeys.some((x: any) => x.id === 'gitmv'))
  ok('a file renamed with git mv: the step follows it from git, in a journey read afterwards')

  // 32e. The map follows the step; a ref is lit with "← Back to step"; the card and the step's lines are in view after a jump lower in the same
  // file; arriving at a step doesn't read a note there; leaving a journey for another says so;
  // a step whose file is gone opens no stand-in tab.
  fs.writeFileSync(path.join(ws, 'src', 'long.ts'), Array.from({ length: 220 }, (_, i) => `export const v${i} = ${i} // line ${i + 1} of a long file`).join('\n') + '\n')
  const lst = (id: string, node: string, line: number, extra: object = {}) => ({ id, title: `At line ${line}`, node, file: 'src/long.ts', range: { start: line, end: line + 2 }, lead: `Line ${line}.`, refs: [], ...extra })
  const longPath = path.join(path.dirname(j.demoPath), 'long.json')
  fs.writeFileSync(longPath, JSON.stringify({ version: 2, id: 'long', question: 'How long is it?', title: 'Long', summary: 'Long.',
    nodes: [{ id: 'A', kind: 'system', label: 'A' }, { id: 'B', kind: 'system', label: 'B' }, { id: 'f1', kind: 'function', label: 'f1', parent: 'A' }, { id: 'f2', kind: 'function', label: 'f2', parent: 'A' }, { id: 'f3', kind: 'function', label: 'f3', parent: 'A' }],
    edges: [{ from: 'A', to: 'B', label: 'uses' }],
    steps: [lst('l1', 'f1', 20, { refs: ['src/long.ts:100-104'] }), lst('l2', 'f2', 150), lst('l3', 'f3', 190)] }))
  await until('long loaded', () => snap().journeys.some((x: any) => x.id === 'long'))
  await vscode.commands.executeCommand('codeNotes.openJourney', 'long')
  await until('long map', () => tr().map === 'long' && tr().mapBoxes === 5, 10000)
  await vscode.commands.executeCommand('codeNotes.startJourney', 'long')
  await until('inline card for step 1', () => tr().step === 1 && tr().card?.title === 'At line 20' && !tr().panelCard, 8000)
  const longUri = vscode.Uri.file(path.join(ws, 'src', 'long.ts'))
  const lensTitles = async () => ((await vscode.commands.executeCommand('vscode.executeCodeLensProvider', longUri)) as vscode.CodeLens[]).map((l) => l.command?.title ?? '')
  assert.ok(!(await lensTitles()).some((t) => /Step 1\/3/.test(t)), 'no marker line above the step (it was the panel mode\'s)')
  // A ref from the card (inside More) into the step's own file: a peek of a read-only copy under the card,
  // the step's editor stays.
  await vscode.commands.executeCommand('codeNotes.stepDetails', true)
  await until('More open', () => /long\.ts:100/.test(tr().card?.body ?? ''))
  await vscode.commands.executeCommand('codeNotes.openAt', vscode.workspace.workspaceFolders![0].uri.toString(), 'src/long.ts', 100, 104, 1)
  await until('ref peeked', () => /^code-notes-ref:.*long\.ts/.test(tr().peek?.uri ?? '') && tr().peek.start === 99 && tr().peek.end === 103 && !tr().ref)
  await vscode.commands.executeCommand('closeReferenceSearch').then(undefined, () => undefined)
  await until('still at the step', () => /^src\/long\.ts:/.test(j.at()) && tr().card?.title === 'At line 20')
  // The map follows the step (0.21: the whole map, centred on the step's box).
  await vscode.commands.executeCommand('codeNotes.nextStep')
  await until('step 2, the map on f2', () => tr().step === 2 && tr().mapFocus === 'f2')
  await vscode.commands.executeCommand('codeNotes.previousStep')
  await until('step 1', () => tr().step === 1)
  await until('the map followed the step back to f1', () => tr().mapFocus === 'f1' && tr().mapBoxes === 5)
  await until('the card is back on step 1', () => tr().card?.title === 'At line 20')
  // An unread reply on the next step's lines stays unread when the journey arrives there.
  write('20261111-200300-onstep', { file: 'src/long.ts', range: { start: 150, end: 150 }, status: 'open', messages: [{ author: 'claude', role: 'agent', body: 'Reply on a step' }] })
  await until('unread on the step', () => note('20261111-200300-onstep')?.unread === 1)
  // A jump lower in the same file shows the card's line and the step's lines.
  await vscode.commands.executeCommand('codeNotes.nextStep')
  await until('step 2 card', () => tr().step === 2 && tr().card?.title === 'At line 150')
  await sleep(700)
  const vr = vscode.window.activeTextEditor!.visibleRanges[0]
  assert.ok(vr.start.line <= 148 && vr.end.line >= 151, `card line 148 and the step (150-152) in view: ${vr.start.line}-${vr.end.line}`)
  assert.equal(note('20261111-200300-onstep').unread, 1, 'arriving at a step is not reading the note there')
  // A step from the storyline: the same.
  api.mapSend({ type: 'test', click: '.story .st[data-n="3"]' })
  await until('step 3 from the storyline', () => tr().step === 3 && tr().card?.title === 'At line 190')
  await sleep(700)
  const vr3 = vscode.window.activeTextEditor!.visibleRanges[0]
  assert.ok(vr3.start.line <= 188 && vr3.end.line >= 191, `storyline jump: card line 188 and the step in view: ${vr3.start.line}-${vr3.end.line}`)
  // Another journey mid-way: the first one is left with a way back.
  await vscode.commands.executeCommand('codeNotes.startJourney', 'demo')
  await until('left long', () => tr().journey === 'demo' && tr().lastLeft?.title === 'Long' && tr().lastLeft?.at === '3/3')
  await vscode.commands.executeCommand('codeNotes.endJourney')
  // A step whose file is gone: no stand-in tab; the card (in the map) says so.
  const gonePath = path.join(path.dirname(j.demoPath), 'gonefile.json')
  fs.writeFileSync(gonePath, JSON.stringify({ version: 2, id: 'gonefile', question: 'Where?', title: 'Gone file', summary: '', nodes: [{ id: 'x', kind: 'function', label: 'x' }],
    steps: [{ id: 'g', title: 'Here', node: 'x', file: 'src/nope_gone.ts', range: { start: 3, end: 4 }, lead: 'Was here.', refs: [] }] }))
  await until('gonefile loaded', () => snap().journeys.some((x: any) => x.id === 'gonefile'))
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  await vscode.commands.executeCommand('codeNotes.startJourney', 'gonefile')
  await until('file gone card', () => tr().journey === 'gonefile' && tr().fileGone && /File moved or deleted/.test(tr().panelCard?.staleText ?? ''), 8000)
  assert.ok(!vscode.window.tabGroups.all.some((g) => g.tabs.some((x) => /not found/.test(x.label))), 'no "(not found)" tab')
  await vscode.commands.executeCommand('codeNotes.endJourney')
  for (const f of [gonePath, longPath]) fs.unlinkSync(f)
  fs.unlinkSync(jp('20261111-200300-onstep'))
  await until('cleaned', () => !snap().journeys.some((x: any) => x.id === 'long' || x.id === 'gonefile') && !note('20261111-200300-onstep'))
  ok('one inline card, the map follows the step, ref lit with Back, card in view after jumps, no read on arrival, leave toast, gone file in the map')

  // 33. R: resolve the note at the cursor, then go to the next unread one.
  await vscode.commands.executeCommand('codeNotes.markAllRead') // earlier steps left unread notes elsewhere
  await until('all read', () => snap().notes.every((x: any) => x.unread === 0))
  write('20261111-200001-unr2', { file: 'src/flow.ts', range: { start: 1, end: 1 }, status: 'open', messages: [{ author: 'claude', role: 'agent', body: 'Second unread' }] })
  await until('second unread', () => note('20261111-200001-unr2')?.unread === 1)
  const ed = await vscode.window.showTextDocument(vscode.Uri.file(path.join(ws, 'src', 'flow2.ts')))
  ed.selection = new vscode.Selection(0, 0, 0, 0)
  void vscode.commands.executeCommand('codeNotes.resolveNext')
  await until('R resolved it', () => readJson(jp('20261111-200000-unr1')).status === 'resolved')
  await until('R went on to the next unread', () => j.at() === 'src/flow.ts:1' && note('20261111-200001-unr2').unread === 0)
  const ev = readJson(jp('20261111-200000-unr1')).events
  assert.equal(ev.length, 1)
  assert.equal(ev[0].type, 'resolved')
  assert.equal(ev[0].by, snap().me)
  ok('R resolves the note at the cursor (recorded in "events") and opens the next unread note')

  // 34. Severity: icon and order (most severe first); an unknown severity and unknown fields survive a rewrite.
  const sev = (id: string, line: number, severity: string | undefined, extra: object = {}) => write(id, { file: 'src/flow.ts', range: { start: line, end: line }, status: 'open', session: 'Review', ...(severity ? { severity } : {}), ...extra, messages: [{ author: 'claude', role: 'agent', body: `${severity ?? 'none'} finding` }] })
  sev('20261111-200100-sv1', 2, 'low')
  sev('20261111-200101-sv2', 6, 'high')
  sev('20261111-200102-sv3', 3, undefined)
  sev('20261111-200103-sv4', 7, 'critical', { reviewer: { tool: 'x', v: 2 } })
  await until('review loaded', () => snap().notes.filter((x: any) => x.session === 'Review').length === 4)
  await vscode.commands.executeCommand('codeNotes.groupBySession')
  await until('grouped by session', () => snap().groupBy === 'session' && snap().tree().some((l: string) => l.startsWith('session:Review')))
  const t = snap().tree() as string[]
  const i = t.findIndex((l) => l.startsWith('session:Review'))
  const kids = t.slice(i + 1, i + 7).filter((l) => l.startsWith('    note:'))
  assert.deepEqual(kids.map((l) => l.trim().split(' · ')[0]), ['note:high finding', 'note:none finding', 'note:critical finding', 'note:low finding'], `severity order: ${kids.join(' | ')}`)
  assert.match(kids[0], /\[flame\]$/)
  assert.match(kids[3], /\[triangle-down\]$/)
  assert.match(kids[1], /\[circle-filled\]$/, 'no severity, unread: the blue dot')
  await vscode.commands.executeCommand('codeNotes.markAllRead')
  await until('read: who spoke last (an agent)', () => (snap().tree() as string[]).some((l) => /none finding.*\[sparkle\]$/.test(l)))
  const critical = jp('20261111-200103-sv4')
  void vscode.commands.executeCommand('codeNotes.resolve', { thread: await until('thread', () => api.thread('20261111-200103-sv4')) })
  await until('critical resolved', () => readJson(critical).status === 'resolved')
  assert.equal(readJson(critical).severity, 'critical', 'unknown severity kept')
  assert.deepEqual(readJson(critical).reviewer, { tool: 'x', v: 2 }, 'unknown field kept')
  assert.equal(readJson(critical).events.length, 1)
  ok('severity: icons, most severe first inside a session; unknown severity and fields survive a rewrite')

  // 35. Group by: File puts every non-journey note under its file; a file with one note is one row (file:line).
  await vscode.commands.executeCommand('codeNotes.groupByFile')
  await until('grouped by file', () => snap().groupBy === 'file')
  const tf = snap().tree() as string[]
  assert.ok(!tf.some((l) => l.startsWith('session:Review')), 'no Review session in file mode')
  assert.ok(tf.some((l) => l.startsWith('journeys:Journeys')), 'journeys stay their own group')
  assert.ok(tf.some((l) => /^file:flow\.ts/.test(l)), 'flow.ts row')
  const solo = tf.find((l) => /^note:.* · .*renamed\.ts:\d+/.test(l)) ?? tf.find((l) => /^note:/.test(l) && /\.ts:\d+/.test(l))
  assert.ok(solo, `a single-note file is one row with file:line:\n${tf.join('\n')}`)
  ok('Group by File / Session toggles; single-note files are one row')

  // 36. History: an agent resolves on disk -> recorded as theirs and unread; the thread shows it as a grey line.
  const h = '20261111-200101-sv2'
  const th = await until('thread', () => api.thread(h))
  await vscode.commands.executeCommand('codeNotes.reveal', { thread: th })
  await until('read', () => note(h).unread === 0)
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  await sleep(600) // closing saves the notes' anchors: the agent's write comes after that
  const d = readJson(jp(h)); d.status = 'resolved'; fs.writeFileSync(jp(h), JSON.stringify(d, null, 2))
  await until('agent resolve recorded and unread', () => note(h)?.unread === 1 && note(h).events?.at(-1)?.by === 'claude').catch((e) => { console.log(JSON.stringify(note(h)), fs.readFileSync(jp(h), 'utf8')); throw e })
  await until('written to the file', () => readJson(jp(h)).events?.at(-1)?.type === 'resolved')
  await until('thread still shown', () => api.thread(h))
  await until('grey line in the thread', () => api.thread(h)!.comments.some((c: vscode.Comment) => c.contextValue === 'event' && c.author.name === 'claude' && /Resolved/.test((c.body as vscode.MarkdownString).value)))
  // My reply reopens it: a second line.
  await vscode.commands.executeCommand('codeNotes.reply', { thread: api.thread(h), text: 'Not fixed yet' })
  await until('reopened by me', () => readJson(jp(h)).status === 'open' && readJson(jp(h)).events.at(-1).type === 'reopened')
  ok('an agent\'s resolve on disk is recorded and unread; resolve/reopen lines in the thread')

  // 37. No placeholder avatars: the name says who.
  const icons = api.thread(h)!.comments.filter((c: vscode.Comment) => c.contextValue === 'message').map((c: vscode.Comment) => c.author.iconPath)
  assert.deepEqual(icons, [undefined, undefined])
  ok('no avatars in threads')

  // An older version of the file restored (git checkout): its status comes back, no event is invented.
  const evBefore = (d.events ?? []).length
  fs.writeFileSync(jp(h), JSON.stringify(d, null, 2))
  await until('restore read', () => note(h)?.status === 'resolved')
  await sleep(700)
  assert.equal((readJson(jp(h)).events ?? []).length, evBefore, `no event written for a restore: ${JSON.stringify(readJson(jp(h)).events)}`)
  ok('a restored older note file writes no events')

  // 38. Suggestion: Apply replaces the note's lines; Ctrl+Z (undo) takes it back; a stale note refuses.
  const fdoc = await vscode.workspace.openTextDocument(path.join(ws, 'src', 'flow.ts'))
  const sg = '20261111-200200-sug1'
  const ln = fdoc.getText().split('\n').findIndex((l) => l.includes('return 2')) + 1
  write(sg, { file: 'src/flow.ts', range: { start: ln, end: ln }, status: 'open', messages: [{ author: snap().me, role: 'human', body: 'Return 3?' }] })
  await until('suggestion note', () => note(sg)?.anchor?.text?.includes('return 2'))
  // The extension writes the anchor it took into the file: reply only after that, as an agent re-reading the file would
  // (replying on the copy read before it raced that write and dropped the anchor: the flake of runs 1/2).
  await until('anchor on disk', () => readJson(jp(sg)).anchor?.text?.includes('return 2'))
  reply(sg, { author: 'claude', role: 'agent', body: 'Yes:\n\n```suggestion\n  return 3 // three\n```', at: now() })
  await until('suggestion loaded', () => note(sg)?.messages.length === 2)
  const sth = await until('suggestion thread', () => api.thread(sg))
  const body = await until('apply link', () => sth.comments.map((c: vscode.Comment) => (c.body as vscode.MarkdownString).value).find((b: string) => b.includes('command:codeNotes.applySuggestion')))
  const args = JSON.parse(decodeURIComponent(/command:codeNotes\.applySuggestion\?([^ )]+)/.exec(body)![1]))
  await vscode.commands.executeCommand('codeNotes.applySuggestion', ...args) // the link's click
  await until('applied', () => fdoc.lineAt(ln - 1).text === '  return 3 // three')
  await sleep(600)
  assert.equal(note(sg).stale, false, 'not stale after its own suggestion')
  await vscode.window.showTextDocument(fdoc)
  await vscode.commands.executeCommand('undo')
  await until('undone', () => fdoc.lineAt(ln - 1).text === '  return 2')
  await until('undone: the note is back on the old code, not stale', () => note(sg)?.stale === false && note(sg).anchor.text === '  return 2')
  await fdoc.save()
  // Stale: refused, nothing changed.
  const fed = await vscode.window.showTextDocument(fdoc)
  await fed.edit((b) => b.replace(fdoc.lineAt(ln - 1).range, '  return 22'))
  await until('stale', () => note(sg)?.stale === true)
  const applied = await api.applySuggestion(sg, args[1], args[2])
  assert.equal(applied, false, 'refused on stale code')
  assert.equal(fdoc.lineAt(ln - 1).text, '  return 22')
  await vscode.commands.executeCommand('undo')
  await fdoc.save()
  ok('Apply suggestion replaces the lines, undo restores them, stale notes refuse')

  // 39. File and folder notes: from the explorer command, and written by an agent.
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  const fileNote = await vscode.commands.executeCommand<any>('codeNotes.addPathNote', vscode.Uri.file(path.join(ws, 'src', 'flow2.ts')), 'Is this file still used?')
  const folderNote = await vscode.commands.executeCommand<any>('codeNotes.addPathNote', vscode.Uri.file(path.join(ws, 'src')), 'Split this folder?')
  const fn = readJson(fileNote.uri.fsPath), dn = readJson(folderNote.uri.fsPath)
  assert.equal(fn.target, 'file'); assert.equal(dn.target, 'folder')
  assert.ok(fn.range === undefined && fn.anchor === undefined, 'no range/anchor in a file note')
  assert.equal(dn.file, 'src')
  const fth = await until('file note thread', () => api.thread(fn.id))
  assert.equal(fth.range?.start.line, 0, 'the file note sits on line 1')
  assert.match(fth.label ?? '', /File note/)
  const dth = await until('folder note thread', () => api.thread(dn.id))
  assert.equal(dth.uri.scheme, 'code-notes-folder')
  assert.ok(vscode.window.activeTextEditor?.document.getText().includes('flow.ts'), 'the folder page lists the folder')
  await vscode.commands.executeCommand('codeNotes.reply', { thread: dth, text: 'Yes: api and storage' })
  await until('reply on a folder note', () => readJson(folderNote.uri.fsPath).messages.length === 2)
  write('20261111-200300-agf1', { file: 'src', status: 'open', messages: [{ author: 'claude', role: 'agent', body: 'Agent folder note' }] })
  write('20261111-200301-agf2', { file: 'src/flow2.ts', target: 'file', status: 'open', messages: [{ author: 'claude', role: 'agent', body: 'Agent file note' }] })
  await until('agent folder/file notes', () => note('20261111-200300-agf1')?.target === 'folder' && note('20261111-200301-agf2')?.target === 'file')
  assert.equal(snap().broken, 0, 'not reported as broken')
  const tt = snap().tree() as string[]
  console.log(tt.map((l) => `      | ${l}`).join('\n'))
  assert.ok(tt.some((l) => /^file:src · 2\b.*\[folder\]$/.test(l)), 'a folder row holding the two folder notes')
  assert.ok(tt.some((l) => /Agent file note.*flow2\.ts|flow2\.ts/.test(l)), 'file note listed')
  // A file note survives edits to the file (stays on line 1, never stale).
  const f2 = await vscode.window.showTextDocument(vscode.Uri.file(path.join(ws, 'src', 'flow2.ts')))
  await f2.edit((b) => b.insert(new vscode.Position(0, 0), '// new first line\n'))
  await f2.document.save()
  await sleep(800)
  assert.equal(note(fn.id).range.start, 1)
  assert.equal(note(fn.id).stale, false)
  ok('file and folder notes: added from the explorer, by agents, listed, threads on line 1 / a folder page, replies work')

  // No commenting range on every line, yet Add Note (Ctrl+' C) still opens its box and saves.
  const ed9 = await vscode.window.showTextDocument(vscode.Uri.file(path.join(ws, 'src', 'flow2.ts')))
  ed9.selection = new vscode.Selection(2, 0, 2, 0)
  const before9 = snap().notes.length
  await vscode.commands.executeCommand('codeNotes.add')
  await sleep(600)
  await vscode.commands.executeCommand('type', { text: 'Typed into the box' })
  await vscode.commands.executeCommand('editor.action.submitComment')
  await until('Add Note saved a note', () => snap().notes.length === before9 + 1 && snap().notes.some((x: any) => x.messages[0].body === 'Typed into the box'), 8000)
  ok('Add Note opens its box with no always-on commenting range')
  assert.equal(vscode.workspace.getConfiguration('comments').get('maxHeight'), false, 'More grows the card: no nested scroll')

  // Nothing matches in the picker: the agent writes the journey (the fake claude CLI plays journey.py), its map opens.
  // The repository's own copy of the skill is used (a teammate has none in their home folder).
  const repoSkill = path.join(ws, '.claude', 'skills', 'code-journey')
  fs.mkdirSync(path.join(repoSkill, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(repoSkill, 'scripts', 'journey.py'), '# stand-in\n')
  const calls0 = fs.readFileSync(process.env.FAKE_CLAUDE_LOG!, 'utf8').trim().split('\n').length
  const apiW = api as unknown as { writing: () => { label: string }[] }
  const writingP = api.writeJourney('How is a note saved?')
  // Written into a staging folder; not listed (nor "new") until it is checked and moved; one "Writing:" row meanwhile.
  const stageRoot = path.join(notesDir, '.writing')
  const staged = () => { try { return fs.readdirSync(stageRoot).map((d) => path.join(stageRoot, d, 'written.json')).find((f) => fs.existsSync(f)) } catch { return undefined } }
  await until('staged file written', () => staged(), 8000)
  assert.ok(!snap().journeys.some((x: any) => x.id === 'written'), 'a journey being written is not listed')
  assert.ok(!fs.existsSync(path.join(ws, 'journeys', 'written.json')), 'not in the journeys folder yet')
  assert.match(apiW.writing()[0]?.label ?? '', /^Writing: How is a note saved\? · \d:\d\d$/, 'one "Writing: <question> · m:ss" row')
  const wrote = await writingP
  assert.equal(wrote, 'written', 'the new journey opened')
  assert.equal(apiW.writing().length, 0, 'no row once written')
  const writtenFile = path.join(ws, 'journeys', 'written.json')
  assert.equal(readJson(writtenFile).model, 'Claude Code default', 'the model is stamped')
  assert.ok(!fs.readdirSync(stageRoot).length, 'the staging folder is cleaned up')
  await until('its map is open', () => snap().tour.map === 'written')
  const cliArgs = JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_LOG!, 'utf8').trim().split('\n')[calls0])
  assert.match(cliArgs[cliArgs.indexOf('-p') + 1], /^Use the code-journey skill to answer: How is a note saved\?/)
  const allowed = cliArgs.slice(cliArgs.indexOf('--allowedTools') + 1, cliArgs.indexOf('--disallowedTools'))
  assert.ok(['Read', 'Grep', 'Glob', 'Skill'].every((x) => allowed.includes(x)) && allowed.some((x: string) => /^Bash\(.*\/\.claude\/skills\/code-journey\/scripts\/\*\)$/.test(x)), `tools: ${allowed}`)
  assert.ok(cliArgs.includes('Edit') && cliArgs.includes('Write'), 'edits stay blocked')
  assert.ok(allowed.includes(`Bash(${repoSkill}/scripts/*)`), `the repo's skill scripts are allowed: ${allowed}`)
  assert.ok(cliArgs[cliArgs.indexOf('-p') + 1].includes(`${repoSkill}/scripts/`), 'the prompt points at the repo\'s skill')
  assert.match(cliArgs[cliArgs.indexOf('-p') + 1], /a request, not the journey's question/, 'the person\'s words are a request')
  fs.unlinkSync(writtenFile)
  await until('written gone', () => !snap().journeys.some((x: any) => x.id === 'written'))
  ok('"Ask the agent to write a journey": claude with the code-journey skill writes it, its map opens')

  // ---------- In the repo: <repo>/journeys/, compact (v3) anchors, the request file and links ----------
  const ext = require(path.join(__dirname, '../../src/compact.js'))
  const api2 = api as unknown as { reloadJourneys: () => Promise<void>; explainLog: () => { action: string; question: string; via: string; outcome: string }[]
    confirming: () => { title: string; question: string; items: string[] } | undefined; answerConfirm: (label: string) => boolean
    clarify: () => { question: string; session: string; text: string } | undefined; answerClarify: (t: string) => Promise<string | undefined>
    askBox: () => { title: string; value: string } | undefined; askBoxSend: (t: string) => boolean }
  const srcFile = path.join(ws, 'src', 'saving.ts')
  const code = ['import { write } from "./disk"', '', 'export function saveNote(n: Note) {', '  const raw = serialize(n)', '  write(n.path, raw)', '  log(n.id)', '  return raw', '}', '',
    'export function loadNote(p: string) {', '  const raw = read(p)', '  return parse(raw)', '}', '']
  fs.writeFileSync(srcFile, code.join('\n'))
  const repoJourneys = path.join(ws, 'journeys')
  fs.mkdirSync(repoJourneys, { recursive: true })
  const saving = { version: 2, id: 'saving', question: 'How is a note saved to disk?', title: 'Saving a note', summary: 'A note is serialized and written.',
    nodes: [{ id: 'app', kind: 'system', label: 'App', summary: '' }, { id: 'save', kind: 'function', label: 'saveNote', parent: 'app', summary: '', at: { file: 'src/saving.ts', start: 3, end: 8, anchor: ext.compactOf(code, 2, 7) } },
      { id: 'load', kind: 'function', label: 'loadNote', parent: 'app', summary: '' }],
    edges: [],
    steps: [
      { id: 'save', title: 'saveNote serializes and writes', node: 'save', file: 'src/saving.ts', range: { start: 3, end: 8 }, anchor: ext.compactOf(code, 2, 7), lead: 'Here.', refs: [] },
      { id: 'load', title: 'loadNote parses', node: 'load', file: 'src/saving.ts', range: { start: 10, end: 13 }, anchor: ext.compactOf(code, 9, 12), lead: 'There.', refs: [] },
    ] }
  // The same id in the notes folder too (a personal copy, the old place): listed once, the repo's.
  fs.mkdirSync(path.join(notesDir, 'journeys'), { recursive: true })
  fs.writeFileSync(path.join(notesDir, 'journeys', 'saving-copy.json'), JSON.stringify({ ...saving, title: 'Personal copy' }))
  fs.writeFileSync(path.join(repoJourneys, 'saving.json'), JSON.stringify(saving, null, 2))
  await api2.reloadJourneys()
  const jSaving = () => snap().journeys.find((x: any) => x.id === 'saving')
  await until('repo journey read', () => jSaving())
  assert.equal(snap().journeys.filter((x: any) => x.id === 'saving').length, 1, 'one saving journey')
  const rows = snap().tree() as string[]
  assert.ok(rows.some((l) => /journey:.*Saving a note/.test(l)) && !rows.some((l) => /Personal copy/.test(l)), `the repo copy wins: ${rows.join(' / ')}`)
  assert.deepEqual(jSaving().at.map((a: any) => [a.start, a.end, a.stale]), [[3, 8, false], [10, 13, false]])
  ok('journeys in <repo>/journeys/ (codeNotes.journeys.folder) are read; a same-id copy in the notes folder is not listed twice')

  // v3 relocation: moved → fresh at its new place; edited inside → changed; deleted → gone.
  fs.writeFileSync(srcFile, ['// header', '// more', ...code].join('\n'))
  await api2.reloadJourneys()
  await until('moved, fresh', () => jSaving()?.at[0].start === 5 && jSaving().at[0].end === 10 && !jSaving().at[0].stale && jSaving().at[1].start === 12)
  const edited = [...code]; edited[5] = '  log("saved", n.id)'
  fs.writeFileSync(srcFile, edited.join('\n'))
  await api2.reloadJourneys()
  await until('edited, changed', () => { const a = jSaving()?.at[0]; return a && a.stale && !a.removed && a.start === 3 && a.end === 8 })
  fs.writeFileSync(srcFile, code.slice(9).join('\n'))
  await api2.reloadJourneys()
  await until('deleted, gone', () => { const a = jSaving()?.at[0]; return a && a.stale && a.removed })
  assert.deepEqual([jSaving().at[1].start, jSaving().at[1].stale], [1, false], 'the other step followed')
  fs.writeFileSync(srcFile, code.join('\n'))
  await api2.reloadJourneys()
  await until('back, fresh', () => jSaving() && jSaving().at.every((a: any) => !a.stale))
  ok('compact anchors: moved block fresh at its new place, edited inside changed, deleted gone')

  // The request file (.code-notes/.request.json, written by a script or another tool), then the link.
  const reqFile = path.join(ws, '.code-notes', '.request.json')
  const request = (o: object) => fs.writeFileSync(reqFile, JSON.stringify({ at: new Date().toISOString(), ...o }))
  const outcomes = () => api2.explainLog()
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  const resFile = path.join(ws, '.code-notes', '.result.json')
  const result = () => { try { return readJson(resFile) } catch { return undefined } }
  request({ action: 'ask', question: 'How does saving a note work?', model: '', id: 'req-1', needs: '0.1.0' })
  await until('ask matched', () => outcomes().some((x) => x.via === 'file' && x.outcome === 'opened:saving'))
  await until('result for the script', () => result()?.id === 'req-1')
  assert.deepEqual(result(), { id: 'req-1', outcome: 'opened', title: 'Saving a note' }, 'the result names the journey that opened')
  await until('its map is open', () => snap().tour.map === 'saving')
  await until('request file deleted', () => !fs.existsSync(reqFile))
  assert.equal(snap().notes.filter((n: any) => n.path.endsWith('.request.json')).length, 0, 'the request file is not a note')
  assert.equal(snap().broken, 0, 'nor a broken one')
  ok('request file, ask: the matching journey opens; the file is deleted')

  const n0 = outcomes().length
  request({ action: 'overview', question: '' })
  await until('overview', () => outcomes().length > n0 && outcomes()[n0].outcome === 'overview')
  // The panel's Journeys list (no picker), the tab titled "Journeys".
  await until('the Journeys list in the panel', () => snap().tour.map && snap().tour.mapTitle === 'Journeys', 8000)
  ok('request file, overview: the panel\'s Journeys list')

  // Older than 2 minutes: ignored (and deleted).
  const n1 = outcomes().length
  fs.writeFileSync(reqFile, JSON.stringify({ action: 'ask', question: 'saving a note', at: new Date(Date.now() - 5 * 60_000).toISOString() }))
  await until('stale request deleted', () => !fs.existsSync(reqFile))
  await sleep(500)
  assert.equal(outcomes().length, n1, 'an old request does nothing')
  ok('a request older than 2 minutes is ignored')

  // A request for a newer Code Notes is left for the reloaded window.
  const nTooNew = outcomes().length
  request({ action: 'ask', question: 'How does saving a note work?', id: 'req-new', needs: '99.0.0' })
  await until('too new', () => outcomes().slice(nTooNew).some((x) => x.outcome === 'too-new'))
  await sleep(500)
  assert.ok(fs.existsSync(reqFile) && result()?.id !== 'req-new', 'left alone, no result')
  fs.unlinkSync(reqFile)
  ok('a request that needs a newer Code Notes is left for it')

  // No journey matches: one confirm first, the closest journeys listed first; Cancel runs nothing.
  const fakeCalls = () => fs.readFileSync(process.env.FAKE_CLAUDE_LOG!, 'utf8').trim().split('\n').filter((l) => l.includes('"-p"')).length
  const callsC = fakeCalls()
  request({ action: 'ask', question: 'How are saved widgets frobnicated?', model: 'claude-fake-x', id: 'req-2' })
  const conf = await until('confirm shown', () => api2.confirming())
  assert.match(conf.title, /^No journey answers this yet\. Write one with Claude \(claude-fake-x, about 3 min\)\?$/)
  const si = conf.items.findIndex((x) => /Saving a note/.test(x))
  assert.ok(si >= 0 && si < conf.items.indexOf('$(sparkle) Write') && conf.items.at(-1) === 'Cancel', `closest journeys first, then Write, Cancel: ${conf.items}`)
  await until('result: confirm', () => result()?.id === 'req-2' && result().outcome === 'confirm' && result().model === 'claude-fake-x')
  api2.answerConfirm('Cancel')
  await until('cancelled', () => outcomes().some((x) => x.question === 'How are saved widgets frobnicated?' && x.outcome === 'cancelled'))
  await sleep(500)
  assert.equal(fakeCalls(), callsC, `Cancel: no Claude run: ${fs.readFileSync(process.env.FAKE_CLAUDE_LOG!, 'utf8').trim().split('\n').filter((l) => l.includes('"-p"')).slice(callsC).map((l) => l.slice(0, 200)).join('\n')}`)
  ok('no match asks first, closest journeys first; Cancel starts nothing')

  // An unknown model (the request's or the setting's) runs nothing; the script gets an error with the message.
  const callsM = fakeCalls()
  request({ action: 'ask', question: 'How are gadgets frobnicated?', model: 'sonet', id: 'req-m' })
  await until('result: error', () => result()?.id === 'req-m' && result().outcome === 'error')
  assert.equal(result().message, "Unknown model 'sonet'. Use sonnet, opus, haiku or fable.")
  assert.equal(api2.confirming(), undefined, 'no confirm for a run that can\'t happen')
  await vscode.workspace.getConfiguration('codeNotes').update('journeys.model', 'sonet', vscode.ConfigurationTarget.Workspace)
  assert.equal(await api.writeJourney('How are gadgets frobnicated?'), undefined)
  await vscode.workspace.getConfiguration('codeNotes').update('journeys.model', undefined, vscode.ConfigurationTarget.Workspace)
  assert.equal(fakeCalls(), callsM, 'nothing spawned')
  ok('an unknown model is refused before any Claude run, with the message in the result')

  // Write: the journey is written (the fake claude CLI) with the requested model, and its map opens (not while you
  // walk another journey: then the notice's Open).
  await vscode.commands.executeCommand('codeNotes.endJourney')
  await until('no walk', () => !snap().tour.touring)
  const calls1 = fs.readFileSync(process.env.FAKE_CLAUDE_LOG!, 'utf8').trim().split('\n').length
  request({ action: 'ask', question: 'How are widgets frobnicated?', model: 'claude-fake-x', id: 'req-3' })
  await until('confirm shown', () => api2.confirming()?.question === 'How are widgets frobnicated?')
  api2.answerConfirm('Write')
  await until('writing', () => outcomes().some((x) => x.question === 'How are widgets frobnicated?' && x.outcome === 'writing'))
  await until('result: writing', () => result()?.id === 'req-3' && result().outcome === 'writing')
  await until('written journey map open', () => snap().tour.map === 'written', 15000)
  const args1 = JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_LOG!, 'utf8').trim().split('\n')[calls1])
  assert.match(args1[args1.indexOf('-p') + 1], /^Use the code-journey skill to answer: How are widgets frobnicated\?/)
  assert.equal(args1[args1.indexOf('--model') + 1], 'claude-fake-x')
  assert.match(args1[args1.indexOf('-p') + 1], /--dir \.code-notes\/\.writing\/\S+`.*moves the journey into journeys\//s)
  assert.equal(readJson(path.join(repoJourneys, 'written.json')).model, 'claude-fake-x', 'stamped with the model')
  fs.unlinkSync(path.join(repoJourneys, 'written.json'))
  await until('written gone', () => !snap().journeys.some((x: any) => x.id === 'written'))
  ok('request file, ask with no match: after Write, the agent writes the journey with the requested model; its map opens')

  // Claude asks a question instead of writing: shown with a reply box; the answer resumes the same session.
  const callsQ = fs.readFileSync(process.env.FAKE_CLAUDE_LOG!, 'utf8').trim().split('\n').length
  const none = await api.writeJourney('Something unclear about things')
  assert.equal(none, undefined, 'no journey yet')
  const cq = await until('Claude\'s question shown', () => api2.clarify())
  assert.equal(cq.session, 'sess-clarify')
  assert.match(cq.text, /Which part do you mean/)
  const resumedId = await api2.answerClarify('The saving part')
  assert.equal(resumedId, 'written', 'the answer led to the journey')
  const argsQ = fs.readFileSync(process.env.FAKE_CLAUDE_LOG!, 'utf8').trim().split('\n').slice(callsQ).map((l) => JSON.parse(l)).filter((a) => a.includes('-p'))
  assert.equal(argsQ.length, 2)
  assert.equal(argsQ[1][argsQ[1].indexOf('--resume') + 1], 'sess-clarify', 'the same session goes on')
  assert.match(argsQ[1][argsQ[1].indexOf('-p') + 1], /^The saving part\n/)
  assert.equal(api2.clarify(), undefined, 'the question panel closed')
  fs.unlinkSync(path.join(repoJourneys, 'written.json'))
  await until('written gone', () => !snap().journeys.some((x: any) => x.id === 'written'))
  ok('a clarifying answer is shown with a reply box; the reply resumes the session and the journey is written')

  // Claude writes nothing because a journey already answers it: that journey opens; no error.
  await vscode.commands.executeCommand('codeNotes.endJourney')
  assert.equal(await api.writeJourney('Something already answered'), 'saving', 'the existing journey opened')
  await until('its map', () => snap().tour.map === 'saving')
  assert.equal(api2.clarify(), undefined, 'not shown as a question')
  ok('"already in journeys/<slug>.json": that journey opens')

  // Ask on a step: its own box (no cursor needed), the note's thread open with Claude's answer, titled by the question.
  request({ action: 'ask', question: 'How is a note saved to disk?', id: 'req-4' })
  await until('saving opened by that request', () => result()?.id === 'req-4' && result().outcome === 'opened', 8000)
  await until('saving open on a step', () => snap().tour.journey === 'saving' && snap().tour.step >= 1, 8000)
  await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup')
  const notesN = snap().notes.length
  void vscode.commands.executeCommand('codeNotes.askStep')
  const box = await until('the Ask box', () => api2.askBox())
  assert.match(box.title, /^Ask about step \d+\/2: /)
  assert.ok(api2.askBoxSend('Where is the note written?'))
  const sn = await until('step question saved', () => snap().notes.length === notesN + 1 && snap().notes.find((x: any) => x.messages[0].body.startsWith('Where is the note written?')))
  await until('its thread open, titled by the question', () => { const x = snap().notes.find((y: any) => y.id === sn.id); return x?.threadExpanded && x.threadLabel === 'Where is the note written?' })
  await until('Claude answered in it', () => snap().notes.find((y: any) => y.id === sn.id)?.messages.at(-1)?.author === 'Claude', 10000)
  // The answer as the thread shows it (once re-rendered): its reference is a link.
  await until('the answer\'s reference is a link', () => api.thread(sn.id)?.comments.some((c: vscode.Comment) => c.author.name === 'Claude' && /\[`src\/renamed\.ts:3`\]\(command:codeNotes\.openAt\?/.test((c.body as vscode.MarkdownString).value)))
  fs.unlinkSync(sn.path)
  ok('Ask on a step opens its own box; the thread stays open under the step with the answer, titled by the question')

  // A link never starts Claude, whatever it asks (and its model is ignored): the overview instead.
  const callsL = fakeCalls()
  const nL = outcomes().length
  await vscode.env.openExternal(vscode.Uri.parse(`${vscode.env.uriScheme}://${EXT_ID}/explain?action=ask&q=${encodeURIComponent('How are gizmos teleported?')}&model=evil&repo=${encodeURIComponent(ws)}`))
  await until('link handled', () => outcomes().slice(nL).some((x) => x.via === 'uri'), 8000)
  await sleep(800)
  assert.equal(outcomes().slice(nL).find((x) => x.via === 'uri')!.outcome, 'overview', 'the overview, not a run')
  assert.equal(api2.confirming(), undefined, 'not even the confirm')
  assert.equal(fakeCalls(), callsL, 'no Claude run from a link')
  await vscode.commands.executeCommand('workbench.action.closeQuickOpen')
  ok('a vscode:// link never starts Claude')

  // The link (what `code --open-url` delivers), for this repo; the same request as a file is handled once.
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  await until('map closed', () => !snap().tour.map)
  const n2 = outcomes().length
  const link = (q: string, repo = ws) => vscode.Uri.parse(`${vscode.env.uriScheme}://${EXT_ID}/explain?action=ask&q=${encodeURIComponent(q)}&repo=${encodeURIComponent(repo)}`)
  request({ action: 'ask', question: 'loadNote parses' })
  await vscode.env.openExternal(link('loadNote parses'))
  await until('link handled', () => outcomes().slice(n2).some((x) => x.outcome === 'opened:saving'), 8000)
  await until('map open', () => snap().tour.map === 'saving')
  await sleep(800)
  const tail = outcomes().slice(n2)
  assert.equal(tail.filter((x) => x.outcome.startsWith('opened')).length, 1, `handled once: ${JSON.stringify(tail)}`)
  assert.ok(!fs.existsSync(reqFile), 'request file consumed')
  // A link for another repository: left to the window that has it.
  const n3 = outcomes().length
  await vscode.env.openExternal(link('loadNote parses', path.join(ws, '..', 'not-this-repo')))
  await sleep(1000)
  assert.equal(outcomes().length, n3, 'another repo\'s link is ignored here')
  ok('vscode://<extension id>/explain links: handled once with the request file; another repo\'s link ignored')
  // Two journeys answer about equally: a short pick, not one opened silently.
  fs.writeFileSync(path.join(repoJourneys, 'drafts.json'), JSON.stringify({ ...saving, id: 'drafts', title: 'Saving a draft', question: 'How is a draft kept?' }, null, 2))
  await api2.reloadJourneys()
  await until('drafts read', () => snap().journeys.some((x: any) => x.id === 'drafts'))
  const api3 = api as unknown as { choosing: () => string[] | undefined; choose: (t: string) => void }
  const nC = outcomes().length
  request({ action: 'ask', question: 'How does saving work?', id: 'req-5' })
  const titles = await until('the pick', () => api3.choosing())
  assert.deepEqual([...titles].sort(), ['Saving a draft', 'Saving a note'])
  await until('result: choose', () => result()?.id === 'req-5' && result().outcome === 'choose')
  api3.choose('Saving a note')
  await until('opened the one picked', () => outcomes().slice(nC).some((x) => x.outcome === 'opened:saving'))
  ok('close matches: a pick of them (result "choose"), the one picked opens')
  fs.rmSync(repoJourneys, { recursive: true, force: true })
  fs.rmSync(path.join(notesDir, 'journeys', 'saving-copy.json'), { force: true })
  // ---- a step's animation (prototype): the row's toggle plays the scene in place of the map; each beat lights the
  // line that does it, with an example value above; back, forward and "Map" all work ----
  {
    const jd = path.join(notesDir, 'journeys')
    fs.mkdirSync(jd, { recursive: true })
    fs.writeFileSync(path.join(ws, 'src', 'tok.ts'), ['import { readToken, use } from "./lib"', 'export function main() {', '  const token = readToken()', '  use(token)', '  return 0', '}', ''].join('\n'))
    fs.writeFileSync(path.join(ws, 'src', 'anim.ts'), ['export function save(run: object) {', '  const body = JSON.stringify(run)', '  return store(body)', '}', 'function store(b: string) { return b.length }', ''].join('\n'))
    const scene = {
      actors: [{ id: 'svc', type: 'service', col: 0, label: 'Server', fn: 'save()', checks: ['encode', 'store'] }, { id: 'db', type: 'table', col: 1, label: 'Database', rows: [{ id: 'run 1', chips: ['queued'] }] }],
      wires: [['svc', 'db']],
      beats: [
        { focus: 'svc', caption: 'It encodes the run.', set: { svc: { done: 1 } }, code: { file: 'src/anim.ts', line: 2, text: 'const body = JSON.stringify(run)' } },
        // written for line 9: the code moved, the line is found by what it says
        { focus: 'db', caption: 'It stores it.', set: { svc: { done: 2 }, db: { show: 1, hi: 0 } }, packet: { from: 'svc', to: 'db', label: 'insert' }, code: { file: 'src/anim.ts', line: 9, text: 'return store(body)' } },
        // in another file than the step's: the card is out of sight while it is lit
        { focus: 'svc', caption: 'It uses the token.', code: { file: 'src/tok.ts', line: 4, text: 'use(token)' } },
        { focus: 'all', caption: 'Done.' },
      ],
    }
    const scene2 = { actors: scene.actors, wires: scene.wires, beats: [{ focus: 'svc', caption: 'It reads the token.', code: { file: 'src/tok.ts', line: 3, text: 'const token = readToken()' } }] }
    const longValue = 'a value far longer than forty characters, so it is cut short'
    fs.writeFileSync(path.join(jd, 'anim.json'), JSON.stringify({
      version: 2, id: 'anim', question: 'How is a run saved?', title: 'Anim', summary: 'save stores it.',
      nodes: [{ id: 'app', kind: 'system', label: 'App', summary: '' }, { id: 'm', kind: 'module', label: 'anim', summary: '', parent: 'app' }, { id: 'f', kind: 'function', label: 'save', summary: '', parent: 'm' }],
      edges: [], steps: [{ id: 'a1', title: 'save stores the run', node: 'f', file: 'src/anim.ts', range: { start: 1, end: 4 }, lead: 'It encodes the run, then stores it <fast>, with the token.', details: 'Afterwards it reports the length.',
        // tok.ts:3 repeats the "with the token" link: not listed under More; tok.ts:5 is listed
        refs: ['src/tok.ts:3', 'src/tok.ts:5'], scene,
        values: [{ name: 'body', value: '{ "id": 1 }', file: 'src/anim.ts', line: 2, text: 'const body = JSON.stringify(run)' }, { name: 'stored', value: '11', note: 'the length of the body', file: 'src/anim.ts', line: 8, text: 'return store(body)' }, { name: 'gone', value: '1', file: 'src/anim.ts', line: 1, text: 'no such line' },
          { name: 'token', value: longValue, note: 'from the env', file: 'src/tok.ts', line: 3, text: 'const token = readToken()' }],
        links: [{ phrase: 'encodes the run', file: 'src/anim.ts', start: 2, end: 2, text: 'const body = JSON.stringify(run)' }, { phrase: 'stores it', file: 'src/anim.ts', start: 7, end: 7, text: 'return store(body)' }, { phrase: 'never said', file: 'src/anim.ts', start: 1, end: 1, text: '' }, { phrase: 'reports the length', file: 'src/anim.ts', start: 5, end: 5, text: 'function store(b: string) { return b.length }' },
          { phrase: 'with the token', file: 'src/tok.ts', start: 3, end: 3, text: 'const token = readToken()' }] },
      { id: 'a2', title: 'store measures it', node: 'f', file: 'src/anim.ts', range: { start: 5, end: 5 }, lead: 'It returns the length.', refs: [], scene: scene2 }],
    }, null, 2))
    const bt = () => api.snapshot().tour
    const animUri = vscode.Uri.file(path.join(ws, 'src', 'anim.ts')).toString(), tokUri = vscode.Uri.file(path.join(ws, 'src', 'tok.ts')).toString()
    /** The code group's editor (never the map's). */
    const codeEd = () => vscode.window.visibleTextEditors.find((e) => e.viewColumn !== bt().mapColumn && e.document.uri.scheme === 'file')
    const onScreen = (line: number) => !!codeEd()?.visibleRanges.some((r) => r.start.line <= line && r.end.line >= line)
    // CODE_NOTES_ANIM_SHOTS=<dir>: pictures of this block's states, for a person to look at.
    const shot = async (name: string) => { const d = process.env.CODE_NOTES_ANIM_SHOTS; if (!d) return; await sleep(1500); require('child_process').execFileSync('import', ['-window', 'root', path.join(d, `${name}.png`)]) }
    await until('the journey with a scene is read', () => api.snapshot().journeys.some((x: any) => x.id === 'anim'), 10000)
    await vscode.commands.executeCommand('codeNotes.openJourney', 'anim')
    await until('walking it, map drawn', () => bt().journey === 'anim' && bt().step === 1 && bt().mapBoxes > 0, 10000)
    assert.equal(bt().beat, undefined, 'nothing lit before the animation is on')
    // Code links: phrases of the card's text link to their lines (own colour), marked faintly while the step is open; a click lights one.
    await until('the card has the two phrases as code links, the linked lines found (one had moved)', () => /\[<span style="color:var\(--vscode-foreground\);background-color:var\(--vscode-toolbar-hoverBackground\);">encodes <\/span>​<span [^>]*>the <\/span>​<span [^>]*>run<\/span>\]\(command:codeNotes\.codeLink/.test(bt().card?.body ?? '') && bt().codeLinks.at[0]?.start === 1 && bt().codeLinks.at[1]?.start === 2, 10000)
    assert.ok(/>stores <\/span>​<span [^>]*>it<\/span>\]\(command:codeNotes\.codeLink/.test(bt().card.body) && !/said<\/span>/.test(bt().card.body), `a phrase not in the text is no link: ${bt().card.body}`)
    assert.ok(bt().card.body.includes('\\<fast\\>'), 'other tags in the text stay text')
    assert.equal(bt().codeLinks.active, -1, 'none lit before a click')
    // Only phrases on the card have their lines marked: the one behind More only while it is open.
    assert.deepEqual(bt().codeLinks.visible, [0, 1, 4], 'More closed: the phrase in the details marks nothing')
    await vscode.commands.executeCommand('codeNotes.stepDetails', true)
    await until('More open: its phrase is a link and its lines are marked', () => />reports <\/span>​<span [^>]*>the <\/span>​<span [^>]*>length<\/span>/.test(bt().card?.body ?? '') && bt().codeLinks.visible.join() === '0,1,3,4', 10000)
    // A file:line under More that a code link already points at is not listed again.
    assert.ok(/\[tok\.ts:5\]/.test(bt().card.body) && !/\[tok\.ts:3\]/.test(bt().card.body), `the ref repeating a link is dropped: ${bt().card.body}`)
    await vscode.commands.executeCommand('codeNotes.stepDetails', false)
    await until('More closed again: no longer marked', () => bt().codeLinks.visible.join() === '0,1,4', 10000)
    await vscode.commands.executeCommand('codeNotes.codeLink', bt().codeLinks.key, 1)
    await until('clicked: that phrase\'s lines lit, the cursor there', () => bt().codeLinks.active === 1 && /anim\.ts$/.test(vscode.window.activeTextEditor?.document.uri.path ?? '') && vscode.window.activeTextEditor?.selection.active.line === 2, 10000)
    assert.equal(bt().step, 1, 'still on the step')
    const lensTitles = async (uri = vscode.window.activeTextEditor!.document.uri) => ((await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri, 20)) ?? []).map((l) => `${l.range.start.line}:${l.command?.title}`)
    // A link into the card's file, on screen with the card: no scroll away from it, no way back needed.
    await sleep(300)
    assert.equal(bt().codeLinks.back, false, 'the card is on screen with the lit lines: no Back row')
    assert.ok(onScreen(bt().card.line) && onScreen(2), 'card and lit lines both on screen')
    assert.ok(!(await lensTitles()).some((x) => /Back/.test(x)), `no Back lens: ${await lensTitles()}`)
    await shot('anim-1-link-same-file')
    // A second click on the lit phrase turns it off.
    await vscode.commands.executeCommand('codeNotes.codeLink', bt().codeLinks.key, 1)
    await until('second click: off', () => bt().codeLinks.active === -1, 10000)
    await vscode.commands.executeCommand('codeNotes.codeLink', bt().codeLinks.key, 1)
    await until('lit again', () => bt().codeLinks.active === 1, 10000)
    await vscode.commands.executeCommand('codeNotes.codeLinkBack')
    await until('"Back to step 1": at the step again, no phrase lit, the faint marks stay', () => bt().codeLinks.active === -1 && bt().codeLinks.at[1]?.start === 2 && vscode.window.activeTextEditor?.selection.active.line === 0 && !!bt().card, 10000)
    // Moving away from the lit lines (VS Code's Go Back, a click elsewhere) ends the link.
    await vscode.commands.executeCommand('codeNotes.codeLink', bt().codeLinks.key, 0)
    await until('another phrase', () => bt().codeLinks.active === 0, 10000)
    await sleep(600)
    vscode.window.activeTextEditor!.selection = new vscode.Selection(4, 0, 4, 0)
    await until('the caret left the lit lines: nothing lit', () => bt().codeLinks.active === -1, 10000)
    // A link into another file: the card is out of sight, so the way back is shown, as a control, alone on its row.
    await vscode.commands.executeCommand('codeNotes.codeLink', bt().codeLinks.key, 4)
    await until('the other file\'s line lit, the way back shown', () => bt().codeLinks.active === 4 && bt().codeLinks.back && vscode.window.activeTextEditor?.document.uri.toString() === tokUri, 10000)
    const tokLenses = await lensTitles(vscode.Uri.parse(tokUri))
    assert.ok(tokLenses.includes('2:$(arrow-left) Back to step 1'), `the way back reads as a control: ${tokLenses}`)
    assert.ok(!tokLenses.some((x) => x.startsWith('2:token =')), `no value hint on the Back row: ${tokLenses}`)
    await shot('anim-2-link-other-file-back')
    // What VS Code's Go Back does here: the step's file comes back in the code group (navigateBack itself depends on
    // the editor history the earlier tests left, so it is not driven here).
    await sleep(300)
    await vscode.window.showTextDocument(vscode.Uri.parse(animUri), { viewColumn: codeEd()!.viewColumn, preserveFocus: false })
    await until('back in the step\'s file: the link is no longer lit, and its hint is back', async () => bt().codeLinks.active === -1 && (await lensTitles(vscode.Uri.parse(tokUri))).some((x) => x.startsWith('2:token =')), 10000)
    // A long value is cut so its note stays visible.
    assert.ok(bt().values.includes(`tok.ts:2: token = ${longValue.slice(0, 39).trimEnd()}…  ·  from the env`), `the long value is capped: ${bt().values}`)
    // Value hints: what a variable holds in the example run, faint, above its line (found again when the line moved), while the step is open.
    assert.deepEqual(bt().values.filter((x: string) => x.startsWith('anim.ts')), ['anim.ts:1: body = { "id": 1 }', 'anim.ts:2: stored = 11  ·  the length of the body'], 'the step\'s values, at their lines')
    await vscode.commands.executeCommand('codeNotes.codeLinkBack')
    await until('back at the step', () => vscode.window.activeTextEditor?.document.uri.toString() === animUri && !!bt().card, 10000)
    assert.ok((await lensTitles()).includes('1:body = { "id": 1 }') && (await lensTitles()).includes('2:stored = 11  ·  the length of the body'), `shown above the lines: ${await lensTitles()}`)
    // Hints and link targets follow edits to the file.
    const grow = new vscode.WorkspaceEdit(); grow.insert(vscode.Uri.parse(animUri), new vscode.Position(0, 0), '// one\n// two\n')
    await vscode.workspace.applyEdit(grow)
    await until('after two lines inserted above: hints and links moved with their lines', () => bt().values.includes('anim.ts:3: body = { "id": 1 }') && bt().codeLinks.at[0]?.start === 3 && bt().codeLinks.at[1]?.start === 4, 10000)
    const shrink = new vscode.WorkspaceEdit(); shrink.delete(vscode.Uri.parse(animUri), new vscode.Range(0, 0, 2, 0))
    await vscode.workspace.applyEdit(shrink)
    await until('and back', () => bt().values.includes('anim.ts:1: body = { "id": 1 }') && bt().codeLinks.at[0]?.start === 1, 10000)
    await vscode.workspace.textDocuments.find((d) => d.uri.toString() === animUri)?.save()
    // CODE_NOTES_SHOT=<file.png>: a picture of the window here (the card with its code links, one lit), for a person to look at.
    if (process.env.CODE_NOTES_SHOT) { await vscode.commands.executeCommand('codeNotes.codeLink', bt().codeLinks.key, 1); await sleep(4000); require('child_process').execFileSync('import', ['-window', 'root', process.env.CODE_NOTES_SHOT]); await vscode.commands.executeCommand('codeNotes.codeLink', bt().codeLinks.key, 1) }
    api.mapSend({ type: 'test', click: '.animbtn' })
    await until('beat 1: its line lit, the caret on it (one lit line)', () => bt().beat?.uri === animUri && bt().beat.line === 1 && codeEd()?.selection.active.line === 1, 10000)
    // The step's own delayed scrolls do not take beat 1's line away.
    await sleep(700)
    assert.ok(onScreen(1) && bt().beat?.line === 1, 'beat 1 still lit and on screen after the step\'s reveals')
    // The lit line follows an edit too.
    const g2 = new vscode.WorkspaceEdit(); g2.insert(vscode.Uri.parse(animUri), new vscode.Position(0, 0), '// one\n')
    await vscode.workspace.applyEdit(g2)
    await until('the lit beat moved with its line', () => bt().beat?.line === 2, 10000)
    const s2 = new vscode.WorkspaceEdit(); s2.delete(vscode.Uri.parse(animUri), new vscode.Range(0, 0, 1, 0))
    await vscode.workspace.applyEdit(s2)
    await until('and back', () => bt().beat?.line === 1, 10000)
    await vscode.workspace.textDocuments.find((d) => d.uri.toString() === animUri)?.save()
    api.mapSend({ type: 'test', click: '.scn-next' })
    await until('beat 2: the moved line is found by its text; no example, no lens', () => bt().beat?.line === 2, 10000)
    await shot('anim-3-beat-in-step')
    api.mapSend({ type: 'test', click: '.scn-next' })
    await until('beat 3: a line in another file, the card out of sight', () => bt().beat?.uri === tokUri && bt().beat.line === 3 && codeEd()?.document.uri.toString() === tokUri, 10000)
    // The panel gets that line with the lines around it, for its own small view of the code.
    assert.ok(bt().beatCode?.line === 4 && bt().beatCode.lines[bt().beatCode.line - bt().beatCode.from]?.length > 0, `the beat's lines for the panel: ${JSON.stringify(bt().beatCode)}`)
    api.mapSend({ type: 'test', click: '.scn-next' })
    // A beat without code gives the editor back to the step: its file, its lines, its card.
    await until('a beat without code lights nothing, and the step is back', () => !bt().beat && codeEd()?.document.uri.toString() === animUri && !!bt().card && onScreen(0), 10000)
    api.mapSend({ type: 'test', click: '.scn-prev' })
    await until('back: beat 3 again, in the other file', () => bt().beat?.uri === tokUri && codeEd()?.document.uri.toString() === tokUri, 10000)
    assert.equal(bt().step, 1, 'still on the step')
    api.mapSend({ type: 'test', click: '.scn-close' })
    // "Map" gives the editor back to the step.
    await until('"Map": the animation goes, the line is no longer lit, the step and its card are back', () => !bt().beat && codeEd()?.document.uri.toString() === animUri && !!bt().card && onScreen(0), 10000)
    // ▶ then the next step: its beat 1 is what is on screen, not the step's own reveal.
    api.mapSend({ type: 'test', click: '.animbtn' })
    // The animation comes back at the beat it was left on (kept per step for the walk): beat 3, in the other file.
    await until('the animation again, at the beat it was left on', () => bt().beat?.uri === tokUri && bt().beat.line === 3, 10000)
    await vscode.commands.executeCommand('codeNotes.nextStep')
    await until('step 2, the animation on: its beat 1 (another file) lit and on screen', () => bt().step === 2 && bt().beat?.uri === tokUri && bt().beat.line === 2 && codeEd()?.document.uri.toString() === tokUri, 10000)
    await sleep(700)
    assert.ok(bt().beat?.line === 2 && codeEd()?.document.uri.toString() === tokUri && onScreen(2), 'still the beat after the step\'s delayed reveals')
    // Ctrl+' P: the command exists and runs (the panel's answer to it is the webview's).
    await vscode.commands.executeCommand('codeNotes.toggleAnimation', { prefix: "'" })
    api.mapSend({ type: 'test', click: '.scn-close' })
    await until('closed: step 2 is back', () => !bt().beat && codeEd()?.document.uri.toString() === animUri, 10000)
    // With the panel's group active, a file opened without a group (Ctrl+P) ends up beside it, never over the journey.
    const mc = bt().mapColumn as number
    await vscode.commands.executeCommand(`workbench.action.focus${['First', 'Second', 'Third', 'Fourth'][mc - 1]}EditorGroup`)
    await until('the panel\'s group is active', () => vscode.window.tabGroups.activeTabGroup.viewColumn === mc, 10000)
    await sleep(500)
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(ws, 'src', 'flow.ts')))
    await until('the file opened outside the panel\'s group', () => vscode.window.tabGroups.all.some((g) => g.viewColumn !== mc && g.tabs.some((t) => t.input instanceof vscode.TabInputText && t.input.uri.path.endsWith('/flow.ts'))), 10000)
    await until('nothing left over the journey panel', () => !vscode.window.tabGroups.all.find((g) => g.viewColumn === mc)!.tabs.some((t) => t.input instanceof vscode.TabInputText), 10000)
    // Only the panel's group: the code's group still takes a file opened from it.
    const groupsBefore = vscode.window.tabGroups.all.length
    const cc = vscode.window.tabGroups.all.find((g) => g.viewColumn !== mc && g.tabs.some((t) => t.input instanceof vscode.TabInputText && t.input.uri.path.endsWith('/flow.ts')))!.viewColumn
    await vscode.commands.executeCommand(`workbench.action.focus${['First', 'Second', 'Third', 'Fourth'][cc - 1]}EditorGroup`)
    await until('the code group is active', () => vscode.window.tabGroups.activeTabGroup.viewColumn === cc, 10000)
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(tokUri))
    await until('tok.ts opened in the code group, not in a new one', () => vscode.window.tabGroups.activeTabGroup.viewColumn === cc && vscode.window.activeTextEditor?.document.uri.toString() === tokUri, 10000)
    assert.equal(vscode.window.tabGroups.all.length, groupsBefore, 'the code group takes files as before')
    await shot('anim-4-file-kept-off-panel')
    ok('a step\'s animation: toggle, beats forward and back, each lights its line (found again when moved, following edits); the step comes back when the scene stops; code links stay near the card, toggle, end on Go Back; files opened over the panel move to the code group')
  }
}
