// How wide the journey panel opens beside the code (pure: unit-tested in test/layout.test.ts). The code keeps 80
// visible columns; the panel takes at most 40 % unless the reader made it wider; too little room left: no panel (the
// step card in the editor is enough to walk).

/** A character's width, as a share of the font size (a monospace font). */
const CHAR_WIDTH_EM = 0.6
/** The gutter: line numbers (about 5 characters) and the glyph, comment and folding margins (px). */
const GUTTER_CHARS = 5
const GUTTER_MARGINS_PX = 40
/** The vertical scrollbar (px). */
const SCROLLBAR_PX = 14
/** The minimap's own margin (px). */
const MINIMAP_MARGIN_PX = 8
/** The panel's share when the reader set none (and the most it takes unless they made it wider). */
const DEFAULT_SHARE = 0.35
const MAX_SHARE = 0.4
/** A remembered share outside these is a mistake (a panel dragged shut or over everything): the default is used. */
const MIN_REMEMBERED = 0.1
const MAX_REMEMBERED = 0.9
/** Below this the panel is not worth opening (px). */
const PANEL_MIN_PX = 260

export interface ShareOptions {
  /** The reader's last width for the panel, as a share of the editor area. */
  remembered?: number
  /** The editor's font size (px). */
  fontSize: number
  /** The minimap is on (`editor.minimap.enabled`, the default). */
  minimap?: boolean
  minChars?: number
  /** Below this the panel is not worth opening (px). */
  panelMin?: number
}

/**
 * The width of an editor (px) that shows `chars` columns of code: the gutter (line numbers, the comment and folding
 * margins), the text, the vertical scrollbar and the minimap. VS Code gives the minimap about one pixel per character
 * of the width left after the gutter (a ninth of it at 14 px), so it grows with the editor.
 */
export function codeWidth(chars: number, fontSize: number, minimap = true): number {
  const cw = fontSize * CHAR_WIDTH_EM
  const gutter = GUTTER_CHARS * cw + GUTTER_MARGINS_PX
  const text = chars * cw + SCROLLBAR_PX
  // The minimap: about one pixel per character of `text`.
  return gutter + (minimap ? (text * (cw + 1)) / cw + MINIMAP_MARGIN_PX : text)
}

/** The panel's share of an editor area `total` px wide; 0: no room for it. */
export function panelShare(total: number, o: ShareOptions): number {
  const need = codeWidth(o.minChars ?? 80, o.fontSize, o.minimap ?? true)
  const want = o.remembered && o.remembered > MIN_REMEMBERED && o.remembered < MAX_REMEMBERED ? o.remembered : DEFAULT_SHARE
  const share = Math.min(o.remembered ? want : Math.min(want, MAX_SHARE), (total - need) / total)
  // Rounded to a thousandth (the share is stored and compared).
  return total * share < (o.panelMin ?? PANEL_MIN_PX) ? 0 : Math.round(share * 1000) / 1000
}

/** While an episode plays, the panel holds the step's animation and the player: this wide (px), the code the rest. */
const LISTENING_MIN_PX = 360
const LISTENING_MAX_PX = 420
const LISTENING_SHARE = 0.3

/** The panel's share of an editor area `total` px wide while an episode is on: 360–420 px (30 % of the area in
 *  between), never more than half of it. */
export function listeningShare(total: number): number {
  if (total <= 0) return 0
  const px = Math.min(LISTENING_MAX_PX, Math.max(LISTENING_MIN_PX, total * LISTENING_SHARE), total / 2)
  return Math.round((px / total) * 1000) / 1000
}
