// The pick when several journeys answer a question, and the confirm before writing one (the ranking: ranking.ts).

import * as vscode from 'vscode'
import { journeys } from './ports'
import { LoadedJourney } from '../journeys/steps'
import { pickOne } from '../platform/quickPick'
import { shortQ } from '../core/text'
import { questionBesidesTitle } from '../tour/texts'
import { modelLabel } from '../core/agentRun'
import { journeyModel, WRITE_ESTIMATE } from './claudeRun'
import { CLOSEST_SHOWN, matchJourneys as matching, rankJourneys, Rankable } from './ranking'

/** Every journey as the ranking reads it. */
const rankable = (): Rankable<LoadedJourney>[] => journeys().all().map((x) => ({
  item: x,
  text: { title: x.j.title, question: x.j.question, summary: x.j.summary, steps: x.j.steps.map((s) => s.title) },
}))

/** The journeys that answer a question (ranking.ts matchJourneys): one, several close ones, or none. */
export const matchJourneys = (question: string): LoadedJourney[] => matching(rankable(), question)

/** A journey as a row of the pick and the confirm. */
const journeyRow = (x: LoadedJourney) => ({ label: `$(map) ${x.j.title}`, description: questionBesidesTitle(x) })

/** Several journeys answer it about equally: a short pick (Esc: none). */
export async function chooseJourney(question: string, list: LoadedJourney[]): Promise<LoadedJourney | undefined> {
  type It = vscode.QuickPickItem & { lj: LoadedJourney }
  const qp = vscode.window.createQuickPick<It>()
  qp.title = `Several journeys answer “${shortQ(question, 60)}”`
  qp.placeholder = 'Open one'
  qp.ignoreFocusOut = true
  qp.items = list.map((x) => ({ ...journeyRow(x), lj: x }))
  const pick = await pickOne(qp, {
    onOpen: (accept) => {
      const byTitle = (t: string) => accept(qp.items.find((i) => i.lj.j.title === t))
      choosing = { titles: list.map((x) => x.j.title), accept: byTitle }
    },
    onHide: () => { choosing = undefined },
  })
  return pick?.lj
}

/** The open pick, while it is open: the integration tests answer it through src/testApi.ts. */
export let choosing: { titles: string[]; accept: (title: string) => void } | undefined

/** A row of the confirm: a journey to open, Write, or Cancel; separators are rows nobody can pick. */
type ConfirmRow = vscode.QuickPickItem & { act: 'write' | 'cancel' | LoadedJourney }
type Separator = vscode.QuickPickItem & { kind: vscode.QuickPickItemKind.Separator }
export type ConfirmItem = ConfirmRow | Separator

const separator = (label: string): Separator => ({ label, kind: vscode.QuickPickItemKind.Separator })

/** The open confirm, while it is open: the integration tests answer it through src/testApi.ts. */
export let confirming:
  | { qp: vscode.QuickPick<ConfirmItem>; question: string; accept: (it: ConfirmItem | undefined) => void }
  | undefined

/**
 * Before a paid, minutes-long run: the closest journeys first (opening one costs nothing), then Write and Cancel.
 */
export async function confirmWrite(question: string, model?: string): Promise<'write' | LoadedJourney | undefined> {
  const label = modelLabel(journeyModel(model))
  const qp = vscode.window.createQuickPick<ConfirmItem>()
  qp.title = `No journey answers this yet. Write one with Claude (${label}, ${WRITE_ESTIMATE})?`
  qp.placeholder = `“${shortQ(question, 80)}”`
  qp.ignoreFocusOut = true
  qp.matchOnDescription = false
  const closest = rankJourneys(rankable(), question).slice(0, CLOSEST_SHOWN)
    .map((v): ConfirmRow => ({ ...journeyRow(v.item), act: v.item }))
  qp.items = [
    ...(closest.length ? [separator('Closest journeys'), ...closest, separator('')] : []),
    { label: '$(sparkle) Write', description: `a journey for this with Claude (${label})`, act: 'write' },
    { label: 'Cancel', act: 'cancel' },
  ]
  const pick = await pickOne(qp, { onOpen: (accept) => { confirming = { qp, question, accept } } })
  confirming = undefined
  return !pick || !('act' in pick) || pick.act === 'cancel' ? undefined : pick.act
}
