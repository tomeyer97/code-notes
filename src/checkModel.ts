// Understanding check in the editor: the prompt that writes the questions, the plain phase shown while it works, the
// grader's reply as a thread message, the Check view's model, the status bar. No vscode API here (unit-tested in
// test/checkModel.test.ts). The rules (file format, grading prompt, the pass rule and the one state every surface
// shows: checkState / stateWords) live in cli/understanding.mjs; its shapes are typed here.
import type { ToolCall } from './claude'

export type Kind = 'how' | 'why' | 'failure' | 'edge' | 'change'
export type Verdict = 'pass' | 'retry' | 'explained' | 'restated'
export type QState = 'todo' | 'ungraded' | 'pass' | 'retry' | 'explained' | 'restated'
export interface Who { name?: string; email?: string }
export interface Attempt {
  /** Missing on an answer that a later one superseded (not kept in the file). */
  answer?: string; at?: string; by?: Who; verdict?: Verdict; feedback?: string; hint?: string; hash?: string; gradedAt?: string
  note?: string; topic?: string; concern?: string; flagged?: boolean; links?: Link[]
}
export interface Range { file: string; start: number; end: number }
/** A code link: words of a text that light these lines when clicked (the same as a journey step's links). */
export interface Link extends Range { phrase: string; text?: string }
export interface Question {
  id: string; kind: Kind; text: string; file: string; start?: number; end?: number; target?: 'file'
  anchor?: { v: 3; head: string; tail: string; lines: number; hash: string; before: string; after: string }
  attempts?: Attempt[]; round?: number; also?: Range[]; suspect?: boolean; links?: Link[]
  /** The step of the check's tour after which its answer is visible. */
  step?: number
  /** A concern about the code found while grading; `flagged`: the author put it on the merge request. */
  concern?: { text: string; flagged?: boolean; at?: string; by?: Who; dismissed?: { reason: string; by?: Who; at?: string }; fixed?: { by?: Who; at?: string } }
}
/** The check's tour: a journey of the change (the journey file format), its steps walked in the journey panel. */
export interface Tour { title: string; steps: { id?: string; title: string; file: string; range: { start: number; end: number } }[]; [k: string]: unknown }
export interface Check { version: 1; branch: string; base?: string; head: string; answeredBy?: Who; diffStat?: { files: number; added: number; removed: number }; model?: string; createdAt?: string; questions: Question[]; journey?: Tour }
export interface Summary { total: number; passed: number; done: number; explained: number; restated: number; retry: number; todo: number; ungraded: number; open: number; needed: number; met: boolean; states: QState[] }
export type Phase = 'nothing' | 'none' | 'invalid' | 'drift' | 'answering' | 'short' | 'done'
export interface State { phase: Phase; passed?: number; done?: number; total?: number; needed?: number; maxDrift?: number; grew?: number; commitFirst?: boolean; changed?: number; exemptOnly?: boolean; why?: string }
export interface Words { tone: 'ok' | 'warn' | 'todo'; bar: string; title: string; line: string; rule: string }
export interface Status {
  branch: string; file: string; base?: string; baseRef?: string; head?: string; changed: number; exists: boolean
  errors?: string[]; check?: Check; summary?: Summary; drift?: { lines: number; approx: boolean }; pending?: { lines: number; approx: boolean }; dirty?: boolean
  state: State; next: string
}
export interface Config { questions: { min: number; max: number }; passRatio: number; maxDrift: number; model: string | null }
export interface PushResult { ok: boolean; committed: boolean; pushed: boolean; line: string }

/** The functions of cli/understanding.mjs the extension uses (it is loaded with import() at run time). */
export interface Cli {
  localStatus(repo: string, o?: { base?: string }): Status
  stateWords(state: State, st?: Partial<Status>): Words
  loadConfig(repo: string): Config
  readCheck(file: string): Check
  writeCheck(file: string, c: Check): void
  validateCheck(c: unknown, o?: { repo?: string }): string[]
  relocate(repo: string, c: Check): number
  stateOf(q: Question): QState
  summarize(c: Check, cfg: Config): Summary
  addAttempt(c: Check, q: Question, answer: string, who?: Who): Attempt
  gitIdentity(repo: string): Who | undefined
  attemptHash(q: Question, a: Attempt): string
  gradeMode(q: Question): { attempt: number; explanation?: string }
  graderPrompt(o: { q: Question; answer: string; attempt: number; explanation?: string; diff: string; code: string; canRead: boolean; tour?: string; others?: string[] }): string
  /** The texts of the check's other questions not done yet. */
  openOthers(check: Check, q: Question): string[]
  /** The tour as numbered lines (the grader's context): "3. The API refuses a used code (api/discounts.ts:40-52)". */
  tourText(c: Check): string
  parseVerdict(text: string, attempt: number, o?: { restate?: boolean }): { verdict: Verdict; feedback: string; hint: string; note?: string; topic?: string; concern?: string; links?: Link[] }
  diffText(repo: string, from: string, to?: string): string
  diffForGrader(diff: string, file: string): string
  codeWindow(repo: string, q: Question): string
  stamp(c: Check, cfg: Config): Check
  fileFor(branch: string): string
  slugOf(branch: string): string
  /** Where a branch's check waits while another branch is checked out. */
  cachedFor(branch: string): string
  commitAndPush(repo: string, files: string[], message: string): Promise<PushResult>
  /** The code a question's concern is about (a link of the grade that raised it), if it named some. */
  concernLink(q: Question): Link | undefined
  /** The check file, Code Notes' notes and the setup files: never part of the change, never "uncommitted work". */
  own(file: string): boolean
  /** The .gitattributes and .ignore lines for check files the repository doesn't have yet. */
  setupMissing(repo: string): string[]
  /** Writes the repository's .gitattributes and .ignore lines for check files; returns the lines it added. */
  initRepo(repo: string): string[]
  codeLinksIn(repo: string, links: Link[]): Link[]
}

/** The prompt for `claude -p` that writes (or tops up) the questions with the understanding-check skill. */
export function checkPrompt(o: { skill: string; branch: string; baseRef: string; base: string; topUp: boolean; bundled: boolean; head?: string }): string {
  const how = o.bundled
    ? `Read ${o.skill}/SKILL.md and follow it exactly (it is the understanding-check skill; it is not installed, so do not look for it with the Skill tool)`
    : 'Use the understanding-check skill'
  // The branch and commit are pinned: the person may switch branches while this runs.
  const pin = o.head ? ` --branch ${o.branch} --head ${o.head}` : ''
  const start = `${o.skill}/scripts/questions.mjs start ${o.topUp ? '--top-up' : `--base ${o.base}`}${pin}`
  return [
    `${how} to ${o.topUp ? 'add 1-2 questions about what changed since the understanding check of' : 'write the questions of an understanding check for'} this branch (${o.branch}, compared with ${o.baseRef}).`,
    `Start with: ${start}`,
    `Run the script by its full path (${o.skill}/scripts/…), one command per call: no shell variables, no && or pipes. Do not modify any other file.`,
    'When done, reply with one line per question you wrote.',
  ].join('\n\n')
}

/**
 * The prompt that writes the check's tour (a journey of the change, embedded in the check file), right after the
 * questions: `resumed` when it goes on in the session that wrote them (the change is read already).
 */
export function tourPrompt(o: { skill: string; journeySkill: string; topUp: boolean; bundled: boolean; resumed: boolean }): string {
  const how = o.bundled || !o.resumed ? `Follow the section "The tour" of ${o.skill}/SKILL.md` : 'Follow the section "The tour" of the understanding-check skill'
  return [
    `${o.resumed ? 'Now write' : 'Write'} the tour of this change, so the author can click their way to each answer. ${how}.`,
    `Start with: ${o.skill}/scripts/questions.mjs tour${o.topUp ? ' --top-up' : ''}`,
    `Run the scripts by their full path (${o.skill}/scripts/… and ${o.journeySkill}/scripts/journey.py), one command per call: no shell variables, no && or pipes (a heredoc for journey.py's text is fine). Do not modify any other file.`,
    'When done, reply with the step titles, one per line.',
  ].join('\n\n')
}

/** What Claude is doing while it writes the questions (or the tour), in plain words, from its last tool call. */
export function checkPhase(tool: ToolCall | undefined, prev: string): string {
  if (!tool) return prev
  if (tool.name !== 'Bash') return ['Read', 'Grep', 'Glob'].includes(tool.name) && prev !== 'writing questions' && prev !== 'writing the tour' ? 'reading the code' : prev
  const cmd = String(tool.input?.command ?? '')
  if (/journey\.py/.test(cmd)) return 'writing the tour'
  const m = /questions\.mjs\s+([a-z-]+)/.exec(cmd)
  if (!m) return prev
  return m[1] === 'start' ? 'reading the change' : m[1] === 'add' || m[1] === 'remove' ? 'writing questions' : m[1] === 'finish' || m[1] === 'tour-finish' ? 'checking' : m[1] === 'tour' ? 'writing the tour' : prev
}

export const KIND_LABEL: Record<Kind, string> = { how: 'How', why: 'Why', failure: 'Failure', edge: 'Edge case', change: 'Change' }

const range = (r: Range) => `${r.file}:${r.start}${r.end > r.start ? `-${r.end}` : ''}`

/** The question as the first message of its thread; unchanged code it depends on (not linked from its words) below it. */
export function questionBody(q: Question): string {
  const linked = (r: Range) => (q.links ?? []).some((l) => l.file === r.file && l.start <= r.end && r.start <= l.end)
  const also = (q.also ?? []).filter((r) => !linked(r))
  return also.length ? `${q.text}\n\nAlso read: ${also.map(range).join(', ')}` : q.text
}

/**
 * The code links of message `mi` of a check thread (`roles`: each message's role): the question's for the first
 * message, then each grade's own (the n-th agent reply is the n-th graded attempt). Answers have none.
 */
export function linksAt(q: Question, roles: string[], mi: number): Link[] {
  if (roles[mi] !== 'agent') return []
  const k = roles.slice(0, mi).filter((r) => r === 'agent').length
  if (k === 0) return q.links ?? []
  return (q.attempts ?? []).filter((a) => a.verdict)[k - 1]?.links ?? []
}

/**
 * The grader's reply in the thread: pass → a short confirmation; retry → feedback + hint; explained → the
 * explanation and an offer to say it back; a restatement → ✓, or what is still off.
 */
export function gradeBody(a: Attempt, o: { restatement?: boolean } = {}): string {
  if (a.verdict === 'pass' || a.verdict === 'restated') return `✓ ${a.feedback || 'Right.'}`
  if (a.verdict === 'retry') return `${/^not quite/i.test(a.feedback ?? '') ? '' : 'Not quite. '}${a.feedback ?? ''}${a.hint ? `\n\n**Hint:** ${a.hint}` : ''}`.trim()
  if (o.restatement) return `${a.feedback ?? ''}\n\n_Try once more, or leave it: it is done._`.trim()
  return `${a.feedback ?? ''}\n\n_Got it? Say it back in one sentence (optional)._`.trim()
}

/** The words of a row's state (the icon says the rest). */
export const STATE_WORD: Record<QState, string> = { todo: '', ungraded: 'not graded', pass: '', retry: 'try again', explained: 'explained · say it back', restated: 'in your words' }

/**
 * A question's concern: the one stored on it (found while grading), else the question's own "may be a bug", shown
 * only once it has been answered (before, it would give the answer away).
 */
export function concernOf(q: Question): { text: string; flagged: boolean; suspect: boolean; by?: string } | undefined {
  // Dismissed (with a reason) or marked fixed: done with; nothing more to do about it.
  if (q.concern?.dismissed || q.concern?.fixed) return undefined
  if (q.concern?.text) return { text: q.concern.text, flagged: !!q.concern.flagged, suspect: !!q.suspect && SUSPECTS.includes(q.concern.text), ...(q.concern.by ? { by: q.concern.by.name ?? q.concern.by.email } : {}) }
  return q.suspect && (q.attempts ?? []).some((a) => a.verdict) ? { text: SUSPECT, flagged: false, suspect: true } : undefined
}
export const SUSPECT = 'May be a bug.'
/** Its words in files written before (kept as a concern's text when flagged). */
const SUSPECTS = [SUSPECT, 'May be a bug: fix it or explain.']

export interface CheckRow { id: string; n: number; kind: string; text: string; where: string; also: string[]; state: QState; word: string; flag?: string; step?: number }
export interface CheckView {
  branch: string; file: string
  tone: Words['tone']; title: string; line: string
  rows: CheckRow[]
  /** The one button, when there is one. */
  action?: { id: 'start' | 'topUp' | 'commitPush' | 'scm'; label: string }
  /** Someone else's check: whose, in one line. */
  who?: string
  /** Writing questions now: "Writing questions · 0:42 · reading the change". */
  busy?: string
  /** One line about what the questions left out. */
  notice?: string
  /** With Commit & push: what it commits ("feat-x.json, .gitattributes"), and files a TODO was added to, to tick. */
  commits?: string
  also?: { file: string; label: string; on: boolean }[]
  /** The answer box: only for the selected question (checkAnswer.ts / media/checkAnswer.js). */
  answer?: AnswerBox
  /** Writing the questions failed: why, in plain words, with Retry (and the model setting when it was the model). */
  failed?: { text: string; setting?: boolean }
  /** The repository lacks the lines that collapse check files in diffs: a link that adds them in a commit of their own. */
  setup?: string
  /** The tour of the change: walk it ("Walk the tour · 9 steps"), or write one (an older check, a failed run). */
  tour?: { label: string; action?: 'walk' | 'write' }
}

/** Words of a grade, with the code-link phrases marked (`link`: its index in the grade's links). */
export interface Part { text: string; link?: number }
/** The selected question's answer box in the Check view, and its latest grade (short). */
export interface AnswerBox {
  id: string; n: number
  /** The box is shown (not done yet, or explained: say it back); else only the grade and "Next question ›". */
  open: boolean
  draft: string
  checking?: boolean
  grade?: { pass: boolean; feedback: Part[]; hint?: Part[]; say?: string }
  /** "Next question ›": this one is done and another is open. */
  next?: boolean
}

/** A text split at the code links' phrases (each phrase once, the first time it appears). */
export function linkParts(text: string, links: { phrase: string }[] = []): Part[] {
  const hits = links.map((l, i) => ({ i, at: l.phrase ? text.indexOf(l.phrase) : -1, len: l.phrase.length })).filter((h) => h.at >= 0).sort((a, b) => a.at - b.at)
  const out: Part[] = []
  let pos = 0
  for (const h of hits) {
    if (h.at < pos) continue
    if (h.at > pos) out.push({ text: text.slice(pos, h.at) })
    out.push({ text: text.slice(h.at, h.at + h.len), link: h.i })
    pos = h.at + h.len
  }
  if (pos < text.length) out.push({ text: text.slice(pos) })
  return out
}

/**
 * The answer box of question `q` (number `n`, state `state`): open while it is to be answered (or explained: say it
 * back), its latest grade under it, "Next question ›" once it is done while `others` are open.
 */
export function answerBox(q: Question, n: number, state: QState, o: { draft?: string; grading?: boolean; others?: boolean } = {}): AnswerBox {
  const a = [...(q.attempts ?? [])].reverse().find((x) => x.verdict)
  const pass = state === 'pass' || state === 'restated'
  const grade = a && !o.grading ? {
    pass: a.verdict === 'pass' || a.verdict === 'restated',
    feedback: linkParts(`${a.verdict === 'retry' && !/^not quite/i.test(a.feedback ?? '') ? 'Not quite. ' : ''}${a.feedback || (a.verdict === 'pass' ? 'Right.' : '')}`, a.links),
    ...(a.verdict === 'retry' && a.hint ? { hint: linkParts(a.hint, a.links) } : {}),
    ...(a.verdict === 'explained' && state === 'explained' ? { say: 'Got it? Say it back in one sentence (optional).' } : {}),
  } : undefined
  return {
    id: q.id, n, open: !pass, draft: o.draft ?? '', ...(o.grading ? { checking: true } : {}), ...(grade ? { grade } : {}),
    ...(pass && o.others ? { next: true } : {}),
  }
}

const where = (q: Question) => (q.target === 'file' || !q.start ? q.file : `${q.file}:${q.start}`)

/**
 * The Check view: where the check stands (the CLI's words), the questions, one button. `unpushed`: the branch has
 * commits its remote doesn't (undefined: no upstream). `pushed`: what Commit & push said last.
 */
export function checkView(st: Status, w: Words, o: { busy?: string; tourBusy?: string; tourFailed?: boolean; grading?: Set<string>; unpushed?: boolean; pushed?: string; me?: Who; notice?: string; commit?: { files: string[]; todos: string[]; include: Set<string> }; selected?: string; draft?: string; setup?: boolean; failed?: { text: string; setting?: boolean } } = {}): CheckView {
  const s = st.summary
  const rows: CheckRow[] = (st.check?.questions ?? []).map((q, i) => {
    const grading = o.grading?.has(q.id)
    const state: QState = grading ? 'ungraded' : s?.states[i] ?? 'todo'
    const c = concernOf(q)
    return { id: q.id, n: i + 1, kind: KIND_LABEL[q.kind] ?? q.kind, text: q.text, where: where(q), also: (q.also ?? []).map(range), state, word: grading ? 'checking…' : STATE_WORD[state],
      ...(c ? { flag: c.suspect ? 'may be a bug' : c.flagged ? 'flagged for review' : 'concern' } : {}), ...(q.step && st.check?.journey ? { step: q.step } : {}) }
  })
  const p = st.state.phase
  let line = w.line
  let action: CheckView['action']
  if (p === 'none') action = { id: 'start', label: 'Start' }
  else if (p === 'drift') action = st.state.commitFirst ? { id: 'scm', label: 'Commit…' } : { id: 'topUp', label: 'Add questions' }
  else if (p === 'done') {
    if (st.dirty || o.unpushed !== false) { action = { id: 'commitPush', label: 'Commit & push' }; if (!st.dirty) line = 'Not pushed yet.' }
    else line = 'Pushed.'
    if (o.pushed && o.pushed !== 'Pushed.') line = o.pushed
  }
  // Commit & push names what it commits; a TODO added from the check is the person's choice.
  const base = (f: string) => f.split('/').pop()!
  const files = o.commit ? [...(st.dirty ? [st.file] : []), ...o.commit.files.filter((f) => f !== st.file)] : []
  const commit = action?.id === 'commitPush' && o.commit ? {
    ...(files.length ? { commits: `Commits ${files.map(base).join(', ')}` } : {}),
    ...(o.commit.todos.length ? { also: o.commit.todos.map((f) => ({ file: f, label: `also ${base(f)} (TODO added)`, on: o.commit!.include.has(f) })) } : {}),
  } : {}
  // The selected question's answer box.
  const qs = st.check?.questions ?? []
  const si = o.selected ? qs.findIndex((x) => x.id === o.selected) : -1
  const open = (k: number) => ['todo', 'retry', 'ungraded'].includes(rows[k]?.state)
  const answer = si >= 0 ? answerBox(qs[si], si + 1, s?.states[si] ?? 'todo', { draft: o.draft, grading: !!o.grading?.has(qs[si].id), others: rows.some((_r, k) => k !== si && open(k)) }) : undefined
  // The tour: walk it; an older check (or a run that failed) offers to write one. Nothing while one is being written.
  const steps = st.check?.journey?.steps?.length ?? 0
  const tour: CheckView['tour'] = !st.check || o.busy ? undefined : o.tourBusy ? { label: o.tourBusy } : steps ? { label: `Walk the tour · ${steps} steps`, action: 'walk' }
    : p === 'answering' || p === 'short' || p === 'done' ? { label: o.tourFailed ? "Couldn't write the tour · Try again" : 'Write a tour', action: 'write' } : undefined
  const by = st.check?.answeredBy
  const sameWho = !by || !o.me || (by.email && o.me.email ? by.email === o.me.email : by.name === o.me.name)
  return {
    branch: st.branch, file: st.file, tone: w.tone, title: w.title, line, rows,
    // A failed write: its Retry is the action.
    ...(action && !o.busy && !o.failed ? { action, ...commit } : {}), ...(o.busy ? { busy: o.busy } : {}), ...(o.notice ? { notice: o.notice } : {}), ...(tour ? { tour } : {}),
    ...(!sameWho ? { who: `${by!.name ?? by!.email}'s check: your answers are recorded as yours.` } : {}),
    ...(answer ? { answer } : {}),
    ...(o.failed && !o.busy ? { failed: o.failed } : {}),
    // Only with a check, and never while busy: the person decides; nothing is written to the repository by itself.
    ...(o.setup && st.check && !o.busy ? { setup: 'Collapse check files in diffs:' } : {}),
  }
}

/** A TODO comment of at most 80 characters (the text cut at a word, with "…"). */
export function todoLine(mark: [string, string], text: string, max = 80): string {
  const head = `${mark[0]} TODO: `, room = max - head.length - mark[1].length
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= room) return `${head}${t}${mark[1]}`
  const cut = t.slice(0, room - 1).replace(/\s+\S*$/, '').replace(/[,;:.]$/, '')
  return `${head}${cut}…${mark[1]}`
}

/** The status bar, from the CLI's words: hidden when no check is needed; an icon by tone; amber for a top-up. */
export function statusText(st: Status | undefined, w: Words | undefined): { text: string; tip: string; warn: boolean } | undefined {
  if (!st || !w || !w.bar) return undefined
  const p = st.state.phase
  const icon = p === 'done' ? '$(pass)' : w.tone === 'warn' ? '$(warning)' : '$(checklist)'
  return { text: `${icon} ${w.bar.replace(/^✓\s*/, '')}`, tip: [w.title, w.line].filter(Boolean).join(' · '), warn: p === 'drift' }
}

/**
 * Why writing the questions failed, in plain words for the Check view (never the script's or the CLI's own advice):
 * `error` from Claude, or `text`, the writer's reply when it wrote nothing.
 */
export function writeFailure(o: { error?: string; text?: string; model?: string }): { text: string; setting?: boolean } {
  const e = String(o.error ?? '')
  if (e) {
    if (/model/i.test(e)) return { text: `Claude couldn't use the model${o.model ? ` "${o.model}"` : ''}.`, setting: true }
    if (/rate.?limit|overloaded|429|529/i.test(e)) return { text: 'Claude is busy right now.' }
    if (/auth|log ?in|api key|401|403/i.test(e)) return { text: "Claude Code isn't signed in." }
    return { text: `Claude couldn't write the questions: ${e.split(/(?<=[.!?])\s/)[0].replace(/\s*Run --?\S+.*$/i, '').slice(0, 120)}` }
  }
  const t = String(o.text ?? '')
  if (/UNCOMMITTED/.test(t)) return { text: 'Commit your change first: questions are about committed code.' }
  if (/NOTHING/.test(t)) return { text: 'No code lines changed: nothing to ask.' }
  return { text: "Claude couldn't write questions for this change." }
}
