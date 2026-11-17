// Picking a journey: words of its title, question or steps, best match first; nothing matches: write one.

import * as vscode from 'vscode'
import { LoadedJourney, posKey } from '../journeys/steps'
import { journeyOrder } from '../sidebar/journeyRows'
import { Node } from '../sidebar/nodes'
import { journeyScore } from '../write/rank'
import { writeJourney } from '../write/writeJourney'
import { journeyModel, modelLabel } from '../write/writer'
import { tour, walk } from './tour'

export async function pickJourney(arg?: unknown): Promise<LoadedJourney | undefined> {
  const all = journeyOrder()
  if (typeof arg === 'string') return all.find((x) => x.key === arg || x.j.id === arg || posKey(x) === arg)
  if (arg && typeof arg === 'object' && (arg as Node).kind === 'journey') return (arg as { lj: LoadedJourney }).lj
  // Always a picker (the "…" promises one): the question once, and how far each one got.
  const multi = (vscode.workspace.workspaceFolders?.length ?? 0) > 1
  // Words, not scattered letters: each word must be in the title, question, summary or a step's title; the
  // best matches first, with the step that matched.
  const hay = (x: LoadedJourney) => [x.j.title, x.j.question, x.j.summary].join('\n').toLowerCase()
  const item = (x: LoadedJourney, words: string[]) => {
    const step = words.length ? x.j.steps.find((st) => words.some((w) => st.title.toLowerCase().includes(w))) : undefined
    // One line per journey: the short title; the step that matched (when only a step did), else the question
    // when it says more than the title; a ⚠ when its file can't be read; the folder when there are several.
    const q = x.j.question.toLowerCase().includes(x.j.title.toLowerCase()) ? '' : x.j.question
    return {
      ask: undefined as string | undefined,
      label: `${x.key === tour.key && tour.step ? '$(play-circle) ' : ''}${x.j.title}`,
      description: [step && !words.every((w) => hay(x).includes(w)) ? `step ${step.n}: ${step.title}` : q, x.readError ? '⚠' : '', multi ? x.folder.name : ''].filter(Boolean).join(' · '),
      alwaysShow: true, // filtered here, not by VS Code
      lj: x as LoadedJourney | undefined,
    }
  }
  const qp = vscode.window.createQuickPick<ReturnType<typeof item>>()
  // No title; in progress first, then the best match, the exact title first.
  qp.placeholder = all.length ? 'Open a journey' : 'Type a question about the code'
  qp.matchOnDescription = false
  qp.matchOnDetail = false
  const update = () => {
    const words = qp.value.toLowerCase().split(/\s+/).filter(Boolean)
    const typed = qp.value.trim().toLowerCase()
    const score = (x: LoadedJourney) => journeyScore(x, words, typed)
    const going = (x: LoadedJourney) => (x.key === tour.key && tour.step ? 2 : walk.resumeAt(x) ? 1 : 0)
    const items = all.map((x) => ({ x, k: score(x) })).filter((v) => v.k >= 0).sort((a, b) => b.k - a.k || going(b.x) - going(a.x)).map((v) => item(v.x, words))
    // Nothing matches: one item that asks the agent to write that journey.
    const q = qp.value.trim()
    qp.items = items.length || !q ? items : [{ ask: q, label: `$(sparkle) Write a journey for '${q}' with Claude`, description: `${modelLabel(journeyModel())}, about 3 min`, alwaysShow: true, lj: undefined }]
  }
  qp.onDidChangeValue(update)
  update()
  const pick = await new Promise<ReturnType<typeof item> | undefined>((res) => {
    qp.onDidAccept(() => { const p = qp.selectedItems[0]; res(p); qp.hide() })
    qp.onDidHide(() => { res(undefined); qp.dispose() })
    qp.show()
  })
  if (pick?.ask) { void writeJourney(pick.ask); return undefined }
  return pick?.lj
}
