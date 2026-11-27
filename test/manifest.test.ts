// What package.json contributes, checked where it can drift by hand: command titles in one style, every command either
// in the palette on purpose or hidden from it, and every setting that picks what runs listed for Restricted Mode.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'

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
  'codeNotes.toggleAnimation',
  'codeNotes.playPodcast',
  'codeNotes.checkUnderstanding',
  'codeNotes.searchJourneys',
  'codeNotes.sortJourneys',
  'codeNotes.refreshJourney',
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
  commentThread: ['asking', 'check', 'open', 'resolved', 'stepAsk'],
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
