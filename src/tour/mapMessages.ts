// The extension's side of the journey panel (journeys/mapPanel.ts draws it): what each of its messages (MapMessage)
// does, and mapState, what the panel is told besides the journey.

import * as vscode from 'vscode'
import { beats, byId, cfg, gstate, journeys, KEY, log, mapPanel, state, understanding } from '../app'
import { git } from '../checkout'
import { ageOf } from '../journeyList'
import { LEGEND_HIDDEN_KEY, MapMessage, TourInfo } from '../journeys/mapPanel'
import { fileOf, LoadedJourney } from '../journeys/steps'
import { reveal } from '../notes/reveal'
import { askedOf } from '../sidebar/journeyRows'
import { journeysTree } from '../sidebar/journeysTree'
import { listModel, listState, SORT_KEY } from '../sidebar/listModel'
import { relPath } from '../notes/location'
import { wfs } from '../workspaceFs'
import { refreshJourney } from '../write/refreshJourney'
import { askStep, askUpdate } from './askStep'
import { openCheckpoint } from './checkTour'
import { rememberPanelWidth } from './panelLayout'
import { endJourney, finishTour, walkJourney } from './commands'
import { provenance } from './provenance'
import { openRef } from './refs'
import { card, tourState, walk } from './instances'
import { onTutorial, TUTORIAL_KEY } from './tutorial'
import { podcasts } from '../podcast/player'

/** The map column's width in wide panels, as last dragged (0.21.1): every panel, every journey. */
const MAP_WIDTH_KEY = 'codeNotes.mapWidth'

type Handler<K extends MapMessage['type']> = (lj: LoadedJourney, m: Extract<MapMessage, { type: K }>) => void

/** What each message from the journey panel does (the panel's own state messages have none). */
const MAP_MESSAGES: { [K in MapMessage['type']]?: Handler<K> } = {
  step: (lj, m) => void walk.goToStep(lj, m.n, { focus: false }),
  end: () => void endJourney(),
  finish: () => void finishTour(),
  question: (_lj, m) => revealNoteById(m.id),
  checkpoint: (lj, m) => void openCheckpoint(lj, m.id),
  nextStop: () => void walk.stepBy(1),
  ref: (lj, m) => openPanelRef(lj, m.i),
  ask: (_lj, m) => void (m.update ? askUpdate() : askStep()),
  openPath: (lj, m) => void openBoxPath(lj, m.path),
  // The list over the walk: the walk keeps its place, card and status item.
  home: () => undefined,
  beat: (lj, m) => { if (m.user) podcasts.onBeat(lj, m.n, m.i); void showBeat(lj, m.n, m.i) },
  closed: () => { beats.clear(); podcasts.onClosed() },
  podcastTime: (lj, m) => podcasts.onTime(lj, m),
  podcastError: (_lj, m) => podcasts.onError(String(m.message)),
  podcastMeta: (lj, m) => podcasts.onAudioMeta(lj, Number(m.duration)),
  podcastWhy: (lj) => void podcasts.showWhy(lj),
  panelWidth: () => void rememberPanelWidth(),
  mapWidth: (_lj, m) => void gstate.update(MAP_WIDTH_KEY, m.w > 0 ? Math.round(m.w) : undefined),
  list: (_lj, m) => homeQueryChanged(m),
  preview: (_lj, m) => withJourney(m.key, (x) => void sendPreview(x)),
  refresh: (_lj, m) => withJourney(m.key, (x) => void refreshJourney(x)),
  hereAll: () => { listState.hereAll = true; mapPanel.update() },
  walk: (_lj, m) => withJourney(m.key, (x) => void walkJourney(x, { keepFocus: 'panel' })),
  details: (_lj, m) => { tourState.detailsOpen = m.open; mapPanel.update() },
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

/** A journey the panel names by key, when it is still there. */
function withJourney(key: string, f: (lj: LoadedJourney) => void): void {
  const lj = journeys.list.get(key)
  if (lj) f(lj)
}

/** A question row of the map: its note. */
function revealNoteById(id: string): void {
  const note = byId(id)
  if (note) void reveal(note)
}

/** A link of the panel's step card (its index in tourState.panelRefs): opened as from the inline card. */
function openPanelRef(lj: LoadedJourney, i: number): void {
  const r = tourState.panelRefs[i]
  if (r) void openRef(lj, r.file, r.line, r.end, tourState.step)
}

/** A journey's preview in the panel's list: the journey, and which steps are stale since when. */
async function sendPreview(lj: LoadedJourney): Promise<void> {
  const stale = await staleInfo(lj)
  mapPanel.send({ type: 'preview', key: lj.key, journey: lj.j, stale })
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
  if (!raw) return
  const restored = () => vscode.window.setStatusBarMessage(`$(check) Restored ${lj.j.title}`, 4000)
  void wfs.writeFile(lj.uri, new TextEncoder().encode(raw)).then(restored)
}

/** Author mode: the journey's rule breaks, in the Output channel. */
function showRuleBreaks(lj: LoadedJourney): void {
  const list = lj.j.problems.map((p) => `  - ${p}`).join('\n')
  log.info(`journey ${lj.j.id} (${relPath(lj.folder, lj.uri)}): ${lj.j.problems.length} rule break(s) for its author:\n${list}`)
  log.show(true)
}

/**
 * A beat of the step's animation (i < 0: the scene is gone). Its line is lit; when the scene stops driving the editor
 * (Map, ■, Esc, a beat without code) the editor is given back to the step: its lines and its card.
 */
async function showBeat(lj: LoadedJourney, n: number, i: number): Promise<void> {
  // A beat of a step left just now (the map learns of the move after its scene drew): nothing.
  if (i >= 0 && (lj.key !== tourState.key || n !== tourState.step)) return
  const was = beats.lit
  // The caret goes to the lit line: arriving is not reading a note there.
  tourState.cursorUntil = Date.now() + 1500
  const shown = await beats.show(lj.folder.uri, i >= 0 ? lj.j.steps[n - 1]?.scene?.beats[i] : undefined, journeys.renames(lj), walk.codeColumn)
  // The panel shows those lines itself, under the caption, when it has the room.
  if (shown !== 'superseded' && i >= 0) mapPanel.send({ type: 'code', n, i, code: shown === 'lit' ? beats.preview : undefined })
  const givenBack = shown === 'none' && was && !tourState.stepping && walk.touring() && tourState.key === lj.key && tourState.step
  if (givenBack) await walk.goToStep(lj, tourState.step, { focus: false })
}

/** Ctrl+' P: the current step's animation on or off, in the journey panel. */
export function toggleAnimation(): void {
  const lj = walk.tourJourney()
  if (!lj || !walk.touring()) {
    void vscode.window.setStatusBarMessage('Open a journey step first: its animation plays in the journey panel.', 4000)
    return
  }
  if (!lj.j.steps[tourState.step - 1]?.scene?.beats?.length) {
    void vscode.window.setStatusBarMessage(`Step ${tourState.step} has no animation.`, 4000)
    return
  }
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
    if (st.type & vscode.FileType.Directory) {
      await vscode.commands.executeCommand('revealInExplorer', uri)
      return
    }
    const a = lines ? Math.max(0, Number(lines[1]) - 1) : 0
    const b = lines ? Math.max(a, Number(lines[2] ?? lines[1]) - 1) : 0
    const selection = lines ? { selection: new vscode.Range(a, 0, b, 0) } : {}
    await vscode.window.showTextDocument(uri, { preview: true, viewColumn: walk.codeColumn(), ...selection })
  } catch { vscode.window.setStatusBarMessage(`$(info) ${p} isn't in this folder`, 3000) }
}

/** The stale steps of a journey for its preview: which, and the last commit to their file since it was written. */
async function staleInfo(lj: LoadedJourney): Promise<{ n: number; when: string }[]> {
  const out: { n: number; when: string }[] = []
  for (const [i, a] of lj.at.entries()) {
    if (!a.stale) continue
    out.push({ n: i + 1, when: await lastChange(lj, fileOf(lj, i + 1)) })
  }
  return out
}

/** "uncommitted", or the last commit to `file` since the journey's (else ever): "a1b2c3d · 3 days ago"; '' unknown. */
async function lastChange(lj: LoadedJourney, file: string): Promise<string> {
  if (await git(lj.folder, ['status', '--porcelain', '--', file])) return 'uncommitted'
  const lastCommit = (range: string[]) => git(lj.folder, ['log', '-1', '--format=%h %ct', ...range, '--', file])
  const l = (lj.j.commit ? await lastCommit([`${lj.j.commit}..HEAD`]) : undefined) ?? await lastCommit([])
  if (!l) return ''
  const [hash, time] = l.split(' ')
  const age = ageOf(new Date(Number(time) * 1000).toISOString(), Date.now())
  return `${hash} · ${age === 'today' ? age : `${age} ago`}`
}

/** What the journey panel shows of a journey besides the journey itself: the walk, the tutorial, the list, its home. */
export function mapState(lj: LoadedJourney): TourInfo {
  const walking = lj.key === tourState.key
  const mapWidth = gstate.get<number>(MAP_WIDTH_KEY)
  const cardInMap = walking && tourState.step && card.inMap(lj, tourState.step) ? card.panelCard(lj, tourState.step) : undefined
  const done = tourState.finishedKey === lj.key && !(walking && tourState.step)
  return {
    key: KEY,
    tutorial: !gstate.get<boolean>(TUTORIAL_KEY),
    current: walking ? tourState.step : 0,
    marks: walk.stepMarks(lj),
    resume: walk.resumeAt(lj),
    legendHidden: state.get<boolean>(LEGEND_HIDDEN_KEY) ?? true, // on demand (M99)
    ...(mapWidth ? { mapWidth } : {}),
    problems: lj.readError ? [lj.readError] : [],
    authors: cfg().get<boolean>('journeys.authorMode') ? lj.j.problems.length : 0,
    moved: Object.fromEntries(journeys.renames(lj)),
    ...(cardInMap ? { card: cardInMap } : {}),
    asked: askedOf(lj),
    prov: provenance(lj),
    ...(lj.check ? { stops: checkStops(lj) } : {}),
    list: journeys.all().map((x) => listRow(x, lj)),
    home: listModel(listState.homeQuery),
    ...(done ? { done: true } : {}),
  }
}

/** A check's tour: its questions, the one the walk is at marked `cur`. */
function checkStops(lj: LoadedJourney) {
  const atQuestion = (q: { id: string; step: number }) => lj.key === tourState.key && tourState.checkpointId === q.id && tourState.step === q.step
  return (understanding?.tourStops() ?? []).map((q) => (atQuestion(q) ? { ...q, cur: true } : { ...q }))
}

/** A journey in the panel home's list (`here`: the one the panel is about). */
function listRow(x: LoadedJourney, shown: LoadedJourney) {
  return {
    key: x.key,
    title: x.j.title,
    question: x.j.question,
    steps: x.j.steps.length,
    resume: walk.resumeAt(x),
    ...(x.key === shown.key ? { here: true } : {}),
    ...(x.j.start ? { start: true } : {}),
  }
}

/**
 * Turn author mode off: the setting is the state (journeys.authorMode); the command (shown only while it is on) turns
 * it off, in the workspace too when it is set there.
 */
export const toggleAuthorMode = async () => {
  await cfg().update('journeys.authorMode', false, vscode.ConfigurationTarget.Global)
  if (cfg().inspect('journeys.authorMode')?.workspaceValue) await cfg().update('journeys.authorMode', false, vscode.ConfigurationTarget.Workspace)
  vscode.window.setStatusBarMessage('$(info) Journey author mode off', 2500)
  mapPanel.update()
}
