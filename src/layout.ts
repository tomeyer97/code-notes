// How wide the journey panel opens beside the code (pure: unit-tested in test/layout.test.ts). The code keeps about
// 80 characters; the panel takes at most 40 % unless the reader made it wider; too little room left: no panel (the
// step card in the editor is enough to walk).

export interface ShareOptions {
  /** The reader's last width for the panel, as a share of the editor area. */
  remembered?: number
  /** The editor's font size (px). */
  fontSize: number
  minChars?: number
  /** Below this the panel is not worth opening (px). */
  panelMin?: number
}

/** The panel's share of an editor area `total` px wide; 0: no room for it. */
export function panelShare(total: number, o: ShareOptions): number {
  const need = (o.minChars ?? 80) * o.fontSize * 0.6 + 60 // the text, plus the gutter
  const want = o.remembered && o.remembered > 0.1 && o.remembered < 0.9 ? o.remembered : 0.35
  const share = Math.min(o.remembered ? want : Math.min(want, 0.4), (total - need) / total)
  return total * share < (o.panelMin ?? 260) ? 0 : Math.round(share * 1000) / 1000
}
