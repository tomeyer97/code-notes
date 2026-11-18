// The journey panel's messages (journeys/mapPanel.ts MapMessage) and what each does; the panel's state.

import * as vscode from 'vscode'
import { beats, byId, cfg, gstate, journeys, KEY, log, mapPanel, state, understanding } from '../app'
import { git } from '../identity'
import { ageOf } from '../journeyList'
import { MapMessage, MapPanel } from '../journeys/mapPanel'
import { fileOf, LoadedJourney } from '../journeys/steps'
import { reveal } from '../notes/reveal'
import { askedOf, journeyOrder } from '../sidebar/journeyRows'
import { journeysTree } from '../sidebar/journeysTree'
import { listModel, listState, SORT_KEY } from '../sidebar/listModel'
import { relPath } from '../notes/location'
import { wfs } from '../wfs'
import { refreshJourney } from '../write/refreshJourney'
import { askStep, askUpdate } from './askStep'
import { openCheckpoint } from './checkTour'
import { rememberPanelWidth } from './layout'
import { endTour, finishTour, walkJourney } from './open'
import { provenance } from './provenance'
import { openRef } from './refs'
import { card, tour, walk } from './tour'
import { onTutorial, TUTORIAL_KEY } from './tutorial'

/** The map column's width in wide panels, as last dragged (0.21.1): every panel, every journey. */
const MAP_WIDTH_KEY = 'codeNotes.mapWidth'

type Handler<K extends MapMessage['type']> = (lj: LoadedJourney, m: Extract<MapMessage, { type: K }>) => void

/** What each message from the journey panel does (the panel's own state messages have none). */
const MAP_MESSAGES: { [K in MapMessage['type']]?: Handler<K> } = {
  step: (lj, m) => void walk.goToStep(lj, m.n, { focus: false }),
  end: () => void endTour(),
  finish: () => void finishTour(),
  question: (_lj, m) => { const nt = byId(m.id); if (nt) void reveal(nt) },
  checkpoint: (lj, m) => void openCheckpoint(lj, m.id),
  nextStop: () => void walk.stepBy(1),
  ref: (lj, m) => { const r = tour.panelRefs[m.i]; if (r) void openRef(lj, r.file, r.line, r.end, tour.step) },
  ask: (_lj, m) => void (m.update ? askUpdate() : askStep()),
  openPath: (lj, m) => void openBoxPath(lj, m.path),
  home: () => { /* the list over the walk: the walk keeps its place, card and status item */ },
  beat: (lj, m) => void showBeat(lj, m.n, m.i),
  closed: () => beats.clear(),
  panelWidth: () => void rememberPanelWidth(),
  mapWidth: (_lj, m) => void gstate.update(MAP_WIDTH_KEY, m.w > 0 ? Math.round(m.w) : undefined),
  list: (_lj, m) => homeQueryChanged(m),
  preview: (_lj, m) => { const x = journeys.list.get(m.key); if (x) void staleInfo(x).then((stale) => mapPanel.send({ type: 'preview', key: m.key, journey: x.j, stale })) },
  refresh: (_lj, m) => { const x = journeys.list.get(m.key); if (x) void refreshJourney(x) },
  hereAll: () => { listState.hereAll = true; mapPanel.update() },
  walk: (_lj, m) => { const x = journeys.list.get(m.key); if (x) void walkJourney(x, { keepFocus: 'panel' }) },
  details: (_lj, m) => { tour.detailsOpen = m.open; mapPanel.update() },
  openFile: (lj) => void vscode.window.showTextDocument(lj.uri, { viewColumn: walk.codeColumn() }),
  close: () => mapPanel.close(),
  pick: () => void vscode.commands.executeCommand('codeNotes.openJourney'),
  restore: (lj) => restoreLastGood(lj),
  authors: (lj) => showRuleBreaks(lj),
  tutorial: (lj, m) => onTutorial(lj, m),
}

export function onMapMessage(lj: LoadedJourney, m: MapMessage): void {
  (MAP_MESSAGES[m.type] as Handler<MapMessage['type']> | undefined)?.(lj, m)
}

/** The panel home's search, chips or sort changed. */
function homeQueryChanged(m: Extract<MapMessage, { type: 'list' }>): void {
  listState.homeQuery = { query: String(m.query ?? ''), kind: m.kind ?? 'all', area: String(m.area ?? ''), searchSort: m.searchSort }
  if (m.sort) void state.update(SORT_KEY, m.sort).then(() => { journeysTree.refresh(); mapPanel.update() })
  else mapPanel.update()
}

/** A journey file that can't be read: back to its last good version. */
function restoreLastGood(lj: LoadedJourney): void {
  const raw = journeys.lastGood.get(lj.key)
  if (raw) void wfs.writeFile(lj.uri, new TextEncoder().encode(raw)).then(() => vscode.window.setStatusBarMessage(`$(check) Restored ${lj.j.title}`, 4000))
}

/** Author mode: the journey's rule breaks, in the Output channel. */
function showRuleBreaks(lj: LoadedJourney): void {
  log.info(`journey ${lj.j.id} (${relPath(lj.folder, lj.uri)}): ${lj.j.problems.length} rule break(s) for its author:\n${lj.j.problems.map((p) => `  - ${p}`).join('\n')}`)
  log.show(true)
}

/**
 * A beat of the step's animation (i < 0: the scene is gone). Its line is lit; when the scene stops driving the editor
 * (Map, ■, Esc, a beat without code) the editor is given back to the step: its lines and its card.
 */
async function showBeat(lj: LoadedJourney, n: number, i: number): Promise<void> {
  // A beat of a step left just now (the map learns of the move after its scene drew): nothing.
  if (i >= 0 && (lj.key !== tour.key || n !== tour.step)) return
  const was = beats.lit
  // The caret goes to the lit line: arriving is not reading a note there.
  tour.cursorUntil = Date.now() + 1500
  const shown = await beats.show(lj.folder.uri, i >= 0 ? lj.j.steps[n - 1]?.scene?.beats[i] : undefined, journeys.renames(lj), walk.codeColumn)
  // The panel shows those lines itself, under the caption, when it has the room.
  if (shown !== 'superseded' && i >= 0) mapPanel.send({ type: 'code', n, i, code: shown === 'lit' ? beats.preview : undefined })
  if (shown === 'none' && was && !tour.stepping && walk.touring() && tour.key === lj.key && tour.step) await walk.goToStep(lj, tour.step, { focus: false })
}

/** Ctrl+' P: the current step's animation on or off, in the journey panel. */
export function toggleAnimation(): void {
  const lj = walk.tourJourney()
  if (!lj || !walk.touring()) { void vscode.window.setStatusBarMessage('Open a journey step first: its animation plays in the journey panel.', 4000); return }
  if (!lj.j.steps[tour.step - 1]?.scene?.beats?.length) { void vscode.window.setStatusBarMessage(`Step ${tour.step} has no animation.`, 4000); return }
  if (mapPanel.journey?.key !== lj.key || !mapPanel.visible) walk.showMap(lj, true)
  mapPanel.send({ type: 'anim', action: 'toggle' })
}

/** A box without steps (a store): open what its `path` names: a file, else the folder in the Explorer. */
async function openBoxPath(lj: LoadedJourney, p: string): Promise<void> {
  // `path`, or `file:a-b` (a function box's code, 0.21): the lines selected.
  const lines = /:(\d+)(?:-(\d+))?$/.exec(p)
  const uri = vscode.Uri.joinPath(lj.folder.uri, p.replace(/:\d+(-\d+)?$/, ''))
  try {
    const st = await wfs.stat(uri)
    if (st.type & vscode.FileType.Directory) await vscode.commands.executeCommand('revealInExplorer', uri)
    else {
      const a = lines ? Math.max(0, Number(lines[1]) - 1) : 0, b = lines ? Math.max(a, Number(lines[2] ?? lines[1]) - 1) : 0
      await vscode.window.showTextDocument(uri, { preview: true, viewColumn: walk.codeColumn(), ...(lines ? { selection: new vscode.Range(a, 0, b, 0) } : {}) })
    }
  } catch { vscode.window.setStatusBarMessage(`$(info) ${p} isn't in this folder`, 3000) }
}

/** The stale steps of a journey for its preview: which, and the last commit to their file since it was written. */
async function staleInfo(lj: LoadedJourney): Promise<{ n: number; when: string }[]> {
  const out: { n: number; when: string }[] = []
  for (const [i, a] of lj.at.entries()) {
    if (!a.stale) continue
    const file = fileOf(lj, i + 1)
    let when = ''
    if (await git(lj.folder, ['status', '--porcelain', '--', file])) when = 'uncommitted'
    else {
      const log1 = (range: string[]) => git(lj.folder, ['log', '-1', '--format=%h %ct', ...range, '--', file])
      const l = (lj.j.commit ? await log1([`${lj.j.commit}..HEAD`]) : undefined) ?? await log1([])
      if (l) { const [h, t] = l.split(' '); const age = ageOf(new Date(Number(t) * 1000).toISOString(), Date.now()); when = `${h} · ${age === 'today' ? age : `${age} ago`}` }
    }
    out.push({ n: i + 1, when })
  }
  return out
}

/** What the journey panel shows of a journey besides the journey itself: the walk, the tutorial, the list, its home. */
export function mapState(lj: LoadedJourney): ReturnType<ConstructorParameters<typeof MapPanel>[3]> {
  return {
    key: KEY, tutorial: !gstate.get<boolean>(TUTORIAL_KEY),
    current: lj.key === tour.key ? tour.step : 0, marks: walk.stepMarks(lj), resume: walk.resumeAt(lj), legendHidden: state.get<boolean>('codeNotes.legendHidden') ?? true, // on demand (M99)
    ...(gstate.get<number>(MAP_WIDTH_KEY) ? { mapWidth: gstate.get<number>(MAP_WIDTH_KEY) } : {}),
    problems: lj.readError ? [lj.readError] : [], authors: cfg().get<boolean>('journeys.authorMode') ? lj.j.problems.length : 0, moved: Object.fromEntries(journeys.renames(lj)),
    ...(lj.key === tour.key && tour.step && card.inMap(lj, tour.step) ? { card: card.panelCard(lj, tour.step) } : {}),
    asked: askedOf(lj), prov: provenance(lj),
    ...(lj.check ? { stops: (understanding?.tourStops() ?? []).map((q) => ({ ...q, ...(lj.key === tour.key && tour.cp === q.id && tour.step === q.step ? { cur: true } : {}) })) } : {}),
    list: journeyOrder().map((x) => ({ key: x.key, title: x.j.title, question: x.j.question, steps: x.j.steps.length, resume: walk.resumeAt(x), ...(x.key === lj.key ? { here: true } : {}), ...(x.j.start ? { start: true } : {}) })),
    home: listModel(listState.homeQuery),
    ...(tour.finishedKey === lj.key && !(lj.key === tour.key && tour.step) ? { done: true } : {}),
  }
}

/**
 * From a reference's "← Back to step n" (R8).
 * the setting is the state (journeys.authorMode); the command (shown only while it is on) turns it off.
 */
export const authorModeOff = async () => {
  await cfg().update('journeys.authorMode', false, vscode.ConfigurationTarget.Global)
  if (cfg().inspect('journeys.authorMode')?.workspaceValue) await cfg().update('journeys.authorMode', false, vscode.ConfigurationTarget.Workspace)
  vscode.window.setStatusBarMessage('$(info) Journey author mode off', 2500)
  mapPanel.update()
}
