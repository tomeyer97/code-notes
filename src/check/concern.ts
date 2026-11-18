// A concern about the code (found while grading, or a question's "may be a bug" once answered), and what the person
// can do about it: Suggest a fix (a note asked to Claude), Add TODO (a comment above the lines), Flag for review (on
// the merge request), Dismiss (with a reason, or "I fixed it").
import * as vscode from 'vscode'
import type { Note } from '../store'
import { Check, Question } from './types'
import { concernOf, samePerson, settledConcern, whoOf } from './concernState'
import { commentMark, todoLines, todoPlace } from './todoComment'
import { gitOut } from '../git'
import { docLines } from '../documents'
import type { CheckController } from './controller'

export type ConcernAction = 'fix' | 'todo' | 'flag' | 'dismiss' | 'fixed'
/** The actions the Check view's buttons send. */
export const VIEW_CONCERN_ACTIONS: ConcernAction[] = ['fix', 'todo', 'flag', 'dismiss']
/** Every ConcernAction (the codeNotes.checkConcern command takes any of them). */
const CONCERN_ACTIONS: readonly ConcernAction[] = [...VIEW_CONCERN_ACTIONS, 'fixed']
export const isConcernAction = (a: unknown): a is ConcernAction => CONCERN_ACTIONS.includes(a as ConcernAction)

/** A concern as shown: its question and what concernOf says. */
type Shown = { q: Question; c: NonNullable<ReturnType<typeof concernOf>> }

export class Concerns {
  constructor(private ctl: CheckController) {}

  private get host() { return this.ctl.host }

  /** `action` on the concern of thread `n`'s question; `given`: a dismissal's reason (no prompt). */
  async act(n: Note, action: ConcernAction, given?: string): Promise<void> {
    const q = this.ctl.questionOf(n)
    const c = q && concernOf(q)
    if (!q || !c || !this.ctl.repo) return
    const shown = { q, c }
    if (action === 'fix') return this.suggestFix(n, shown)
    if (action === 'todo') return this.addTodo(n, shown)
    if (action === 'dismiss') return this.dismiss(n, shown, given)
    if (action === 'fixed') return this.settle(shown, { fixed: true })
    return this.toggleFlag(shown)
  }

  /** A note on the code the concern names, asked to Claude for a short fix that Apply puts in. */
  private async suggestFix(n: Note, { q, c }: Shown): Promise<void> {
    const at = await this.concernAt(q, n)
    await this.host.askAbout(at.file, at.start, at.end, `Suggest a fix: ${c.suspect ? q.text : c.text}`, { checkFix: q.id, ...this.ctl.branchOf(n) })
  }

  /** Above the code the concern names (else the question's first line); the whole concern, wrapped; said in the thread. */
  private async addTodo(n: Note, { q, c }: Shown): Promise<void> {
    const at = await this.concernAt(q, n)
    const uri = vscode.Uri.joinPath(this.ctl.folder!.uri, at.file)
    const doc = await vscode.workspace.openTextDocument(uri)
    // Above the line, at its indentation (inside the block a "} catch {" line opens).
    const place = todoPlace(docLines(doc), Math.min(doc.lineCount - 1, Math.max(0, at.start - 1)))
    const text = todoLines(commentMark(at.file), c.suspect ? q.text : c.text).map((l) => `${place.indent}${l}\n`).join('')
    const edit = new vscode.WorkspaceEdit()
    edit.insert(uri, new vscode.Position(place.line, 0), text)
    if (!(await vscode.workspace.applyEdit(edit))) return
    await doc.save()
    await this.ctl.todos.set(this.ctl.st!.branch, q.id, { file: at.file, line: place.line + 1 })
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
      fq.concern = settledConcern(fq.concern, text, how, this.ctl.who, this.host.now())
    })
  }

  /** Flag for reviewer: on the merge request (toggles); independent of a TODO. */
  private async toggleFlag(shown: Shown): Promise<void> {
    await this.update(shown, (fq, text, check) => {
      fq.concern = { ...(fq.concern ?? { text }), text: fq.concern?.text ?? text, flagged: !shown.c.flagged }
      // Flagged by someone other than the check's author: the merge request says who.
      const me = this.ctl.who, author = check.answeredBy
      if (fq.concern.flagged && me && author && !samePerson(me, author)) fq.concern.by = whoOf(me)
      else delete fq.concern.by
    })
  }

  /** Reads the check file, lets `change` edit the concern's question there (`text`: its words), saves, refreshes. */
  private async update({ q, c }: Shown, change: (fq: Question, text: string, check: Check) => void): Promise<void> {
    const abs = this.ctl.abs!
    const check = this.ctl.cli.readCheck(abs)
    const fq = check.questions.find((x) => x.id === q.id)
    if (!fq) return
    change(fq, c.suspect ? q.text : c.text, check)
    this.ctl.save(abs, check)
    await this.ctl.refresh()
    this.host.refresh()
  }

  /**
   * The lines a concern is about: the code its grade linked (found again by its text when it moved), else the
   * question's thread.
   */
  private async concernAt(q: Question, n: Note): Promise<{ file: string; start: number; end: number }> {
    const thread = { file: n.data.file, start: n.data.range.start, end: n.data.range.end }
    const l = this.ctl.cli.concernLink(q)
    if (!l) return thread
    let start = l.start
    try {
      const doc = await this.document(l.file)
      const moved = !!l.text && doc.lineAt(Math.min(doc.lineCount - 1, l.start - 1)).text !== l.text
      if (moved) start = nearestLine(docLines(doc), l.text!, l.start) ?? start
    } catch {
      return thread
    }
    return { file: l.file, start, end: start + (l.end - l.start) }
  }

  /** A file of the repository as an open document (unsaved edits included). */
  private document(file: string): Thenable<vscode.TextDocument> {
    return vscode.workspace.openTextDocument(vscode.Uri.joinPath(this.ctl.folder!.uri, file))
  }

  /**
   * A concern's code changed here since it was raised: its suggested fix was applied, the line its grade named is gone
   * from the open document, or the file has uncommitted changes in the lines it is about. (CI's own test, the CLI's
   * concernChanged, looks only at the named line, at a commit.)
   */
  private async changedSinceRaised(q: Question, n: Note): Promise<boolean> {
    if (this.ctl.push.commit?.applied?.includes(q.id) || q.id in this.ctl.fixes.get(this.ctl.st?.branch)) return true
    const l = this.ctl.cli.concernLink(q)
    try {
      if (l?.text && !docLines(await this.document(l.file)).includes(l.text)) return true
      const at = await this.concernAt(q, n)
      const diff = await gitOut(this.ctl.repo!, ['diff', '-U0', 'HEAD', '--', at.file], true)
      return this.ctl.cli.hunksOf(diff ?? '').some((h) => h.start <= at.end && h.end >= at.start)
    } catch {
      return false
    }
  }
}

/** The 1-based line of `lines` that is `text`, nearest to line `near` (the first of two as near); undefined: none. */
function nearestLine(lines: string[], text: string, near: number): number | undefined {
  const hits = lines.flatMap((t, k) => (t === text ? [k + 1] : []))
  if (!hits.length) return undefined
  return hits.reduce((a, b) => (Math.abs(b - near) < Math.abs(a - near) ? b : a))
}
