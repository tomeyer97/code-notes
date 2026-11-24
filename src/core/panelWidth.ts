// How wide the journey panel opens beside the code (pure: unit-tested in test/layout.test.ts). The code keeps 80
// visible columns; the panel takes at most 40 % unless the reader made it wider; too little room left: no panel (the
// step card in the editor is enough to walk).

/**
 * What the width model below was tuned to: measured in VS Code at 14 px, an editor this wide (gutter 83 px, the
 * minimap on) showed this many columns. The constants under it are guesses that reproduce it.
 */
export const MEASURED_EDITOR = { fontSize: 14, widthPx: 733, gutterPx: 83, columns: 66 } as const

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
export const DEFAULT_SHARE = 0.35
export const MAX_SHARE = 0.4
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

/** The reader's remembered share, when it is a plausible one. */
function validRemembered(remembered: number | undefined): number | undefined {
  return remembered && remembered > MIN_REMEMBERED && remembered < MAX_REMEMBERED ? remembered : undefined
}

/** A share rounded to a thousandth (the share is stored and compared). */
const thousandth = (share: number) => Math.round(share * 1000) / 1000

/** The panel's share of an editor area `total` px wide; 0: no room for it. */
export function panelShare(total: number, o: ShareOptions): number {
  const need = codeWidth(o.minChars ?? 80, o.fontSize, o.minimap ?? true)
  // Any remembered share counts as the reader's choice (even an implausible one: then the default, uncapped).
  const want = validRemembered(o.remembered) ?? DEFAULT_SHARE
  const cap = o.remembered ? want : Math.min(want, MAX_SHARE)
  const roomLeft = (total - need) / total
  const share = Math.min(cap, roomLeft)
  return total * share < (o.panelMin ?? PANEL_MIN_PX) ? 0 : thousandth(share)
}

/** While an episode plays, the panel holds the step's animation and the player: this wide (px), the code the rest. */
export const LISTENING_MIN_PX = 360
export const LISTENING_MAX_PX = 420
export const LISTENING_SHARE = 0.3

/** The panel's share of an editor area `total` px wide while an episode is on: 360–420 px (30 % of the area in
 *  between), never more than half of it. */
export function listeningShare(total: number): number {
  if (total <= 0) return 0
  const px = Math.min(LISTENING_MAX_PX, Math.max(LISTENING_MIN_PX, total * LISTENING_SHARE), total / 2)
  return thousandth(px / total)
}

// The editor groups as `vscode.getEditorLayout` reports them, and what the journey panel's layout code asks of them.

/** An editor layout: groups side by side (orientation 0) or above each other (1), each maybe split again. */
export interface EditorLayout { orientation: number; groups: EditorLayoutGroup[] }
export interface EditorLayoutGroup { size?: number; groups?: EditorLayoutGroup[] }

/** One row of groups side by side, none of them split. */
export const isFlatRow = (l: EditorLayout): boolean => l.orientation === 0 && !l.groups.some((g) => g.groups?.length)

/** The groups' widths (px; 0 when VS Code gives none). */
export const groupWidths = (l: EditorLayout): number[] => l.groups.map((g) => g.size ?? 0)

/** The widest group other than `i` (-1: there is none). */
export function widestOther(sizes: number[], i: number): number {
  let best = -1
  for (let k = 0; k < sizes.length; k++) {
    if (k !== i && (best < 0 || sizes[k] > sizes[best])) best = k
  }
  return best
}

/** Widths (px) as the shares `vscode.setEditorLayout` takes, side by side. */
export function layoutOfWidths(sizes: number[]): EditorLayout {
  const total = sizes.reduce((x, y) => x + y, 0)
  return { orientation: 0, groups: sizes.map((w) => ({ size: w / total })) }
}

/** VS Code's minimum width of an editor group (px). A group activated while exactly this wide is expanded by VS Code
 *  to an even share of the editor area (EditorPart doRestoreGroup): focusing a panel dragged or squeezed to its
 *  minimum (Ctrl+3, a click in it, ‹ Journeys, a row of the Journeys view) flipped it from ~220 to ~580 px mid-episode. */
export const GROUP_MIN_PX = 220
/** A panel grown by more than this (px) on being activated was grown by VS Code, not dragged. */
export const EXPANDED_PX = 100

/** Group `i` was at VS Code's minimum in `before` and is much wider `now`: VS Code expanded it on focus. */
export function expandedOnFocus(before: number[] | undefined, now: number[], i: number): before is number[] {
  return !!before && before.length === now.length && before[i] <= GROUP_MIN_PX + 0.5 && now[i] > before[i] + EXPANDED_PX
}

/** Group `i` grew by more than VS Code's expansion since `known` (the widths before it count). */
export function grownSince(known: number[] | undefined, now: number[], i: number): known is number[] {
  return !!known && known.length === now.length && now[i] > known[i] + EXPANDED_PX
}

/** The panel needs this many px for its map's boxes (journey-splitter.js MAPMIN, with the panel's padding). */
export const MAP_ROOM_PX = 300

/** Widths with group `i` given room for the map (MAP_ROOM_PX), taken from the widest other group, which keeps as much
 *  itself; undefined: it has the room, or none can be given. */
export function withRoomForMap(sizes: number[], i: number): number[] | undefined {
  if (i < 0 || i >= sizes.length || sizes[i] >= MAP_ROOM_PX) return undefined
  const from = widestOther(sizes, i)
  if (from < 0) return undefined
  const give = Math.min(MAP_ROOM_PX - sizes[i], sizes[from] - MAP_ROOM_PX)
  if (give <= 0) return undefined
  const out = [...sizes]
  out[i] += give
  out[from] -= give
  return out
}
