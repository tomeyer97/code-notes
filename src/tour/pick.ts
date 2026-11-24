// Picking a journey: words of its title, question or steps, best match first; nothing matches: write one.

import * as vscode from 'vscode'
import { journeys } from './ports'
import { podcast, tourState, walk } from './instances'
import { fileOf, LoadedJourney, posKey } from '../journeys/steps'
import { matchScore, SearchText } from '../core/list/match'
import { pickOne } from '../platform/quickPick'
import { writeJourney } from '../write/writeJourney'
import { journeyModel, modelLabel } from '../write/claudeRun'
import { fireAndForget } from '../platform/run'
import { questionBesidesTitle } from './texts'

/** The ▶ on a picker row whose journey has a podcast. */
const LISTEN_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('play'), tooltip: 'Listen to Journey' }

/** A row of the picker: a journey, or (`ask`) writing one for the question typed. */
type PickItem = vscode.QuickPickItem & { ask: string | undefined; lj: LoadedJourney | undefined }

/**
 * What a command's argument names: a journey (a sidebar row's), or a string that is a key, a posKey or an id. A key is
 * looked for first, then a posKey, then an id: an id that happens to equal another journey's key never wins.
 */
export type JourneyRef = { kind: 'journey'; lj: LoadedJourney } | { kind: 'name'; name: string }

/** The command argument `arg` as a JourneyRef (undefined: none, or nothing that names a journey). */
export function journeyRefOf(arg: unknown): JourneyRef | undefined {
  if (typeof arg === 'string') return { kind: 'name', name: arg }
  // A row of the Journeys view (sidebar/nodes.ts: `{ kind: 'journey', lj }`).
  const row = arg as { kind?: unknown; lj?: LoadedJourney } | undefined
  if (row && typeof row === 'object' && row.kind === 'journey' && row.lj) return { kind: 'journey', lj: row.lj }
  return undefined
}

/** The journey `ref` names among `all`. */
export function findJourney(all: LoadedJourney[], ref: JourneyRef): LoadedJourney | undefined {
  if (ref.kind === 'journey') return ref.lj
  const name = ref.name
  return all.find((x) => x.key === name) ?? all.find((x) => posKey(x) === name) ?? all.find((x) => x.j.id === name)
}

/** The journey `arg` names (a key, an id, a posKey, a sidebar row), else the one picked. */
export async function pickJourney(arg?: unknown): Promise<LoadedJourney | undefined> {
  const all = journeys().all()
  const ref = journeyRefOf(arg)
  if (ref) return findJourney(all, ref)
  // Always a picker (the "…" promises one): the question once, and how far each one got.
  const multi = (vscode.workspace.workspaceFolders?.length ?? 0) > 1
  const qp = vscode.window.createQuickPick<PickItem>()
  // No title; in progress first, then the best match, the exact title first.
  qp.placeholder = all.length ? 'Open a journey' : 'Type a question about the code'
  qp.matchOnDescription = false
  qp.matchOnDetail = false
  const update = () => { qp.items = pickerItems(all, qp.value, multi) }
  qp.onDidChangeValue(update)
  // ▶ on a row with a podcast: that journey, listened to.
  qp.onDidTriggerItemButton((e) => {
    if (!e.item.lj) return
    const key = e.item.lj.key
    qp.hide()
    fireAndForget(podcast()?.play(key), 'pick: podcast.play')
  })
  update()
  const pick = await pickOne(qp)
  if (pick?.ask) {
    fireAndForget(writeJourney(pick.ask), 'pick: writeJourney')
    return undefined
  }
  return pick?.lj
}

/**
 * The rows for what is typed: the journeys the list's search finds (core/list/match.ts, the same words and weights as
 * the Journeys list), the best matches first (then the one being walked, then those left mid-way), with the step that
 * matched. Nothing matches: one row that asks the agent to write that journey.
 */
function pickerItems(all: LoadedJourney[], value: string, multi: boolean): PickItem[] {
  const words = value.toLowerCase().split(/\s+/).filter(Boolean)
  const going = (x: LoadedJourney) => (journeyBadges(x).walking ? 2 : walk().resumeAt(x) ? 1 : 0)
  const items = rankJourneys(all, value)
    .sort((a, b) => b.score - a.score || going(b.lj) - going(a.lj))
    .map((v) => journeyItem(v.lj, words, multi))
  const q = value.trim()
  if (items.length || !q) return items
  const label = `$(sparkle) Write a journey for '${q}' with Claude`
  return [{ ask: q, label, description: `${modelLabel(journeyModel())}, about 3 min`, alwaysShow: true, lj: undefined }]
}

/** What the list's search reads of a journey. */
const searchTextOf = (x: LoadedJourney): SearchText => ({
  title: x.j.title, question: x.j.question, summary: x.j.summary,
  stepTitles: x.j.steps.map((s) => s.title),
  files: x.j.steps.map((s) => fileOf(x, s.n)),
})

/** The journeys matching `query` with their scores (in `all`'s order): one ranking, the list's (matchScore). */
export function rankJourneys(all: LoadedJourney[], query: string): { lj: LoadedJourney; score: number }[] {
  return all.map((lj) => ({ lj, score: matchScore(searchTextOf(lj), query).score })).filter((v) => v.score > 0)
}

/** What a journey's row says besides its title: being walked, has a podcast, listened to now, can't be read. */
export interface JourneyBadges { walking: boolean; podcast: boolean; listening: boolean; unreadable: boolean }

export function journeyBadges(x: LoadedJourney): JourneyBadges {
  const pod = podcast()?.status(x)
  const has = pod?.state === 'ok'
  return {
    walking: x.key === tourState().key && !!tourState().step,
    podcast: has,
    listening: has && !!pod?.session,
    unreadable: !!x.readError,
  }
}

/**
 * One line per journey: the short title (a ♪ after it when it has a podcast); the step that matched (when only a step
 * did), else the question when it says more than the title; a ⚠ when its file can't be read; the folder when there
 * are several. The journey listened to: "listening", and no ▶.
 */
function journeyItem(x: LoadedJourney, words: string[], multi: boolean): PickItem {
  const step = words.length ? x.j.steps.find((st) => words.some((w) => st.title.toLowerCase().includes(w))) : undefined
  const onlyStepMatched = step && !words.every((w) => journeyHay(x).includes(w))
  const about = onlyStepMatched ? `step ${step.n}: ${step.title}` : questionBesidesTitle(x)
  const b = journeyBadges(x)
  // A podcast: ♪ after the title, and a ▶ button on the row that opens it and listens.
  const description = [b.listening ? 'listening' : about, b.unreadable ? '⚠' : '', multi ? x.folder.name : '']
  return {
    ask: undefined,
    label: `${b.walking && !b.listening ? '$(play-circle) ' : ''}${x.j.title}${b.podcast ? ' ♪' : ''}`,
    description: description.filter(Boolean).join(' · '),
    ...(b.podcast && !b.listening ? { buttons: [LISTEN_BUTTON] } : {}),
    alwaysShow: true, // filtered here, not by VS Code
    lj: x,
  }
}

/** Title, question and summary, lower case: what a word must be in for more than a step to match. */
const journeyHay = (x: LoadedJourney) => [x.j.title, x.j.question, x.j.summary].join('\n').toLowerCase()
