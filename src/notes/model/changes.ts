// What a change of the notes says: which notes, and what kind of change. Pure.

export type NotesChangeKind =
  /** The notes read again: the start, a reload, another notes folder. */
  | 'loaded'
  /** Note files changed on disk by someone else (their rules applied first: notes/changedOnDisk.ts). */
  | 'disk'
  /** Notes written by the extension. */
  | 'saved'
  /** Notes moved to the trash, or back. */
  | 'removed'
  /** Where notes are, or whether they are stale, changed in memory (re-anchored, moved). */
  | 'placed'
  /** Lines moved with an edit being typed: only what draws notes on lines follows (threads, the editor's marks);
   *  'placed' comes once the typing stops. */
  | 'edited'
  /** What the person has read. */
  | 'seen'
  /** The filter, the grouping, resolved notes or sessions shown or hidden. */
  | 'view'
  /** Claude or the understanding check at work on notes, done, or failed. */
  | 'activity'
  /** The journeys changed: questions asked from a step are listed and linked through them. */
  | 'journeys'
  /** A setting that changes how notes are shown. */
  | 'settings'
  /** Another branch checked out. */
  | 'branch'

export interface NotesChange {
  readonly kind: NotesChangeKind
  /** The notes that changed; none: any may have. */
  readonly ids?: readonly string[]
  /** A line the Code Notes view shows until the next change (a notes folder being read). */
  readonly notice?: string
}

/** Kinds after which every note's view is checked, ids or not (notes came, went, or something all of them show). */
const EVERY_NOTE: ReadonlySet<NotesChangeKind> = new Set(['loaded', 'disk', 'removed', 'view', 'journeys', 'settings', 'branch'])

/** Only an edit being typed: what doesn't draw lines (lists, badges, keys, the tour) waits for 'placed'. */
export const whileTyping = (c: NotesChange) => c.kind === 'edited'

/** Only the notes `c.ids` need a look (else all of them). */
export const onlyThese = (c: NotesChange): readonly string[] | undefined => (EVERY_NOTE.has(c.kind) ? undefined : c.ids)

/** Changes made during one batch as one: their notes together, the widest kind. */
export function mergeChanges(list: readonly NotesChange[]): NotesChange {
  // An edit being typed counts only when nothing else happened (the others are what every view follows).
  const settled = list.filter((c) => !whileTyping(c))
  const from = settled.length ? settled : list
  const kind = from.find((c) => EVERY_NOTE.has(c.kind))?.kind ?? from[from.length - 1].kind
  const ids = list.every((c) => c.ids) ? [...new Set(list.flatMap((c) => c.ids!))] : undefined
  const notice = [...list].reverse().find((c) => c.notice)?.notice
  return { kind, ...(ids ? { ids } : {}), ...(notice ? { notice } : {}) }
}
