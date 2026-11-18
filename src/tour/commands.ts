// The tour's commands: opening a journey (its map, then its steps), finishing or ending a walk, the walk back after a
// reload, and the commands of the map and of a step link.

import * as vscode from 'vscode'
import { beats, codeLinks, gstate, journeys, log, mapPanel, state, valueHints } from '../app'
import { prefixUsed } from '../chords'
import { MAP_VIEW } from '../journeys/mapPanel'
import { fileOf, journeyById, LoadedJourney, posKey } from '../journeys/steps'
import { markJourneysSeen } from '../seen'
import { INTRO_KEY, showIntro } from '../sidebar/journeyRows'
import { tree } from '../sidebar/notesTree'
import { cardOnly, codeGetsMoreRoom, panelFits } from './panelLayout'
import { pickJourney } from './pick'
import { card, tourState, walk } from './instances'
import { MAP_KEY, POS_KEY, TOUR_KEY } from './state'

/**
 * Opening a journey walks it (no separate Start): its map, and the code with its card at step 1,
 * or where it was left (the step being walked, else the resume point).
 */
export async function walkJourney(lj: LoadedJourney, opts: { fromStart?: boolean; keepFocus?: 'sidebar' | 'panel' } = {}): Promise<void> {
  // A journey without steps: its map only.
  if (!lj.j.steps.length) {
    await openMap(lj)
    return
  }
  const room = await openMapIfRoom(lj)
  await walk.goToStep(lj, opts.fromStart ? 1 : walk.startStep(lj))
  // Back where the click was: the code is shown, but arrows and Enter never type into it.
  if (opts.keepFocus === 'sidebar') await vscode.commands.executeCommand('codeNotes.journeys.focus').then(undefined, () => undefined)
  else if (opts.keepFocus === 'panel' && room) mapPanel.takeFocus()
  if (room) await codeGetsMoreRoom()
}

/**
 * The journey's map, when there is room for it beside 80 columns of code; else the step card only. Decided before
 * anything opens (the panel never squeezes the code, not even for a moment). Returns whether there was room.
 */
async function openMapIfRoom(lj: LoadedJourney): Promise<boolean> {
  const room = await panelFits()
  await openMap(lj, room)
  if (!room) cardOnly()
  return room
}

/** Shows a journey's map (`show`: false when there is no room for it). Another journey's tour ends first, keeping its place. */
export async function openMap(lj: LoadedJourney, show = true): Promise<void> {
  // Another journey's map is only a look: the running tour goes on until Start there, or End.
  await markJourneysSeen(lj)
  if (showIntro()) await gstate.update(INTRO_KEY, true)
  // One journey on screen at a time: another journey's map ends the running walk quietly (its place is kept
  // for Resume); its status item and code marker go with it.
  if (lj.key !== tourState.key && walk.touring()) await endJourney()
  if (lj.key !== tourState.key) { tourState.key = lj.key; tourState.step = 0 }
  if (show) walk.showMap(lj)
  walk.updateTour()
  tree.refresh()
}

/**
 * Finish on the last step: the walk ends and starts over next time; the step tab it opened closes, so the map
 * gets its width back. No message.
 */
export async function finishTour(): Promise<void> {
  const lj = walk.tourJourney()
  const doc = tourState.doc
  await endJourney()
  if (!lj) return
  await state.update(POS_KEY, Object.fromEntries(Object.entries(walk.positions()).filter(([k]) => k !== posKey(lj))))
  // Only the walk's own preview tab (not one you kept open or edited).
  const tabs = doc ? walkPreviewTabs(lj, doc.column) : []
  if (tabs.length) await vscode.window.tabGroups.close(tabs, true)
  tourState.finishedKey = lj.key
  // The panel says Done when it is open or has the room; else the status bar says it.
  if (mapPanel.journey || (await panelFits())) walk.showMap(lj)
  else vscode.window.setStatusBarMessage('$(check) Journey finished', 3000)
  walk.updateTour()
  tree.refresh()
}

/** Preview tabs in `column` showing one of the journey's step files, not edited. */
function walkPreviewTabs(lj: LoadedJourney, column: vscode.ViewColumn): vscode.Tab[] {
  const stepFiles = new Set(lj.j.steps.map((s) => vscode.Uri.joinPath(lj.folder.uri, fileOf(lj, s.n)).toString()))
  return vscode.window.tabGroups.all.filter((g) => g.viewColumn === column).flatMap((g) => g.tabs)
    .filter((t) => t.isPreview && !t.isDirty && t.input instanceof vscode.TabInputText && stepFiles.has(t.input.uri.toString()))
}

/** Ends the tour: its place is kept (resume later), the card goes; the code stays open. */
export async function endJourney(): Promise<void> {
  const lj = walk.tourJourney()
  if (lj && tourState.step) await walk.savePos(lj, tourState.step)
  await state.update(TOUR_KEY, undefined)
  // The code you were reading stays open: you probably ended the tour to keep reading there.
  tourState.doc = undefined
  codeLinks.clear()
  valueHints.clear()
  beats.clear()
  tourState.step = 0
  card.clear()
  walk.updateTour()
  tree.refresh()
}

/** After a reload: the tour where it was. The map comes back by itself when it was open (serializer). */
export async function restoreTour(): Promise<void> {
  const lj = journeys.byPos(state.get<string>(TOUR_KEY))
  if (!lj) return
  const n = walk.resumeAt(lj) || 1
  if (!mapPanel.journey) { tourState.key = lj.key }
  await walk.goToStep(lj, n, { focus: false })
}

/**
 * The map comes back after a reload: VS Code hands the old panel over once the journeys are read (call the function
 * returned then). A panel that can't come back (its journey is gone, or no room beside 80 columns of code) closes once
 * VS Code has put it in place: closed while VS Code was still restoring it, it left an empty editor group
 * ("OverlayWebview has been disposed").
 */
export function restoreMapPanel(context: vscode.ExtensionContext): () => void {
  let journeysLoaded!: () => void
  const journeysReady = new Promise<void>((r) => { journeysLoaded = r })
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(MAP_VIEW, {
    deserializeWebviewPanel: async (panel, st) => {
      mapPanel.placeholder(panel, st as { q?: string; cur?: number; n?: number } | undefined)
      await journeysReady
      const lj = await mapJourneyRead()
      const afterRestore = (f: () => void) => setTimeout(f, AFTER_RESTORE_MS)
      if (!lj) {
        log.info('journey panel: its journey is gone; closed after the reload')
        afterRestore(() => panel.dispose())
        return
      }
      if (!tourState.key) tourState.key = lj.key
      mapPanel.adopt(panel, lj)
      walk.updateTour()
      afterRestore(() => void codeGetsMoreRoom())
    },
  }))
  return journeysLoaded
}

/** How long after VS Code restored a panel it is closed or resized (closed while VS Code still restored it, it left an
 *  empty editor group). */
const AFTER_RESTORE_MS = 1500

/** A check's tour is read with its check, a moment after the journeys: asked for this many times, this far apart. */
const MAP_JOURNEY_TRIES = 20
const MAP_JOURNEY_WAIT_MS = 250

/** The journey last shown on the map, once it has been read (undefined: it is gone). */
async function mapJourneyRead(): Promise<LoadedJourney | undefined> {
  let lj = journeys.byPos(state.get<string>(MAP_KEY))
  for (let i = 0; !lj && i < MAP_JOURNEY_TRIES; i++) {
    await new Promise((r) => setTimeout(r, MAP_JOURNEY_WAIT_MS))
    lj = journeys.byPos(state.get<string>(MAP_KEY))
  }
  return lj
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
  const lj = walk.tourJourney() ?? journeys.byPos(state.get<string>(MAP_KEY)) ?? (await pickJourney())
  if (lj) await openMap(lj)
  // "The map" means the map: an animation showing in its place goes.
  mapPanel.send({ type: 'anim', action: 'off' })
}

/** Start Journey: a journey (the argument, else the one whose map is open, else picked) from step 1. */
export async function startJourney(arg?: unknown): Promise<void> {
  const lj = await pickJourney(arg ?? tourState.key)
  if (lj) await walk.goToStep(lj, 1)
}

/**
 * A note asked from a step, or a step lens: to that step (by id; by number when its id is gone). The journey is the
 * one in `folder`, the workspace folder the link came from (else the active editor's): ids are unique per folder only.
 */
export async function openStepLink(id: string, stepId: string, n: number, folder?: string): Promise<void> {
  const from = folder ?? activeFolder()
  const lj = journeyById(journeys.list.values(), id, from)
  if (!lj) {
    vscode.window.setStatusBarMessage('$(info) That journey is gone', 3000)
    return
  }
  const i = lj.j.steps.findIndex((x) => x.id === stepId)
  await openMapIfRoom(lj)
  await walk.goToStep(lj, i >= 0 ? i + 1 : n)
}

/** The workspace folder of the active editor's file (its uri), if any. */
function activeFolder(): string | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri
  return uri && vscode.workspace.getWorkspaceFolder(uri)?.uri.toString()
}

/** From a reference's "← Back to step n": the step again (its file, card and lines). */
export async function backToStep(): Promise<void> {
  const lj = walk.tourJourney()
  if (lj && tourState.step) await walk.goToStep(lj, tourState.step)
}
