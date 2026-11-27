// What a step change does to the journey panel when the code beside it has under 80 columns (pure: unit-tested in
// test/layout.test.ts). The README promises the walk never leaves the code that narrow: the panel shrinks to the share
// that leaves the code its columns, or, with no such share, the walk goes on with the step card alone.

/** Keep the layout, set the panel to this share of the editor area, or close the panel (the step card alone). */
export type CodeRoomMove = 'keep' | 'cardOnly' | { share: number }

export interface CodeRoomInput {
  /** The code group's width (px). */
  codePx: number
  /** What 80 columns of code need (px: core/panelWidth codeWidth). */
  needPx: number
  /** The panel's share that leaves the code its columns (core/panelWidth panelShare; 0: none does). */
  share: number
  /** The reader chose this layout (asked for the map's room): it is theirs to keep. */
  readerChose: boolean
}

/** A pixel or two under is rounding, not a squeezed editor. */
const SLACK_PX = 2

export function codeRoomMove(i: CodeRoomInput): CodeRoomMove {
  if (i.readerChose || i.codePx + SLACK_PX >= i.needPx) return 'keep'
  return i.share > 0 ? { share: i.share } : 'cardOnly'
}
