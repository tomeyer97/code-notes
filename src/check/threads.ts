// The check's questions as note threads: a view of the check file, kept in sync with it. Every question has its
// thread; answers and grades written elsewhere (the CLI, another window) are added to it; a thread whose question
// changed or went is removed (a thread never stands for a question it didn't show).
import * as fs from 'fs'
import * as path from 'path'
import { findCompact } from '../compact'
import type { Note, NoteData } from '../store'
import { Attempt, Check, Question, gradeBody, missingMessages, notDone, questionBody } from '../checkModel'
import { AUTHOR, SESSION } from './constants'
import { linkOf, sameQuestion, textHash } from './links'
import type { Understanding } from './index'

type Messages = NoteData['messages']

export class CheckThreads {
  /** Check threads graded in this window: they stay open where they are (the reply is read next to the code). */
  readonly graded = new Set<string>()

  constructor(private u: Understanding) {}

  private get host() { return this.u.host }

  /** The thread of question `id` of the check checked out now. */
  noteOf(id: string): Note | undefined {
    const file = this.u.st?.file
    return this.host.store.all().find((n) => linkOf(n)?.q === id && linkOf(n)?.file === file)
  }

  /** Brings every thread of `check` in line with it (see the top of this file). */
  async sync(check: Check): Promise<void> {
    const file = this.u.st!.file
    for (const n of this.host.store.all().filter((x) => linkOf(x)?.file === file)) {
      const q = check.questions.find((x) => x.id === linkOf(n)!.q)
      if (!q || !sameQuestion(n, q)) {
        this.graded.delete(n.data.id)
        await this.host.store.trash(n)
        this.host.refresh()
      }
    }
    for (const q of check.questions) {
      const want = this.messagesOf(q, check)
      const n = this.noteOf(q.id)
      if (!n) { await this.create(q, want); continue }
      // An answer the file no longer keeps (a later one superseded it): its copy in the note goes too.
      if (this.dropSuperseded(n, q) && await this.host.store.save(n)) await this.host.changed(n, false)
      const missing = missingMessages(n.data.messages, want)
      if (!missing.length) continue
      n.data.messages.push(...missing.map((m) => ({ ...m, at: m.at ?? this.host.now() })))
      // Done: resolved quietly (the ✓ in the thread says it; no "Resolved" line under it).
      if (!notDone(this.u.cli.stateOf(q)) && n.data.status === 'open') n.data.status = 'resolved'
      if (await this.host.store.save(n)) await this.host.changed(n, false)
    }
  }

  /**
   * The thread messages a question's file entry stands for: the question, then each answer and its grade. A superseded
   * answer (not kept in the file) is left out with its grade, except an explanation: that is the lesson.
   */
  private messagesOf(q: Question, check: Check): Messages {
    const out: Messages = [{ author: AUTHOR, role: 'agent', body: questionBody(q) }]
    let explained = false
    for (const a of q.attempts ?? []) {
      if (a.answer !== undefined) {
        out.push({ author: a.by?.name ?? check.answeredBy?.name ?? this.host.me(), role: 'human', body: a.answer, ...(a.at ? { at: a.at } : {}) })
      }
      if (a.verdict && (a.answer !== undefined || a.verdict === 'explained')) {
        out.push({ author: AUTHOR, role: 'agent', body: gradeBody(a, { restatement: explained }), ...(a.gradedAt ? { at: a.gradedAt } : {}) })
      }
      if (a.verdict === 'explained') explained = true
    }
    return out
  }

  /**
   * A thread's copies of answers the file no longer keeps (a later one superseded them) go, with the grade under each
   * (an explanation stays). They are the thread's answers before the last kept one that aren't kept; matched from the
   * last, the n-th such answer from the end is the n-th superseded attempt from the end.
   */
  private dropSuperseded(n: Note, q: Question): boolean {
    const superseded = (q.attempts ?? []).filter((a) => a.answer === undefined)
    const kept = new Set((q.attempts ?? []).flatMap((a) => (a.answer !== undefined ? [a.answer] : [])))
    const ms = n.data.messages
    let lastKept = -1
    ms.forEach((m, i) => { if (m.role === 'human' && kept.has(m.body)) lastKept = i })
    if (!superseded.length || lastKept < 0) return false
    const old = ms.flatMap((m, i) => (i > 0 && i < lastKept && m.role === 'human' && !kept.has(m.body) ? [i] : []))
    if (!old.length) return false
    // From the last: each old answer's message index with the superseded attempt it stands for.
    const pairs: { answer: number; attempt: Attempt | undefined }[] = old.reverse().map((i, k) => ({ answer: i, attempt: superseded.at(-1 - k) }))
    const drop = new Set<number>()
    for (const { answer, attempt } of pairs) {
      drop.add(answer)
      // Its grade (the next message) goes with it, unless it explained.
      if (ms[answer + 1]?.role === 'agent' && attempt?.verdict !== 'explained') drop.add(answer + 1)
    }
    n.data.messages = ms.filter((_m, i) => !drop.has(i))
    return true
  }

  /** A new thread for question `q` on its lines (found again by its anchor when the code moved). */
  private async create(q: Question, messages: Messages): Promise<void> {
    const u = this.u, folder = u.folder!
    let lines: string[]
    try { lines = fs.readFileSync(path.join(folder.uri.fsPath, q.file), 'utf8').split(/\r?\n/) } catch { return /* its file is gone */ }
    let start = q.start ?? 1, end = q.end ?? start
    if (!q.target && q.anchor) {
      const f = findCompact(lines, q.anchor, start - 1)
      if (f.state !== 'gone') { start = f.loc.start + 1; end = f.loc.end + 1 }
    }
    start = clamp(start, 1, lines.length)
    end = clamp(end, start, lines.length)
    const at = this.host.now()
    const id = this.host.newId()
    const done = !notDone(u.cli.stateOf(q))
    const n: Note = {
      folder, uri: this.host.store.uriFor(folder, id),
      data: {
        id, file: q.file, range: { start, end },
        anchor: q.target ? { text: '', before: '', after: '' } : anchorOf(lines, start, end),
        session: SESSION(u.st!.branch), status: done ? 'resolved' : 'open', stale: false, createdAt: at,
        messages: messages.map((m) => ({ ...m, at: m.at ?? at })),
        ...(q.target ? { target: 'file' as const } : {}),
        extra: { check: { file: u.st!.file, q: q.id, h: textHash(q) } },
      },
    }
    if (await this.host.store.save(n)) await this.host.changed(n, true)
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(lo, v), hi)

/** A note's anchor on lines start..end (1-based): their text, two lines before and two after (the note file format). */
function anchorOf(lines: string[], start: number, end: number): { text: string; before: string; after: string } {
  return {
    text: lines.slice(start - 1, end).join('\n'),
    before: lines.slice(Math.max(0, start - 3), start - 1).join('\n'),
    after: lines.slice(end, end + 2).join('\n'),
  }
}
