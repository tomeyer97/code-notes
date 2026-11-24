// The notes the person picked: the rows selected in the Code Notes view (two or more are what bulk actions work on)
// and the note just opened. Pure.

export class NotesSelection {
  /** Note ids ticked for bulk actions: the note rows selected, when there are 2 or more. */
  readonly checked = new Set<string>()
  /** The note rows selected in the Code Notes view, however many (ids). */
  selected: readonly string[] = []
  /** The note the person just opened: its thread shows even when resolved, filtered out or in a hidden session. */
  revealed: string | undefined

  /** The rows selected in the view now. */
  select(ids: readonly string[]): void {
    this.selected = ids
    this.checked.clear()
    if (ids.length > 1) for (const id of ids) this.checked.add(id)
  }

  /** Ticks `keep` rejects (a note gone, or no longer listed) are dropped: no invisible ticks. */
  prune(keep: (id: string) => boolean): void {
    for (const id of [...this.checked]) if (!keep(id)) this.checked.delete(id)
  }
}
