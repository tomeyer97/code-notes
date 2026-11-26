// What package.json contributes, checked where it can drift by hand: command titles in one style, every command either
// in the palette on purpose or hidden from it, and every setting that picks what runs listed for Restricted Mode. Then
// what it promises a user: the description, the empty views' welcome text, the menus and the settings' wording.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import { HiddenCmd } from '../src/platform/commands'

type Command = { command: string; title: string }
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'))
const commands: Command[] = pkg.contributes.commands
const palette: { command: string; when?: string }[] = pkg.contributes.menus.commandPalette

/** Words Title Case leaves in lower case (after the first word), and units. */
const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor', 'of', 'on', 'or', 'the', 'to', 'with', 's'])
/** Titles not in Title Case yet: other text quotes them (the CLI's messages, the status bar), so they change together. */
const TITLE_EXCEPTIONS = ['codeNotes.checkUnderstanding']

test('command titles are in Title Case', () => {
  const lower = commands.filter((c) => !TITLE_EXCEPTIONS.includes(c.command)).flatMap((c) => {
    // A part in parentheses says the state a toggle's title is in ("Filter Notes (filtered)…").
    const words = c.title.replace(/\(.*?\)/g, '').split(/[\s/:…]+/).filter(Boolean)
    return words.filter((w, i) => /^[a-z]/.test(w) && (i === 0 || !SMALL.has(w))).map((w) => `${c.command}: "${w}" in "${c.title}"`)
  })
  assert.deepEqual(lower, [])
})

/** The commands the Command Palette always shows; every other command has a commandPalette `when` (false: never). */
const IN_PALETTE = [
  'codeNotes.add',
  'codeNotes.askQuestion',
  'codeNotes.checkUnderstanding',
  'codeNotes.searchJourneys',
  'codeNotes.refresh',
]

test('every command is either shown in the palette on purpose or has a commandPalette rule', () => {
  const ruled = new Set(palette.map((m) => m.command))
  const unruled = commands.map((c) => c.command).filter((c) => !ruled.has(c))
  assert.deepEqual(unruled.sort(), [...IN_PALETTE].sort(), 'a new command: add a commandPalette `when` (false for plumbing) or list it here')
  for (const m of palette) assert.ok(m.when, `${m.command}: a commandPalette entry without a when shows it anyway`)
  assert.equal(new Set(palette.map((m) => m.command)).size, palette.length, 'one commandPalette entry per command')
})

test('every setting that picks what runs, its model or its skills is ignored from the workspace in Restricted Mode', () => {
  const settings = Object.keys(pkg.contributes.configuration.properties)
  const restricted: string[] = pkg.capabilities.untrustedWorkspaces.restrictedConfigurations
  const runs = settings.filter((s) => /\.(path|model|mode|skills|background)$/.test(s))
  assert.deepEqual(runs.filter((s) => !restricted.includes(s)), [])
  assert.deepEqual(restricted.filter((s) => !settings.includes(s)), [], 'only real settings are listed')
})

/**
 * The words the menus' `when` clauses look for in a comment thread's and a tree row's contextValue (flags joined by
 * `;`), in one list. They come from src/threads/sync.ts (threads), src/sidebar/rowItems.ts and journeyRows.ts (rows);
 * no code writes `stepAsk`, nor `check` on a row, today.
 */
const CONTEXT_WORDS: Record<string, string[]> = {
  commentThread: ['asking', 'check', 'concern', 'open', 'resolved', 'stepAsk', 'todo'],
  viewItem: ['asking', 'broken', 'check', 'hidden', 'journey', 'known', 'named', 'note', 'open', 'podcast', 'replied', 'resolved', 'session', 'shown', 'stale', 'unread'],
}

test('the menus look for known context words only', () => {
  const found: Record<string, Set<string>> = { commentThread: new Set(), viewItem: new Set() }
  const whens = Object.values(pkg.contributes.menus as Record<string, { when?: string }[]>).flat().map((m) => m.when ?? '')
  for (const w of whens) {
    for (const m of w.matchAll(/\b(commentThread|viewItem)\s*(?:=~\s*\/((?:[^/\\]|\\.)*)\/|[!=]=\s*([\w.-]+))/g)) {
      for (const word of (m[2] ?? m[3]).split(/[^A-Za-z]+/).filter(Boolean)) found[m[1]].add(word)
    }
  }
  for (const key of Object.keys(CONTEXT_WORDS)) assert.deepEqual([...found[key]].sort(), CONTEXT_WORDS[key], key)
})

type Menu = { command: string; when?: string; group?: string }
const c = pkg.contributes
const menus: Record<string, Menu[]> = c.menus
const settings: Record<string, { description?: string; markdownDescription?: string; enum?: string[]; enumItemLabels?: string[]; examples?: string[] }> = c.configuration.properties
const titleOf = (id: string) => commands.find((x) => x.command === id)?.title
const menu = (where: string, command: string) => menus[where].filter((m) => m.command === command)
const describe = (key: string) => settings[key].description ?? settings[key].markdownDescription ?? ''

test('the description names notes, journeys and the merge-request check in one line', () => {
  assert.doesNotMatch(pkg.description, /\n/)
  for (const word of [/\bnotes\b/, /\bjourneys\b/, /\bcheck\b/, /\bmerge\b/]) assert.match(pkg.description, word)
})

test('an empty Journeys view: one line and a button that writes a journey', () => {
  const welcome = c.viewsWelcome.filter((w: { view: string }) => w.view === 'codeNotes.journeys')
  assert.equal(welcome.length, 1)
  const lines: string[] = welcome[0].contents.split('\n')
  assert.equal(lines.length, 2)
  assert.doesNotMatch(lines[0], /\[/, 'the first line is text')
  assert.equal(lines[1], '[Ask a Question About the Code…](command:codeNotes.askQuestion)')
})

test('with journeys, the Journeys view\'s … menu offers the tutorial', () => {
  assert.deepEqual(menu('view/title', 'codeNotes.tutorial'), [
    { command: 'codeNotes.tutorial', when: 'view == codeNotes.journeys && codeNotes.hasJourneys', group: '1_help@1' },
  ])
})

test('no walkthrough: the empty views carry the first-run text', () => {
  assert.equal(c.walkthroughs, undefined)
})

test('no two contributed commands share a title; the unreachable one-line note and Reply & Resolve are gone', () => {
  const titles = commands.map((x) => x.title)
  assert.deepEqual(titles.filter((t, i) => titles.indexOf(t) !== i), [])
  for (const id of ['codeNotes.addQuick', 'codeNotes.replyResolve']) {
    assert.equal(titleOf(id), undefined, id)
    for (const items of Object.values(menus)) assert.ok(!items.some((m) => m.command === id), id)
  }
  assert.equal(titleOf('codeNotes.createFromThread'), 'Save Note')
})

test('every command the code registers is contributed, or internal by name here', () => {
  const internal = [
    'codeNotes.askStepUpdate', 'codeNotes.claudeLinkBack', 'codeNotes.codeLink', 'codeNotes.codeLinkBack',
    'codeNotes.nextCheckQuestion', 'codeNotes.openNoteId', 'codeNotes.openStepLink', 'codeNotes.podcastFollow',
    'codeNotes.link', 'codeNotes.concernFixed', 'codeNotes.addQuick', 'codeNotes.replyResolve', 'codeNotes.closeNoteBox',
    'codeNotes.notes.focus', 'codeNotes.journeys.focus', 'codeNotes.check.focus',
  ]
  assert.deepEqual(Object.values(HiddenCmd).sort(), [...internal].sort())
  const contributed = new Set(commands.map((x) => x.command))
  for (const id of internal) assert.ok(!contributed.has(id), `${id} is internal`)
})

test('the inbox actions that need no row are in the palette; Reload Notes is in the Notes view\'s … menu too', () => {
  const ids = ['markAllRead', 'resolveAll', 'deleteResolved', 'filter', 'refresh', 'copyAgentPrompt', 'nextUnread',
    'previousUnread', 'groupByFile', 'groupBySession', 'showResolved', 'hideResolved', 'showAllSessions']
  for (const id of ids.map((x) => `codeNotes.${x}`)) {
    assert.ok(titleOf(id), id)
    assert.ok(menu('commandPalette', id).every((m) => m.when !== 'false'), `${id} in the palette`)
  }
  assert.deepEqual(menu('view/title', 'codeNotes.refresh'), [{ command: 'codeNotes.refresh', when: 'view == codeNotes.notes', group: '3_reload@1' }])
  assert.equal(titleOf('codeNotes.refresh'), 'Reload Notes')
})

test('journey commands are in the palette only where there are journeys', () => {
  for (const id of ['refreshJourney', 'playPodcast', 'sortJourneys', 'toggleAnimation']) {
    assert.deepEqual(menu('commandPalette', `codeNotes.${id}`).map((m) => m.when), ['codeNotes.hasJourneys'], id)
  }
})

test('titles say what they do', () => {
  assert.equal(titleOf('codeNotes.showOnlySession'), 'Show Only This Session in Editor')
  assert.equal(titleOf('codeNotes.askQuestion'), 'Find or Write a Journey…')
  assert.equal(titleOf('codeNotes.askClaude'), 'Ask Claude')
})

test('the note bar: the setting says bar, and no unused background colour', () => {
  assert.equal(describe('codeNotes.highlight'), 'Show a bar beside lines with an open note.')
  assert.ok(!c.colors.some((x: { id: string }) => x.id === 'codeNotes.noteBackground'))
})

test('VS Code\'s comment height cap is left alone', () => {
  assert.ok(!('comments.maxHeight' in c.configurationDefaults))
})

test('model settings: one-line descriptions, the four models as suggestions; Claude: Mode reads as behaviour', () => {
  for (const key of ['codeNotes.claude.model', 'codeNotes.journeys.model', 'codeNotes.understanding.model']) {
    assert.deepEqual(settings[key].examples, ['sonnet', 'opus', 'haiku', 'fable'], key)
    assert.equal(settings[key].enum, undefined, `${key} still takes any model id`)
    assert.ok(describe(key).length <= 100, `${key}: ${describe(key)}`)
  }
  const mode = settings['codeNotes.claude.mode']
  assert.deepEqual(mode.enum, ['button', 'always', 'off'], 'stored values unchanged')
  assert.deepEqual(mode.enumItemLabels, ['When I ask', 'Every note', 'Never'])
  assert.ok(describe('codeNotes.claude.mode').length <= 100)
})

test('background questions: the description says where they run', () => {
  assert.equal(describe('codeNotes.understanding.background'), 'Writes the questions with Claude when a branch is pushed, in repositories that use the check.')
})

test('Ask Claude is a labelled button beside Reply on open notes; Stop has its own title slot', () => {
  const ask = menu('comments/commentThread/context', 'codeNotes.askClaude')
  assert.equal(ask.length, 1)
  assert.equal(ask[0].group, 'inline@2')
  for (const part of ['commentController == codeNotes', "config.codeNotes.claude.mode != 'off'", 'codeNotes.claudeFound', 'commentThread =~ /open/', '!(commentThread =~ /check/)']) {
    assert.ok(ask[0].when!.includes(part), part)
  }
  const title = menus['comments/commentThread/title']
  const stop = title.find((m) => m.command === 'codeNotes.cancelClaude')!
  assert.equal(stop.group, 'navigation@1')
  assert.ok(!title.some((m) => m.command !== stop.command && m.group === stop.group), 'nothing else in Stop\'s slot')
})

test('a check concern\'s actions are named buttons on its thread', () => {
  const want = { concernFix: 'Suggest a Fix', concernTodo: 'Add TODO', concernFlag: 'Flag for Reviewer', concernDismiss: 'Dismiss Concern' }
  for (const [name, title] of Object.entries(want)) {
    const id = `codeNotes.${name}`
    assert.equal(titleOf(id), title)
    const m = menu('comments/commentThread/context', id)
    assert.equal(m.length, 1, id)
    assert.match(m[0].when!, /commentThread =~ \/concern\//)
    assert.match(m[0].group!, /^inline@/)
    assert.deepEqual(menu('commandPalette', id).map((x) => x.when), ['false'], `${id} needs a thread`)
  }
})

test('the Check view is hidden on the default branch without a check', () => {
  assert.equal(c.views.codeNotes.find((v: { id: string }) => v.id === 'codeNotes.check').when, '!codeNotes.checkOnBase')
})

test('the docs the README links ship in the package', () => {
  for (const doc of ['docs/journey-format.md', 'docs/understanding-check.md', 'docs/agent-protocol.md']) {
    assert.ok(pkg.files.includes(doc), doc)
    assert.ok(fs.existsSync(path.join(__dirname, '../..', doc)), doc)
  }
})
