// Was a selection a link from a chat with Claude Code? A guess from the selection alone. Pure: no vscode.
//
// Claude Code's VS Code extension opens such a link by showing the file and selecting its lines from the API: start
// line, column 0, to the end line, column 0 (a single line: the caret at its start). Up to VS Code 1.14x a selection
// set by an extension has no kind (unlike the keyboard, the mouse or a command); newer versions report Command (as
// for Go to Definition). A single line is taken only right after its editor came to the front: a caret put at a line
// start by another extension, in an editor already in front, is too common to light.

/** How VS Code reported the change: no kind, a command, or the keyboard or the mouse. */
export type SelectionKind = 'none' | 'command' | 'other'

export interface SelectionSeen {
  kind: SelectionKind
  /** One selection from column 0 to column 0. */
  shape: boolean
  /** It spans several lines. */
  lines: boolean
  /** Nothing selected: a caret. */
  caret: boolean
  /** Its editor came to the front just now. */
  fresh: boolean
  /** The extension itself is selecting (ownSelection). */
  ours: boolean
}

/** The selection looks like a chat link opening. */
export function isLinkSelection(s: SelectionSeen): boolean {
  if (!s.shape || s.ours) return false
  const oldVsCode = s.kind === 'none' && (s.lines || (s.caret && s.fresh))
  const newVsCode = s.kind === 'command' && s.lines && s.fresh
  return oldVsCode || newVsCode
}
