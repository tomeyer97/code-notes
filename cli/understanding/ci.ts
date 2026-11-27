// The CI job (`ci`): never calls a model; checks that the check was done for this change and meets the rule.
import fs from 'node:fs'
import path from 'node:path'
import { cliName, DEFAULTS } from './constants'
import { currentBranch, defaultBase, gitOk, hasCommit, mergeBase, stackBase } from './git'
import { codeStat, diffOrEmpty, linesOf, numstat } from './diff'
import { questionsForChange, sizeWords } from './size'
import { fileFor, loadConfig, readCheck, unknownLine, unknownSettings } from './checkFile'
import { hashProblems, validateCheck } from './validate'
import { checkState, driftOf, ruleText, summarize } from './state'
import { relocate } from './anchors'
import { approvers, ciContext, forgeOf, mrInfo, refLink, upsertComment } from './platform'
import { commentBody, concernChangedIn, inline, liveConcern, MARK, reviewItems, settingsChange } from './mrComment'
import { syncConcerns } from './threads'
import { hasSkill, setupMissing } from './init'
import { counted } from './changeFiles'
import { MARKER } from './markers'
import { PHASE, roomText, type CheckedPhase, type ResultWords } from './phases'
import {
  ADVISORY_COMMENT, advisoryLine, ANNOTATION_TITLE, cantReadApprovals, cantReadMr, commentFailed, commentWritten, coveredBy,
  foldTip, INVALID, missingBody, missingLog, NO_HISTORY, noCheckText, ONLY_SETTINGS, settingsHeadline, settingsLater, SKIP,
  withoutVsCode,
} from './messages'
import type { CiContext, Forge, Spot } from './forge'
import type { Check, CodeStat, Config, Phase, Question, Summary } from './types'

/** runCi's options: `base` the base commit (`--base`), `comment: false` no merge request comment. */
interface CiOptions { env?: NodeJS.ProcessEnv; comment?: boolean; base?: string }
type CiMode = 'required' | 'advisory'
/** The job's result (runCi): its exit code, log lines, the merge request comment, and the mode it ran in. */
interface CiResult { code: number; lines: string[]; comment?: string; mode?: CiMode }

/**
 * What a step of the job concludes, before the mode is applied (runCi): `code` 0 pass, 1 fail, 2 can't check; the
 * log's first line (`head`, its `glyph` chosen by the code: ✓ ✗ !, or none), the rest of the log, the comment.
 */
interface Outcome { code: 0 | 1 | 2; glyph: '✓' | '✗' | '!' | ''; head: string; lines: string[]; comment?: string }
const passed = (head: string, lines: string[] = []): Outcome => ({ code: 0, glyph: '✓', head, lines })
const failed = (head: string, lines: string[] = []): Outcome => ({ code: 1, glyph: '✗', head, lines })
const cantCheck = (head: string): Outcome => ({ code: 2, glyph: '!', head, lines: [] })
/** The first line as the log shows it. */
const headLine = (o: Pick<Outcome, 'glyph' | 'head'>): string => (o.glyph ? `${o.glyph} ${o.head}` : o.head)

/**
 * The CI job (no model calls). No code lines changed (or only exempt files) → pass. Skip label + an approval by
 * someone other than the author → waived. Else the file must exist, be valid, belong to this change (drift in code
 * lines), match its hashes, and meet the rule (checkState: every question done, enough passed). A skip label without a
 * valid approval only says how to waive when the check itself doesn't pass. The merge request comment follows the job:
 * its first line says the result or what is missing. Returns { code, lines, comment?, mode }: 0 pass, 1 fail, 2 can't
 * check, 3 a failure in advisory mode (on GitHub Actions: 0 with a warning annotation).
 */
export async function runCi(repo: string, opts: CiOptions = {}): Promise<CiResult> {
  const env = opts.env ?? process.env
  const { outcome, mode } = await ciJob(repo, { ...opts, env })
  return resultIn(mode, outcome, env)
}

/**
 * The outcome as the job reports it in its mode. Advisory never blocks: a failure says "⚠ Advisory" and GitLab gets
 * exit 3 ("passed with warnings" with allow_failure: exit_codes: [3]); GitHub can't allow one exit code, so there it
 * is a warning annotation and exit 0.
 */
function resultIn(mode: CiMode, o: Outcome, env: NodeJS.ProcessEnv): CiResult {
  const advise = mode === 'advisory' && o.code === 1
  const first = advise ? advisoryLine(o.head) : headLine(o)
  const comment = o.comment !== undefined ? { comment: o.comment } : {}
  const res: CiResult = { code: o.code, lines: [first, ...o.lines], ...comment, mode }
  if (!advise) return res
  if (env.GITHUB_ACTIONS) {
    res.lines.push(githubAnnotation('warning', ANNOTATION_TITLE, first))
    res.code = 0
  } else {
    res.code = 3
  }
  return res
}

/** A GitHub Actions workflow command (`::warning title=…::message`), its message escaped as GitHub reads it. */
function githubAnnotation(kind: 'warning' | 'error', title: string, message: string): string {
  const escaped = message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
  return `::${kind} title=${title}::${escaped}`
}

/** `required` (default) or `advisory`: UNDERSTANDING_MODE, else the config's "mode". */
export function ciMode(cfg: Pick<Config, 'mode'> = DEFAULTS, env: NodeJS.ProcessEnv = process.env): CiMode {
  return (env.UNDERSTANDING_MODE || cfg.mode) === 'advisory' ? 'advisory' : 'required'
}

/** What the job concluded, and the mode it judges in. */
interface JobResult { outcome: Outcome; mode: CiMode }

/** The job, step by step: base and settings, no code changed, the skip label, the check file, threads, the comment. */
async function ciJob(repo: string, opts: CiOptions = {}): Promise<JobResult> {
  const { env = process.env, comment = true, base: baseFlag } = opts
  const ctx = ciContext(env)
  const head = ctx.head || gitOk(repo, ['rev-parse', 'HEAD'])
  const rel = fileFor(ctx.branch || currentBranch(repo, env))
  let base = resolveBase(repo, ctx, baseFlag, head)
  const cfg = targetConfig(repo, ctx, base)
  const mode = ciMode(cfg, env)
  const advisory = mode === 'advisory'
  const unknown = unknownSettings(repo)
  const unknownLines = unknown.length ? [unknownLine(unknown)] : []
  const finish = (o: Outcome): JobResult => ({ outcome: { ...o, lines: [...o.lines, ...unknownLines] }, mode })
  // Stacked on a branch whose check is committed here (or the same work under a new branch name): that code
  // was checked.
  const bothKnown = !!base && hasCommit(repo, base) && !!head && hasCommit(repo, head)
  const stacked = bothKnown ? stackBase(repo, base!, head!, rel) : undefined
  if (stacked) base = stacked.base
  if (!base || !hasCommit(repo, base) || !hasCommit(repo, head)) return finish(cantCheck(NO_HISTORY))

  const change = codeStat(repo, base, head, cfg.exempt)
  const forge = forgeOf(ctx)
  const canApi = ctx.platform !== 'local' && !!ctx.token && !!ctx.mr && !!ctx.api
  // This merge request changes the check's own settings (understanding/config.json): said to everyone, first.
  const settings = settingsChange(repo, base, head!)
  const send = comment && cfg.mrComment
  const post = (o: Outcome, body: string | undefined): Promise<Outcome> => {
    return postResult(o, body, { ctx, canApi, send, settings, advisory })
  }
  // The settings change as a log line (no markdown).
  const settingsPlain = (): string => settingsChange(repo, base, head!, { plain: true })!

  if (!linesOf(change) && !change.renamed?.length) {
    const text = noCheckNeeded({ repo, base, head: head!, change, exempt: cfg.exempt, stackedOn: stacked?.branch, settings })
    if (!settings) return finish(passed(text))
    // Only the settings changed: the comment says so (a policy change everyone should see), nothing else.
    return finish(await post(passed(text, [`  ${settingsPlain()}`]), MARKER))
  }
  let info: { labels: string[]; author?: string } = { labels: ctx.labels ?? [], author: ctx.author }
  if (canApi) {
    try {
      info = await mrInfo(ctx)
    } catch (e) {
      return finish(cantCheck(cantReadMr((e as Error).message)))
    }
  }

  // Advisory: nothing blocks, so nothing to skip.
  const asked = !advisory && info.labels.includes(cfg.skipLabel)
  let approved: string[] | undefined
  if (asked && canApi) {
    try {
      approved = await approvers(ctx)
    } catch (e) {
      return finish(cantCheck(cantReadApprovals((e as Error).message)))
    }
  }
  const skip = asked ? skipDecision({ approved, author: info.author, skipLabel: cfg.skipLabel, forge }) : undefined
  if (skip?.waived) {
    const waived = SKIP.waived(skip.by)
    return finish(await post(passed(waived), `${MARKER}\n✓ ${waived}`))
  }

  const res = await checkResult(repo, {
    cfg,
    ctx,
    head: head!,
    base,
    rel,
    change,
    rerun: forge.rerun,
    quiet: advisory || !!skip,
  })
  // Flagged concerns go on their lines first, as threads a reviewer can resolve (never fails the job); the comment
  // then lists them as one-line links to those threads.
  const threads = new Map<string, string>()
  let synced: string[] = []
  if (res.check && canApi && send) {
    synced = await syncConcerns(ctx, res.check, {
      head,
      link: res.link,
      urls: threads,
      repo,
      items: res.items ?? reviewItems(res.check),
      diff: res.diff,
      changed: res.changed,
    })
  }
  const body = commentOf(res, threads)
  // A skip asked for but not granted goes first, when the check doesn't pass either.
  const skipFirst = skip && res.outcome.code !== 0 ? skip : undefined
  const done = skipFirst
    ? await post(skipped(skipFirst, res.outcome), skipFirst.body ?? body)
    : await post(res.outcome, body)
  if (settings) done.lines.unshift(settingsLater(settingsPlain()))
  done.lines.push(...synced)
  // The repository doesn't collapse check files in diffs yet: a tip in the log (never in the comment).
  if (res.check && setupMissing(repo).length) done.lines.push(foldTip(cliName(repo)))
  return finish(done)
}

/** Why no check is needed (the log's line): a stack's parent covers it, only the settings changed, or no code lines. */
interface NoCheckInput {
  repo: string
  base: string
  head: string
  change: CodeStat
  exempt: string[]
  /** The stack's parent whose check covers this change. */
  stackedOn?: string
  /** The settings change, if any. */
  settings?: string
}

function noCheckNeeded(o: NoCheckInput): string {
  if (o.stackedOn) return coveredBy(o.stackedOn)
  const onlySettings = !!o.settings && !numstat(o.repo, o.base, o.head).some((f) => counted(f.file, o.exempt))
  return onlySettings ? ONLY_SETTINGS : noCheckText(o.change)
}

/** The comment: checkResult's own text, or its headline rendered with the items' thread links (`threads`). */
function commentOf(res: CheckOutcome, threads: Map<string, string>): string {
  if ('body' in res.comment) return res.comment.body
  const { sum, headline, qa } = res.comment
  return commentBody(res.check!, sum, headline, res.link, { qa, changed: res.changed, items: res.items, threads })
}

/** A skip that wasn't granted, first, then the check's own outcome (`res`) under it. */
function skipped(skip: Extract<Skip, { waived: false }>, res: Outcome): Outcome {
  return { code: res.code, glyph: skip.glyph, head: skip.head, lines: [headLine(res), ...res.lines] }
}

/**
 * The commit the change starts from: `--base`, else CI's (the merge request's diff base), else the merge base with
 * the target branch (CI's, or the repository's default branch).
 */
function resolveBase(repo: string, ctx: CiContext, flag: string | undefined, head: string | undefined): string | undefined {
  const base = flag ?? ctx.base
  if (base) return base
  const ref = ctx.baseRef ?? defaultBase(repo)
  return ref && head ? mergeBase(repo, ref, head) : undefined
}

/**
 * The settings the job judges by: the target branch's (its tip when the clone has it, else the merge base). A merge
 * request that changes them (mode advisory, a bigger maxDrift, a new exempt glob) is still judged by the settings it
 * would change.
 */
function targetConfig(repo: string, ctx: CiContext, base: string | undefined): Config {
  const target = [ctx.baseRef, base].find((r) => r && gitOk(repo, ['rev-parse', '--verify', '--quiet', `${r}^{commit}`]))
  return target ? loadConfig(repo, { at: target }) : loadConfig(repo)
}

/** What skipDecision decides from. */
interface SkipInput {
  /** Who approved, the author included; undefined: the job can't see approvals (no token). */
  approved: string[] | undefined
  /** The merge request's author. */
  author: string | undefined
  /** The label that asks for a skip (config "skipLabel"). */
  skipLabel: string
  /** The forge: its token variable and what to do after an approval. */
  forge: Pick<Forge, 'tokenVar' | 'rerun'>
}

/** The skip label's outcome: waived by `by`, or the line that says what is missing (and the comment's, if its own). */
type Skip = { waived: true; by: string[] } | { waived: false; glyph: '✗' | ''; head: string; body?: string }

/**
 * Who can bypass the check, once the skip label is set: anyone who approved except the author (good faith: no reason
 * asked). `approved`: who approved, author included; undefined when the job can't see approvals (no token).
 *   approvals                      outcome
 *   can't see them                 not waived: "Label is set, but this job can't see approvals (no <token>)"
 *   someone besides the author     waived, by them
 *   the author only                not waived: "Approved only by <author>"; the comment: "Your own approval doesn't count"
 *   none                           not waived: "Skip requested: an approval from a reviewer waives …" (log and comment)
 */
export function skipDecision({ approved, author, skipLabel, forge }: SkipInput): Skip {
  if (!approved) return { waived: false, glyph: '✗', head: SKIP.blind(skipLabel, forge.tokenVar) }
  const others = approved.filter((u) => u !== author)
  if (others.length) return { waived: true, by: others }
  const { rerun } = forge
  if (approved.length) {
    const body = `${MARKER}\n${SKIP.ownApproval(rerun)}`
    return { waived: false, glyph: '✗', head: SKIP.authorOnly(author, rerun), body }
  }
  return { waived: false, glyph: '', head: SKIP.asked(rerun), body: `${MARKER}\n${SKIP.asked(rerun)}` }
}

/**
 * The comment written (when the job comments: `send`), with the settings change and the advisory line under its
 * headline; the log says whether the forge took it.
 */
interface PostOptions {
  ctx: CiContext
  /** The job can call the forge's API (a token, a merge request). */
  canApi: boolean
  /** The job writes a comment (not --no-comment, config "mrComment"). */
  send: boolean
  /** The settings change, said under the headline. */
  settings: string | undefined
  advisory: boolean
}

async function postResult(o: Outcome, body: string | undefined, opts: PostOptions): Promise<Outcome> {
  const { ctx, canApi, send, settings, advisory } = opts
  if (!send || !body) return o
  const top = [...(settings ? [settingsHeadline(settings)] : []), ...(advisory ? [ADVISORY_COMMENT] : [])]
  if (top.length) {
    const [headline, ...rest] = body.split('\n')
    body = [headline, ...top, ...(rest.length ? [''] : []), ...rest].join('\n')
  }
  o.comment = body
  if (canApi) {
    try {
      o.lines.push(commentWritten(await upsertComment(ctx, body)))
    } catch (e) {
      o.lines.push(commentFailed((e as Error).message))
    }
  }
  return o
}

/**
 * checkResult's result: the outcome, its comment (`body`, or a headline commentBody renders once the threads are
 * known), and what the review threads need: the check, links to its lines, the diff, concerns whose lines changed.
 */
interface CheckOutcome {
  outcome: Outcome
  comment: { body: string } | { headline: string; qa: boolean; sum: Summary }
  check?: Check
  link?: (q: Spot) => string | undefined
  diff?: string
  changed?: Map<string, string>
  items?: ReturnType<typeof reviewItems>
}

/** What checkResult reads besides the repository. */
interface CheckInput {
  cfg: Config
  ctx: CiContext
  head: string
  base: string
  /** The check file, relative to the repository. */
  rel: string
  change: CodeStat
  /** What to do after a reviewer approves (the forge's rerun). */
  rerun: string
  /** No skip instructions (advisory, or the label is there already). */
  quiet?: boolean
}

/** The check file against this change: the outcome and the merge request comment. */
async function checkResult(repo: string, input: CheckInput): Promise<CheckOutcome> {
  const { cfg, ctx, head, base, rel, change, rerun, quiet = false } = input
  const abs = path.join(repo, rel)
  if (!fs.existsSync(abs)) {
    const size = sizeWords(questionsForChange(change, cfg))
    const withoutVs = withoutVsCode(hasSkill(repo))
    const [first, ...more] = missingLog(rel, { size, skipLabel: cfg.skipLabel, rerun, quiet, withoutVs })
    const body = missingBody(rel, cfg, rerun.replace('this job', 'the job'), { quiet, size })
    return { outcome: failed(first, more), comment: { body } }
  }
  let check: Check
  try {
    check = readCheck(abs)
  } catch (e) {
    const outcome = failed(INVALID.notJson.log(rel, (e as Error).message))
    return { outcome, comment: { body: `${MARKER}\n${INVALID.notJson.comment(rel)}` } }
  }
  const errs = validateCheck(check, { repo })
  if (errs.length) {
    const outcome = failed(INVALID.notValid.log(rel, errs[0]), errs.slice(1, 4).map((e) => `  ${e}`))
    return { outcome, comment: { body: `${MARKER}\n${INVALID.notValid.comment(rel, inline(errs[0]))}` } }
  }

  const drift = driftOf(repo, check, head, change, cfg.exempt, base)
  relocate(repo, check) // the lines as they are in this commit
  const sum: Summary = summarize(check, cfg)
  const state = checkState({ exists: true, summary: sum, drift }, cfg)
  const diff = diffOrEmpty(repo, base, head, cfg.exempt)
  const link = (q: Spot): string | undefined => refLink({ ...ctx, head }, q, diff)
  // Concerns whose line changed since the questions' commit: "lines changed in <sha> · fixed?".
  const changed = new Map<string, string>()
  for (const q of check.questions) {
    if (!liveConcern(q)) continue
    const sha = concernChangedIn(repo, q, check.head, head)
    if (sha !== undefined) changed.set(q.id, sha)
  }
  // The check and its links go along: the job posts its review items on their lines.
  const along = { check, link, diff, changed }
  const bad = hashProblems(check)
  if (state.phase !== 'drift' && bad.length) {
    const outcome = failed(INVALID.regraded.log(rel, bad))
    return { outcome, comment: { body: `${MARKER}\n${INVALID.regraded.comment}` }, ...along }
  }
  const phase = reportedPhase(state.phase)
  const words: ResultWords = { sum, drift, rel, rule: ruleText(sum), room: roomText(drift, cfg.maxDrift) }
  const qa = phase === 'drift' ? sum.met : phase === 'done'
  const ci = PHASE[phase].ci
  // Each question in a line under the result (not for a top-up: the questions are the old ones).
  const qLines = phase === 'drift' ? [] : check.questions.map((q, i) => questionLine(q, MARK[sum.states[i]]))
  const outcome = phase === 'done' ? passed(ci.log(words), qLines) : failed(ci.log(words), qLines)
  const items = reviewItems(check, sum, { qa })
  return { outcome, comment: { headline: ci.comment(words), qa, sum }, items, ...along }
}

/** The phase CI reports for a valid check (checkState gives only these here; anything else reads as done). */
function reportedPhase(phase: Phase): CheckedPhase {
  if (phase === 'drift' || phase === 'answering' || phase === 'short') return phase
  return 'done'
}

/** A question in the log: its mark, id, kind and text, cut at 70 characters. */
function questionLine(q: Question, mark: string): string {
  const plain = q.text.replace(/`/g, '').trim()
  return `  ${mark} ${q.id} ${q.kind}: ${plain.slice(0, 70)}${plain.length > 70 ? '…' : ''}`
}
