// Picking a journey: words of its title, question or steps, best match first; nothing matches: write one.

import * as vscode from 'vscode'
import { journeys } from '../app'
import { LoadedJourney, posKey } from '../journeys/steps'
import { pickOne } from '../platform/quickPick'
import { Node } from '../sidebar/nodes'
import { writeJourney } from '../write/writeJourney'
import { journeyModel, modelLabel } from '../write/claudeRun'
import { tourState, walk } from './instances'
import { podcasts } from '../podcast/player'

/** The ▶ on a picker row whose journey has a podcast. */
const LISTEN_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('play'), tooltip: 'Listen to Journey' }

/** A row of the picker: a journey, or (`ask`) writing one for the question typed. */
type PickItem = vscode.QuickPickItem & { ask: string | undefined; lj: LoadedJourney | undefined }

/** The journey `arg` names (a key, an id, a posKey, a sidebar row), else the one picked. */
export async function pickJourney(arg?: unknown): Promise<LoadedJourney | undefined> {
  const all = journeys.all()
  if (typeof arg === 'string') return all.find((x) => x.key === arg || x.j.id === arg || posKey(x) === arg)
  if (arg && typeof arg === 'object' && (arg as Node).kind === 'journey') return (arg as { lj: LoadedJourney }).lj
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
  qp.onDidTriggerItemButton((e) => { if (e.item.lj) { const key = e.item.lj.key; qp.hide(); void podcasts.play(key) } })
  update()
  const pick = await pickOne(qp)
  if (pick?.ask) {
    void writeJourney(pick.ask)
    return undefined
  }
  return pick?.lj
}

/**
 * The rows for what is typed. Words, not scattered letters: each word must be in the title, question, summary or a
 * step's title; the best matches first (then the one being walked, then those left mid-way), with the step that
 * matched. Nothing matches: one row that asks the agent to write that journey.
 */
function pickerItems(all: LoadedJourney[], value: string, multi: boolean): PickItem[] {
  const words = value.toLowerCase().split(/\s+/).filter(Boolean)
  const typed = value.trim().toLowerCase()
  const going = (x: LoadedJourney) => (x.key === tourState.key && tourState.step ? 2 : walk.resumeAt(x) ? 1 : 0)
  const items = all.map((x) => ({ x, k: pickerScore(x, words, typed) }))
    .filter((v) => v.k >= 0)
    .sort((a, b) => b.k - a.k || going(b.x) - going(a.x))
    .map((v) => journeyItem(v.x, words, multi))
  const q = value.trim()
  if (items.length || !q) return items
  const label = `$(sparkle) Write a journey for '${q}' with Claude`
  return [{ ask: q, label, description: `${modelLabel(journeyModel())}, about 3 min`, alwaysShow: true, lj: undefined }]
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
  // A podcast: ♪ after the title, and a ▶ button on the row that opens it and listens.
  const pod = podcasts.status(x)
  const has = pod?.state === 'ok'
  const listening = has && !!pod?.session
  const walking = x.key === tourState.key && tourState.step && !listening
  return {
    ask: undefined,
    label: `${walking ? '$(play-circle) ' : ''}${x.j.title}${has ? ' ♪' : ''}`,
    description: [listening ? 'listening' : about, x.readError ? '⚠' : '', multi ? x.folder.name : ''].filter(Boolean).join(' · '),
    ...(has && !listening ? { buttons: [LISTEN_BUTTON] } : {}),
    alwaysShow: true, // filtered here, not by VS Code
    lj: x,
  }
}

/** A journey's question, when it says more than its title (else ''): a picker row's description. */
export function questionBesidesTitle(x: LoadedJourney): string {
  return x.j.question.toLowerCase().includes(x.j.title.toLowerCase()) ? '' : x.j.question
}

/** Title, question and summary, lower case: what a word must be in for more than a step to match. */
const journeyHay = (x: LoadedJourney) => [x.j.title, x.j.question, x.j.summary].join('\n').toLowerCase()

/** The picker's weights: the exact title, a title starting with what was typed, each word in the title. */
const EXACT_TITLE = 1e6
const TITLE_PREFIX = 1e5
const TITLE_WORD = 1e3

/** How well a journey matches typed `words` (-1: a word is in none of its texts); then how often the words occur. */
export function pickerScore(x: LoadedJourney, words: string[], typed: string): number {
  const text = [journeyHay(x), ...x.j.steps.map((st) => st.title.toLowerCase())].join('\n')
  if (!words.every((w) => text.includes(w))) return -1
  const title = x.j.title.toLowerCase()
  const exact = typed && title === typed ? EXACT_TITLE : 0
  const prefix = typed && title.startsWith(typed) ? TITLE_PREFIX : 0
  const titleWords = words.filter((w) => title.includes(w)).length * TITLE_WORD
  const occurrences = words.reduce((a, w) => a + text.split(w).length - 1, 0)
  return exact + prefix + titleWords + occurrences
}
