// The walk in the status bar: its one item ("3/14", click = the map) and its short messages.
import * as vscode from 'vscode'
import type { LoadedJourney } from '../journeys/steps'
import { SAY_MS, SayKind } from './timings'
import { stepCount } from './walkMoves'

/** A status bar message for as long as its kind says (timings.ts SAY_MS). */
export function say(text: string, kind: SayKind): vscode.Disposable {
  return vscode.window.setStatusBarMessage(text, SAY_MS[kind])
}

/** Only while a tour runs, and one item: "3/14", click = the map; ‹ › × live on the map and the card. None while its
 *  journey is listened to (the podcast's item is the one then: src/podcast/player.ts). */
export class TourStatusItem {
  /** The walk's items (instances.ts TourItems): ‹ step › ×. */
  constructor(private readonly items: Record<'prev' | 'pos' | 'next' | 'end', vscode.StatusBarItem>) {}

  render(lj: LoadedJourney | undefined, step: number, listening: boolean): void {
    const { items } = this
    if (!lj || !step || listening) {
      for (const i of Object.values(items)) i.hide()
      return
    }
    // The journey's name is the map tab's title; a one-line tooltip.
    const total = stepCount(lj)
    items.pos.text = `$(map) ${step}/${total}`
    items.pos.accessibilityInformation = { label: `${lj.j.title}, step ${step} of ${total}. Opens the map.` }
    items.pos.tooltip = `${lj.j.title}: open the map`
    items.pos.show()
    items.prev.hide()
    items.next.hide()
    items.end.hide()
  }
}
