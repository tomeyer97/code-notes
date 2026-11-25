import test from 'node:test'
import assert from 'node:assert/strict'
import { isLinkSelection, SelectionSeen } from '../src/codeLinks/chatLinkGuess'

/** Claude Code opening a link to several lines: whole lines, column 0 to column 0, not the extension's own. */
const seen = (o: Partial<SelectionSeen>): SelectionSeen => ({ kind: 'none', shape: true, lines: true, caret: false, fresh: false, ours: false, ...o })

test('a chat link on VS Code up to 1.14x (no kind): several whole lines, or a caret in an editor just come to the front', () => {
  assert.ok(isLinkSelection(seen({})), 'several lines, editor already in front')
  assert.ok(isLinkSelection(seen({ lines: false, caret: true, fresh: true })), 'one line, editor just in front')
  assert.ok(!isLinkSelection(seen({ lines: false, caret: true, fresh: false })), 'a caret at a line start in an editor in front: too common')
})

test('a chat link on newer VS Code (Command): only several lines of an editor just come to the front', () => {
  assert.ok(isLinkSelection(seen({ kind: 'command', fresh: true })))
  assert.ok(!isLinkSelection(seen({ kind: 'command', fresh: false })), 'whole lines in the editor in front: a command, not a link')
  assert.ok(!isLinkSelection(seen({ kind: 'command', lines: false, caret: true, fresh: true })), 'a single line is Go to Definition')
})

test('never a link: the keyboard or the mouse, another shape, or the extension selecting', () => {
  assert.ok(!isLinkSelection(seen({ kind: 'other', fresh: true })))
  assert.ok(!isLinkSelection(seen({ shape: false })), 'not column 0 to column 0')
  assert.ok(!isLinkSelection(seen({ ours: true })), 'the extension\'s own selection (ownSelection)')
})
