// A concern about the code (found while grading, or a question's "may be a bug" once answered), and what the person
// can do about it: Suggest a fix (a note asked to Claude), Add TODO (a comment above the lines), Flag for review (on
// the merge request), Dismiss (with a reason, or "I fixed it").
import * as vscode from 'vscode'
import type { Note } from '../notes/store'
import type { Question, Who } from './types'
import { concernOf, samePerson, settledConcern, whoOf, type ConcernAction, type ConcernView } from './concernState'
import { commentMarkFor, todoLines, todoPlace } from './todoComment'
import { gitOut } from '../platform/git'
import { docLines } from '../platform/documents'
import { exists } from '../platform/exists'
import { clampLine, insertLinesAbove } from './editor'
import type { CheckHost } from './host'
import type { Pusher } from './push'
import { type CheckCore, updateCheck } from './state'

export { isConcernAction, VIEW_CONCERN_ACTIONS, type ConcernAction } from './concernState'

/** A concern as shown: its question and what concernOf says. */
interface Shown { q: Question; c: ConcernView }

/** What the concerns need: the check's core, the notes (Suggest a fix asks Claude), and the log. */
export interface ConcernsPorts extends Pick<CheckCore, 'state' | 'cli' | 'log' | 'refresh' | 'save'> {
  host: Pick<CheckHost, 'askAbout' | 'now' | 'refresh'>
  /** Not read: whether a fix was applied is the state's (CheckState.fixApplied). Kept while the controller passes it. */
  push?: Pick<Pusher, 'commit'>
}

/** The lines a concern is about. */
interface Place { file: string; start: number; end: number }

export class Concerns {
  constructor(private ports: ConcernsPorts) {}

  private get host() { return this.ports.host }

  /** What each action does to the concern `shown` of thread `n` (`given`: a dismissal's reason). */
  private readonly handlers: Record<ConcernAction, (n: Note, shown: Shown, given?: string) => Promise<void>> = {
    fix: (n, shown) => this.suggestFix(n, shown),
    todo: (n, shown) => this.addTodo(n, shown),
    flag: (_n, shown) => this.toggleFlag(shown),
    dismiss: (n, shown, given) => this.dismiss(n, shown, given),
    fixed: (_n, shown) => this.settle(shown, { fixed: true }),
  }

  /** `action` on the concern of thread `n`'s question; `given`: a dismissal's reason (no prompt). */
  async act(n: Note, action: ConcernAction, given?: string): Promise<void> {
    const q = this.ports.state.questionOf(n)
    const c = q && concernOf(q)
    if (!q || !c || !this.ports.state.repo) return
    await this.handlers[action](n, { q, c }, given)
  }

  /** A note on the code the concern names, asked to Claude for a short fix that Apply puts in. */
  private async suggestFix(n: Note, shown: Shown): Promise<void> {
    const at = await this.concernAt(shown.q, n)
    const extra = { checkFix: shown.q.id, ...this.ports.state.branchOf(n) }
    await this.host.askAbout(at.file, at.start, at.end, `Suggest a fix: ${wordsOf(shown)}`, extra)
  }

  /** Above the code the concern names (else the question's first line); the whole concern, wrapped; said in the thread. */
  private async addTodo(n: Note, shown: Shown): Promise<void> {
    const at = await this.concernAt(shown.q, n)
    const doc = await this.document(at.file)
    // Above the line, at its indentation (inside the block a "} catch {" line opens).
    const place = todoPlace(docLines(doc), clampLine(doc, at.start - 1))
    const lines = todoLines(commentMarkFor(doc.languageId, at.file), wordsOf(shown)).map((l) => `${place.indent}${l}`)
    if (!(await insertLinesAbove(doc, place.line, lines))) return
    await this.ports.state.todos.set(this.ports.state.st!.branch, shown.q.id, { file: at.file, line: place.line + 1 })
    this.host.refresh()
  }

  /**
   * Not a problem (with a short reason, or `given`), or fixed: the concern leaves the merge request. When its code
   * changed since it was raised (or its suggested fix was applied), "I fixed it" is offered first.
   */
  private async dismiss(n: Note, shown: Shown, given: string | undefined): Promise<void> {
    if (given === undefined && await this.changedSinceRaised(shown.q, n)) {
      const choices = [{ label: 'I fixed it', id: 'fixed' }, { label: "It isn't a problem…", id: 'why' }]
      const pick = await vscode.window.showQuickPick(choices, { title: 'Dismiss this concern' })
      if (!pick) return
      if (pick.id === 'fixed') return this.settle(shown, { reason: 'fixed' })
    }
    const reason = (given ?? await vscode.window.showInputBox({
      title: 'Dismiss this concern',
      prompt: 'Why is it not a problem? One line, kept in the check file.',
      placeHolder: 'e.g. the caller checks it first',
    }))?.trim()
    if (!reason) return
    await this.settle(shown, { reason })
  }

  /** Writes a dismissal (`reason`) or a fix (`fixed`) into the check file: by whom, when; no longer flagged. */
  private async settle(shown: Shown, how: { reason: string } | { fixed: true }): Promise<void> {
    await this.update(shown, (fq, text) => {
      fq.concern = settledConcern(fq.concern, text, how, this.ports.state.who, this.host.now())
    })
  }

  /** Flag for reviewer: on the merge request (toggles); independent of a TODO. */
  private async toggleFlag(shown: Shown): Promise<void> {
    await this.update(shown, (fq, text, author) => {
      fq.concern = { ...(fq.concern ?? { text }), text: fq.concern?.text ?? text, flagged: !shown.c.flagged }
      // Flagged by someone other than the check's author: the merge request says who.
      const me = this.ports.state.who
      if (fq.concern.flagged && me && author && !samePerson(me, author)) fq.concern.by = whoOf(me)
      else delete fq.concern.by
    })
  }

  /**
   * The check file with the concern's question changed by `change` (`text`: the concern's words, `author`: the
   * check's), then the check and the notes drawn again.
   */
  private async update(shown: Shown, change: (fq: Question, text: string, author: Who | undefined) => void): Promise<void> {
    const written = updateCheck(this.ports, (check) => {
      const fq = check.questions.find((x) => x.id === shown.q.id)
      if (!fq) return false
      change(fq, wordsOf(shown), check.answeredBy)
    })
    if (!written) return
    await this.ports.refresh()
    this.host.refresh()
  }

  /**
   * The lines a concern is about: the code its grade linked (found again by its text when it moved), else the
   * question's thread (also when the linked file is gone).
   */
  private async concernAt(q: Question, n: Note): Promise<Place> {
    const thread = { file: n.data.file, start: n.data.range.start, end: n.data.range.end }
    const l = this.ports.cli.concernLink(q)
    if (!l) return thread
    const doc = await this.documentIfThere(l.file)
    if (!doc) return thread
    let start = l.start
    const moved = !!l.text && doc.lineAt(clampLine(doc, l.start - 1)).text !== l.text
    if (moved) start = nearestLine(docLines(doc), l.text!, l.start) ?? start
    return { file: l.file, start, end: start + (l.end - l.start) }
  }

  private uri(file: string): vscode.Uri { return vscode.Uri.joinPath(this.ports.state.folder!.uri, file) }

  /** A file of the repository as an open document (unsaved edits included). */
  private document(file: string): Thenable<vscode.TextDocument> {
    return vscode.workspace.openTextDocument(this.uri(file))
  }
  /** The same, or undefined when the file is not there (said in the log). */
  private async documentIfThere(file: string): Promise<vscode.TextDocument | undefined> {
    if (await exists(this.uri(file))) return this.document(file)
    this.ports.log.debug(`concern: ${file} is not there`)
    return undefined
  }

  /**
   * A concern's code changed here since it was raised: its suggested fix was applied, the line its grade named is gone
   * from the open document, or the file has uncommitted changes in the lines it is about. (CI's own test, the CLI's
   * concernChanged, looks only at the named line, at a commit.)
   */
  private async changedSinceRaised(q: Question, n: Note): Promise<boolean> {
    const state = this.ports.state
    if (state.fixApplied(q.id)) return true
    const l = this.ports.cli.concernLink(q)
    if (l?.text) {
      const doc = await this.documentIfThere(l.file)
      if (!doc) return false
      if (!docLines(doc).includes(l.text)) return true
    }
    const at = await this.concernAt(q, n)
    const diff = await gitOut(state.repo!, ['diff', '-U0', 'HEAD', '--', at.file], true)
    if (diff === undefined) {
      // Git couldn't say: "I fixed it" is not offered first (Dismiss asks why).
      this.ports.log.debug(`concern: git diff of ${at.file} failed`)
      return false
    }
    return this.ports.cli.hunksOf(diff).some((h) => h.start <= at.end && h.end >= at.start)
  }
}

/** A concern's words: the question itself for its own "may be a bug" (that line alone says nothing). */
const wordsOf = ({ q, c }: Shown): string => (c.suspect ? q.text : c.text)

/** The 1-based line of `lines` that is `text`, nearest to line `near` (the first of two as near); undefined: none. */
function nearestLine(lines: string[], text: string, near: number): number | undefined {
  const hits = lines.flatMap((t, k) => (t === text ? [k + 1] : []))
  if (!hits.length) return undefined
  return hits.reduce((a, b) => (Math.abs(b - near) < Math.abs(a - near) ? b : a))
}
