// Where a step's card and code are: its file, the line its inline card hangs under, and where the journey file put it.
// Imported by the walk, the card, refs and links; kept apart from card.ts, which only instances.ts loads (see there).

import * as vscode from 'vscode'
import { fileOf, LoadedJourney } from '../journeys/steps'

/** Where the step's card goes: its file. */
export function stepUri(lj: LoadedJourney, n: number): vscode.Uri {
  const f = fileOf(lj, n)
  return vscode.Uri.joinPath(lj.folder.uri, f)
}

/**
 * The 0-based line the inline card hangs under (VS Code draws a thread under its line): the line right before the
 * step's first line, always (you read the card, then the code; above a doc comment it left the code at the
 * bottom edge). A step on line 1 has its card under that line.
 */
export function cardLine(lj: LoadedJourney, n: number): number {
  const at = lj.at[n - 1]
  if (at.removed) return 0
  return Math.max(0, at.start - 2)
}

/** Where the journey file puts step n (a change there is the agent re-anchoring it). */
export function wroteAt(lj: LoadedJourney, n: number): string {
  const s = lj.j.steps[n - 1]
  return `${s.file}:${s.range.start}-${s.range.end}`
}
