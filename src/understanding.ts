// The understanding check (src/check/) wired to the notes, the tour and the journeys; its commands.

import * as vscode from 'vscode'
import { byId, cfg, log, mapPanel, notes, now, provide, state, store, understanding } from './app'
import { askAbout, claudeAllowed, claudeCli } from './ask'
import { Understanding } from './check/index'
import { me } from './identity'
import { newId } from './notes/create'
import { focusReply, reveal } from './notes/reveal'
import { unread } from './seen'
import { addReply } from './notes/reply'
import { resolve } from './notes/status'
import { refreshAll } from './refresh'
import { markRead, setSeen } from './seen'
import { journeysTree } from './sidebar/journeysTree'
import { shape, shapeOf } from './notes/changedOnDisk'
import { noteOfThread, revealed } from './threads/sync'
import { currentTour, openCheckpoint, tourChanged } from './tour/checkTour'
import { walkJourney } from './tour/open'
import { card, tour, walk } from './tour/tour'
import { journeySkill } from './write/writer'
import { Note } from './store'

/** Back from a check thread's code link: the question, with the keyboard in its answer box (never in the code). */
export async function backToQuestion(n: Note): Promise<void> {
  const q = understanding?.qidOf(n)
  if (q) { await understanding!.open(q); return }
  await reveal(n, walk.codeColumn())
  await focusReply(n)
}

/** A code link key of a check thread ("check|<note id>|<message index>"): its note and that message's links. */
export function checkLinkNote(key: string): { n: Note; links: ReturnType<NonNullable<typeof understanding>['linksIn']> } | undefined {
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

/** Ctrl+Enter in a question's thread: the answer is saved to the check's file and graded. */
export const answerCheck = async (r: vscode.CommentReply) => {
  const n = noteOfThread(r.thread)
  if (n && r.text.trim()) await understanding!.answer(n, r.text)
}

export const checkConcern = async (id?: string, action?: string, reason?: string) => {
  const n = typeof id === 'string' ? byId(id) : undefined
  if (n && (action === 'fix' || action === 'todo' || action === 'flag' || action === 'dismiss' || action === 'fixed')) await understanding!.concern(n, action, typeof reason === 'string' ? reason : undefined)
}

export const gradeCheck = async (id?: string) => {
  const n = typeof id === 'string' ? byId(id) : undefined
  const q = n && understanding!.qidOf(n)
  if (q) await understanding!.grade(q)
}

/** The understanding check: questions about this branch's change, answered in their threads (src/check/). */
export function createUnderstanding(context: vscode.ExtensionContext): void {
  provide({ understanding: new Understanding({
    log, store, extUri: context.extensionUri, memento: state, me, now, newId,
    revealed: () => revealed.id,
    focusReply,
    askAbout,
    cli: claudeCli,
    allowed: (what) => claudeAllowed(what),
    model: () => cfg().get<string>('understanding.model') || cfg().get<string>('claude.model') || undefined,
    changed: async (n, created) => {
      if (created) await setSeen([[n.data.id, n.data.messages.length]])
      shape.set(n.data.id, shapeOf(n))
      if (revealed.id === n.data.id) await markRead([n], n)
      refreshAll()
    },
    addReply: (n, text) => addReply(n, text),
    resolve: (n) => resolve([n]),
    reveal: (n, col, keep) => reveal(n, col ?? walk.codeColumn(), keep),
    refresh: () => refreshAll(),
    codeColumn: walk.codeColumn,
    listChanged: () => { journeysTree.refresh(); mapPanel.update(); card.lensChanged.fire() },
    journeySkill: () => { const f = vscode.workspace.workspaceFolders?.[0]; return f ? journeySkill(f) : undefined },
    tourChanged,
    walkTour: async () => { const lj = currentTour(); if (!lj || !lj.j.steps.length) return false; await walkJourney(lj); return true },
    openInTour: async (id) => { const lj = currentTour(); return lj ? openCheckpoint(lj, id) : false },
    tourNext: async (id) => { const lj = walk.tourJourney(); if (!lj?.check || !walk.touring() || tour.cp !== id) return false; await walk.stepBy(1); return true },
  }) })
  context.subscriptions.push(understanding!)
}
