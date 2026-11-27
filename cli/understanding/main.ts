// The command line: `node understanding.mjs <command>` (see HELP).
import fs from 'node:fs'
import path from 'node:path'
import { CI_URL, cliName, DOCS_URL, SKILL_DIR, SKILL_URL, STATE } from './constants'
import { currentBranch, repoRoot } from './git'
import { diffOrEmpty } from './diff'
import { addAttempt, fileFor, flagConcern, gitIdentity, loadConfig, readCheck, unknownLine, unknownSettings, writeCheck } from './checkFile'
import { validateCheck } from './validate'
import { localStatus, nextQuestion, stamp, stateOf, stateWords, summarize } from './state'
import { applyGrade, gradeQuestion, promptFor } from './grading'
import { pickBackend } from './graderBackends'
import { commitCheck } from './push'
import { MARK } from './mrComment'
import { runCi } from './ci'
import { FOLD_TEXT, hasSkill, initRepo, installSkill } from './init'
import { withoutVsCode } from './messages'
import type { Attempt, Check, Config, Question } from './types'

/** The parsed command line (parseArgs): `_` the words, then each `--flag`: its value, or true. */
type Args = { _: string[]; [flag: string]: any }
type Print = (s: string) => void
/** What a command gets: the arguments, the repository, where it runs, the environment, where it prints. */
interface CommandArgs { o: Args; repo: string; cwd: string; env: NodeJS.ProcessEnv; print: Print }

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

/**
 * The flags that never take a value, and who reads them (the skill's scripts/questions.mjs parses with parseArgs
 * too). Any other `--flag` takes the next word as its value unless that word is a flag too; `--flag=value` always does.
 * A new boolean flag goes here and in HELP.
 */
export const BOOLEAN_FLAGS: Record<string, string> = {
  json: 'status',
  write: 'grade',
  prompt: 'grade',
  'no-comment': 'ci',
  'no-push': 'commit',
  suspect: 'questions.mjs',
  'whole-file': 'questions.mjs',
  'top-up': 'questions.mjs',
  replace: 'questions.mjs',
  evidence: 'questions.mjs',
  none: 'questions.mjs',
}

/**
 * The command line: `_` the words, then each `--flag`: its value, or true. Not node:util's parseArgs, whose rules
 * differ where command lines that work today depend on these: `--base --json` (no value here), an unknown
 * `--flag value` (a value here), a word starting with a single "-" (a word here, e.g. an answer).
 */
export function parseArgs(argv: string[]): Args {
  const o: Args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { o._.push(a); continue }
    const [k, v] = a.slice(2).split(/=(.*)/s)
    const next = argv[i + 1]
    if (v !== undefined) o[k] = v
    else if (next !== undefined && !next.startsWith('--') && !Object.hasOwn(BOOLEAN_FLAGS, k)) { o[k] = next; i++ }
    else o[k] = true
  }
  return o
}

export async function main(argv: string[] = process.argv.slice(2), { cwd = process.cwd(), env = process.env, print = (s: string) => console.log(s) }: { cwd?: string; env?: NodeJS.ProcessEnv; print?: Print } = {}): Promise<number> {
  const o = parseArgs(argv)
  const cmd = o._[0]
  const repo = repoRoot(cwd) ?? cwd
  if (!cmd || cmd === 'help' || o.help) { print(HELP); return 0 }
  if (!Object.hasOwn(COMMANDS, cmd)) { print(`unknown command "${cmd}"\n\n${HELP}`); return 2 }
  return COMMANDS[cmd]({ o, repo, cwd, env, print })
}

/** The commands, each `({ o: the arguments, repo, cwd, env, print })` → its exit code. */
const COMMANDS: Record<string, (a: CommandArgs) => number | Promise<number>> = {
  status: statusCommand,
  init: initCommand,
  validate: validateCommand,
  grade: gradeCommand,
  next: nextCommand,
  flag: flagCommand,
  commit: commitCommand,
  ci: ciCommand,
}

function statusCommand({ o, repo, env, print }: CommandArgs): number {
  const s = localStatus(repo, { base: typeof o.base === 'string' ? o.base : undefined, env })
  if (o.json) {
    const { check, ...rest } = s
    print(JSON.stringify(rest, null, 2))
    return 0
  }
  const w = stateWords(s.state, s)
  print(w.title ? `${w.title}${w.line ? ` · ${w.line}` : ''}` : w.line)
  if (s.state.phase === 'none') {
    print('  Run "Code Notes: Check my understanding" in VS Code.')
    print(`  ${withoutVsCode(hasSkill(repo))}`)
  }
  print(`  ${s.branch} · ${s.file}${s.exists ? '' : ' (none yet)'} · ${s.changed} code line${s.changed === 1 ? '' : 's'} changed`)
  if (s.conflict) print(`  First conflict at ${s.file}:${s.conflict.line}.`)
  if (s.summary) print(`  ${s.summary.done} done, ${s.summary.passed} passed · ${s.drift!.lines} lines since the check`)
  const unknown = unknownSettings(repo)
  if (unknown.length) print(unknownLine(unknown))
  // A file that can't be read is an error for scripts and hooks too.
  return s.state.phase === 'invalid' ? 1 : 0
}

function initCommand({ repo, print }: CommandArgs): number {
  const changed = initRepo(repo)
  const skill = installSkill(repo)
  const files = [...new Set(changed.map((l) => l.split(':')[0]))]
  const skillLine = skill.length ? [`the skill (${SKILL_DIR}: ${skill.map((f) => path.basename(f)).join(', ')})`] : []
  print(changed.length || skill.length ? `Added: ${[...changed, ...skillLine].join('; ')}.` : 'Already set up.')
  if (files.length || skill.length) {
    print(`Commit them: git add ${[...files, ...(skill.length ? [SKILL_DIR] : [])].join(' ')} && git commit -m "Add understanding check setup"`)
  }
  print(withoutVsCode(hasSkill(repo)))
  // The CI job goes in the last stage with needs: [] (in .pre, a missing check would skip lint and tests).
  print(`CI recipe: ${CI_URL}`)
  return 0
}

function validateCommand({ o, repo, cwd, print }: CommandArgs): number {
  const f = o._[1]
  if (!f) { print('validate: which file?'); return 2 }
  let c: Check
  try { c = readCheck(path.resolve(cwd, f)) } catch (e) { print(`✗ ${f}: ${(e as Error).message}`); return 1 }
  const errs = validateCheck(c, { repo })
  if (!errs.length) { print(`✓ ${f}: ${c.questions.length} questions`); return 0 }
  for (const e of errs) print(`✗ ${e}`)
  return 1
}

/**
 * `grade`: the ungraded answers (or `--question`'s) graded by a backend (gradeRun); `--prompt` prints the grader's
 * instructions instead (gradePrompt); `--reply` records a grade written elsewhere (recordReply). The file and the
 * flags are checked here, once.
 */
async function gradeCommand({ o, repo, cwd, env, print }: CommandArgs): Promise<number> {
  const f = o._[1] ? path.resolve(cwd, o._[1]) : path.join(repo, fileFor(currentBranch(repo, env)))
  let c: Check
  try { c = readCheck(f) } catch (e) { print(`✗ ${f}: ${(e as Error).message}`); return 2 }
  const errs = validateCheck(c)
  if (errs.length) { print(`✗ not valid: ${errs[0]}`); return 2 }
  const cfg = loadConfig(repo)
  const one = typeof o.question === 'string'
  const answer = typeof o.answer === 'string' ? o.answer : undefined
  if ((o.prompt || o.reply !== undefined) && (!one || answer === undefined)) {
    print(`--${o.prompt ? 'prompt' : 'reply'} needs --question and --answer`)
    return 2
  }
  if (!one && answer !== undefined) { print('--answer needs --question'); return 2 }
  if (!one) return gradeRun({ f, c, list: c.questions.filter((q: Question) => stateOf(q) === STATE.ungraded), cfg, o, repo, env, print })
  const q = c.questions.find((x: Question) => x.id === o.question)
  if (!q) { print(`✗ no question ${o.question}`); return 2 }
  // The grader's instructions for this answer, for Claude Code to grade in a chat: nothing is recorded.
  if (o.prompt) { print(promptFor(repo, c, q, answer!)); return 0 }
  if (answer !== undefined) addAttempt(c, q, answer, gitIdentity(repo))
  // A grade written elsewhere (Claude Code in a chat): checked and recorded like the grader's own reply.
  if (o.reply !== undefined) return recordReply({ f, c, q, cfg, reply: String(o.reply), repo, env, print })
  return gradeRun({ f, c, list: [q], cfg, o, repo, env, print })
}

/** `grade` with a backend: each question of `list` graded at once, said; `--write` saves the file. */
async function gradeRun({ f, c, list, cfg, o, repo, env, print }: { f: string; c: Check; list: Question[]; cfg: Config; o: Args; repo: string; env: NodeJS.ProcessEnv; print: Print }): Promise<number> {
  if (!list.length) { print('Nothing to grade: no answers without a verdict.'); return 0 }
  let backend: ReturnType<typeof pickBackend>
  try {
    backend = pickBackend({ flag: typeof o.backend === 'string' ? o.backend : undefined, cfg, env })
  } catch (e) {
    print(`! ${(e as Error).message}`)
    return 2
  }
  const model = typeof o.model === 'string' ? o.model : cfg.model ?? env.UNDERSTANDING_MODEL ?? undefined
  const diff = diffOrEmpty(repo, c.base ?? c.head)
  const results = await Promise.all(list.map(async (q: Question) => {
    try {
      const a = await gradeQuestion(repo, c, q, { backend, model, env, diff })
      print(gradeLine(q, a))
      return true
    } catch (e) {
      print(`! ${q.id}: ${(e as Error).message}`)
      return false
    }
  }))
  if (o.write) { writeCheck(f, stamp(c, cfg)); print(`Saved ${path.relative(repo, f)}.`) }
  return results.every(Boolean) ? 0 : 2
}

/** `grade --reply`: the grade (`reply`) recorded on question `q`'s latest answer, the file saved, what is next said. */
function recordReply({ f, c, q, cfg, reply, repo, env, print }: { f: string; c: Check; q: Question; cfg: Config; reply: string; repo: string; env: NodeJS.ProcessEnv; print: Print }): number {
  let a: Attempt
  try { a = applyGrade(repo, q, q.attempts!.at(-1)!, reply) } catch (e) { print(`✗ ${(e as Error).message}`); return 2 }
  writeCheck(f, stamp(c, cfg))
  print(gradeLine(q, a))
  print(progressLine(c, cfg, repo, env))
  return 0
}

function nextCommand({ repo, env, print }: CommandArgs): number {
  const branch = branchCheck(repo, env, print)
  if (!branch) return 1
  const c = branch.check
  const q = nextQuestion(c)
  if (!q) { print(grownLine(repo, env) ?? progressLine(c, loadConfig(repo), repo, env)); return 0 }
  const i = c.questions.indexOf(q)
  const tries = (q.attempts ?? []).filter((a: Attempt) => a.verdict).length
  const where = q.target === 'file' ? q.file : `${q.file}:${q.start}-${q.end}`
  const also = q.also?.length ? ` · also ${q.also.map((x: NonNullable<Question['also']>[number]) => `${x.file}:${x.start}-${x.end}`).join(', ')}` : ''
  print(`${q.id} (${i + 1} of ${c.questions.length}${tries ? `, try ${tries + 1}` : ''}) · ${q.kind} · ${where}${also}`)
  print(q.text)
  const hint = q.attempts?.at(-1)?.verdict === STATE.retry ? q.attempts!.at(-1)!.hint : ''
  if (hint) print(`Hint: ${hint}`)
  return 0
}

function flagCommand({ o, repo, env, print }: CommandArgs): number {
  const branch = branchCheck(repo, env, print)
  if (!branch) return 1
  const c = branch.check
  const q = c.questions.find((x: Question) => x.id === o.question)
  if (!q) { print(`✗ no question ${o.question ?? '(--question q1)'}`); return 2 }
  if (!flagConcern(c, q, gitIdentity(repo))) { print(`${q.id} has no concern to flag.`); return 1 }
  writeCheck(branch.file, c)
  print(`⚠ Flagged for the reviewer: ${q.concern!.text}`)
  return 0
}

async function commitCommand({ o, repo, env, print }: CommandArgs): Promise<number> {
  const r = await commitCheck(repo, { env, push: !o['no-push'] })
  if (!r.ok) { print(`✗ ${r.line}`); return 1 }
  const fold = r.files!.includes('.gitattributes') ? ` (${FOLD_TEXT.replace(/ \(.*$/, '')})` : ''
  const what = `${r.files!.map((x) => path.basename(x)).join(', ')}${fold}`
  print(`${r.committed ? `Committed ${what}. ` : ''}${r.line === 'Committed.' ? '' : r.line}${r.mr ? ` Open a merge request: ${r.mr}` : ''}`.trim())
  return 0
}

async function ciCommand({ o, repo, env, print }: CommandArgs): Promise<number> {
  const r = await runCi(repo, { env, comment: !o['no-comment'], base: typeof o.base === 'string' ? o.base : undefined })
  for (const l of r.lines) print(l)
  return r.code
}

/** This branch's check file (`file`) and its check, or undefined after saying there is none yet. */
function branchCheck(repo: string, env: NodeJS.ProcessEnv, print: Print): { file: string; check: Check } | undefined {
  const file = path.join(repo, fileFor(currentBranch(repo, env)))
  try {
    return { file, check: readCheck(file) }
  } catch {
    print(`No check yet: ${path.relative(repo, file)} doesn't exist.`)
    return undefined
  }
}

/** Every question done but the change grew past the check (status's drift): its words, the same as `status`. */
function grownLine(repo: string, env: NodeJS.ProcessEnv): string | undefined {
  const s = localStatus(repo, { env })
  if (s.state.phase !== 'drift') return undefined
  const w = stateWords(s.state, s)
  return `${w.title} · ${w.line}`
}

/** One grade in a line: "✓ q1 pass: Right: …", with the hint and a concern when there are. */
function gradeLine(q: Question, a: Attempt): string {
  const hint = a.hint ? `\n  Hint: ${a.hint}` : ''
  const concern = a.concern ? `\n  Concern: ${a.concern}` : ''
  return `${MARK[a.verdict!]} ${q.id} ${a.verdict}${a.partial ? ' (mostly right)' : ''}: ${a.feedback}${hint}${concern}`
}
/** Where the check stands after a grade, and what is next: the next question, or the commit. */
function progressLine(check: Check, cfg: Config, repo: string, env: NodeJS.ProcessEnv): string {
  const s = summarize(check, cfg)
  const next = nextQuestion(check)
  if (next) return `${s.done} of ${s.total} done · next: ${next.id}`
  if (s.met) return `✓ Done: ${s.passed} of ${s.total} passed (${s.needed} needed). Commit and push: node ${cliName(repo)} commit`
  return `${s.passed} passed, ${s.needed} must pass: say an explained answer back in one sentence (grade --question <id> --answer "…" --reply …).`
}
