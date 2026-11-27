// The chord scheme, as data: package.json's contributes.keybindings is generated from it (every chord on both prefixes,
// with Ctrl released or still held for the second key). After editing: node scripts/keymap.mjs --write
// test/keybindings.test.ts fails while package.json is not up to date with this table.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The second key of a chord -> the command it runs. */
export const CHORDS = {
  c: 'codeNotes.add',
  r: 'codeNotes.resolveNext',
  d: 'codeNotes.next',
  a: 'codeNotes.previous',
  v: 'codeNotes.showMap',
  p: 'codeNotes.toggleAnimation',
  j: 'codeNotes.searchJourneys',
  // Listening (the journey podcast): play / pause, back and forward 15 s, previous and next step (src/podcast/player.ts).
  space: 'codeNotes.podcastToggle',
  left: 'codeNotes.podcastBack',
  right: 'codeNotes.podcastForward',
  'shift+left': 'codeNotes.podcastPrevStep',
  'shift+right': 'codeNotes.podcastNextStep',
}

/** The two prefixes: Ctrl+< by scan code (the ISO key, whatever the layout) and Ctrl+'; `arg` tells the command which. */
export const PREFIXES = [{ key: 'ctrl+[IntlBackslash]', arg: '<' }, { key: "ctrl+'", arg: "'" }]

/** Bindings outside the chord scheme. */
export const OTHERS = [
  { command: 'codeNotes.cancelMove', key: 'escape', when: 'codeNotes.moving && editorTextFocus && !suggestWidgetVisible && !findWidgetVisible' },
  // Moving a note: Enter puts it on the selected lines (the status bar item says so).
  { command: 'codeNotes.moveToSelection', key: 'enter', when: 'codeNotes.moving && editorTextFocus && !suggestWidgetVisible' },
  // Esc in an empty new note box closes it and keeps the draft.
  { command: 'codeNotes.closeNoteBox', key: 'escape', when: 'commentEditorFocused && commentController == codeNotes && commentThreadIsEmpty' },
  // Esc puts away a controller's explanation beside the code (the bridge), unless the editor has its own use for it.
  { command: 'codeNotes.dismissExplanation', key: 'escape', when: 'codeNotes.explanationShown && editorTextFocus && !suggestWidgetVisible && !findWidgetVisible && !inSnippetMode && !codeNotes.moving' },
]

/**
 * The keybindings as package.json lists them. A chord has no `when` (always consumed: it never types into the code).
 * The plain chord comes last for each command: VS Code shows a command's last binding ("Ctrl+' D").
 */
export function keybindings() {
  const chords = PREFIXES.flatMap((p) => Object.entries(CHORDS).flatMap(([k, command]) =>
    [`ctrl+${k}`, k].map((second) => ({ command, key: `${p.key} ${second}`, args: { prefix: p.arg } }))))
  return [...chords, ...OTHERS]
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href && process.argv.includes('--write')) {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
  pkg.contributes.keybindings = keybindings()
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
}
