// The walk in the journey panel: its messages (a step, the step card's links, the animation's beats, End) and the
// walk's part of what the panel shows.

import * as vscode from 'vscode'
import type { WalkInfo } from '../../../protocol/map'
import type { LoadedJourney } from '../../steps'
import type { PanelFeature } from '../controller'
import { beats, journeys, mapPanel } from '../../../tour/ports'
import { card, podcast, tourState, walk } from '../../../tour/instances'
import { askStep, askUpdate } from '../../../tour/askStep'
import { endJourney, finishTour } from '../../../tour/commands'
import { provenance } from '../../../tour/provenance'
import { openRef } from '../../../tour/refs'
import { chordKey } from '../../../platform/chordKey'
import { fireAndForget } from '../../../platform/run'
import { OWN_MOVE_MS } from '../../../platform/timings'
import { wfs } from '../../../platform/workspaceFs'

export interface WalkFeatureDeps {
  /** Steps someone asked about (the Journeys view's rows know). */
  askedOf(lj: LoadedJourney): NonNullable<WalkInfo['asked']>
}

export function walkFeature(d: WalkFeatureDeps): PanelFeature {
  return {
    name: 'the walk',
    handlers: {
      step: (lj, m) => fireAndForget(walk().goToStep(lj, m.n, { focus: false }), 'panel: walk.goToStep'),
      end: () => fireAndForget(endJourney(), 'panel: endJourney'),
      finish: () => fireAndForget(finishTour(), 'panel: finishTour'),
      ref: (lj, m) => openPanelRef(lj, m.i),
      ask: (_lj, m) => fireAndForget(m.update ? askUpdate() : askStep(), 'panel: ask'),
      openPath: (lj, m) => fireAndForget(openBoxPath(lj, m.path), 'panel: openBoxPath'),
      openFile: (lj) => fireAndForget(vscode.window.showTextDocument(lj.uri, { viewColumn: walk().codeColumn() }), 'panel: showTextDocument'),
      // The list over the walk: the walk keeps its place, card and status item.
      home: () => undefined,
      beat: (lj, m) => {
        if (m.user) podcast()?.onBeat(lj, m.n, m.i)
        fireAndForget(showBeat(lj, m.n, m.i), 'panel: showBeat')
      },
      closed: () => { beats().clear(); card().refreshDecorations(); podcast()?.onClosed() },
      details: (_lj, m) => { tourState().detailsOpen = m.open; mapPanel().update() },
    },
    slice: (lj) => walkInfo(lj, d),
  }
}

function walkInfo(lj: LoadedJourney, d: WalkFeatureDeps): WalkInfo {
  const st = tourState()
  const walking = lj.key === st.key
  const cardInMap = walking && st.step && card().inMap(lj, st.step) ? card().panelCard(lj, st.step) : undefined
  const done = st.finishedKey === lj.key && !(walking && st.step)
  return {
    key: chordKey(),
    current: walking ? st.step : 0,
    marks: walk().stepMarks(lj),
    resume: walk().resumeAt(lj),
    moved: Object.fromEntries(journeys().renames(lj)),
    ...(cardInMap ? { card: cardInMap } : {}),
    asked: d.askedOf(lj),
    prov: provenance(lj),
    ...(done ? { done: true } : {}),
  }
}

/** A link of the panel's step card (its index in tourState.panelRefs): opened as from the inline card. */
function openPanelRef(lj: LoadedJourney, i: number): void {
  const r = tourState().panelRefs[i]
  if (r) fireAndForget(openRef(lj, r.file, r.line, r.end, tourState().step), 'panel: openRef')
}

/**
 * A beat of the step's animation (i < 0: the scene is gone). Its line is lit; when the scene stops driving the editor
 * (Map, ■, Esc, a beat without code) the editor is given back to the step: its lines and its card.
 */
export async function showBeat(lj: LoadedJourney, n: number, i: number): Promise<void> {
  const st = tourState()
  // A beat of a step left just now (the map learns of the move after its scene drew): nothing.
  if (i >= 0 && (lj.key !== st.key || n !== st.step)) return
  const wasLit = beats().lit
  // The caret goes to the lit line: arriving is not reading a note there.
  st.cursorUntil = Date.now() + OWN_MOVE_MS
  beats().index = i >= 0 ? i : undefined
  const beat = i >= 0 ? lj.j.steps[n - 1]?.scene?.beats[i] : undefined
  const shown = await beats().show(lj.folder.uri, beat, journeys().renames(lj), walk().codeColumn)
  // A newer beat (or step) took the editor meanwhile: it draws its own.
  if (shown === 'superseded') return
  // The beat's marks, and the step's dimmed (stepMarks.ts).
  card().refreshDecorations()
  // The panel shows those lines itself, under the caption, when it has the room.
  if (i >= 0) mapPanel().send({ type: 'code', n, i, code: shown === 'lit' ? beats().preview : undefined })
  // The scene ended while its line was lit, and the walk is still on this step: the editor goes back to the step.
  const stillOnStep = !st.stepping && walk().touring() && st.key === lj.key && st.step
  const sceneEnded = shown === 'none' && wasLit
  if (sceneEnded && stillOnStep) await walk().goToStep(lj, st.step, { focus: false })
}

/** Ctrl+' P: the current step's animation on or off, in the journey panel. */
export function toggleAnimation(): void {
  const lj = walk().tourJourney()
  if (!lj || !walk().touring()) {
    void vscode.window.setStatusBarMessage('Open a journey step first: its animation plays in the journey panel.', 4000)
    return
  }
  if (!lj.j.steps[tourState().step - 1]?.scene?.beats?.length) {
    void vscode.window.setStatusBarMessage(`Step ${tourState().step} has no animation.`, 4000)
    return
  }
  if (mapPanel().journey?.key !== lj.key || !mapPanel().visible) walk().showMap(lj, true)
  mapPanel().send({ type: 'anim', action: 'toggle' })
}

/** A box without steps (a store): open what its `path` names: a file, else the folder in the Explorer. */
async function openBoxPath(lj: LoadedJourney, p: string): Promise<void> {
  // `path`, or `file:a-b` (a function box's code, 0.21): the lines selected.
  const lines = /:(\d+)(?:-(\d+))?$/.exec(p)
  const uri = vscode.Uri.joinPath(lj.folder.uri, p.replace(/:\d+(-\d+)?$/, ''))
  try {
    const st = await wfs.stat(uri)
    if (st.type & vscode.FileType.Directory) {
      await vscode.commands.executeCommand('revealInExplorer', uri)
      return
    }
    const a = lines ? Math.max(0, Number(lines[1]) - 1) : 0
    const b = lines ? Math.max(a, Number(lines[2] ?? lines[1]) - 1) : 0
    const selection = lines ? { selection: new vscode.Range(a, 0, b, 0) } : {}
    await vscode.window.showTextDocument(uri, { preview: true, viewColumn: walk().codeColumn(), ...selection })
  } catch { vscode.window.setStatusBarMessage(`$(info) ${p} isn't in this folder`, 3000) }
}
