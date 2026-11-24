// The understanding check (src/check/) wired to the rest of the extension: what its host gets (the notes, Claude, the
// tour and the journeys), its commands, and the check's side of code links and D / A.

import * as vscode from 'vscode'
import { byId, visibleNotes } from '../notes/visible'
import { cfg } from '../platform/settings'
import { log, now, stored } from '../platform/host'
import { askAbout } from '../ask/run'
import { claudeCli } from '../ask/settings'
import { claudeAllowed } from '../ask/trust'
import { me } from '../notes/identity'
import { newId } from '../notes/create'
import { addReply } from '../notes/reply'
import { focusReply, reveal } from '../notes/reveal'
import { notesChanged, selection } from '../notes/model'
import { markRead, setSeen, unread } from '../notes/seen'
import { Note } from '../notes/store'
import { noteOfThread } from '../threads/sync'
import { journeySkill } from '../write/claudeRun'
import { isConcernAction } from './concern'
import { CheckController } from './controller'
import type { CheckHost } from './host'
import { CheckPorts, checkPorts, controller, started } from './ports'
import { parseCheckLinkKey } from '../platform/keys'

/** The check's host (src/check/host.ts): the notes, Claude, the tour and the journeys, from its ports. */
export function checkHost(extUri: vscode.Uri, { store, tour }: CheckPorts): CheckHost {
  return {
    log: log(), store, extUri, stored: stored(), me, now, newId,
    revealed: () => selection().revealed,
    focusReply,
    askAbout,
    cli: claudeCli,
    allowed: (what) => claudeAllowed(what),
    model: checkModel,
    changed: noteChanged,
    addReply: (n, text) => addReply(n, text),
    reveal: (n, col, keep) => reveal(n, col ?? tour.codeColumn(), keep),
    refresh: () => notesChanged({ kind: 'activity' }),
    codeColumn: () => tour.codeColumn(),
    listChanged,
    journeySkill: firstFolderSkill,
    tourChanged: (check, file, branch) => tour.checkTourChanged(check, file, branch),
    walkTour,
    openInTour,
  }
}

/** The model the check grades with: its own setting, else Claude's. */
const checkModel = () => cfg().get<string>('understanding.model') || cfg().get<string>('claude.model') || undefined

/** A note the check created or changed: read if just made (its question is the check's, not news) or shown now. */
async function noteChanged(n: Note, created: boolean): Promise<void> {
  if (created) await setSeen([[n.data.id, n.data.messages.length]])
  if (selection().revealed === n.data.id) await markRead([n], n)
  notesChanged({ kind: 'activity', ids: [n.data.id] })
}

/** The check's row in the journeys list changed: the list, the map, the lenses. */
function listChanged(): void {
  checkPorts().refreshJourneyList()
  checkPorts().mapPanel.update()
  checkPorts().tour.lensesChanged()
}

/** The code-journey skill of the first workspace folder. */
function firstFolderSkill(): string | undefined {
  const f = vscode.workspace.workspaceFolders?.[0]
  return f ? journeySkill(f) : undefined
}

/** The check's tour walked (where it was left); false when it has no steps. */
async function walkTour(): Promise<boolean> {
  const lj = checkPorts().tour.checkTour()
  if (!lj || !lj.j.steps.length) return false
  await checkPorts().tour.walkJourney(lj)
  return true
}

/** Question `id`'s stop of the check's tour opened; false without a tour. */
async function openInTour(id: string): Promise<boolean> {
  const lj = checkPorts().tour.checkTour()
  return lj ? checkPorts().tour.openCheckpoint(lj, id) : false
}


/** Ctrl+Enter in a question's thread: the answer is saved to the check's file and graded. */
export const answerCheck = async (r: vscode.CommentReply) => {
  const n = noteOfThread(r.thread)
  if (n && r.text.trim()) await controller().answer(n, r.text)
}


/** codeNotes.checkConcern (a concern row's links): `action` on note `id`'s concern; `reason`: a dismissal's. */
export const checkConcern = async (id?: string, action?: string, reason?: string) => {
  const n = typeof id === 'string' ? byId(id) : undefined
  if (!n || !isConcernAction(action)) return
  await controller().concerns.act(n, action, typeof reason === 'string' ? reason : undefined)
}

/** codeNotes.gradeCheck (Try again): note `id`'s question graded again. */
export const gradeCheck = async (id?: string) => {
  const n = typeof id === 'string' ? byId(id) : undefined
  const q = n && controller().qidOf(n)
  if (q) await controller().grader.grade(q)
}

/** Back from a check thread's code link: the question, with the keyboard in its answer box (never in the code). */
export async function backToQuestion(n: Note): Promise<void> {
  const q = started()?.qidOf(n)
  if (q) { await controller().open(q); return }
  await reveal(n, checkPorts().tour.codeColumn())
  await focusReply(n)
}

/** A code link key of a check thread (platform/keys.ts checkLinkKey): its note and that message's links. */
export function checkLinkNote(key: string): { n: Note; links: ReturnType<CheckController['linksIn']> } | undefined {
  const k = parseCheckLinkKey(key)
  const n = k ? byId(k.noteId) : undefined
  const check = started()
  return n && k && check ? { n, links: check.linksIn(n, k.index) } : undefined
}

/**
 * Whether D (next) and A (previous) walk the check's open questions, outside a tour: while it has some, when nothing
 * is unread or the thread shown is one of its questions. (Else they step through unread replies.)
 */
export function checkStepping(): boolean {
  const check = started()
  if (!check?.hasOpen()) return false
  const nothingUnread = !visibleNotes().some((n) => unread(n) > 0)
  const revealed = selection().revealed
  const shown = revealed ? byId(revealed) : undefined
  return nothingUnread || (!!shown && check.isCheck(shown))
}
