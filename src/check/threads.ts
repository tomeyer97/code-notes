// The check's questions as note threads: a view of the check file, kept in sync with it. Every question has its
// thread; answers and grades written elsewhere (the CLI, another window) are added to it; a thread whose question
// changed or went is removed (a thread never stands for a question it didn't show).
import * as fs from 'fs'
import * as path from 'path'
import { findCompact } from '../core/anchors/compact'
import { captureAnchor, type NoteData } from '../core/format/noteModel'
import type { Note } from '../notes/store'
import { Attempt, Check, notDone, Question } from './types'
import { gradeBody, missingMessages, questionBody, showsGrade } from './threadText'
import { AUTHOR, SESSION } from './constants'
import { linkOf, sameQuestion, textHash } from './threadLink'
import type { CheckHost } from './host'
import type { CheckCore } from './state'

type Messages = NoteData['messages']

/** What the threads need: the state, the CLI's question states, and the notes. */
export interface ThreadsPorts extends Pick<CheckCore, 'state' | 'cli'> {
  host: Pick<CheckHost, 'changed' | 'me' | 'newId' | 'now' | 'refresh' | 'store'>
}

export class CheckThreads {
  /** Check threads graded in this window: they stay open where they are (the reply is read next to the code). */
  readonly graded = new Set<string>()

  constructor(private ports: ThreadsPorts) {}

  private get host() { return this.ports.host }

  /** The thread of question `id` of the check checked out now. */
  noteOf(id: string): Note | undefined {
    const file = this.ports.state.st?.file
    return this.host.store.all().find((n) => linkOf(n)?.q === id && linkOf(n)?.file === file)
  }

  /** Brings every thread of `check` in line with it (see the top of this file). */
  async sync(check: Check): Promise<void> {
    const file = this.ports.state.st!.file
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
      if (!notDone(this.ports.cli.stateOf(q)) && n.data.status === 'open') n.data.status = 'resolved'
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
      if (showsGrade(a)) {
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
    const attempts = q.attempts ?? []
    // The attempts whose answer the file no longer keeps, and the answers it keeps.
    const superseded = attempts.filter((a) => a.answer === undefined)
    const kept = new Set(attempts.flatMap((a) => (a.answer !== undefined ? [a.answer] : [])))
    const messages = n.data.messages
    const isKeptAnswer = (m: Messages[number]) => m.role === 'human' && kept.has(m.body)
    let lastKept = -1
    messages.forEach((m, i) => { if (isKeptAnswer(m)) lastKept = i })
    if (!superseded.length || lastKept < 0) return false
    // The thread's other answers before it (message indexes), newest first.
    const oldAnswers = messages.flatMap((m, i) => (i > 0 && i < lastKept && m.role === 'human' && !kept.has(m.body) ? [i] : []))
    if (!oldAnswers.length) return false
    const newestFirst = oldAnswers.reverse()
    const drop = new Set<number>()
    newestFirst.forEach((answer, k) => {
      // The k-th old answer from the end stands for the k-th superseded attempt from the end.
      const attempt: Attempt | undefined = superseded.at(-1 - k)
      drop.add(answer)
      // Its grade (the next message) goes with it, unless it explained.
      if (messages[answer + 1]?.role === 'agent' && attempt?.verdict !== 'explained') drop.add(answer + 1)
    })
    n.data.messages = messages.filter((_m, i) => !drop.has(i))
    return true
  }

  /** A new thread for question `q` on its lines (found again by its anchor when the code moved). */
  private async create(q: Question, messages: Messages): Promise<void> {
    const ports = this.ports, folder = ports.state.folder!
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
    const done = !notDone(ports.cli.stateOf(q))
    const n: Note = {
      folder, uri: this.host.store.uriFor(folder, id),
      data: {
        id, file: q.file, range: { start, end },
        anchor: q.target ? { text: '', before: '', after: '' } : captureAnchor(lines, start - 1, end - 1),
        session: SESSION(ports.state.st!.branch), status: done ? 'resolved' : 'open', stale: false, createdAt: at,
        messages: messages.map((m) => ({ ...m, at: m.at ?? at })),
        ...(q.target ? { target: 'file' as const } : {}),
        extra: { check: { file: ports.state.st!.file, q: q.id, h: textHash(q) } },
      },
    }
    if (await this.host.store.save(n)) await this.host.changed(n, true)
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(lo, v), hi)
