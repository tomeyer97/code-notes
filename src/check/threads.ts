// The check's questions as note threads: a view of the check file, kept in sync with it. Every question has its
// thread; answers and grades written elsewhere (the CLI, another window) are added to it; a thread whose question
// changed or went is removed (a thread never stands for a question it didn't show). What changes is planned in
// threadSync.ts (no I/O); this file reads and writes the notes.
import * as vscode from 'vscode'
import type { Note } from '../notes/store'
import { diskLines } from '../platform/documents'
import { type Check, notDone } from './types'
import { AUTHOR, SESSION } from './constants'
import { linkOf } from './threadLink'
import { planSync, threadNoteData, type SyncPlan } from './threadSync'
import type { CheckHost } from './host'
import type { CheckCore } from './state'

/** What the threads need: the state, the CLI's question states, and the notes. */
export interface ThreadsPorts extends Pick<CheckCore, 'state' | 'cli'> {
  host: Pick<CheckHost, 'changed' | 'me' | 'newId' | 'now' | 'refresh' | 'store'>
}

export class CheckThreads {
  /** Check threads graded in this window: they stay open where they are (the reply is read next to the code). */
  readonly graded = new Set<string>()
  /** Each question's thread as last found (checked again on each lookup: the store may have read it again). */
  private found = new Map<string, Note>()

  constructor(private ports: ThreadsPorts) {}

  private get host() { return this.ports.host }

  /** The thread of question `id` of the check checked out now. */
  noteOf(id: string): Note | undefined {
    const file = this.ports.state.st?.file
    const was = this.found.get(id)
    const now = was && this.host.store.atUri(was.uri.toString())
    const l = now && linkOf(now)
    if (now && l?.q === id && l.file === file) return now
    // Not found where it was: every note is looked at once, and each question's thread remembered.
    this.found = new Map()
    for (const n of this.threadsOf(file)) if (!this.found.has(linkOf(n)!.q)) this.found.set(linkOf(n)!.q, n)
    return this.found.get(id)
  }

  /** The notes linked to check file `file`. */
  private threadsOf(file: string | undefined): Note[] {
    return file === undefined ? [] : this.host.store.all().filter((n) => linkOf(n)?.file === file)
  }

  /** Brings every thread of `check` in line with it (see the top of this file and threadSync.ts). */
  async sync(check: Check): Promise<void> {
    const st = this.ports.state.st!
    const plan = planSync(check, this.threadsOf(st.file), {
      stateOf: (q) => this.ports.cli.stateOf(q), me: this.host.me(), author: AUTHOR, now: this.host.now(),
    })
    await this.apply(plan)
  }

  private async apply(plan: SyncPlan): Promise<void> {
    for (const n of plan.trash) {
      this.graded.delete(n.data.id)
      await this.host.store.trash(n)
    }
    if (plan.trash.length) this.host.refresh()
    for (const c of plan.create) await this.create(c.q, c.messages)
    for (const u of plan.update) {
      u.note.data.messages = u.messages
      u.note.data.status = u.status
      if (await this.host.store.save(u.note)) await this.host.changed(u.note, false)
    }
  }

  /** A new thread for question `q` on its lines (found again by its anchor when the code moved). */
  private async create(q: Check['questions'][number], messages: SyncPlan['create'][number]['messages']): Promise<void> {
    const ports = this.ports, folder = ports.state.folder!, st = ports.state.st!
    const lines = await diskLines(vscode.Uri.joinPath(folder.uri, q.file))
    // Its file is gone: no thread until it is back.
    if (!lines) return
    const id = this.host.newId()
    const done = !notDone(ports.cli.stateOf(q))
    const data = threadNoteData(q, lines, { id, at: this.host.now(), checkFile: st.file, session: SESSION(st.branch), done, messages })
    const n: Note = { folder, uri: this.host.store.uriFor(folder, id), data }
    if (await this.host.store.save(n)) await this.host.changed(n, true)
  }
}
