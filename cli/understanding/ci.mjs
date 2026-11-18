// The CI job (`ci`): never calls a model; checks that the check was done for this change and meets the rule.
import fs from 'node:fs'
import path from 'node:path'
import { cliName, DEFAULTS, hasSkill, MARKER, withoutVsCode } from './constants.mjs'
import { currentBranch, defaultBase, gitOk, hasCommit, mergeBase, stackBase } from './git.mjs'
import { codeStat, diffText, linesOf, numstat } from './diff.mjs'
import { minutesFor, questionsForChange, sizeWords } from './size.mjs'
import { fileFor, loadConfig, readCheck, unknownLine, unknownSettings } from './checkFile.mjs'
import { hashProblems, validateCheck } from './validate.mjs'
import { checkState, driftOf, ruleText, summarize } from './state.mjs'
import { relocate } from './anchors.mjs'
import { approvers, ciContext, mrInfo, upsertComment } from './platform.mjs'
import { commentBody, concernChangedIn, inline, liveConcern, MARK, missingBody, noCheckLine, refLink, reviewItems, settingsChange, settingsHeadline } from './mrComment.mjs'
import { syncConcerns } from './threads.mjs'
import { setupMissing } from './init.mjs'
import { counted } from './changeFiles.mjs'

/**
 * The CI job (no model calls). No code lines changed (or only exempt files) → pass. Skip label + an approval by
 * someone other than the author → waived. Else the file must exist, be valid, belong to this change (drift in code
 * lines), match its hashes, and meet the rule (checkState: every question done, enough passed). A skip label without a
 * valid approval only says how to waive when the check itself doesn't pass. The merge request comment follows the job:
 * its first line says the result or what is missing. Returns { code, lines, comment?, mode }: 0 pass, 1 fail, 2 can't
 * check, 3 a failure in advisory mode (on GitHub Actions: 0 with a warning annotation).
 */
export async function runCi(repo, opts = {}) {
  const env = opts.env ?? process.env
  const res = await ciJob(repo, { ...opts, env })
  const mode = res.mode ?? ciMode(loadConfig(repo), env)
  res.mode = mode
  if (mode !== 'advisory' || res.code !== 1) return res
  // Advisory: never blocks. GitLab shows exit 3 as "passed with warnings" (allow_failure: exit_codes: [3]); GitHub
  // can't allow one exit code, so there it is a warning annotation and exit 0.
  res.lines[0] = `⚠ Advisory: ${res.lines[0].replace(/^[✗!]\s*/, '')}`
  if (env.GITHUB_ACTIONS) { res.lines.push(`::warning title=Understanding check::${res.lines[0].replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`); res.code = 0 } else res.code = 3
  return res
}

/** `required` (default) or `advisory`: UNDERSTANDING_MODE, else the config's "mode". */
export function ciMode(cfg = DEFAULTS, env = process.env) {
  return (env.UNDERSTANDING_MODE || cfg.mode) === 'advisory' ? 'advisory' : 'required'
}

async function ciJob(repo, { env = process.env, comment = true, base: baseFlag } = {}) {
  const ctx = ciContext(env)
  const head = ctx.head || gitOk(repo, ['rev-parse', 'HEAD'])
  const branch = ctx.branch || currentBranch(repo, env)
  const rel = fileFor(branch)
  let base = baseFlag ?? ctx.base
  if (!base) { const ref = ctx.baseRef ?? defaultBase(repo); base = ref && head ? mergeBase(repo, ref, head) : undefined }
  // The target branch's settings (its tip when the clone has it, else the merge base): a merge request that changes them
  // (mode advisory, a bigger maxDrift, a new exempt glob) is still judged by the settings it would change.
  const target = [ctx.baseRef, base].find((r) => r && gitOk(repo, ['rev-parse', '--verify', '--quiet', `${r}^{commit}`]))
  const cfg = target ? loadConfig(repo, { at: target }) : loadConfig(repo)
  const mode = ciMode(cfg, env)
  const advisory = mode === 'advisory'
  const unknown = unknownSettings(repo)
  const finish = (res) => Object.assign(res, { mode, lines: [...res.lines, ...(unknown.length ? [unknownLine(unknown)] : [])] })
  // Stacked on a branch whose check is committed here (or the same work under a new branch name): that code was checked.
  const stacked = base && hasCommit(repo, base) && head && hasCommit(repo, head) ? stackBase(repo, base, head, rel) : undefined
  if (stacked) base = stacked.base
  if (!base || !hasCommit(repo, base) || !hasCommit(repo, head)) {
    return finish({ code: 2, lines: ['! Understanding check: the base or head commit is not in this clone. Fetch the full history (GitLab: GIT_DEPTH: 0; GitHub: fetch-depth: 0).'] })
  }
  const change = codeStat(repo, base, head, cfg.exempt)
  const canApi = ctx.platform !== 'local' && !!ctx.token && !!ctx.mr && !!ctx.api
  // GitHub runs the job again on a review (the recipe listens to it); GitLab doesn't.
  const rerun = ctx.platform === 'github' ? '' : ', then re-run this job'
  // This merge request changes the check's own settings (understanding/config.json): said to everyone, first.
  const settings = settingsChange(repo, base, head)
  const post = async (res, body) => {
    if (!comment || !cfg.mrComment || !body) return res
    const top = [...(settings ? [settingsHeadline(settings)] : []), ...(advisory ? ["Advisory: this check doesn't block merging."] : [])]
    if (top.length) { const [m, ...rest] = body.split('\n'); body = [m, ...top, ...(rest.length ? [''] : []), ...rest].join('\n') }
    res.comment = body
    if (canApi) { try { res.lines.push(`  Merge request comment ${await upsertComment(ctx, body)}.`) } catch (e) { res.lines.push(`  (couldn't write the merge request comment: ${e.message})`) } }
    return res
  }
  if (!linesOf(change) && !change.renamed?.length) {
    const line = stacked ? `✓ No check needed: covered by ${stacked.branch}'s check (no code changed since).` : settings && !numstat(repo, base, head).some((f) => counted(f.file, cfg.exempt)) ? '✓ No check needed: only the check\'s settings changed.' : noCheckLine(change)
    // Only the settings changed: the comment says so (a policy change everyone should see), nothing else.
    return finish(settings ? await post({ code: 0, lines: [line, `  ${settingsChange(repo, base, head, { plain: true })}`] }, MARKER) : { code: 0, lines: [line] })
  }
  let info = { labels: ctx.labels ?? [], author: ctx.author }
  if (canApi) { try { info = await mrInfo(ctx) } catch (e) { return finish({ code: 2, lines: [`! Understanding check: couldn't read the merge request: ${e.message}`] }) } }

  // Skip: an approval by anyone but the author waives the check (good faith: no reason asked).
  let skip
  // Advisory: nothing blocks, so nothing to skip.
  if (!advisory && info.labels.includes(cfg.skipLabel)) {
    if (!canApi) skip = { line: `✗ Label "${cfg.skipLabel}" is set, but this job can't see approvals (no ${ctx.platform === 'github' ? 'GITHUB_TOKEN' : 'GITLAB_TOKEN'}).` }
    else {
      let all = []
      try { all = await approvers(ctx) } catch (e) { return finish({ code: 2, lines: [`! Understanding check: couldn't read approvals: ${e.message}`] }) }
      const others = all.filter((u) => u !== info.author)
      if (others.length) {
        const line = `✓ Understanding check waived (approved by ${others.map((u) => `@${u}`).join(', ')})`
        return finish(await post({ code: 0, lines: [line] }, `${MARKER}\n${line}`))
      }
      const asked = `Skip requested: an approval from a reviewer waives the understanding check${rerun}.`
      const own = `Your own approval doesn't count: ask a reviewer to approve${rerun}.`
      skip = { line: all.length ? `✗ Approved only by ${info.author} (the author). Ask a reviewer to approve${rerun}.` : asked, body: `${MARKER}\n${all.length ? own : asked}` }
    }
  }
  const res = await checkResult(repo, { cfg, ctx, head, base, rel, change, rerun, quiet: advisory || !!skip })
  // Flagged concerns go on their lines first, as threads a reviewer can resolve (never fails the job); the comment
  // then lists them as one-line links to those threads.
  let synced = []
  if (res.check && canApi && comment && cfg.mrComment) {
    const urls = new Map()
    synced = await syncConcerns(ctx, res.check, { head, link: res.link, urls, repo, items: res.items ?? reviewItems(res.check), diff: res.diff, changed: res.changed })
    if (urls.size && res.remake) res.body = res.remake(urls)
  }
  const done = res.code !== 0 && skip ? await post({ code: res.code, lines: [skip.line, ...res.lines] }, skip.body ?? res.body) : await post({ code: res.code, lines: res.lines }, res.body)
  if (settings) done.lines.splice(1, 0, `  ${settingsChange(repo, base, head, { plain: true })} It applies once merged.`)
  done.lines.push(...synced)
  // The repository doesn't collapse check files in diffs yet: a tip in the log (never in the comment).
  if (res.check && setupMissing(repo).length) {
    done.lines.push(`  tip: run "node ${cliName(repo)} init" once and commit .gitattributes and .ignore: check files then collapse in diffs.`)
  }
  return finish(done)
}


/** The check file against this change: `{ code, lines, body }` (body: the merge request comment). */
async function checkResult(repo, { cfg, ctx, head, base, rel, change, rerun, quiet = false }) {
  const abs = path.join(repo, rel)
  if (!fs.existsSync(abs)) {
    const size = sizeWords(questionsForChange(change, cfg))
    return { code: 1, lines: [`✗ No understanding check yet: a few questions about your change (${size}). Run "Code Notes: Check my understanding" in VS Code, then commit ${rel} and push.`,
      `  ${withoutVsCode(hasSkill(repo))}`,
      // Advisory, or the label is there already: no skip instructions.
      ...(quiet ? [] : [`  Or add the label "${cfg.skipLabel}" and get a reviewer's approval${rerun}.`])], body: missingBody(rel, cfg, rerun.replace('this job', 'the job'), { quiet, size }) }
  }
  const short = (line, head) => ({ code: 1, lines: [line], body: `${MARKER}\n${head}` })
  let check
  try { check = readCheck(abs) } catch (e) { return short(`✗ ${rel} is not valid JSON (${e.message}).`, `**Understanding check:** \`${rel}\` is not valid JSON. Run **Check my understanding** again.`) }
  const errs = validateCheck(check, { repo })
  if (errs.length) return { ...short(`✗ ${rel} is not valid: ${errs[0]}.`, `**Understanding check:** \`${rel}\` is not valid (${inline(errs[0])}).`), lines: [`✗ ${rel} is not valid: ${errs[0]}.`, ...errs.slice(1, 4).map((e) => `  ${e}`)] }

  const drift = driftOf(repo, check, head, change, cfg.exempt, base)
  relocate(repo, check) // the lines as they are in this commit
  const sum = summarize(check, cfg)
  const state = checkState({ exists: true, summary: sum, drift }, cfg)
  let diff = ''
  try { diff = diffText(repo, base, head, undefined, cfg.exempt) } catch { /* links fall back to the file */ }
  const link = (q) => refLink({ ...ctx, head }, q, diff)
  // Concerns whose line changed since the questions' commit: "lines changed in <sha> · fixed?".
  const changed = new Map()
  for (const q of check.questions) { if (!liveConcern(q)) continue; const sha = concernChangedIn(repo, q, check.head, head); if (sha !== undefined) changed.set(q.id, sha) }
  // The comment, and the same again once the threads are known (`remake(threads)`); its items go on the code as threads.
  const made = (line, o = {}) => {
    const items = reviewItems(check, sum, { qa: !!o.qa })
    return { items, body: commentBody(check, sum, line, link, { ...o, changed, items }), remake: (threads) => commentBody(check, sum, line, link, { ...o, changed, items, threads }) }
  }
  // The check and its links go along: runCi posts the review items on their lines.
  const out = (r) => Object.assign(r, { check, link, diff, changed })
  // How much room is left before a top-up is needed.
  const room = drift.lines ? ` ${drift.lines} code line${drift.lines === 1 ? '' : 's'} since the check (top-up at ${cfg.maxDrift}).` : ''
  const words = { sum, drift, rel, rule: ruleText(sum), room }
  if (state.phase === 'drift') {
    return out({ code: 1, lines: [RESULT.drift.log(words)], ...made(RESULT.drift.comment(words), { qa: sum.met }) })
  }
  const bad = hashProblems(check)
  if (bad.length) {
    const them = bad.length === 1 ? 'it' : 'them'
    return out(short(
      `✗ ${rel}: ${bad.join(', ')} changed after grading (a merge, or an edit by hand). Grade ${them} again in VS Code, then commit and push.`,
      '**Understanding check:** some answers changed after grading. Grade them again in VS Code, then push.',
    ))
  }
  const plainQ = (q) => q.text.replace(/`/g, '').trim()
  const qLines = check.questions.map((q, i) => `  ${MARK[sum.states[i]]} ${q.id} ${q.kind}: ${plainQ(q).slice(0, 70)}${plainQ(q).length > 70 ? '…' : ''}`)
  const phase = state.phase === 'answering' || state.phase === 'short' ? state.phase : 'done'
  const r = RESULT[phase]
  return out({ code: phase === 'done' ? 0 : 1, lines: [r.log(words), ...qLines], ...made(r.comment(words), phase === 'done' ? { qa: true } : {}) })
}

/**
 * The job's result in words, by phase (checkState's; stateWords has the same phases' words for VS Code and `status`):
 * `log`, the CI log's first line, and `comment`, the merge request comment's headline. `w`: `{ sum, drift, rel, rule,
 * room }`.
 */
const RESULT = {
  drift: {
    log: (w) => `✗ Your change grew by ${w.drift.lines} code lines since the check${w.drift.approx ? ' (compared by size: the branch was rewritten)' : ''}. Run "Check my understanding" again: it adds 1–2 questions about the new part only. Then commit and push.`,
    comment: (w) => `**Understanding check: needs a top-up.** The change grew by ${w.drift.lines} code lines since the questions; 1–2 questions about the new part are missing.`,
  },
  answering: {
    log: (w) => `✗ Understanding check: ${w.sum.done} of ${w.sum.total} done (${w.rule}). Finish in VS Code, commit ${w.rel} and push.`,
    comment: (w) => `**Understanding check in progress:** ${w.sum.done} of ${w.sum.total} done (about ${minutesFor(w.sum.total - w.sum.done)} min left).`,
  },
  short: {
    log: (w) => `✗ Understanding check: ${w.sum.passed} passed, ${w.sum.needed} must pass. In VS Code, say an explained answer back in your own words, then commit and push.`,
    comment: (w) => `**Understanding check in progress:** all ${w.sum.total} answered, not finished yet.`,
  },
  done: {
    log: (w) => `✓ Understanding check done: ${w.sum.passed} of ${w.sum.total} passed (${w.rule}).${w.room}`,
    comment: (w) => `**✓ Understanding check done** · ${w.sum.total} question${w.sum.total === 1 ? '' : 's'}`,
  },
}
