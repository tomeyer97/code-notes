// The command line: `node understanding.mjs <command>` (see HELP).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CI_URL, DOCS_URL, hasSkill, SKILL_DIR, SKILL_URL, withoutVsCode } from './constants.mjs'
import { currentBranch, repoRoot } from './git.mjs'
import { diffText } from './diff.mjs'
import { addAttempt, fileFor, flagConcern, gitIdentity, loadConfig, readCheck, unknownLine, unknownSettings, writeCheck } from './checkFile.mjs'
import { validateCheck } from './validate.mjs'
import { localStatus, nextQuestion, stamp, stateOf, stateWords, summarize } from './state.mjs'
import { applyGrade, gradeQuestion, promptFor } from './grading.mjs'
import { pickBackend } from './graderBackends.mjs'
import { commitCheck } from './push.mjs'
import { MARK } from './mrComment.mjs'
import { runCi } from './ci.mjs'
import { FOLD_TEXT, initRepo, installSkill } from './init.mjs'

const HELP = `understanding.mjs: an understanding check for a change (docs: ${DOCS_URL})

  status [--json] [--base <ref>]          this branch's check: valid?, answered/passed, what to do next
  validate <file>                         check a file's format
  grade [<file>] [--question q2] [--answer "text"] [--write] [--backend claude|anthropic] [--model m]
                                          grade answers (local only): the ungraded ones, or one question;
                                          the file defaults to this branch's
                                          (--answer adds an attempt first; --write saves the result)
  grade --question q2 --answer "text" --prompt
                                          print the grader's instructions for that answer (nothing saved)
  grade --question q2 --answer "text" --reply '{"verdict": …}'
                                          record that answer with a grade written elsewhere (Claude Code in a
                                          chat), checked and saved as the extension saves it; no model call
  next                                    the question to answer next
  flag --question q2                      flag its concern for the reviewer (the merge request lists it)
  commit [--no-push]                      commit this branch's check file and push (the first check also adds
                                          the .gitattributes line that folds check files in diffs)
  ci [--no-comment] [--base <sha>]        the CI job: never calls a model; exit 0 pass, 1 fail, 2 can't check,
                                          3 would fail but advisory (config "mode", UNDERSTANDING_MODE)
  init                                    set up the repository: understanding/ out of diffs and search
                                          (.gitattributes, .ignore) and the skill in .claude/skills, for
                                          /understanding-check in Claude Code

Config: understanding/config.json. Grader: --backend, UNDERSTANDING_BACKEND, or claude when on PATH, else
ANTHROPIC_API_KEY (Messages API). UNDERSTANDING_CLAUDE: the claude CLI to run.
The questions are written by the understanding-check skill: in VS Code by Code Notes, else by Claude Code
(/understanding-check; ${SKILL_URL}).`

export function parseArgs(argv) {
  const o = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { o._.push(a); continue }
    const [k, v] = a.slice(2).split(/=(.*)/s)
    if (v !== undefined) o[k] = v
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--') && !['json', 'write', 'no-comment', 'suspect', 'whole-file', 'top-up', 'replace', 'evidence', 'none', 'prompt', 'no-push'].includes(k)) o[k] = argv[++i]
    else o[k] = true
  }
  return o
}

export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), env = process.env, print = (s) => console.log(s) } = {}) {
  const o = parseArgs(argv)
  const cmd = o._[0]
  const repo = repoRoot(cwd) ?? cwd
  if (!cmd || cmd === 'help' || o.help) { print(HELP); return 0 }
  if (cmd === 'status') {
    const s = localStatus(repo, { base: typeof o.base === 'string' ? o.base : undefined, env })
    if (o.json) { const { check, ...rest } = s; print(JSON.stringify(rest, null, 2)); return 0 }
    const w = stateWords(s.state, s)
    print(w.title ? `${w.title}${w.line ? ` · ${w.line}` : ''}` : w.line)
    if (s.state.phase === 'none') {
      print('  Run "Code Notes: Check my understanding" in VS Code.')
      print(`  ${withoutVsCode(hasSkill(repo))}`)
    }
    print(`  ${s.branch} · ${s.file}${s.exists ? '' : ' (none yet)'} · ${s.changed} code line${s.changed === 1 ? '' : 's'} changed`)
    if (s.conflict) print(`  First conflict at ${s.file}:${s.conflict.line}.`)
    if (s.summary) print(`  ${s.summary.done} done, ${s.summary.passed} passed · ${s.drift.lines} lines since the check`)
    const unknown = unknownSettings(repo)
    if (unknown.length) print(unknownLine(unknown))
    // A file that can't be read is an error for scripts and hooks too.
    return s.state.phase === 'invalid' ? 1 : 0
  }
  if (cmd === 'init') {
    const changed = initRepo(repo)
    const skill = installSkill(repo)
    const files = [...new Set(changed.map((l) => l.split(':')[0]))]
    print(changed.length || skill?.length ? `Added: ${[...changed, ...(skill?.length ? [`the skill (${SKILL_DIR}: ${skill.map((f) => path.basename(f)).join(', ')})`] : [])].join('; ')}.` : 'Already set up.')
    if (files.length || skill?.length) print(`Commit them: git add ${[...files, ...(skill?.length ? [SKILL_DIR] : [])].join(' ')} && git commit -m "Add understanding check setup"`)
    if (skill?.length || (skill && hasSkill(repo))) print('Without VS Code: type /understanding-check in Claude Code.')
    else if (!skill) print(withoutVsCode(hasSkill(repo)))
    // The CI job goes in the last stage with needs: [] (in .pre, a missing check would skip lint and tests).
    print(`CI recipe: ${CI_URL}`)
    return 0
  }
  if (cmd === 'validate') {
    const f = o._[1]
    if (!f) { print('validate: which file?'); return 2 }
    let c
    try { c = readCheck(path.resolve(cwd, f)) } catch (e) { print(`✗ ${f}: ${e.message}`); return 1 }
    const errs = validateCheck(c, { repo })
    if (!errs.length) { print(`✓ ${f}: ${c.questions.length} questions`); return 0 }
    for (const e of errs) print(`✗ ${e}`)
    return 1
  }
  if (cmd === 'grade') {
    const f = o._[1] ? path.resolve(cwd, o._[1]) : path.join(repo, fileFor(currentBranch(repo, env)))
    let c
    try { c = readCheck(f) } catch (e) { print(`✗ ${f}: ${e.message}`); return 2 }
    const errs = validateCheck(c)
    if (errs.length) { print(`✗ not valid: ${errs[0]}`); return 2 }
    const cfg = loadConfig(repo)
    let list = c.questions.filter((q) => stateOf(q) === 'ungraded')
    if ((o.prompt || o.reply !== undefined) && (typeof o.question !== 'string' || typeof o.answer !== 'string')) { print(`--${o.prompt ? 'prompt' : 'reply'} needs --question and --answer`); return 2 }
    if (typeof o.question === 'string') {
      const q = c.questions.find((x) => x.id === o.question)
      if (!q) { print(`✗ no question ${o.question}`); return 2 }
      // The grader's instructions for this answer, for Claude Code to grade in a chat: nothing is recorded.
      if (o.prompt) { print(promptFor(repo, c, q, o.answer)); return 0 }
      if (typeof o.answer === 'string') addAttempt(c, q, o.answer, gitIdentity(repo))
      // A grade written elsewhere (Claude Code in a chat): checked and recorded like the grader's own reply.
      if (o.reply !== undefined) {
        let a
        try { a = applyGrade(repo, q, q.attempts.at(-1), String(o.reply)) } catch (e) { print(`✗ ${e.message}`); return 2 }
        writeCheck(f, stamp(c, cfg))
        print(gradeLine(q, a))
        print(progressLine(c, cfg, repo, env))
        return 0
      }
      list = [q]
    } else if (typeof o.answer === 'string') { print('--answer needs --question'); return 2 }
    if (!list.length) { print('Nothing to grade: no answers without a verdict.'); return 0 }
    let backend
    try { backend = pickBackend({ flag: typeof o.backend === 'string' ? o.backend : undefined, cfg, env }) } catch (e) { print(`! ${e.message}`); return 2 }
    const model = typeof o.model === 'string' ? o.model : cfg.model ?? env.UNDERSTANDING_MODEL ?? undefined
    let diff
    try { diff = diffText(repo, c.base ?? c.head, undefined) } catch { diff = '' }
    let failed = 0
    await Promise.all(list.map(async (q) => {
      try {
        const a = await gradeQuestion(repo, c, q, { backend, model, env, diff })
        print(gradeLine(q, a))
      } catch (e) { failed++; print(`! ${q.id}: ${e.message}`) }
    }))
    if (o.write) { writeCheck(f, stamp(c, cfg)); print(`Saved ${path.relative(repo, f)}.`) }
    return failed ? 2 : 0
  }
  if (cmd === 'next') {
    const f = path.join(repo, fileFor(currentBranch(repo, env)))
    let c
    try { c = readCheck(f) } catch { print(`No check yet: ${path.relative(repo, f)} doesn't exist.`); return 1 }
    const q = nextQuestion(c)
    if (!q) { print(progressLine(c, loadConfig(repo), repo, env)); return 0 }
    const i = c.questions.indexOf(q)
    const tries = (q.attempts ?? []).filter((a) => a.verdict).length
    print(`${q.id} (${i + 1} of ${c.questions.length}${tries ? `, try ${tries + 1}` : ''}) · ${q.kind} · ${q.target === 'file' ? q.file : `${q.file}:${q.start}-${q.end}`}${q.also?.length ? ` · also ${q.also.map((x) => `${x.file}:${x.start}-${x.end}`).join(', ')}` : ''}`)
    print(q.text)
    const hint = q.attempts?.at(-1)?.verdict === 'retry' ? q.attempts.at(-1).hint : ''
    if (hint) print(`Hint: ${hint}`)
    return 0
  }
  if (cmd === 'flag') {
    const f = path.join(repo, fileFor(currentBranch(repo, env)))
    let c
    try { c = readCheck(f) } catch { print(`No check yet: ${path.relative(repo, f)} doesn't exist.`); return 1 }
    const q = c.questions.find((x) => x.id === o.question)
    if (!q) { print(`✗ no question ${o.question ?? '(--question q1)'}`); return 2 }
    if (!flagConcern(c, q, gitIdentity(repo))) { print(`${q.id} has no concern to flag.`); return 1 }
    writeCheck(f, c)
    print(`⚠ Flagged for the reviewer: ${q.concern.text}`)
    return 0
  }
  if (cmd === 'commit') {
    const r = await commitCheck(repo, { env, push: !o['no-push'] })
    if (!r.ok) { print(`✗ ${r.line}`); return 1 }
    const what = `${r.files.map((x) => path.basename(x)).join(', ')}${r.files.includes('.gitattributes') ? ` (${FOLD_TEXT.replace(/ \(.*$/, '')})` : ''}`
    print(`${r.committed ? `Committed ${what}. ` : ''}${r.line === 'Committed.' ? '' : r.line}${r.mr ? ` Open a merge request: ${r.mr}` : ''}`.trim())
    return 0
  }
  if (cmd === 'ci') {
    const r = await runCi(repo, { env, comment: !o['no-comment'], base: typeof o.base === 'string' ? o.base : undefined })
    for (const l of r.lines) print(l)
    return r.code
  }
  print(`unknown command "${cmd}"\n\n${HELP}`)
  return 2
}

/** One grade in a line: "✓ q1 pass: Right: …", with the hint and a concern when there are. */
const gradeLine = (q, a) => `${MARK[a.verdict]} ${q.id} ${a.verdict}${a.partial ? ' (mostly right)' : ''}: ${a.feedback}${a.hint ? `\n  Hint: ${a.hint}` : ''}${a.concern ? `\n  Concern: ${a.concern}` : ''}`
/** Where the check stands after a grade, and what is next: the next question, or the commit. */
function progressLine(check, cfg, repo, env) {
  const s = summarize(check, cfg)
  const next = nextQuestion(check)
  if (next) return `${s.done} of ${s.total} done · next: ${next.id}`
  return s.met ? `✓ Done: ${s.passed} of ${s.total} passed (${s.needed} needed). Commit and push: node ${cliName(repo)} commit` : `${s.passed} passed, ${s.needed} must pass: say an explained answer back in one sentence (grade --question <id> --answer "…" --reply …).`
}
/** This file's path for a command line: relative to the repository when it is inside it. */
const cliName = (repo) => { const me = path.relative(repo, fileURLToPath(import.meta.url)); return me && !me.startsWith('..') && !path.isAbsolute(me) ? me : 'understanding.mjs' }

const self = fileURLToPath(import.meta.url)
if (process.argv[1] && (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(self) } catch { return false } })()) {
  main().then((code) => { process.exitCode = code }, (e) => { console.error(`! ${e.message}`); process.exitCode = 2 })
}
