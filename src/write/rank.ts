// Which journeys answer a question: ranked by its telling words; a pick when several do, a confirm before writing one.

import * as vscode from 'vscode'
import { LoadedJourney } from '../journeys/steps'
import { scoreJourney } from '../match'
import { journeyOrder } from '../sidebar/journeyRows'
import { shortQ } from '../text'
import { journeyModel, modelLabel } from './writer'

export function journeyScore(x: LoadedJourney, words: string[], typed: string): number {
  const hay = [x.j.title, x.j.question, x.j.summary].join('\n').toLowerCase()
  const t = [hay, ...x.j.steps.map((st) => st.title.toLowerCase())].join('\n')
  if (!words.every((w) => t.includes(w))) return -1
  const title = x.j.title.toLowerCase()
  return (typed && title === typed ? 1e6 : 0) + (typed && title.startsWith(typed) ? 1e5 : 0) + words.filter((w) => title.includes(w)).length * 1e3 + words.reduce((a, w) => a + t.split(w).length - 1, 0)
}

/** The journey that answers a question: the same question, else the picker's best match on its telling words. */

const journeyText = (x: LoadedJourney) => ({ title: x.j.title, question: x.j.question, summary: x.j.summary, steps: x.j.steps.map((s) => s.title) })

/** Journeys by how well they answer a question: most telling words matched, title and question first. */
function rankJourneys(question: string): { x: LoadedJourney; s: ReturnType<typeof scoreJourney> }[] {
  return journeyOrder().map((x) => ({ x, s: scoreJourney(journeyText(x), question) })).filter((v) => v.s.matched > 0)
    .sort((a, b) => b.s.matched - a.s.matched || b.s.weight - a.s.weight)
}

/**
 * The journeys that answer a question: the same question or title (one), else those matching most of its words; more
 * than one only when the best two are close (then the person picks).
 */
export function matchJourneys(question: string): LoadedJourney[] {
  const flat = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const q = flat(question)
  const same = journeyOrder().find((x) => flat(x.j.question) === q || flat(x.j.title) === q)
  if (same) return [same]
  const ok = rankJourneys(question).filter((v) => v.s.answers)
  if (!ok.length) return []
  const top = ok[0].s
  return ok.filter((v, i) => i === 0 || (v.s.matched === top.matched && v.s.weight >= top.weight * 0.85)).slice(0, 4).map((v) => v.x)
}

/** several journeys answer it about equally: a short pick (Esc: none). */
export async function chooseJourney(question: string, list: LoadedJourney[]): Promise<LoadedJourney | undefined> {
  type It = vscode.QuickPickItem & { lj: LoadedJourney }
  const qp = vscode.window.createQuickPick<It>()
  qp.title = `Several journeys answer “${shortQ(question, 60)}”`
  qp.placeholder = 'Open one'
  qp.ignoreFocusOut = true
  qp.items = list.map((x) => ({ label: `$(map) ${x.j.title}`, description: x.j.question.toLowerCase().includes(x.j.title.toLowerCase()) ? '' : x.j.question, lj: x }))
  return new Promise<LoadedJourney | undefined>((res) => {
    const accept = (it: unknown) => { res((it as It | undefined)?.lj); qp.hide() }
    choosing = { titles: list.map((x) => x.j.title), accept: (t: string) => accept(qp.items.find((i) => i.lj.j.title === t)) }
    qp.onDidAccept(() => accept(qp.selectedItems[0]))
    qp.onDidHide(() => { res(undefined); qp.dispose(); choosing = undefined })
    qp.show()
  })
}

/** The open pick (for the integration test). */
export let choosing: { titles: string[]; accept: (title: string) => void } | undefined

/** The pending "Write one with Claude?", for the integration test to answer. */
export let confirming: { qp: vscode.QuickPick<vscode.QuickPickItem & { act: unknown }>; question: string; accept: (it: unknown) => void } | undefined

/**
 * before a paid, minutes-long run: the closest journeys first (opening one costs nothing), then Write and Cancel.
 */
export async function confirmWrite(question: string, model?: string): Promise<'write' | LoadedJourney | undefined> {
  type It = vscode.QuickPickItem & { act: 'write' | 'cancel' | LoadedJourney }
  const qp = vscode.window.createQuickPick<It>()
  qp.title = `No journey answers this yet. Write one with Claude (${modelLabel(journeyModel(model))}, about 3 min)?`
  qp.placeholder = `“${shortQ(question, 80)}”`
  qp.ignoreFocusOut = true
  qp.matchOnDescription = false
  const alt = rankJourneys(question).slice(0, 3).map((v) => v.x)
  const items: It[] = []
  if (alt.length) {
    items.push({ label: 'Closest journeys', kind: vscode.QuickPickItemKind.Separator, act: 'cancel' })
    for (const x of alt) items.push({ label: `$(map) ${x.j.title}`, description: x.j.question.toLowerCase().includes(x.j.title.toLowerCase()) ? '' : x.j.question, act: x })
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, act: 'cancel' })
  }
  items.push({ label: '$(sparkle) Write', description: `a journey for this with Claude (${modelLabel(journeyModel(model))})`, act: 'write' })
  items.push({ label: 'Cancel', act: 'cancel' })
  qp.items = items
  const pick = await new Promise<It | undefined>((res) => {
    const accept = (it: It | undefined) => { res(it); qp.hide() }
    confirming = { qp: qp as unknown as vscode.QuickPick<vscode.QuickPickItem & { act: unknown }>, question, accept: accept as (it: unknown) => void }
    qp.onDidAccept(() => accept(qp.selectedItems[0]))
    qp.onDidHide(() => { res(undefined); qp.dispose() })
    qp.show()
  })
  confirming = undefined
  return !pick || pick.act === 'cancel' ? undefined : pick.act
}
