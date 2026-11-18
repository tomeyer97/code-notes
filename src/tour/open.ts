// Opening a journey (its map, then its steps), finishing or ending a walk, and the walk back after a reload.

import * as vscode from 'vscode'
import { beats, codeLinks, gstate, journeys, log, mapPanel, state, valueHints } from '../app'
import { prefixUsed } from '../chords'
import { MAP_VIEW } from '../journeys/mapPanel'
import { fileOf, LoadedJourney, posKey } from '../journeys/steps'
import { markJourneysSeen } from '../seen'
import { INTRO_KEY, showIntro } from '../sidebar/journeyRows'
import { tree } from '../sidebar/notesTree'
import { cardOnly, codeGetsMoreRoom, panelFits } from './layout'
import { pickJourney } from './pick'
import { card, tour, walk } from './tour'
import { MAP_KEY, POS_KEY, TOUR_KEY } from './state'

/**
 * Opening a journey walks it (no separate Start): its map, and the code with its card at step 1,
 * or where it was left (the step being walked, else the resume point).
 */
export async function walkJourney(lj: LoadedJourney, opts: { fromStart?: boolean; keepFocus?: 'sidebar' | 'panel' } = {}): Promise<void> {
  // No room for the panel beside 80 columns of code: the step card only, decided before anything opens (the
  // panel never squeezes the code, not even for a moment).
  const room = !lj.j.steps.length || (await panelFits())
  await openMap(lj, room)
  if (!room) cardOnly()
  if (!lj.j.steps.length) return
  await walk.goToStep(lj, opts.fromStart ? 1 : walk.startStep(lj))
  // Back where the click was: the code is shown, but arrows and Enter never type into it.
  if (opts.keepFocus === 'sidebar') await vscode.commands.executeCommand('codeNotes.journeys.focus').then(undefined, () => undefined)
  else if (opts.keepFocus === 'panel' && room) mapPanel.takeFocus()
  if (room) await codeGetsMoreRoom()
}

/** Shows a journey's map (`show`: false when there is no room for it). Another journey's tour ends first, keeping its place. */
export async function openMap(lj: LoadedJourney, show = true): Promise<void> {
  // Another journey's map is only a look: the running tour goes on until Start there, or End.
  await markJourneysSeen(lj)
  if (showIntro()) await gstate.update(INTRO_KEY, true)
  // One journey on screen at a time: another journey's map ends the running walk quietly (its place is kept
  // for Resume); its status item and code marker go with it.
  if (lj.key !== tour.key && walk.touring()) await endTour()
  if (lj.key !== tour.key) { tour.key = lj.key; tour.step = 0 }
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
  const doc = tour.doc
  await endTour()
  if (!lj) return
  await state.update(POS_KEY, Object.fromEntries(Object.entries(walk.positions()).filter(([k]) => k !== posKey(lj))))
  // Only the walk's own preview tab (not one you kept open or edited).
  const tabs = doc ? vscode.window.tabGroups.all.filter((g) => g.viewColumn === doc.column).flatMap((g) => g.tabs)
    .filter((t) => t.isPreview && !t.isDirty && t.input instanceof vscode.TabInputText && lj.j.steps.some((s) => vscode.Uri.joinPath(lj.folder.uri, fileOf(lj, s.n)).toString() === (t.input as vscode.TabInputText).uri.toString())) : []
  if (tabs.length) await vscode.window.tabGroups.close(tabs, true)
  tour.finishedKey = lj.key
  // The panel says Done when it is open or has the room; else the status bar says it.
  if (mapPanel.journey || (await panelFits())) walk.showMap(lj); else vscode.window.setStatusBarMessage('$(check) Journey finished', 3000)
  walk.updateTour()
  tree.refresh()
}

/** Ends the tour: its place is kept (resume later), the card goes; the code stays open. */
export async function endTour(): Promise<void> {
  const lj = walk.tourJourney()
  if (lj && tour.step) await walk.savePos(lj, tour.step)
  await state.update(TOUR_KEY, undefined)
  const doc = tour.doc
  tour.doc = undefined
  codeLinks.clear()
  valueHints.clear()
  beats.clear()
  tour.step = 0
  card.clear()
  walk.updateTour()
  tree.refresh()
  // The code you were reading stays open: you probably ended the tour to keep reading there.
  void doc
}

/** After a reload: the tour where it was. The map comes back by itself when it was open (serializer). */
export async function restoreTour(): Promise<void> {
  const lj = journeys.byPos(state.get<string>(TOUR_KEY))
  if (!lj) return
  const n = walk.resumeAt(lj) || 1
  if (!mapPanel.journey) { tour.key = lj.key }
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
      // A check's tour is read with its check, a moment after the journeys.
      let lj = journeys.byPos(state.get<string>(MAP_KEY))
      for (let i = 0; !lj && i < 20; i++) { await new Promise((r) => setTimeout(r, 250)); lj = journeys.byPos(state.get<string>(MAP_KEY)) }
      const later = (f: () => void) => setTimeout(f, 1500)
      if (!lj) { log.info('journey panel: its journey is gone; closed after the reload'); later(() => panel.dispose()); return }
      if (!tour.key) tour.key = lj.key
      mapPanel.adopt(panel, lj)
      walk.updateTour()
      later(() => void codeGetsMoreRoom())
    },
  }))
  return journeysLoaded
}

/**
 * Open Journey…: always the picker; from a sidebar row, that journey.
 * From a sidebar row (an argument): the focus stays in the list, so arrows and Enter never type into the code.
 */
export const openJourney = async (arg?: unknown) => { const lj = await pickJourney(arg); if (lj) await walkJourney(lj, arg !== undefined ? { keepFocus: 'sidebar' } : {}) }

/** Show Map (the V chord): the tour's or the last journey's map; the picker when there is none. */
export const showMap = async (a?: unknown) => {
  prefixUsed(a)
  const lj = walk.tourJourney() ?? journeys.byPos(state.get<string>(MAP_KEY)) ?? (await pickJourney())
  if (lj) await openMap(lj)
  // "The map" means the map: an animation showing in its place goes.
  mapPanel.send({ type: 'anim', action: 'off' })
}

export const startJourney = async (arg?: unknown) => { const lj = await pickJourney(arg ?? tour.key); if (lj) await walk.goToStep(lj, 1) }

/** A note asked from a step: back to that step. */
export const openStepLink = async (id: string, stepId: string, n: number) => {
  const lj = [...journeys.list.values()].find((x) => x.j.id === id)
  if (!lj) { vscode.window.setStatusBarMessage('$(info) That journey is gone', 3000); return }
  const i = lj.j.steps.findIndex((x) => x.id === stepId)
  const room = await panelFits()
  await openMap(lj, room)
  if (!room) cardOnly()
  await walk.goToStep(lj, i >= 0 ? i + 1 : n)
}

export const backToStep = async () => { const lj = walk.tourJourney(); if (lj && tour.step) await walk.goToStep(lj, tour.step) }
