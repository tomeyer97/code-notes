// Where a note's code is, beyond what its file says ("stale", saved with it): its file is not there, or its lines start
// past the end of its file. One state per note, so a note is never both. (A note FILE that can't be read is the
// store's: Store.broken.) Pure.

export type Placed =
  /** The code file or folder is not there (deleted or moved). */
  | { kind: 'missing' }
  /** The note's lines start past the end of its file, which has `lines` lines. */
  | { kind: 'pastEnd'; lines: number }

export class Placement {
  private readonly state = new Map<string, Placed>()

  missing(id: string): boolean { return this.state.get(id)?.kind === 'missing' }

  /** The file's line count when the note's lines start past its end. */
  pastEnd(id: string): number | undefined {
    const p = this.state.get(id)
    return p?.kind === 'pastEnd' ? p.lines : undefined
  }

  setMissing(id: string): void { this.state.set(id, { kind: 'missing' }) }
  setPastEnd(id: string, lines: number): void { this.state.set(id, { kind: 'pastEnd', lines }) }

  /** Its file is there (and its lines in it, unless `keepPastEnd`). */
  found(id: string, keepPastEnd = false): void {
    if (keepPastEnd && this.state.get(id)?.kind === 'pastEnd') return
    this.state.delete(id)
  }
}
