// A journey's row (as both views show it), the notes asked from its steps and their rows, and a journey file that
// can't be read. A row's state is worked out once (JourneyRowState) and said in each of its texts.

import * as vscode from 'vscode'
import { journeys, podcastStatus, tour } from './ports'
import { visibleNotes } from '../notes/visible'
import { stored } from '../platform/host'
import { mine } from '../notes/identity'
import { ListModel } from '../core/list/journeyList'
import { LoadedJourney } from '../journeys/steps'
import { isNewJourney, unread } from '../notes/seen'
import { Note } from '../notes/store'
import { isolate } from '../core/text'
import { escapeMarkdown } from '../core/escape'
import { isUpdateRequest } from '../tour/texts'
import { provenance } from '../tour/provenance'
import { refreshing } from '../write/refreshJourney'
import { journeysTree } from './journeysTree'
import { staleCount, staleLine } from './listModel'
import { badJourneyNodes, cached, journeyNode, Node, noteNode } from './nodes'
import { matchesFilter, order } from '../notes/model'
import { journeyOfNote as journeyOf, stepLinkOf } from '../notes/model/journeyLink'
import { fileName } from '../platform/jsonFolder'
import { STATE } from '../platform/state'
import { cmdLink, Cmd } from '../platform/commands'
import { trustedMarkdown } from '../platform/commandLinks'
import { journeyDescription, journeyLabel, JourneyRowState, journeyTooltip, nestsQuestions, podcastContext } from './journeyRowText'

/** Every journey's row, then the journey files that can't be read. */
export const journeyRows = (): Node[] => [...journeys().all().map(journeyNode), ...badJourneyNodes()]

export const showIntro = () => !stored().get(STATE.journeyOpened)

/** The journey a note was asked from (notes/model/journeyLink.ts), among the journeys read. */
export const journeyOfNote = (n: Note): LoadedJourney | undefined => journeyOf(n, journeys().list.values())

/**
 * Step n -> its questions: the note to open (the first unread, else the newest), whether any was answered
 * ('a') or not ('q'), how many there are and how many were answered. Resolved ones don't count.
 */
export type Asked = { id: string; state: 'q' | 'a'; unread: boolean; count: number; answered: number; update: boolean }

export function askedOf(lj: LoadedJourney): Record<number, Asked> {
  const out: Record<number, Asked> = {}
  for (const note of visibleNotes().sort(order)) {
    if (journeyOfNote(note) !== lj || note.data.status !== 'open') continue
    const link = stepLinkOf(note)!
    const stepIndex = link.step ? lj.j.steps.findIndex((s) => s.id === link.step) : link.n - 1
    if (stepIndex < 0) continue
    const entry = out[stepIndex + 1] ?? { id: note.data.id, state: 'q', unread: false, count: 0, answered: 0, update: false }
    entry.count++
    if (note.data.messages.some((m) => !mine(m))) {
      entry.answered++
      entry.state = 'a'
    }
    // The note to open: the first unread one; until there is one, the newest.
    if (unread(note) > 0 && !entry.unread) {
      entry.unread = true
      entry.id = note.data.id
    } else if (!entry.unread) entry.id = note.data.id
    if (isUpdateRequest(note)) entry.update = true
    out[stepIndex + 1] = entry
  }
  return out
}

/** "2 asked · new reply". */
export const askedText = (a: Asked) => `${a.count} asked${a.unread ? ' · new reply' : ''}`

export function questionsNode(lj: LoadedJourney): Node | undefined {
  const qs = visibleNotes().filter((n) => matchesFilter(n) && journeyOfNote(n) === lj)
  return qs.length ? cached(`questions:${lj.key}`, { kind: 'questions' as const, lj, notes: qs }) : undefined
}

/** The rows of notes asked from steps, by line. */
export const questionRows = (list: Note[]): Node[] => [...list].sort(order).map(noteNode)

/** A journey's questions' rows (under its row). */
export function journeyQuestionRows(lj: LoadedJourney): Node[] {
  const q = questionsNode(lj)
  return q && q.kind === 'questions' ? questionRows(q.notes) : []
}

/** The state of `lj`'s row, with `questions` its open step questions. */
export function journeyRowState(lj: LoadedJourney, questions: Note[], model: ListModel | undefined): JourneyRowState {
  const { key, step } = tour().state
  const active = lj.key === key && step > 0
  const resumeAt = active ? 0 : tour().resumeAt(lj)
  return {
    active,
    left: active ? step : resumeAt > 1 ? resumeAt : 0,
    steps: lj.j.steps.length,
    newReplies: questions.filter((n) => unread(n) > 0).length,
    pod: podcastStatus(lj),
    refreshing: refreshing.has(lj.key),
    stale: staleCount(lj) > 0,
    unreadable: !!lj.readError,
    isNew: isNewJourney(lj),
    row: model?.rows[lj.key],
  }
}

/**
 * A journey's row. The short title is the row; the question is the tooltip. The description is state only.
 * `group`: the Journeys view's group it is listed in (its id says which; only All and the areas nest its questions).
 * `model`: the list model the view drew (the row's area, age and "here" text).
 */
export function journeyItem(lj: LoadedJourney, group?: string, model: ListModel | undefined = journeysTree.drawnModel()): vscode.TreeItem {
  const q = questionsNode(lj)
  const s = journeyRowState(lj, q && q.kind === 'questions' ? q.notes : [], model)
  // The title isolated: right-to-left text in it never pulls the description into the label.
  const folds = q && nestsQuestions(group) ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
  const item = new vscode.TreeItem(isolate(lj.j.title), folds)
  item.id = group ? `${group}|journey:${lj.key}` : `journey:${lj.key}`
  item.description = journeyDescription(s, group)
  item.iconPath = journeyIcon(s)
  item.tooltip = journeyTooltip(s, { question: lj.j.question, summary: lj.j.summary, provenance: provenance(lj).text, staleLine: staleLine(lj) })
  // The name read is the title and its state; the question is only the tooltip.
  item.accessibilityInformation = { label: journeyLabel(lj.j.title, s) }
  // A podcast: ▶ Listen on the row unless it plays (paused, ▶ goes on where it was); one that can't be played: no ▶
  // (the tooltip says why).
  item.contextValue = (s.stale ? 'journey;stale' : 'journey') + podcastContext(s.pod)
  item.command = { command: Cmd.openJourney, title: 'Walk Journey', arguments: [lj.key] }
  return item
}

/** The icon says state only: walking, or new replies; a plain row otherwise (no stale ⚠: the step card says it, the
 *  storyline marks the step; nothing for listening: the player says it). */
function journeyIcon(s: JourneyRowState): vscode.ThemeIcon | undefined {
  if (s.active) return new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('codeNotes.noteRuler'))
  if (s.newReplies) return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('codeNotes.unreadForeground'))
  return undefined
}

/** The notes asked from a journey's steps: one row, open, with how many are new. */
export function questionsItem(node: Extract<Node, { kind: 'questions' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(`Questions (${node.notes.length})`, vscode.TreeItemCollapsibleState.Expanded)
  item.id = `questions:${node.lj.key}`
  item.iconPath = new vscode.ThemeIcon('comment-discussion')
  const u = node.notes.filter((n) => unread(n) > 0).length
  if (u) item.description = `${u} new`
  item.tooltip = 'Notes asked from this journey\'s steps'
  return item
}

/** A journey file that can't be read: one dimmed row (the text is the row's muted description), why on hover, click opens it. */
export function badJourneyItem(node: Extract<Node, { kind: 'badJourney' }>): vscode.TreeItem {
  const name = fileName(node.uri)
  const item = new vscode.TreeItem('')
  item.id = `badJourney:${node.uri}`
  item.description = `⚠ ${name}`
  item.tooltip = trustedMarkdown(`${escapeMarkdown(node.why)}\n\n${cmdLink('Open file', 'vscode.open', node.uri.toString())}`, ['vscode.open'])
  item.accessibilityInformation = { label: `${name}: can't be read` }
  item.command = { command: 'vscode.open', title: 'Open file', arguments: [node.uri] }
  item.contextValue = 'badJourney'
  return item
}

/** A row's texts: journeyRowText.ts; revealing rows in the Journeys view: journeysTree.ts. */
export { JourneyRowState, nestsQuestions } from './journeyRowText'
export { revealHereGroup, revealJourneyRow } from './journeysTree'
