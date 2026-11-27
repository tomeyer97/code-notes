import type * as vscode from 'vscode'
import { parseJourney } from '../core/format/journeyModel'
import { LoadedJourney, carryPositions, writtenAt } from './steps'

// The understanding checks' tours: each check file's `journey`, walked like a journey file but never listed with them.
// Their own registry, so the journey files' list holds journey files only; their steps are found by the same step
// locator. A tour stays across a reload of the journey folders.

export interface CheckToursPorts {
  /** Finds the tour's steps in the code (the step locator's `locate`). */
  locate(lj: LoadedJourney): Promise<unknown>
  /** A tour came, changed or went. */
  changed(): void
  log: Pick<vscode.LogOutputChannel, 'warn'>
}

/** The key a check file's tour is kept (and found) by. */
export const tourKey = (checkFile: vscode.Uri) => `${checkFile.toString()}#tour`

/** Per branch, so where a tour was left is kept per branch. */
const tourId = (branch: string) => `check-${branch.replace(/[^\w.-]+/g, '-')}`

export class CheckTours {
  /** By tourKey: each tour and the text it was made from (the same text again changes nothing). */
  private readonly tours = new Map<string, { lj: LoadedJourney; text: string }>()

  constructor(private readonly ports: CheckToursPorts) {}

  get(key: string): LoadedJourney | undefined { return this.tours.get(key)?.lj }
  *values(): IterableIterator<LoadedJourney> { for (const t of this.tours.values()) yield t.lj }
  /** A read-only view, by tourKey. */
  get listed(): ReadonlyMap<string, LoadedJourney> { return new Map([...this.tours].map(([k, t]) => [k, t.lj])) }

  /**
   * The tour of the check in `uri` (its `journey`); undefined removes it. Returns it (unchanged when the same tour is
   * set again).
   */
  async set(folder: vscode.WorkspaceFolder, uri: vscode.Uri, raw: unknown, branch: string): Promise<LoadedJourney | undefined> {
    const key = tourKey(uri)
    const prev = this.tours.get(key)
    if (!raw) {
      this.drop(key)
      return undefined
    }
    const text = JSON.stringify(raw)
    if (prev && prev.text === text && prev.lj.check?.branch === branch) return prev.lj
    const parsed = parseJourney(text, 'tour')
    if (!parsed.ok) {
      this.ports.log.warn(`check tour in ${uri.fsPath}: not shown: ${parsed.why}`)
      this.drop(key)
      return undefined
    }
    const j = { ...parsed.value, id: tourId(branch) }
    const lj: LoadedJourney = { key, folder, uri, j, at: writtenAt(j), check: { branch } }
    if (prev) carryPositions(prev.lj, lj)
    this.tours.set(key, { lj, text })
    await this.ports.locate(lj)
    this.ports.changed()
    return lj
  }

  private drop(key: string): void {
    if (!this.tours.delete(key)) return
    this.ports.changed()
  }
}
