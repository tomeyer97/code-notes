// How wide the journey panel opens beside the code (pure: unit-tested in test/layout.test.ts). The code keeps 80
// visible columns; the panel takes at most 40 % unless the reader made it wider; too little room left: no panel (the
// step card in the editor is enough to walk).

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
  const cw = fontSize * 0.6
  const gutter = 5 * cw + 40
  const text = chars * cw + 14
  return gutter + (minimap ? (text * (cw + 1)) / cw + 8 : text)
}

/** The panel's share of an editor area `total` px wide; 0: no room for it. */
export function panelShare(total: number, o: ShareOptions): number {
  const need = codeWidth(o.minChars ?? 80, o.fontSize, o.minimap ?? true)
  const want = o.remembered && o.remembered > 0.1 && o.remembered < 0.9 ? o.remembered : 0.35
  const share = Math.min(o.remembered ? want : Math.min(want, 0.4), (total - need) / total)
  return total * share < (o.panelMin ?? 260) ? 0 : Math.round(share * 1000) / 1000
}
