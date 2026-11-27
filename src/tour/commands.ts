// The tour's commands: opening a journey (its map, then its steps), finishing or ending a walk, the walk back after a
// reload, and the commands of the map and of a step link.

import * as vscode from 'vscode'
import { journeys, mapPanel } from './ports'
import { card, tourState, walk } from './instances'
import { log, stored } from '../platform/host'
import { prefixUsed } from '../platform/chordKey'
import { MAP_VIEW } from '../journeys/mapPanel'
import { journeyById, LoadedJourney } from '../journeys/steps'
import { markJourneysSeen } from '../notes/seen'
import { showIntro } from '../sidebar/journeyRows'
import { cardOnly, codeGetsMoreRoom, keepWidthOnFocus, noteLayout, panelFits, roomForMap } from './panelLayout'
import { pickJourney } from './pick'
import { fireAndForget } from '../platform/run'
import { STATE } from '../platform/state'
import { HiddenCmd } from '../platform/commands'
import { say } from './status'
import { AFTER_RESTORE_MS, CHECK_TOUR_READ_MS } from './timings'
import { numberOf, stepCount } from './walkMoves'

/**
 * Opening a journey walks it (no separate Start): its map, and the code with its card at step 1,
 * or where it was left (the step being walked, else the resume point). `keepFocus`: where the click was (the
 * Journeys list, the panel); see walkFromSidebar and walkFromPanel.
 */
export async function walkJourney(lj: LoadedJourney, opts: { fromStart?: boolean; keepFocus?: 'sidebar' | 'panel' } = {}): Promise<void> {
  if (opts.keepFocus === 'sidebar') return walkFromSidebar(lj, opts)
  if (opts.keepFocus === 'panel') return walkFromPanel(lj, opts)
  if (!opts.fromStart && isHere(lj)) {
    walk().showMap(lj)
    return
  }
  await openAndWalk(lj, opts)
}

/** From a Journeys row: the focus goes back to the list, so arrows and Enter never type into the code. */
async function walkFromSidebar(lj: LoadedJourney, opts: { fromStart?: boolean }): Promise<void> {
  // The journey you're in (its row, Open Journey… on it): its panel to the front, the walk and the podcast as they
  // are. Never closed or reopened, the layout untouched.
  if (!opts.fromStart && isHere(lj)) {
    if (!mapPanel().visible) walk().showMap(lj, true)
    await focusJourneyList()
    return
  }
  // The code is shown, but the focus is back where the click was.
  await openAndWalk(lj, opts, focusJourneyList)
}

/** From the panel (its list, its buttons): the focus stays in the panel when it is shown. */
async function walkFromPanel(lj: LoadedJourney, opts: { fromStart?: boolean }): Promise<void> {
  if (!opts.fromStart && isHere(lj)) {
    walk().showMap(lj)
    return
  }
  await openAndWalk(lj, opts, (room) => { if (room) mapPanel().takeFocus() })
}

/** The journey's map (when there is room) and its walk at the step it opens on, `focus` put back where the click was;
 *  then the code gets more room. */
async function openAndWalk(lj: LoadedJourney, opts: { fromStart?: boolean }, focus?: (room: boolean) => unknown): Promise<void> {
  // A journey without steps: its map only.
  if (!stepCount(lj)) {
    await openMap(lj)
    return
  }
  const room = await openMapIfRoom(lj)
  await walk().goToStep(lj, opts.fromStart ? 1 : walk().startStep(lj))
  await focus?.(room)
  if (room) await codeGetsMoreRoom()
}

/** The Journeys list takes the focus (it may not be there: nothing then). */
const focusJourneyList = () => vscode.commands.executeCommand(HiddenCmd.journeysFocus).then(undefined, () => undefined)

/** `lj` is the journey on screen: its panel is open and its walk (or its podcast) is going on. */
function isHere(lj: LoadedJourney): boolean {
  if (mapPanel().journey?.key !== lj.key) return false
  return (walk().touring() && tourState().key === lj.key) || walk().listening(lj)
}

/**
 * The journey's map, when there is room for it beside 80 columns of code; else the step card only. Decided before
 * anything opens (the panel never squeezes the code, not even for a moment), and only then: a panel that is open
 * stays (it shows this journey now), whatever its width. Returns whether the panel is shown.
 */
async function openMapIfRoom(lj: LoadedJourney): Promise<boolean> {
  const room = !!mapPanel().journey || (await panelFits())
  // A step opens next and takes the keyboard: the map doesn't take it first (a slow window gave it the map after).
  await openMap(lj, room, true)
  if (!room) cardOnly()
  return room
}

/**
 * Shows a journey's map (`show`: false when there is no room for it; `preserveFocus`: the keyboard stays where it is).
 * Another journey's tour ends first, keeping its place. Resolves once the map's group is known, so code shown next
 * goes beside it.
 */
export async function openMap(lj: LoadedJourney, show = true, preserveFocus = false): Promise<void> {
  // Another journey's map is only a look: the running tour goes on until Start there, or End.
  await markJourneysSeen(lj)
  if (showIntro()) await stored().set(STATE.journeyOpened, true)
  // One journey on screen at a time: another journey's map ends the running walk quietly (its place is kept
  // for Resume); its status item and code marker go with it.
  if (lj.key !== tourState().key && walk().touring()) await walk().end()
  if (lj.key !== tourState().key) walk().browse(lj)
  if (show) walk().showMap(lj, preserveFocus)
  walk().updateTour()
  if (show) await mapPanel().placed()
}

/** Finish on the last step (walk.finish). */
export const finishTour = (): Promise<void> => walk().finish()

export { closeWalkTabs } from './walkTabs'

/** Ends the tour: its place is kept (resume later), the card goes; the code stays open (walk.end). */
export const endJourney = (): Promise<void> => walk().end()

/** After a reload: the tour where it was. The map comes back by itself when it was open (serializer). */
export async function restoreTour(): Promise<void> {
  const lj = journeys().byPos(stored().get(STATE.tour))
  if (!lj) return
  const n = walk().resumeAt(lj) || 1
  if (!mapPanel().journey) walk().browse(lj)
  await walk().goToStep(lj, n, { focus: false })
  walk().wasRestored(lj)
}

/**
 * The map comes back after a reload: VS Code hands the old panel over once the journeys are read (call the function
 * returned then). A panel that can't come back (its journey is gone, or no room beside 80 columns of code) closes once
 * VS Code has put it in place: closed while VS Code was still restoring it, it left an empty editor group
 * ("OverlayWebview has been disposed").
 */
export function restoreMapPanel(context: vscode.ExtensionContext): () => void {
  // The panel's layout is the tour's to keep (panelLayout.ts): the panel says when it changed or got the focus.
  mapPanel().layoutChanged = () => fireAndForget(noteLayout(), 'commands: noteLayout')
  mapPanel().activated = () => fireAndForget(keepWidthOnFocus(), 'commands: keepWidthOnFocus')
  const journeysRead = new Signal()
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(MAP_VIEW, {
    deserializeWebviewPanel: (panel, st) => restorePanel(panel, st as PanelState | undefined, journeysRead.done),
  }))
  return () => journeysRead.fire()
}

/** Something that happens once (the journeys read): `done` resolves then. */
class Signal {
  private resolve: () => void = () => undefined
  readonly done = new Promise<void>((r) => { this.resolve = r })
  fire(): void { this.resolve() }
}

/** What a map panel keeps over a reload (media/journey-map.js setState). */
type PanelState = { q?: string; cur?: number; n?: number }

/**
 * A map panel VS Code restored, drawn once `ready` (the journeys read). Closed meanwhile (VS Code still loading),
 * it is left alone: nothing is drawn in it, and nothing here throws (the extension's activation waits on this).
 */
export async function restorePanel(panel: vscode.WebviewPanel, st: PanelState | undefined, ready: Promise<void>): Promise<void> {
  let closed = false
  const sub = panel.onDidDispose(() => { closed = true })
  try {
    mapPanel().placeholder(panel, st)
    await ready
    const lj = await mapJourneyRead()
    if (closed) {
      log().info('journey panel: closed while it was restored')
      return
    }
    const afterRestore = (f: () => void) => setTimeout(f, AFTER_RESTORE_MS)
    if (!lj) {
      log().info('journey panel: its journey is gone; closed after the reload')
      afterRestore(() => panel.dispose())
      return
    }
    if (!tourState().key) walk().browse(lj)
    mapPanel().adopt(panel, lj)
    walk().updateTour()
    afterRestore(() => fireAndForget(codeGetsMoreRoom(), 'commands: codeGetsMoreRoom'))
  } catch (e) {
    log().warn(`journey panel: not restored (${e instanceof Error ? e.message : e})`)
  } finally {
    sub.dispose()
  }
}

/** The journey last shown on the map, once it has been read (undefined: it is gone). A check's tour is read with its
 *  check, a moment after the journeys: the journeys' next changes are waited for, up to CHECK_TOUR_READ_MS. */
function mapJourneyRead(): Promise<LoadedJourney | undefined> {
  const find = () => journeys().byPos(stored().get(STATE.mapJourney))
  const now = find()
  if (now) return Promise.resolve(now)
  return new Promise((resolve) => {
    const done = (lj: LoadedJourney | undefined) => {
      clearTimeout(timer)
      sub.dispose()
      resolve(lj)
    }
    const sub = journeys().onDidChange(() => { const lj = find(); if (lj) done(lj) })
    const timer = setTimeout(() => done(find()), CHECK_TOUR_READ_MS)
  })
}

/**
 * Open Journey…: always the picker; from a sidebar row, that journey.
 * From a sidebar row (an argument): the focus stays in the list, so arrows and Enter never type into the code.
 */
export async function openJourney(arg?: unknown): Promise<void> {
  const lj = await pickJourney(arg)
  if (lj) await walkJourney(lj, arg !== undefined ? { keepFocus: 'sidebar' } : {})
}

/** Show Map (the V chord): the tour's or the last journey's map; the picker when there is none. */
export async function showMap(a?: unknown): Promise<void> {
  prefixUsed(a)
  const lj = walk().tourJourney() ?? journeys().byPos(stored().get(STATE.mapJourney)) ?? (await pickJourney())
  if (lj) await openMap(lj)
  // "The map" means the map: an animation showing in its place goes, and a panel too narrow for the boxes gets the
  // room for them (asked for, so the layout may change).
  mapPanel().send({ type: 'anim', action: 'off' })
  if (lj) await roomForMap()
}

/** Start Journey: a journey (the argument, else the one whose map is open, else picked) from step 1. */
export async function startJourney(arg?: unknown): Promise<void> {
  const lj = await pickJourney(arg ?? tourState().key)
  if (lj) await walk().goToStep(lj, 1)
}

/**
 * A note asked from a step, or a step lens: to that step (by id; by number when its id is gone). The journey is the
 * one in `folder`, the workspace folder the link came from (else the active editor's): ids are unique per folder only.
 */
export async function openStepLink(id: string, stepId: string, n: number, folder?: string): Promise<void> {
  const from = folder ?? activeFolder()
  const lj = journeyById(journeys().list.values(), id, from)
  if (!lj) {
    say('$(info) That journey is gone', 'done')
    return
  }
  await openMapIfRoom(lj)
  await walk().goToStep(lj, numberOf(lj, stepId) || n)
}

/** The workspace folder of the active editor's file (its uri), if any. */
function activeFolder(): string | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri
  return uri && vscode.workspace.getWorkspaceFolder(uri)?.uri.toString()
}

/** From a reference's "← Back to step n": the step again (its file, card and lines). */
export async function backToStep(): Promise<void> {
  const lj = walk().tourJourney()
  if (lj && tourState().step) await walk().goToStep(lj, tourState().step)
}

/** More / Less on the step card (`open`: which; none: the other). */
export const stepDetails = (open?: boolean) => walk().showDetails(open)
