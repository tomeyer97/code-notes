// The understanding check (src/check/) wired to the notes, the tour and the journeys; its commands.

import * as vscode from 'vscode'
import { byId, cfg, log, mapPanel, now, provide, state, store, understanding } from './app'
import { askAbout, claudeAllowed } from './ask'
import { CheckController } from './check/controller'
import { findCli } from './claudeCli'
import { me } from './identity'
import { newId } from './notes/create'
import { focusReply, reveal } from './notes/reveal'
import { addReply } from './notes/status'
import { refreshAll } from './refresh'
import { markRead, setSeen } from './seen'
import { journeysTree } from './sidebar/journeysTree'
import { noteOfThread, revealed, shape, shapeOf } from './threads/threads'
import { currentTour, openCheckpoint, tourChanged } from './tour/checkTour'
import { walkJourney } from './tour/open'
import { card, walk } from './tour/tour'
import { journeySkill } from './write/writer'

/** Ctrl+Enter in a question's thread: the answer is saved to the check's file and graded. */
export const answerCheck = async (r: vscode.CommentReply) => {
  const n = noteOfThread(r.thread)
  if (n && r.text.trim()) await understanding!.answer(n, r.text)
}

export const checkConcern = async (id?: string, action?: string, reason?: string) => {
  const n = typeof id === 'string' ? byId(id) : undefined
  if (n && (action === 'fix' || action === 'todo' || action === 'flag' || action === 'dismiss' || action === 'fixed')) await understanding!.concerns.act(n, action, typeof reason === 'string' ? reason : undefined)
}

export const gradeCheck = async (id?: string) => {
  const n = typeof id === 'string' ? byId(id) : undefined
  const q = n && understanding!.qidOf(n)
  if (q) await understanding!.grader.grade(q)
}

/** The understanding check: questions about this branch's change, answered in their threads (src/check/). */
export function createUnderstanding(context: vscode.ExtensionContext): void {
  provide({ understanding: new CheckController({
    log, store, extUri: context.extensionUri, memento: state, me, now, newId,
    revealed: () => revealed.id,
    focusReply,
    askAbout,
    cli: () => findCli(cfg().get<string>('claude.path') || undefined),
    allowed: (what) => claudeAllowed(what),
    model: () => cfg().get<string>('understanding.model') || cfg().get<string>('claude.model') || undefined,
    changed: async (n, created) => {
      if (created) await setSeen([[n.data.id, n.data.messages.length]])
      shape.set(n.data.id, shapeOf(n))
      if (revealed.id === n.data.id) await markRead([n], n)
      refreshAll()
    },
    addReply: (n, text) => addReply(n, text),
    reveal: (n, col, keep) => reveal(n, col ?? walk.codeColumn(), keep),
    refresh: () => refreshAll(),
    codeColumn: walk.codeColumn,
    listChanged: () => { journeysTree.refresh(); mapPanel.update(); card.lensChanged.fire() },
    journeySkill: () => { const f = vscode.workspace.workspaceFolders?.[0]; return f ? journeySkill(f) : undefined },
    tourChanged,
    walkTour: async () => { const lj = currentTour(); if (!lj || !lj.j.steps.length) return false; await walkJourney(lj); return true },
    openInTour: async (id) => { const lj = currentTour(); return lj ? openCheckpoint(lj, id) : false },
  }) })
  context.subscriptions.push(understanding!)
}
