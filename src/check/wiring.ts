// The understanding check (src/check/) wired to the rest of the extension: what its host gets (the notes, Claude, the
// tour), its commands, the check's side of code links and D / A, and the journeys list following its changes. Each
// function gets the controller or the ports it uses (check/index.ts passes them): no global.

import * as vscode from 'vscode'
import { byId, visibleNotes } from '../notes/visible'
import { log, now, stored } from '../platform/host'
import { askAbout } from '../ask/run'
import type { AskHandler } from '../ask/handlers'
import { claudeCli } from '../ask/settings'
import { agentRunner } from '../platform/agent/runner'
import { me } from '../notes/identity'
import { newId } from '../notes/create'
import { addReply } from '../notes/reply'
import { focusReply, reveal } from '../notes/reveal'
import { notesChanged, selection } from '../notes/model'
import { markRead, setSeen, unread } from '../notes/seen'
import { Note } from '../notes/store'
import { noteOfThread } from '../threads/sync'
import { journeySkill } from '../write/claudeRun'
import { checkAskHint } from './prompts'
import type { CheckController } from './controller'
import type { CheckHost } from './host'
import type { CheckPorts } from './ports'
import { parseCheckConcernArgs, parseNoteIdArg, type CheckQuery } from './query'
import { parseCheckLinkKey } from '../platform/keys'

/** The check's host (src/check/host.ts): the notes, Claude, the tour and the journeys, from its ports. */
export function checkHost(extUri: vscode.Uri, { store, tour }: CheckPorts): CheckHost {
  return {
    log: log(), store, extUri, stored: stored(), me, now, newId,
    revealed: () => selection().revealed,
    focusReply,
    askAbout,
    cli: claudeCli,
    allowed: (what) => agentRunner().allowed(what),
    model: checkModel,
    changed: noteChanged,
    // The thread's status as it is: the check resolves and opens its threads itself (no "Reopened" by the person).
    addReply: (n, text) => addReply(n, text, n.data.status),
    reveal: (n, col, keep) => reveal(n, col ?? tour.codeColumn(), keep),
    refresh: () => notesChanged({ kind: 'activity' }),
    codeColumn: () => tour.codeColumn(),
    journeySkill: firstFolderSkill,
    tourChanged: (check, file, branch) => tour.checkTourChanged(check, file, branch),
    walkTour: () => walkTour(tour),
    openInTour: (id) => openInTour(tour, id),
  }
}

/** The model the check grades with: its own setting, else Claude's. */
const checkModel = () => agentRunner().model('check')

/** A note the check created or changed: read if just made (its question is the check's, not news) or shown now. */
async function noteChanged(n: Note, created: boolean): Promise<void> {
  if (created) await setSeen([[n.data.id, n.data.messages.length]])
  if (selection().revealed === n.data.id) await markRead([n], n)
  notesChanged({ kind: 'activity', ids: [n.data.id] })
}

/** The check changed (controller.onDidChange): its row in the journeys list, the map, the lenses follow. */
export function followCheck({ refreshJourneyList, mapPanel, tour }: CheckPorts): () => void {
  return () => {
    refreshJourneyList()
    mapPanel.update()
    tour.lensesChanged()
  }
}

/** The code-journey skill of the first workspace folder. */
function firstFolderSkill(): string | undefined {
  const f = vscode.workspace.workspaceFolders?.[0]
  return f ? journeySkill(f) : undefined
}

/** The check's tour walked (where it was left); false when it has no steps. */
async function walkTour(tour: CheckPorts['tour']): Promise<boolean> {
  const lj = tour.checkTour()
  if (!lj || !lj.j.steps.length) return false
  await tour.walkJourney(lj)
  return true
}

/** Question `id`'s stop of the check's tour opened; false without a tour. */
async function openInTour(tour: CheckPorts['tour'], id: string): Promise<boolean> {
  const lj = tour.checkTour()
  return lj ? tour.openCheckpoint(lj, id) : false
}

/**
 * Ask Claude on a check question: what do you want to know? The answer goes in a note of its own about the question's
 * code, never in the check's thread, and Claude is told not to give the check's answer away.
 */
export const checkAskHandler = (check: Pick<CheckQuery, 'isCheck' | 'questionOf' | 'branchOf'>): AskHandler => ({
  owns: (n) => check.isCheck(n),
  hint: checkAskHint,
  ask: async (n, text) => {
    const q = check.questionOf(n)
    const box = { title: 'Ask Claude about this code', prompt: 'Claude explains the code; the check question stays yours.', placeHolder: 'What do you want to know?' }
    const ask = text?.trim() || await vscode.window.showInputBox(box)
    if (!ask?.trim()) return
    const extra = { ...(q ? { checkAsk: q.text } : {}), ...check.branchOf(n) }
    await askAbout(n.data.file, n.data.range.start, n.data.range.end, ask.trim(), extra)
  },
})

/** The check's commands that take arguments (a reply box, a thread's links). */
export function checkCommands(check: CheckController) {
  return {
    /** Ctrl+Enter in a question's thread: the answer is saved to the check's file and graded. */
    answerCheck: async (r: vscode.CommentReply) => {
      const n = noteOfThread(r.thread)
      if (n && r.text.trim()) await check.answer(n, r.text)
    },
    /** codeNotes.checkConcern (a concern row's links): `action` on note `id`'s concern; `reason`: a dismissal's. */
    checkConcern: async (id?: unknown, action?: unknown, reason?: unknown) => {
      const a = parseCheckConcernArgs(id, action, reason)
      const n = a && byId(a.id)
      if (a && n) await check.concern(n, a.action, a.reason)
    },
    /** codeNotes.gradeCheck (Try again): note `id`'s question graded again. */
    gradeCheck: async (id?: unknown) => {
      const noteId = parseNoteIdArg(id)
      const n = noteId !== undefined ? byId(noteId) : undefined
      if (n) await check.regrade(n)
    },
  }
}

/** The check's side of code links: a check thread's link key, and the way back from a link to its question. */
export function checkLinks(check: Pick<CheckController, 'qidOf' | 'open' | 'linksIn'>, tour: CheckPorts['tour']) {
  return {
    /** A code link key of a check thread (platform/keys.ts checkLinkKey): its note and that message's links. */
    noteOf(key: string): { n: Note; links: ReturnType<CheckController['linksIn']> } | undefined {
      const k = parseCheckLinkKey(key)
      const n = k ? byId(k.noteId) : undefined
      return n && k ? { n, links: check.linksIn(n, k.index) } : undefined
    },
    /** Back from a check thread's code link: the question, with the keyboard in its answer box (never in the code). */
    async backToQuestion(n: Note): Promise<void> {
      const q = check.qidOf(n)
      if (q) { await check.open(q); return }
      await reveal(n, tour.codeColumn())
      await focusReply(n)
    },
  }
}

/**
 * Whether D (next) and A (previous) walk the check's open questions, outside a tour: while it has some, when nothing
 * is unread or the thread shown is one of its questions. (Else they step through unread replies.)
 */
export function checkStepping(check: Pick<CheckController, 'hasOpen' | 'isCheck'>): boolean {
  if (!check.hasOpen()) return false
  const nothingUnread = !visibleNotes().some((n) => unread(n) > 0)
  const revealed = selection().revealed
  const shown = revealed ? byId(revealed) : undefined
  return nothingUnread || (!!shown && check.isCheck(shown))
}
