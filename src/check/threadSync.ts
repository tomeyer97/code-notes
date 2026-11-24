// The check's threads brought in line with its file, planned without I/O (threads.ts applies the plan): which threads
// go, which are made, and what each kept one gets (answers the file no longer keeps dropped, new messages added,
// resolved once done). No vscode here: unit-tested (test/checkThreadSync.test.ts).
import { findCompact } from '../core/anchors/compact'
import { captureAnchor, type Message, type NoteData } from '../core/format/noteModel'
import type { Note } from '../notes/store'
import { linkOf, sameQuestion, textHash } from './threadLink'
import { gradeBody, missingMessages, questionBody, showsGrade } from './threadText'
import { type Attempt, type Check, notDone, type QState, type Question } from './types'

/** What planning needs besides the check and its threads. */
export interface SyncContext {
  /** A question's state (the CLI's stateOf). */
  stateOf(q: Question): QState
  /** The author of an answer with no one named: the person here. */
  me: string
  /** The author of the question and the grades. */
  author: string
  /** The time given to a message that has none. */
  now: string
}

/** A kept thread's new messages and status (`messages`: all of them, in order). */
export interface ThreadUpdate { note: Note; messages: Message[]; status: NoteData['status'] }

export interface SyncPlan {
  /** Threads whose question went or changed: a thread never stands for a question it didn't show. */
  trash: Note[]
  /** Questions with no thread yet, and the messages their thread starts with. */
  create: { q: Question; messages: Message[] }[]
  update: ThreadUpdate[]
}

/** The plan for `threads` (the notes linked to this check file) against `check`. */
export function planSync(check: Check, threads: readonly Note[], ctx: SyncContext): SyncPlan {
  const plan: SyncPlan = { trash: [], create: [], update: [] }
  const questions = new Map(check.questions.map((q) => [q.id, q]))
  // Each question's thread: the first one kept (as a lookup of the store finds it).
  const byQuestion = new Map<string, Note>()
  for (const n of threads) {
    const q = questions.get(linkOf(n)?.q ?? '')
    if (!q || !sameQuestion(n, q)) plan.trash.push(n)
    else if (!byQuestion.has(q.id)) byQuestion.set(q.id, n)
  }
  for (const q of check.questions) {
    const want = messagesOf(q, check, ctx)
    const n = byQuestion.get(q.id)
    if (!n) { plan.create.push({ q, messages: want }); continue }
    const u = updateOf(n, q, want, ctx)
    if (u) plan.update.push(u)
  }
  return plan
}

/** What a kept thread gets; undefined: nothing. */
function updateOf(n: Note, q: Question, want: Message[], ctx: SyncContext): ThreadUpdate | undefined {
  // An answer the file no longer keeps (a later one superseded it): its copy in the note goes too.
  const kept = withoutSuperseded(n.data.messages, q)
  const have = kept ?? n.data.messages
  const missing = missingMessages(have, want)
  if (!kept && !missing.length) return undefined
  const messages = [...have, ...missing.map((m) => ({ ...m, at: m.at ?? ctx.now }))]
  // Done: resolved quietly (the ✓ in the thread says it; no "Resolved" line under it).
  const done = missing.length > 0 && !notDone(ctx.stateOf(q))
  return { note: n, messages, status: done && n.data.status === 'open' ? 'resolved' : n.data.status }
}

/**
 * The thread messages a question's file entry stands for: the question, then each answer and its grade. A superseded
 * answer (not kept in the file) is left out with its grade, except an explanation: that is the lesson.
 */
export function messagesOf(q: Question, check: Check, ctx: Pick<SyncContext, 'me' | 'author'>): Message[] {
  const out: Message[] = [{ author: ctx.author, role: 'agent', body: questionBody(q) }]
  let explained = false
  for (const a of q.attempts ?? []) {
    if (a.answer !== undefined) {
      const author = a.by?.name ?? check.answeredBy?.name ?? ctx.me
      out.push({ author, role: 'human', body: a.answer, ...(a.at ? { at: a.at } : {}) })
    }
    if (showsGrade(a)) {
      const body = gradeBody(a, { restatement: explained })
      out.push({ author: ctx.author, role: 'agent', body, ...(a.gradedAt ? { at: a.gradedAt } : {}) })
    }
    if (a.verdict === 'explained') explained = true
  }
  return out
}

/**
 * A thread's messages without its copies of answers the file no longer keeps (a later one superseded them), each with
 * the grade under it (an explanation stays); undefined: none to drop. The superseded copies are the thread's answers,
 * before its last kept one, that the file doesn't keep. Messages carry no attempt id, so they are matched by order:
 * the newest such copy stands for the newest superseded attempt, and so on back.
 */
export function withoutSuperseded(messages: readonly Message[], q: Question): Message[] | undefined {
  const attempts = q.attempts ?? []
  const superseded = attempts.filter((a) => a.answer === undefined)
  const keptAnswers = new Set(attempts.flatMap((a) => (a.answer !== undefined ? [a.answer] : [])))
  const isAnswer = (m: Message, i: number) => i > 0 && m.role === 'human'
  let lastKept = -1
  messages.forEach((m, i) => { if (m.role === 'human' && keptAnswers.has(m.body)) lastKept = i })
  if (!superseded.length || lastKept < 0) return undefined
  const copies = messages.flatMap((m, i) => (i < lastKept && isAnswer(m, i) && !keptAnswers.has(m.body) ? [i] : []))
  if (!copies.length) return undefined
  const drop = new Set<number>()
  copies.reverse().forEach((answer, k) => {
    const attempt: Attempt | undefined = superseded.at(-1 - k)
    drop.add(answer)
    // Its grade (the next message) goes with it, unless it explained.
    if (messages[answer + 1]?.role === 'agent' && attempt?.verdict !== 'explained') drop.add(answer + 1)
  })
  return messages.filter((_m, i) => !drop.has(i))
}

/** What a new thread is made with besides its question and its file's lines. */
export interface NewThread { id: string; at: string; checkFile: string; session: string; done: boolean; messages: Message[] }

/** Where a new thread goes and what it is, from its file's lines (`lines`): all but what the store gives (uri, folder). */
export function threadNoteData(q: Question, lines: string[], o: NewThread): NoteData {
  let start = q.start ?? 1, end = q.end ?? start
  // Found again by its anchor when the code moved.
  if (!q.target && q.anchor) {
    const f = findCompact(lines, q.anchor, start - 1)
    if (f.state !== 'gone') { start = f.loc.start + 1; end = f.loc.end + 1 }
  }
  start = clamp(start, 1, lines.length)
  end = clamp(end, start, lines.length)
  return {
    id: o.id, file: q.file, range: { start, end },
    anchor: q.target ? { text: '', before: '', after: '' } : captureAnchor(lines, start - 1, end - 1),
    session: o.session, status: o.done ? 'resolved' : 'open', stale: false, createdAt: o.at,
    messages: o.messages.map((m) => ({ ...m, at: m.at ?? o.at })),
    ...(q.target ? { target: 'file' as const } : {}),
    extra: { check: { file: o.checkFile, q: q.id, h: textHash(q) } },
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(lo, v), hi)
