// Searching every journey from the Journeys view: a picker over the list model's search (journeyList.ts), best match
// first (or the view's sort).

import * as vscode from 'vscode'
import { journeys, tour } from './ports'
import { ListRow, matchedStep, SORTS } from '../core/list/journeyList'
import { pickOne } from '../platform/quickPick'
import { listModel, listSort } from './listModel'
import { fireAndForget } from '../platform/run'

type SearchItem = vscode.QuickPickItem & { key: string }

/** A result: the title, its area · steps · age, its question and the step that matched. VS Code filters the items
 *  again by label/description/detail, so they carry the words searched. */
const resultItem = (r: ListRow): SearchItem => ({
  key: r.key,
  label: r.title,
  description: r.meta,
  detail: [r.question, matchedStep(r)].filter(Boolean).join(' · '),
  alwaysShow: true,
})

/** The items for `query`: the results (in the model's order), under one line when no journey has every word. */
function resultItems(query: string): SearchItem[] {
  const m = listModel({ query })
  const keys = [...new Set(m.sections.flatMap((s) => s.keys))]
  const rows = keys.map((k) => resultItem(m.rows[k]))
  return m.fallback ? [{ key: '', label: m.fallback.note, kind: vscode.QuickPickItemKind.Separator }, ...rows] : rows
}

/** Search every journey (title, question, summary, step titles, files): a picker, best match first (or the view's sort). */
export async function searchJourneys(): Promise<void> {
  const qp = vscode.window.createQuickPick<SearchItem>()
  qp.placeholder = 'Search journeys: words of the title, question, steps or file paths'
  // The results follow the view's sort when one was picked (else best match first).
  const sort = listSort()
  if (sort !== 'area') qp.title = `Search journeys · ${SORTS.find((x) => x.id === sort)!.label}`
  qp.matchOnDescription = true
  qp.matchOnDetail = true
  const fill = () => { qp.items = resultItems(qp.value) }
  qp.onDidChangeValue(fill)
  fill()
  // Not awaited: the command returns while the pick is open.
  fireAndForget(pickOne(qp).then((it) => {
    const lj = it && journeys().list.get(it.key)
    if (lj) fireAndForget(tour().walkJourney(lj), 'journeySearch: walkJourney')
  }), 'journeySearch: pickOne')
}
