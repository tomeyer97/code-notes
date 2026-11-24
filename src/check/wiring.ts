// The understanding check (src/check/) wired to the rest of the extension: what its host gets (the notes, Claude, the
// tour and the journeys), its commands, and the check's side of code links and D / A.

import * as vscode from 'vscode'
import { byId, cfg, log, mapPanel, notes, now, provide, state, store, understanding } from '../app'
import { askAbout } from '../ask/run'
import { claudeCli } from '../ask/settings'
import { claudeAllowed } from '../ask/trust'
import { me } from '../notes/identity'
import { shape, shapeOf } from '../notes/changedOnDisk'
import { newId } from '../notes/create'
import { addReply } from '../notes/reply'
import { focusReply, reveal } from '../notes/reveal'
import { refreshAll } from '../refresh'
import { markRead, setSeen, unread } from '../notes/seen'
import { journeysTree } from '../sidebar/journeysTree'
import { Note } from '../notes/store'
import { noteOfThread, revealed } from '../threads/sync'
import { currentTour, openCheckpoint, tourChanged } from '../tour/checkTour'
import { walkJourney } from '../tour/commands'
import { card, walk } from '../tour/instances'
import { journeySkill } from '../write/claudeRun'
import { isConcernAction } from './concern'
import { CheckController } from './controller'

/** The understanding check: questions about this branch's change, answered in their threads (src/check/). */
export function createUnderstanding(context: vscode.ExtensionContext): void {
  provide({ understanding: new CheckController({
    log, store, extUri: context.extensionUri, memento: state, me, now, newId,
    revealed: () => revealed.id,
    focusReply,
    askAbout,
    cli: claudeCli,
    allowed: (what) => claudeAllowed(what),
    model: checkModel,
    changed: noteChanged,
    addReply: (n, text) => addReply(n, text),
    reveal: (n, col, keep) => reveal(n, col ?? walk.codeColumn(), keep),
    refresh: () => refreshAll(),
    codeColumn: walk.codeColumn,
    listChanged,
    journeySkill: firstFolderSkill,
    tourChanged,
    walkTour,
    openInTour,
  }) })
  context.subscriptions.push(understanding!)
}

/** The model the check grades with: its own setting, else Claude's. */
const checkModel = () => cfg().get<string>('understanding.model') || cfg().get<string>('claude.model') || undefined

/** A note the check created or changed: read if just made (its question is the check's, not news) or shown now. */
async function noteChanged(n: Note, created: boolean): Promise<void> {
  if (created) await setSeen([[n.data.id, n.data.messages.length]])
  shape.set(n.data.id, shapeOf(n))
  if (revealed.id === n.data.id) await markRead([n], n)
  refreshAll()
}

/** The check's row in the journeys list changed: the list, the map, the lenses. */
function listChanged(): void {
  journeysTree.refresh()
  mapPanel.update()
  card.lensChanged.fire()
}

/** The code-journey skill of the first workspace folder. */
function firstFolderSkill(): string | undefined {
  const f = vscode.workspace.workspaceFolders?.[0]
  return f ? journeySkill(f) : undefined
}

/** The check's tour walked (where it was left); false when it has no steps. */
async function walkTour(): Promise<boolean> {
  const lj = currentTour()
  if (!lj || !lj.j.steps.length) return false
  await walkJourney(lj)
  return true
}

/** Question `id`'s stop of the check's tour opened; false without a tour. */
async function openInTour(id: string): Promise<boolean> {
  const lj = currentTour()
  return lj ? openCheckpoint(lj, id) : false
}


/** Ctrl+Enter in a question's thread: the answer is saved to the check's file and graded. */
export const answerCheck = async (r: vscode.CommentReply) => {
  const n = noteOfThread(r.thread)
  if (n && r.text.trim()) await understanding!.answer(n, r.text)
}


/** codeNotes.checkConcern (a concern row's links): `action` on note `id`'s concern; `reason`: a dismissal's. */
export const checkConcern = async (id?: string, action?: string, reason?: string) => {
  const n = typeof id === 'string' ? byId(id) : undefined
  if (!n || !isConcernAction(action)) return
  await understanding!.concerns.act(n, action, typeof reason === 'string' ? reason : undefined)
}

/** codeNotes.gradeCheck (Try again): note `id`'s question graded again. */
export const gradeCheck = async (id?: string) => {
  const n = typeof id === 'string' ? byId(id) : undefined
  const q = n && understanding!.qidOf(n)
  if (q) await understanding!.grader.grade(q)
}

/** Back from a check thread's code link: the question, with the keyboard in its answer box (never in the code). */
export async function backToQuestion(n: Note): Promise<void> {
  const q = understanding?.qidOf(n)
  if (q) { await understanding!.open(q); return }
  await reveal(n, walk.codeColumn())
  await focusReply(n)
}

/** A code link key of a check thread ("check|<note id>|<message index>"): its note and that message's links. */
export function checkLinkNote(key: string): { n: Note; links: ReturnType<CheckController['linksIn']> } | undefined {
  const m = /^check\|([^|]+)\|(\d+)$/.exec(key)
  const n = m ? byId(m[1]) : undefined
  return n && understanding ? { n, links: understanding.linksIn(n, Number(m![2])) } : undefined
}

/**
 * Whether D (next) and A (previous) walk the check's open questions, outside a tour: while it has some, when nothing
 * is unread or the thread shown is one of its questions. (Else they step through unread replies.)
 */
export function checkStepping(): boolean {
  if (!understanding?.hasOpen()) return false
  const nothingUnread = !notes().some((n) => unread(n) > 0)
  const shown = revealed.id ? byId(revealed.id) : undefined
  return nothingUnread || (!!shown && understanding.isCheck(shown))
}
