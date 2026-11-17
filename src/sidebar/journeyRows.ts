// A journey's row (as both views show it), the notes asked from its steps, and revealing rows in the Journeys view.

import * as vscode from 'vscode'
import { gstate, journeys, notes } from '../app'
import { mine } from '../identity'
import { ListModel } from '../journeyList'
import { LoadedJourney } from '../journeys/steps'
import { isNewJourney, unread } from '../seen'
import { Note } from '../store'
import { isolate } from '../text'
import { UPDATE_ASK } from '../tour/askStep'
import { provenance } from '../tour/provenance'
import { tour, walk } from '../tour/tour'
import { refreshing } from '../write/refreshJourney'
import { journeysView } from './journeysTree'
import { activeRel, listModel, listState, staleCount, staleLine } from './listModel'
import { cached, journeyNode, matchesFilter, Node, order } from './nodes'

/** Alphabetical by title, always (R1): the list never jumps when a journey starts or a new one arrives. */
export const journeyOrder = (): LoadedJourney[] => journeys.all()

export const journeyRows = (): Node[] => [...journeyOrder().map(journeyNode),
  ...[...journeys.invalid.values()].sort((a, b) => a.uri.path.localeCompare(b.uri.path)).map((x) => cached(`badJourney:${x.uri}`, { kind: 'badJourney' as const, uri: x.uri, why: x.why }))]

const hasJourneyRows = () => journeys.all().length + journeys.invalid.size > 0

/** The quiet line under the group, until a journey has been opened once. */
export const INTRO_KEY = 'codeNotes.journeyOpened'

export const showIntro = () => !gstate.get<boolean>(INTRO_KEY)

/** The step a note was asked from: `extra.journey` = { id, step, n }. */
export function stepLinkOf(n: Note): { id: string; step?: string; n: number } | undefined {
  const v = n.data.extra?.journey as any
  return v && typeof v.id === 'string' && Number.isInteger(v.n) ? v : undefined
}

export function journeyOfNote(n: Note): LoadedJourney | undefined {
  const l = stepLinkOf(n)
  if (!l) return undefined
  return [...journeys.list.values()].find((x) => x.j.id === l.id && x.folder.uri.toString() === n.folder.uri.toString())
}

/**
 * Step n -> its questions: the note to open (the first unread, else the newest), whether any was answered
 * ('a') or not ('q'), how many there are and how many were answered. Resolved ones don't count.
 */
export type Asked = { id: string; state: 'q' | 'a'; unread: boolean; count: number; answered: number; update: boolean }

export function askedOf(lj: LoadedJourney): Record<number, Asked> {
  const out: Record<number, Asked> = {}
  for (const n of notes().sort(order)) {
    if (journeyOfNote(n) !== lj || n.data.status !== 'open') continue
    const l = stepLinkOf(n)!
    const i = l.step ? lj.j.steps.findIndex((s) => s.id === l.step) : l.n - 1
    if (i < 0) continue
    const a = n.data.messages.some((m) => !mine(m)), u = unread(n) > 0
    const o = out[i + 1] ?? { id: n.data.id, state: 'q', unread: false, count: 0, answered: 0, update: false }
    o.count++
    if (a) { o.answered++; o.state = 'a' }
    if (u && !o.unread) { o.unread = true; o.id = n.data.id } else if (!o.unread) o.id = n.data.id
    if (n.data.messages[0]?.body.startsWith(UPDATE_ASK.slice(0, 30))) o.update = true
    out[i + 1] = o
  }
  return out
}

/** "2 questions · 1 answered". */
export const askedText = (a: Asked) => `${a.count} asked${a.unread ? ' · new reply' : ''}`

export function questionsNode(lj: LoadedJourney): Node | undefined {
  const qs = notes().filter((n) => matchesFilter(n) && journeyOfNote(n) === lj)
  return qs.length ? cached(`questions:${lj.key}`, { kind: 'questions' as const, lj, notes: qs }) : undefined
}

export function journeyItem(lj: LoadedJourney): vscode.TreeItem {
  // The short title is the row; the question is the tooltip (R1). The description is state only: where it was
  // left (3/14; while walking the icon says so and the card and status bar have the position), new, stale.
  const q = questionsNode(lj)
  // The title isolated: right-to-left text in it never pulls the description into the label.
  const item = new vscode.TreeItem(isolate(lj.j.title), q ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)
  item.id = `journey:${lj.key}`
  const active = lj.key === tour.key && tour.step > 0
  // A reply to a step question shows on the folded row, like an unread note.
  const qs = q && q.kind === 'questions' ? q.notes : []
  const newReplies = qs.filter((n) => unread(n) > 0).length
  // State only: no step count, no position, no question count (the questions are the rows below);
  // stale steps are the icon.
  // Where it is (walking) or was left past step 1, quietly (as in the panel's list); opening one is not reading it.
  const left = active ? tour.step : walk.resumeAt(lj) > 1 ? walk.resumeAt(lj) : 0
  // Where it was left, else its area and age (journeyList.ts): muted, short.
  const row = listState.last?.rows[lj.key]
  item.description = [left ? `step ${left}/${lj.j.steps.length}` : row ? [row.area, row.age].filter(Boolean).join(' · ') : '', refreshing.has(lj.key) ? 'Refreshing…' : staleCount(lj) ? '⚠ Stale' : '', newReplies ? `${newReplies} repl${newReplies === 1 ? 'y' : 'ies'}` : '', lj.readError ? '⚠ unreadable' : '', isNewJourney(lj) ? 'new' : ''].filter(Boolean).join(' · ') || undefined

  // The icon says state only: walking, or stale steps; a plain row otherwise.
  // No stale ⚠ here: the step card says it, the storyline marks the step.
  item.iconPath = active ? new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('codeNotes.noteRuler')) : newReplies ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('codeNotes.unreadForeground')) : undefined
  // The question only; the accessible name is what is seen.
  // "new" is only a new journey: an unread answer is "1 reply", said in full here.
  const prov = provenance(lj)
  item.tooltip = [lj.j.question, lj.j.summary, prov.text, staleLine(lj), newReplies ? `${newReplies} unread repl${newReplies === 1 ? 'y' : 'ies'} from Claude` : ''].filter(Boolean).join('\n')
  // the name read is the title and its state; the question is only the tooltip.
  item.accessibilityInformation = { label: [lj.j.title, active ? `walking, step ${tour.step} of ${lj.j.steps.length}` : left ? `left at step ${left} of ${lj.j.steps.length}` : '', newReplies ? `${newReplies} unread repl${newReplies === 1 ? 'y' : 'ies'}` : '', isNewJourney(lj) ? 'new' : ''].filter(Boolean).join(', ') }
  item.contextValue = staleCount(lj) ? 'journey;stale' : 'journey'
  item.command = { command: 'codeNotes.openJourney', title: 'Walk Journey', arguments: [lj.key] }
  return item
}

/**
 * A reveal in the Journeys view goes only to a node the view holds now and keeps holding: a reveal of a node that a
 * redraw dropped meanwhile (the "In this file" group of the file before) logged "Failed to resolve tree node".
 * So: once things settle, against the model as it is then, and only for groups that don't come and go with the editor.
 */
let revealTimer: NodeJS.Timeout | undefined

function revealSettled(f: (m: ListModel) => Node | undefined, o: { select: boolean; expand: boolean }, wait: number): void {
  clearTimeout(revealTimer)
  if (!journeysView?.visible) return
  const file = activeRel()
  revealTimer = setTimeout(() => {
    if (!journeysView.visible || activeRel() !== file) return
    const n = f(listModel())
    if (n) journeysView.reveal(n, { ...o, focus: false }).then(undefined, () => { /* gone meanwhile */ })
  }, wait)
}

/** The walk's row in Continue (where a walk is listed first): never deep in All, which scrolled the view away. */
export function revealJourneyRow(lj: LoadedJourney): void {
  revealSettled((m) => m.groups.find((x) => x.id === 'continue')?.keys.includes(lj.key) ? cached(`journey:continue:${lj.key}`, { kind: 'journey' as const, lj, group: 'continue' }) : undefined, { select: true, expand: false }, 300)
}

/** The editor changed (and stayed): the Journeys view shows "In this file" (the top), not a row deep in All. */
export function revealHereGroup(): void {
  if (walk.touring()) return
  revealSettled((m) => { const g = m.groups.find((x) => x.id === 'here'); return g ? cached('jgroup:here', { kind: 'jgroup' as const, g }) : undefined }, { select: false, expand: true }, 700)
}
