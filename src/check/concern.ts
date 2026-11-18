// A concern about the code (found while grading, or a question's "may be a bug" once answered), and what the person
// can do about it: Suggest a fix (a note asked to Claude), Add TODO (a comment above the lines), Flag for review (on
// the merge request), Dismiss (with a reason, or "I fixed it").
import * as vscode from 'vscode'
import type { Note } from '../store'
import { Check, Question } from './types'
import { concernOf, samePerson, settledConcern, whoOf } from './concernState'
import { commentMark, todoLines, todoPlace } from './todoComment'
import { gitOut } from '../git'
import { docLines } from '../wfs'
import type { Understanding } from './index'

export type ConcernAction = 'fix' | 'todo' | 'flag' | 'dismiss' | 'fixed'
/** The actions the Check view's buttons send. */
export const VIEW_CONCERN_ACTIONS: ConcernAction[] = ['fix', 'todo', 'flag', 'dismiss']

/** A concern as shown: its question and what concernOf says. */
type Shown = { q: Question; c: NonNullable<ReturnType<typeof concernOf>> }

export class Concerns {
  constructor(private u: Understanding) {}

  private get host() { return this.u.host }

  /** `action` on the concern of thread `n`'s question; `given`: a dismissal's reason (no prompt). */
  async act(n: Note, action: ConcernAction, given?: string): Promise<void> {
    const q = this.u.questionOf(n)
    const c = q && concernOf(q)
    if (!q || !c || !this.u.repo) return
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
    await this.host.askAbout(at.file, at.start, at.end, `Suggest a fix: ${c.suspect ? q.text : c.text}`, { checkFix: q.id, ...this.u.branchOf(n) })
  }

  /** Above the code the concern names (else the question's first line); the whole concern, wrapped; said in the thread. */
  private async addTodo(n: Note, { q, c }: Shown): Promise<void> {
    const at = await this.concernAt(q, n)
    const uri = vscode.Uri.joinPath(this.u.folder!.uri, at.file)
    const doc = await vscode.workspace.openTextDocument(uri)
    // Above the line, at its indentation (inside the block a "} catch {" line opens).
    const place = todoPlace(docLines(doc), Math.min(doc.lineCount - 1, Math.max(0, at.start - 1)))
    const text = todoLines(commentMark(at.file), c.suspect ? q.text : c.text).map((l) => `${place.indent}${l}\n`).join('')
    const edit = new vscode.WorkspaceEdit()
    edit.insert(uri, new vscode.Position(place.line, 0), text)
    if (!(await vscode.workspace.applyEdit(edit))) return
    await doc.save()
    await this.u.todos.set(this.u.st!.branch, q.id, { file: at.file, line: place.line + 1 })
    this.host.refresh()
  }

  /**
   * Not a problem (with a short reason, or `given`), or fixed: the concern leaves the merge request. When its code
   * changed since it was raised (or its suggested fix was applied), "I fixed it" is offered first.
   */
  private async dismiss(n: Note, shown: Shown, given: string | undefined): Promise<void> {
    if (given === undefined && await this.changed(shown.q, n)) {
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
      fq.concern = settledConcern(fq.concern, text, how, this.u.who, this.host.now())
    })
  }

  /** Flag for reviewer: on the merge request (toggles); independent of a TODO. */
  private async toggleFlag(shown: Shown): Promise<void> {
    await this.update(shown, (fq, text, check) => {
      fq.concern = { ...(fq.concern ?? { text }), text: fq.concern?.text ?? text, flagged: !shown.c.flagged }
      // Flagged by someone other than the check's author: the merge request says who.
      const me = this.u.who, author = check.answeredBy
      if (fq.concern.flagged && me && author && !samePerson(me, author)) fq.concern.by = whoOf(me)
      else delete fq.concern.by
    })
  }

  /** Reads the check file, lets `change` edit the concern's question there (`text`: its words), saves, refreshes. */
  private async update({ q, c }: Shown, change: (fq: Question, text: string, check: Check) => void): Promise<void> {
    const abs = this.u.abs!
    const check = this.u.cli.readCheck(abs)
    const fq = check.questions.find((x) => x.id === q.id)
    if (!fq) return
    change(fq, c.suspect ? q.text : c.text, check)
    this.u.save(abs, check)
    await this.u.refresh()
    this.host.refresh()
  }

  /**
   * The lines a concern is about: the code its grade linked (found again by its text when it moved), else the
   * question's thread.
   */
  private async concernAt(q: Question, n: Note): Promise<{ file: string; start: number; end: number }> {
    const thread = { file: n.data.file, start: n.data.range.start, end: n.data.range.end }
    const l = this.u.cli.concernLink(q)
    if (!l) return thread
    let start = l.start
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(this.u.folder!.uri, l.file))
      if (l.text && doc.lineAt(Math.min(doc.lineCount - 1, l.start - 1)).text !== l.text) {
        // Moved: the line with its text nearest to where it was.
        const hits = docLines(doc).flatMap((t, k) => (t === l.text ? [k] : []))
        if (hits.length) start = hits.reduce((a, b) => (Math.abs(b + 1 - l.start) < Math.abs(a + 1 - l.start) ? b : a)) + 1
      }
    } catch {
      return thread
    }
    return { file: l.file, start, end: start + (l.end - l.start) }
  }

  /**
   * A concern's code changed since it was raised: its suggested fix was applied, the line its grade named is gone, or
   * the file has uncommitted changes in the lines it is about.
   */
  private async changed(q: Question, n: Note): Promise<boolean> {
    if (this.u.push.commit?.applied?.includes(q.id) || q.id in this.u.fixes.get(this.u.st?.branch)) return true
    const l = this.u.cli.concernLink(q)
    try {
      if (l?.text) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(this.u.folder!.uri, l.file))
        if (!docLines(doc).includes(l.text)) return true
      }
      const at = await this.concernAt(q, n)
      const diff = await gitOut(this.u.repo!, ['diff', '-U0', 'HEAD', '--', at.file], true)
      return this.u.cli.hunksOf(diff ?? '').some((h) => h.start <= at.end && h.end >= at.start)
    } catch {
      return false
    }
  }
}
