// A journey's row (as both views show it), the notes asked from its steps and their rows, a journey file that can't
// be read, and revealing rows in the Journeys view.

import * as vscode from 'vscode'
import { journeys, notes, stored } from '../app'
import { mine } from '../notes/identity'
import { ListModel } from '../core/list/journeyList'
import { LoadedJourney } from '../journeys/steps'
import { isNewJourney, unread } from '../notes/seen'
import { Note } from '../notes/store'
import { isolate, plural } from '../core/text'
import { isUpdateRequest } from '../tour/askStep'
import { provenance } from '../tour/provenance'
import { tourState, walk } from '../tour/instances'
import { refreshing } from '../write/refreshJourney'
import { journeysTree, journeysView } from './journeysTree'
import { activeRel, listModel, listState, staleCount, staleLine } from './listModel'
import { badJourneyNodes, cached, jgroupNode, journeyNode, journeyRowNode, Node, noteNode, order } from './nodes'
import { matchesFilter } from './notesFilter'
import { fileName } from '../platform/jsonFolder'
import { podcasts } from '../podcast/player'
import { clock } from '../podcast/model'
import { STATE } from '../platform/state'
import { Cmd } from '../platform/commands'

/** Every journey's row, then the journey files that can't be read. */
export const journeyRows = (): Node[] => [...journeys.all().map(journeyNode), ...badJourneyNodes()]

export const showIntro = () => !stored.get(STATE.journeyOpened)

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
  for (const note of notes().sort(order)) {
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
  const qs = notes().filter((n) => matchesFilter(n) && journeyOfNote(n) === lj)
  return qs.length ? cached(`questions:${lj.key}`, { kind: 'questions' as const, lj, notes: qs }) : undefined
}

/** The rows of notes asked from steps, by line. */
export const questionRows = (list: Note[]): Node[] => [...list].sort(order).map(noteNode)

/** A journey's questions' rows (under its row). */
export function journeyQuestionRows(lj: LoadedJourney): Node[] {
  const q = questionsNode(lj)
  return q && q.kind === 'questions' ? questionRows(q.notes) : []
}

/** What a journey's row says about the walk: being walked, where it was left (past step 1), new replies. */
interface JourneyState { active: boolean; left: number; newReplies: number }

const replies = (n: number) => plural(n, 'reply', 'replies')

/**
 * A journey's row. The short title is the row; the question is the tooltip. The description is state only.
 * `group`: the Journeys view's group it is listed in (its id says which; only All and the areas nest its questions).
 */
export function journeyItem(lj: LoadedJourney, group?: string): vscode.TreeItem {
  const q = questionsNode(lj)
  // A reply to a step question shows on the folded row, like an unread note.
  const qs = q && q.kind === 'questions' ? q.notes : []
  const active = lj.key === tourState.key && tourState.step > 0
  // Where it is (walking) or was left past step 1, quietly (as in the panel's list); opening one is not reading it.
  const left = active ? tourState.step : walk.resumeAt(lj) > 1 ? walk.resumeAt(lj) : 0
  const s: JourneyState = { active, left, newReplies: qs.filter((n) => unread(n) > 0).length }
  const nestsQuestions = !group || group === 'all' || group.startsWith('area:')
  // The title isolated: right-to-left text in it never pulls the description into the label.
  const folds = q && nestsQuestions ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
  const item = new vscode.TreeItem(isolate(lj.j.title), folds)
  item.id = group ? `${group}|journey:${lj.key}` : `journey:${lj.key}`
  item.description = journeyDescription(lj, s, group)
  item.iconPath = journeyIcon(s)
  item.tooltip = journeyTooltip(lj, s)
  // The name read is the title and its state; the question is only the tooltip.
  item.accessibilityInformation = { label: journeyLabel(lj, s) }
  // A podcast: ▶ Listen on the row unless it plays (paused, ▶ goes on where it was); one that can't be played: no ▶
  // (the tooltip says why).
  item.contextValue = (staleCount(lj) ? 'journey;stale' : 'journey') + podcastContext(lj)
  item.command = { command: Cmd.openJourney, title: 'Walk Journey', arguments: [lj.key] }
  return item
}

/**
 * State only, muted and short: where it was left (step 3/14; while walking the icon says so and the card and status
 * bar have the position), else its area and age (journeyList.ts; under its area's group the area is not said again);
 * Refreshing… or ⚠ Stale; new replies; unreadable; new. No step count, no question count (the questions are the rows
 * below). In this file (`here`): how much of it is here ("3 of 7 steps here"), unless it is being walked or was left.
 */
function journeyDescription(lj: LoadedJourney, s: JourneyState, group: string | undefined): string | undefined {
  const row = listState.last?.rows[lj.key]
  const pod = podcastText(lj)
  if (group === 'here' && row && !(row.walking || row.resume > 1)) return [pod, row.hereText, row.stale ? '⚠ Stale' : ''].filter(Boolean).join(' · ')
  const groupArea = group?.startsWith('area:') ? group.slice(5) : ''
  const areaAndAge = row ? [groupArea && row.area === groupArea ? '' : row.area, row.age].filter(Boolean).join(' · ') : ''
  return [
    pod,
    // Listened to: no step (the player has where it is).
    podcasts.status(lj)?.session ? '' : s.left ? `step ${s.left}/${lj.j.steps.length}` : areaAndAge,
    refreshing.has(lj.key) ? 'Refreshing…' : staleCount(lj) ? '⚠ Stale' : '',
    s.newReplies ? replies(s.newReplies) : '',
    lj.readError ? '⚠ unreadable' : '',
    isNewJourney(lj) ? 'new' : '',
  ].filter(Boolean).join(' · ') || undefined
}

/** The icon says state only: walking, or new replies; a plain row otherwise (no stale ⚠: the step card says it, the
 *  storyline marks the step; nothing for listening: the player says it). */
function journeyIcon(s: JourneyState): vscode.ThemeIcon | undefined {
  if (s.active) return new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('codeNotes.noteRuler'))
  if (s.newReplies) return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('codeNotes.unreadForeground'))
  return undefined
}

/** The question, the summary, who wrote it, which steps are stale, unread replies ("new" is only a new journey: an
 *  unread answer is said in full here). */
function journeyTooltip(lj: LoadedJourney, s: JourneyState): string {
  const unreadReplies = s.newReplies ? `${plural(s.newReplies, 'unread reply', 'unread replies')} from Claude` : ''
  return [lj.j.question, lj.j.summary, provenance(lj).text, staleLine(lj), unreadReplies, podcastLine(lj)].filter(Boolean).join('\n')
}

/** The podcast's line in the tooltip: only for one that can't be played, and why (the row offers no ▶ then). */
function podcastLine(lj: LoadedJourney): string {
  const pod = podcasts.status(lj)
  return pod?.state === 'broken' ? `Podcast unavailable: ${pod.text}` : ''
}

/** The row's quiet podcast mark: its length, always (listening or not: the player has the state and the time). */
function podcastText(lj: LoadedJourney): string {
  const pod = podcasts.status(lj)
  return pod?.state === 'ok' ? `♪ ${clock(pod.duration ?? 0)}` : ''
}

/** Whether the row offers ▶ Listen: a podcast that plays, unless it is playing (paused, ▶ goes on where it was). */
function podcastContext(lj: LoadedJourney): string {
  const pod = podcasts.status(lj)
  if (!pod) return ''
  if (pod.state !== 'ok') return ';podcastBroken'
  return pod.playing ? ';podcastPlaying' : ';podcast'
}

/** What a screen reader says: the title, then where the walk is, unread replies, new. */
function journeyLabel(lj: LoadedJourney, s: JourneyState): string {
  const total = lj.j.steps.length
  const where = s.active ? `walking, step ${tourState.step} of ${total}` : s.left ? `left at step ${s.left} of ${total}` : ''
  const unreadReplies = s.newReplies ? plural(s.newReplies, 'unread reply', 'unread replies') : ''
  const pod = podcasts.status(lj)
  const listen = pod?.state === 'ok' ? `podcast ${clock(pod.duration ?? 0)}` : ''
  return [lj.j.title, where, listen, unreadReplies, isNewJourney(lj) ? 'new' : ''].filter(Boolean).join(', ')
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
  const open = `command:vscode.open?${encodeURIComponent(JSON.stringify([node.uri.toString()]))}`
  const tip = new vscode.MarkdownString(`${node.why.replace(/[\\`*_[\]<>]/g, '\\$&')}\n\n[Open file](${open})`)
  tip.isTrusted = { enabledCommands: ['vscode.open'] }
  item.tooltip = tip
  item.accessibilityInformation = { label: `${name}: can't be read` }
  item.command = { command: 'vscode.open', title: 'Open file', arguments: [node.uri] }
  item.contextValue = 'badJourney'
  return item
}

/**
 * A reveal in the Journeys view goes only to a node the view holds now and keeps holding: a reveal of a node that a
 * redraw dropped meanwhile (the "In this file" group of the file before) logged "Failed to resolve tree node".
 * So: once things settle, against the model as it is then, and only for groups that don't come and go with the editor
 * (and the view waits until it holds the row: viewSync.ts).
 */
let revealTimer: NodeJS.Timeout | undefined

function revealSettled(f: (m: ListModel) => Node | undefined, o: { select: boolean; expand: boolean }, wait: number): void {
  clearTimeout(revealTimer)
  if (!journeysView?.visible) return
  const file = activeRel()
  revealTimer = setTimeout(() => journeysTree.revealRow(() => (activeRel() === file ? f(listModel()) : undefined), o), wait)
}

/** The walk's row in Continue (where a walk is listed first): never deep in All, which scrolled the view away. */
export function revealJourneyRow(lj: LoadedJourney): void {
  const inContinue = (m: ListModel) => m.groups.find((x) => x.id === 'continue')?.keys.includes(lj.key)
  revealSettled((m) => (inContinue(m) ? journeyRowNode(lj, 'continue') : undefined), { select: true, expand: false }, 300)
}

/** The editor changed (and stayed): the Journeys view shows "In this file" (the top), not a row deep in All. */
export function revealHereGroup(): void {
  if (walk.touring()) return
  revealSettled((m) => {
    const g = m.groups.find((x) => x.id === 'here')
    return g ? jgroupNode(g) : undefined
  }, { select: false, expand: true }, 700)
}
