#!/usr/bin/env node
// Writes the questions of an understanding check, one validated question at a time (SKILL.md says how to use it).
//   questions.mjs start [--base <ref>] [--branch <name> --head <sha>] [--top-up] [--replace]   the change, with new-file
//                     line numbers; starts a draft. --branch/--head: the branch and commit the check is for, whatever is
//                     checked out by the time each command runs (the person may switch meanwhile)
//   questions.mjs add --kind <kind> --file <path> (--lines A-B | --whole-file) --text "<question>" [--also <path>:A-B,…] [--suspect]
//                     [--links "<phrase>@<path>:A-B;…"]   phrases of the text that become links to those lines
//   questions.mjs list | remove <qN> | finish
//   questions.mjs tour [--top-up]                    then journey.py (its path and --dir are printed) writes the tour
//   questions.mjs tour-finish --steps q1=3,q2=5,…    checks the tour and puts it, and each question's step, in the file
//   questions.mjs tour-finish --none                 documentation that describes no code: no tour
//   questions.mjs cli <command> …                    the CLI found below (next, grade, flag, commit, status, …):
//                                                     answering in a chat without VS Code
// The draft lives in the git folder (never committed); `finish` writes understanding/<branch>.json; the tour is
// written with the code-journey skill's journey.py into a staging folder there, then embedded as `journey`.
// It uses understanding.mjs (the CLI): UNDERSTANDING_CLI, else the copy that ships beside this skill, else the one the
// repository has (e.g. tools/understanding.mjs, the copy its CI runs).
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const inRepo = () => { try { const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); const f = execFileSync('git', ['ls-files', '--', ':(glob)**/understanding.mjs'], { cwd: top, encoding: 'utf8' }).split('\n').find(Boolean); return f && path.join(top, f) } catch { return undefined } }
const cliPath = [process.env.UNDERSTANDING_CLI, path.join(here, 'understanding.mjs'), path.join(here, '../../../cli/understanding.mjs')].find((p) => p && fs.existsSync(p)) ?? inRepo()
if (!cliPath) { console.log('PROBLEM: understanding.mjs not found (set UNDERSTANDING_CLI to its path)'); process.exit(2) }
const U = await import(pathToFileURL(cliPath).href)

// The CLI itself, for answering in a chat (SKILL.md, "Without VS Code"): one path to know.
if (process.argv[2] === 'cli') {
  const code = await U.main(process.argv.slice(3))
  // A long output (the grader's instructions) is written out before the exit.
  await new Promise((resolve) => process.stdout.write('', resolve))
  process.exit(code)
}

const cwd = process.cwd()
const repo = U.repoRoot(cwd) ?? cwd
const draftPath = process.env.UNDERSTANDING_DRAFT || path.join(path.resolve(repo, execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repo, encoding: 'utf8' }).trim()), 'understanding-draft.json')
const cfg = U.loadConfig(repo)
const o = U.parseArgs(process.argv.slice(2))
const cmd = o._[0]
const say = (s) => console.log(s)
const fail = (s) => { say(`PROBLEM: ${s}`); process.exit(1) }
const loadDraft = () => { try { return JSON.parse(fs.readFileSync(draftPath, 'utf8')) } catch { fail('no draft: run `questions.mjs start` first') } }
const saveDraft = (d) => fs.writeFileSync(draftPath, JSON.stringify(d, null, 2) + '\n')
const MAX_DIFF_LINES = 1500
const gitDir = () => path.resolve(repo, execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repo, encoding: 'utf8' }).trim())
/** Where journey.py writes the tour (slug TOUR) before tour-finish embeds it. */
const stageDir = () => process.env.UNDERSTANDING_TOUR_DIR || path.join(gitDir(), 'understanding-tour')
const TOUR = 'tour'
/** The code-journey skill's journey.py: JOURNEY_PY, the repository's copy, else the one shipped beside this skill. */
const journeyPy = () => [process.env.JOURNEY_PY, path.join(repo, '.claude/skills/code-journey/scripts/journey.py'), path.join(here, '../../code-journey/scripts/journey.py')].find((p) => p && fs.existsSync(p))
/** Steps a top-up adds to a tour (a new tour: U.tourSize, by the change's kind and size). */
const TOPUP_STEPS = [1, 4]
const sizeOf = (check) => (check.diffStat ? U.linesOf(check.diffStat) : Infinity)
const fmtRange = (rs) => rs.map(([a, b]) => (a === b ? a : `${a}-${b}`)).join(', ')
const qLine = (q) => `${q.id} (${q.kind}) ${q.file}${q.target ? '' : `:${q.start}-${q.end}`}${q.also?.length ? ` (also ${q.also.map((x) => `${x.file}:${x.start}-${x.end}`).join(', ')})` : ''}${q.step ? ` · step ${q.step}` : ''}: ${q.text}`

/**
 * Where `branch`'s check file is: in the working tree while it is checked out, else in the git-ignored cache the
 * extension puts back in place when the branch returns (so a branch switch never writes into another branch).
 */
function checkPath(branch) {
  if (U.currentBranch(repo) === branch) return path.join(repo, U.fileFor(branch))
  const cache = path.join(repo, U.cachedFor(branch))
  fs.mkdirSync(path.dirname(cache), { recursive: true })
  const ignore = path.join(repo, '.code-notes/.cache/.gitignore')
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n')
  return cache
}
/** A file's lines at the draft's commit (the working tree may be another branch by now). */
function linesAt(head, file) {
  try { return U.git(repo, ['show', `${head}:${file}`]).split('\n') } catch { return undefined }
}

/** How many questions a change gets (U.questionsForChange: one for docs or a removal); a top-up 1, or 2 when it grew a lot. */
function wanted(st, lines, topUp) {
  return topUp ? (lines < 80 ? 1 : 2) : U.questionsForChange(st, cfg)
}

if (cmd === 'start') {
  const branch = typeof o.branch === 'string' ? o.branch : U.currentBranch(repo)
  const head = U.git(repo, ['rev-parse', typeof o.head === 'string' ? `${o.head}^{commit}` : 'HEAD']).trim()
  const rel = U.fileFor(branch)
  const at = checkPath(branch)
  // Its check: here, in the cache, else as committed on that branch.
  const committed = () => { try { return JSON.parse(U.git(repo, ['show', `${head}:${rel}`])) } catch { return undefined } }
  const existing = fs.existsSync(at) ? U.readCheck(at) : U.currentBranch(repo) === branch ? undefined : committed()
  const topUp = !!o['top-up']
  if (topUp && !existing) fail(`--top-up: ${rel} doesn't exist yet; run start without it`)
  if (!topUp && existing && !o.replace) fail(`${rel} exists already. Use --top-up to add questions about what changed since, or --replace to start over (its answers are lost)`)
  const baseRef = typeof o.base === 'string' ? o.base : U.defaultBase(repo)
  const mb = baseRef && U.mergeBase(repo, baseRef, head)
  if (!mb) fail('no base to compare with: pass --base <branch or commit>')
  // Stacked on a branch whose check is committed here: only what came after that check's code.
  const stack = U.stackBase(repo, mb, head, rel)
  const base = stack?.base ?? mb
  if (stack) say(`STACKED: on ${stack.branch}, whose check covers its own code; this change starts after it.`)
  // Committed code only: the questions record the commit they were written for (uncommitted lines would count as drift).
  // Code lines only: blank and comment-only lines don't count, nor the config's exempt files.
  // Always the branch's OWN change (from today's merge base): code that came in from the target branch is never asked.
  let files = U.numstat(repo, base, head)
  // Uncommitted lines: only those of this branch's working tree (another branch may be checked out by now).
  const loose = U.currentBranch(repo) === branch ? U.linesOf(U.codeStat(repo, head, undefined, cfg.exempt)) : 0
  const st = U.codeStat(repo, base, head, cfg.exempt)
  let lines = U.linesOf(st), ranges
  if (topUp) {
    // Only what the branch's own change gained since the questions (freshLines); else, when the questions' commits are
    // gone, what changed since the questions' commit, or the whole change.
    const fresh = U.freshLines(repo, existing, base, head, cfg.exempt)
      ?? (U.hasCommit(repo, existing.head) ? U.codeLines(repo, existing.head, head, cfg.exempt) : U.codeLines(repo, base, head, cfg.exempt))
    lines = fresh.length
    ranges = U.rangesOf(fresh)
    files = files.filter((f) => ranges.has(f.file))
  }
  if (!topUp && !lines && loose && U.currentBranch(repo) === branch) { say(`UNCOMMITTED: this change is not committed yet (${loose} code lines). Ask the person to commit it first. Write nothing.`); process.exit(0) }
  const renamedOnly = !topUp && !lines && st.renamed?.length > 0
  if ((!lines && !renamedOnly) || (topUp && !ranges.size)) { say(`NOTHING: no code lines changed${topUp ? ' since the questions were written' : ''} (only comments, blank lines or exempt files). Write nothing.`); process.exit(0) }
  const diff = U.diffText(repo, base, head, files, cfg.exempt)
  ranges ??= U.changedRanges(diff, { codeOnly: true })
  // Removed code is part of the change: a question may sit where code was removed, and when the change only removes
  // code, also where the removed code was used (any file).
  for (const [f, rs] of U.removalPoints(diff)) ranges.set(f, [...(ranges.get(f) ?? []), ...rs])
  // A moved file: a question about the move itself (--whole-file), never about the content it kept.
  if (renamedOnly) for (const r of st.renamed) if (!ranges.has(r.to)) ranges.set(r.to, [])
  const removedOnly = !topUp && U.changeKind(st) === 'removal'
  // Only documentation changed: one question about what a reader now sees or understands differently.
  const docsOnly = !topUp && U.changeKind(st) === 'docs'
  const want = wanted(st, lines, topUp)
  const stat = (x) => ({ files: x.files, added: x.added, removed: x.removed })
  const fmt = (rs) => rs.map(([a, b]) => (a === b ? a : `${a}-${b}`)).join(', ')
  saveDraft({ branch, base, head, mode: topUp ? 'top-up' : 'new', want, diffStat: stat(st), ranges: Object.fromEntries(ranges), ...(removedOnly ? { removedOnly } : {}), ...(docsOnly ? { docsOnly } : {}), questions: [] })
  say(topUp ? `TOP-UP: branch ${branch} · ${lines} new code lines since the questions were written` : `CHANGE: branch ${branch} · ${st.files} files · ${lines} code lines (+${st.added} −${st.removed})`)
  if (loose) say(`NOTE: ${loose} uncommitted code lines are not included.`)
  if (docsOnly) say('DOCS ONLY: only documentation changed. Write ONE question about what a reader now sees, can do or understands differently (never why a word was chosen, never about unchanged text). "It is just wording" is a full answer.')
  if (renamedOnly) say(`RENAMED ONLY: ${st.renamed.map((r) => `${r.from} → ${r.to}`).join(', ')}, 0 lines changed. Ask only what the move changes (how a tool, an import or a convention treats the new name or place), with --whole-file; never about the content it kept.`)
  if (removedOnly) {
    // The evidence: where the removed names still appear (a search of the repository at the change's commit).
    const found = U.searchNames(repo, head, U.removedNames(U.codeLines(repo, base, head, cfg.exempt)))
    say(`REMOVED ONLY: this change only removes code. Write ONE evidence question (--evidence --kind change): what a search found about the removed code, for the author to confirm or correct in one sentence. Put it on the lines where code was removed (${[...ranges].map(([f, rs]) => `${f}:${fmt(rs)}`).join(' · ') || 'none left: the files are gone'}), or on code that used what was removed (any file).`)
    if (found.length) say(`EVIDENCE (search at ${head.slice(0, 7)}): ${found.map(U.evidenceText).join(' · ')}`)
    const none = found.find((e) => !e.hits.length), some = found.find((e) => e.hits.length)
    say(`  e.g. ${none ? `"Nothing calls ${none.name} any more (search: 0 hits) — right?"` : some ? `"${some.name} is still named in ${some.hits[0].file} (search: ${some.hits.length} hit${some.hits.length === 1 ? '' : 's'}) — what happens there now?"` : '"Nothing used what this removes (search: 0 hits) — right?"'} Check the hits yourself (Grep) before you write it; keep the numbers true.`)
  }
  if (topUp) say(`NEW LINES (ask only about these): ${[...ranges].map(([f, rs]) => `${f}:${fmt(rs)}`).join(' · ')}`)
  say(`WRITE: ${want} question${want === 1 ? '' : 's'}${topUp ? ' about these new lines only' : ''}, about code lines (never comments or blank lines), then \`finish\`. Files: ${files.filter((f) => U.counted(f.file, cfg.exempt)).map((f) => `${f.file} (+${f.added} −${f.removed})`).join(', ')}`)
  const numbered = U.numberDiff(diff).split('\n')
  say('')
  say(numbered.slice(0, MAX_DIFF_LINES).join('\n'))
  if (numbered.length > MAX_DIFF_LINES) say(`\n… the diff goes on (${numbered.length - MAX_DIFF_LINES} more lines): read the remaining files with Read; line numbers are the files' own.`)
  process.exit(0)
}

if (cmd === 'add') {
  const d = loadDraft()
  const kind = String(o.kind ?? '')
  const file = String(o.file ?? '').replace(/^\.\//, '')
  const text = String(o.text ?? '').replace(/\s+/g, ' ').trim()
  if (!U.KINDS.includes(kind)) fail(`--kind must be one of ${U.KINDS.join(', ')}`)
  if (!file) fail('--file is missing')
  // The file as committed in the change (whatever is checked out now).
  const lines = linesAt(d.head, file)
  if (!lines) fail(`${file} doesn't exist`)
  // A removal-only change: also the code that used what was removed (anywhere).
  const ranges = d.ranges[file] ?? (d.removedOnly ? [] : undefined)
  if (!ranges) fail(`${file} is not part of this ${d.mode === 'top-up' ? 'new change' : 'change'}: ask about the changed files (${Object.keys(d.ranges).join(', ')})`)
  if (text.length < 25) fail('--text is too short: ask a real question about this change')
  if (text.length > U.MAX_TEXT) fail(`--text is ${text.length} characters: at most ${U.MAX_TEXT}. One question, plainly`)
  if (!text.endsWith('?')) fail('--text must be one question, ending with "?"')
  if ((text.match(/\?/g) ?? []).length > 1) fail('--text asks more than one question: ask one')
  if (/(,?\s+(and|or)( also| then)?|;|\s+as well as)\s+(how|what|why|when|where|which|who|whose|does|do|did|is|are|was|were|can|could|would|should|will|has|have|if)\b/i.test(text)) fail('--text asks two things ("…, and could …"): keep the one that matters')
  // "what happens to X, Y and Z": three things to cover is three questions.
  if (/,\s+(?!(?:what|how|why|when|where|which|who|does|do|is|are|can|could|would|should|will|if|so|but|or)\b)[^,?]{1,60},?\s+(and|or)\s+[^?]+\?$/i.test(text)) fail('--text asks about a list of things ("X, Y and Z"): ask about the one that matters')
  // "What does f(x) return for 200 at qty 61?": one computed value per check at most.
  const computed = (t) => /^(what|which)\b[^?]*\b(return|returns|price|cost|total|result|value)\b[^?]*\d/i.test(t) || /^(what|which)\b[^?]*\d[^?]*\breturns?\b/i.test(t)
  if (computed(text) && d.questions.some((x) => computed(x.text))) fail('a second "what does it return for <numbers>" question: one is enough; ask why, or what can go wrong, instead')
  if (/\bline\s+\d+/i.test(text)) fail('--text names a line number: name the function, value or case instead (the question is shown on its lines)')
  if (/^(what does|what is)\b/i.test(text) && kind === 'how' && text.length < 60) say('WARNING: "what does X do" questions are trivia; ask how it behaves in a case, or why')
  const q = { id: '', kind, text, file }
  if (o['whole-file']) q.target = 'file'
  else {
    const m = /^(\d+)(?:-(\d+))?$/.exec(String(o.lines ?? ''))
    if (!m) fail('--lines A-B (or --whole-file for a question about the design of the whole file)')
    q.start = Number(m[1]); q.end = Number(m[2] ?? m[1])
    if (q.end < q.start) fail('--lines: the end is before the start')
    if (q.end > lines.length) fail(`--lines: ${file} has ${lines.length} lines`)
    if (q.end - q.start > 40) fail('--lines: more than 40 lines; point at the lines that matter (the question shows on them)')
    const cs = {}
    if (!lines.slice(q.start - 1, q.end).map((l) => U.isCode(l, file, cs)).some(Boolean)) fail(`--lines ${q.start}-${q.end} hold only comments or blank lines: ask about code`)
    const near = (d.removedOnly && !d.ranges[file]) || ranges.some(([a, b]) => q.start <= b + 5 && q.end >= a - 5)
    if (!near) fail(`--lines ${q.start}-${q.end} are not near a changed code line of ${file} (changed: ${ranges.map(([a, b]) => (a === b ? a : `${a}-${b}`)).join(', ')})`)
    q.anchor = U.compactOf(lines, q.start, q.end)
  }
  // The honest answer is "this is a bug": once answered, the author is offered a fix, a TODO or a flag.
  if (o.suspect) q.suspect = true
  // A removal: the author confirms or corrects what a search found (the grader passes a true one-sentence answer).
  if (o.evidence) { if (!d.removedOnly) fail('--evidence is for a change that only removes code'); q.evidence = true }
  // Unchanged code the answer depends on (a caller, a retry loop, a constraint): shown beside the question.
  if (typeof o.also === 'string' && o.also.trim()) {
    q.also = []
    for (const part of o.also.split(',').map((x) => x.trim()).filter(Boolean)) {
      const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(part)
      if (!m) fail(`--also ${part}: write it as path:A-B`)
      const f = m[1].replace(/^\.\//, ''), a = Number(m[2]), b = Number(m[3] ?? m[2])
      const fl = path.isAbsolute(f) || f.split(/[\\/]/).includes('..') ? undefined : linesAt(d.head, f)
      if (!fl) fail(`--also: ${f} doesn't exist`)
      if (b < a || b > fl.length) fail(`--also ${part}: ${f} has ${fl.length} lines`)
      if (b - a > 40) fail(`--also ${part}: more than 40 lines; point at the lines that matter`)
      if (f === q.file && q.start && a <= q.end && q.start <= b) fail(`--also ${part}: overlaps the question's own lines`)
      q.also.push({ file: f, start: a, end: b, anchor: U.compactOf(fl, a, b) })
    }
    if (q.also.length > 3) fail('--also: at most 3 places')
  }
  // Code links: words of the question shown as a clickable phrase that lights those lines (never line numbers).
  if (typeof o.links === 'string' && o.links.trim()) {
    const raw = []
    for (const part of o.links.split(';').map((x) => x.trim()).filter(Boolean)) {
      const m = /^(.+)@([^@]+):(\d+)(?:-(\d+))?$/.exec(part)
      if (!m) fail(`--links ${part}: write it as "phrase@path:A-B"`)
      const phrase = m[1].trim()
      if (!text.includes(phrase)) fail(`--links: "${phrase}" is not in the question's text (exactly as written)`)
      raw.push({ phrase, file: m[2].replace(/^\.\//, ''), start: Number(m[3]), end: Number(m[4] ?? m[3]) })
    }
    if (raw.length > 3) fail('--links: at most 3')
    const ok = U.codeLinksIn(repo, raw, (f) => { const l = linesAt(d.head, f); if (!l) throw new Error(f); return l })
    const bad = raw.filter((l) => !ok.some((x) => x.phrase === l.phrase))
    if (bad.length) fail(`--links: ${bad.map((l) => `${l.file}:${l.start}-${l.end}`).join(', ')} is not a range of a file in the repository`)
    q.links = ok
  }
  if (d.questions.some((x) => x.file === q.file && x.start && q.start && x.start <= q.end && q.start <= x.end)) say('WARNING: another question is on overlapping lines: make sure it asks something different')
  d.questions.push(q)
  saveDraft(d)
  say(`added #${d.questions.length} (${kind}) ${file}${q.target ? '' : `:${q.start}-${q.end}`}${q.also ? ` (also ${q.also.map((x) => `${x.file}:${x.start}-${x.end}`).join(', ')})` : ''}${q.links ? ` · ${q.links.length} link${q.links.length === 1 ? '' : 's'}` : ''} · ${d.questions.length} of ${d.want}`)
  if (!q.target) say(`  ${lines[q.start - 1].trim().slice(0, 100)}${q.end > q.start ? `\n  … ${lines[q.end - 1].trim().slice(0, 100)}` : ''}`)
  process.exit(0)
}

if (cmd === 'list') {
  const d = loadDraft()
  d.questions.forEach((q, i) => say(`#${i + 1} ${q.kind} ${q.file}${q.target ? '' : `:${q.start}-${q.end}`}: ${q.text}`))
  say(`${d.questions.length} of ${d.want}`)
  process.exit(0)
}

if (cmd === 'remove') {
  const d = loadDraft()
  const i = Number(String(o._[1] ?? '').replace(/^#/, '')) - 1
  if (!(i >= 0 && i < d.questions.length)) fail('remove <number> (as `list` shows it)')
  d.questions.splice(i, 1)
  saveDraft(d)
  say(`removed; ${d.questions.length} of ${d.want}`)
  process.exit(0)
}

if (cmd === 'finish') {
  const d = loadDraft()
  const n = d.questions.length
  // The count follows the change's size: exactly `want` for a small change (1 or 2), 3 up to the config's max above.
  const [lo, hi] = d.mode === 'top-up' ? [1, 2] : d.want < 3 ? [d.want, d.want] : [Math.min(3, d.want), Math.max(d.want, cfg.questions.max)]
  if (n < lo || n > hi) fail(`${n} question${n === 1 ? '' : 's'}: write ${lo === hi ? lo : `${lo}-${hi}`} for this change${lo === hi ? '' : ` (${d.want} suggested)`}`)
  const kinds = new Set(d.questions.map((q) => q.kind))
  if (d.mode !== 'top-up' && n >= 3 && kinds.size < 2) fail('all questions are of one kind: mix them (how, why, failure, edge, change)')
  if (d.mode !== 'top-up' && n >= 3 && ![...kinds].some((k) => ['why', 'failure', 'edge'].includes(k))) fail('ask at least one why, failure or edge question')
  if (d.removedOnly && !d.questions.some((q) => q.evidence)) fail('this change only removes code: its question is an evidence question (add it with --evidence; see EVIDENCE)')
  const rel = U.fileFor(d.branch)
  // Its branch was switched away from meanwhile: into the cache, never into the branch checked out now.
  const abs = checkPath(d.branch)
  const model = process.env.UNDERSTANDING_MODEL_LABEL || process.env.UNDERSTANDING_MODEL || undefined
  let check
  if (d.mode === 'top-up') {
    check = fs.existsSync(abs) ? U.readCheck(abs) : JSON.parse(U.git(repo, ['show', `${d.head}:${rel}`]))
    let k = Math.max(0, ...check.questions.map((q) => Number(q.id.slice(1)) || 0))
    const round = Math.max(1, ...check.questions.map((q) => q.round ?? 1)) + 1
    for (const q of d.questions) check.questions.push({ ...q, id: `q${++k}`, round })
    check.base = d.base
    check.head = d.head
    check.diffStat = d.diffStat
    check.updatedAt = new Date().toISOString()
  } else {
    const who = U.gitIdentity(repo)
    check = { version: 1, branch: d.branch, base: d.base, head: d.head, diffStat: d.diffStat, ...(who ? { answeredBy: who } : {}), ...(model ? { model } : {}), createdAt: new Date().toISOString(),
      questions: d.questions.map((q, i) => ({ ...q, id: `q${i + 1}`, ...(d.docsOnly ? { docs: true } : {}) })) }
  }
  // Its files are checked in the working tree only while its branch is checked out (they were read at its commit).
  const errs = U.validateCheck(check, U.currentBranch(repo) === d.branch ? { repo } : {})
  if (errs.length) fail(`the file would not be valid: ${errs.join('; ')}`)
  U.writeCheck(abs, U.stamp(check, cfg))
  fs.rmSync(draftPath, { force: true })
  say(`WROTE ${path.relative(repo, abs) === rel ? rel : `${rel} (kept for ${d.branch}: it is not checked out)`}: ${check.questions.length} questions${d.mode === 'top-up' ? ` (${n} new)` : ''}. Done: reply with one line per new question.`)
  process.exit(0)
}

if (cmd === 'tour') {
  const branch = typeof o.branch === 'string' ? o.branch : U.currentBranch(repo)
  const rel = U.fileFor(branch)
  const abs = checkPath(branch)
  if (!fs.existsSync(abs)) fail(`${rel} doesn't exist: write the questions first (start, add, finish)`)
  const check = U.readCheck(abs)
  const J = journeyPy()
  if (!J) fail('journey.py (the code-journey skill) was not found: set JOURNEY_PY to its path')
  const stage = stageDir()
  fs.rmSync(stage, { recursive: true, force: true })
  fs.mkdirSync(stage, { recursive: true })
  const topUp = !!o['top-up'] && !!check.journey
  // The branch it is for: tour-finish writes there even after a branch switch.
  fs.writeFileSync(path.join(stage, 'meta.json'), JSON.stringify({ branch }) + '\n')
  if (topUp) fs.writeFileSync(path.join(stage, `${TOUR}.json`), JSON.stringify({ ...check.journey, id: TOUR }, null, 2) + '\n')
  // What the tour must show: the change's lines (a top-up: only what is new since the tour), by file.
  const base = check.base && U.hasCommit(repo, check.base) ? check.base : U.mergeBase(repo, U.defaultBase(repo) ?? 'HEAD', check.head)
  let ranges
  if (topUp) {
    const known = new Set(check.journey.steps.map((s) => s.file))
    const fresh = check.journey.commit && U.hasCommit(repo, check.journey.commit) ? U.codeLines(repo, check.journey.commit, check.head, cfg.exempt) : []
    ranges = U.rangesOf(fresh)
    if (!ranges.size) for (const q of check.questions.filter((x) => !x.step)) if (!known.has(q.file)) ranges.set(q.file, [[q.start ?? 1, q.end ?? 1]])
  } else ranges = base ? U.changedRanges(U.diffText(repo, base, check.head, U.numstat(repo, base, check.head), cfg.exempt), { codeOnly: true }) : new Map()
  const want = topUp ? check.questions.filter((q) => !q.step) : check.questions
  const kind = U.checkKind(check)
  const [lo, hi] = topUp ? TOPUP_STEPS : U.tourSize(kind, sizeOf(check))
  const n0 = topUp ? check.journey.steps.length : 0
  const st = check.diffStat
  // A removal: where the removed code was used; never steps on code that is gone.
  if (!topUp && kind === 'removal' && base) for (const [f, rs] of U.removalPoints(U.diffText(repo, base, check.head, U.numstat(repo, base, check.head), cfg.exempt))) ranges.set(f, [...(ranges.get(f) ?? []), ...rs])
  say(topUp ? `TOUR TOP-UP: the tour of ${branch} has ${n0} steps; add ${lo}-${hi} after step ${n0}, through the new part only` : `TOUR: a journey of this change (${branch}, ${st ? `+${st.added} −${st.removed} ${kind === 'docs' ? 'lines' : 'code lines'}` : 'its size unknown'}): ${lo}-${hi} steps${kind === 'code' ? ' through the changed code and the unchanged code it depends on, in the order a request or the data flows' : ''}. Its title names the change ("Dropping refundReport", "Bumping the version"), not the area`)
  if (!topUp && kind === 'docs') say(`DOCS: the change edits documentation. Steps on the EXISTING code the edited text describes (what a reader can now find or do there), never on the text itself. When the text describes no code, write no tour: run questions.mjs tour-finish --none`)
  else if (!topUp && kind === 'removal') say('REMOVAL: this change only removes code. Steps on code that is still there: where the removed code used to be called (or show that nothing calls it: the search), and why removing it is safe (what takes its place, what never reached it); nothing else')
  // A change that mostly removes code: the tour shows what went and why that is safe, not the code around it.
  else if (!topUp && st && st.removed > 2 * st.added) say('REMOVAL: this change mostly removes code. Steps: what was removed (on the lines where it was), what used it before (or that nothing does now: say how you checked), and the one or two lines that changed besides; nothing else')
  else if (!topUp && sizeOf(check) < 10) say('SMALL: a few lines changed. Steps around the changed lines: what calls them and what they change; nothing else')
  // journey.py check wants 6-14 steps for a journey of the repository; a tour has its own count.
  const steps = `--steps ${n0 + lo}-${n0 + hi}`
  say(`JOURNEY: ${J} <command> <repo> ${TOUR} … --dir ${stage}   (repo: ${repo}; always --dir; slug ${TOUR})`)
  if (topUp) { say('STEPS SO FAR (keep them as they are):'); check.journey.steps.forEach((s, i) => say(`  ${i + 1}. ${s.title} (${s.file}:${s.range.start}-${s.range.end})`)) }
  say(`QUESTIONS ${topUp ? 'that need a step' : '(each needs the step after which its answer is visible)'}:`)
  for (const q of want) say(`  ${qLine(q)}`)
  if (ranges.size) say(`CHANGED: ${[...ranges].map(([f, rs]) => `${f}:${fmtRange(rs)}`).join(' · ')}`)
  say(`THEN: ${J} check <repo> ${TOUR} quiet --dir ${stage} ${steps}; fix every PROBLEM; then questions.mjs tour-finish --steps ${want.map((q) => `${q.id}=<n>`).join(',')}`)
  process.exit(0)
}

if (cmd === 'tour-finish') {
  let meta = {}
  try { meta = JSON.parse(fs.readFileSync(path.join(stageDir(), 'meta.json'), 'utf8')) } catch { /* none: this branch */ }
  const branch = meta.branch || U.currentBranch(repo)
  const rel = U.fileFor(branch)
  // Its branch was switched away from meanwhile: the extension keeps its check in .code-notes/.cache/checks.
  const abs = [path.join(repo, rel), path.join(repo, '.code-notes/.cache/checks', `${U.slugOf(branch)}.json`)].find((f) => fs.existsSync(f))
  if (!abs) fail(`${rel} doesn't exist`)
  // Documentation that describes no code: no tour, on purpose (the check says so; nothing offers to write one).
  if (o.none) {
    const check = U.readCheck(abs)
    if (U.checkKind(check) !== 'docs' || check.journey) fail('--none is only for a change to documentation that describes no code')
    check.noTour = true
    U.writeCheck(abs, check)
    fs.rmSync(stageDir(), { recursive: true, force: true })
    say(`WROTE ${rel}: no tour (the edited text describes no code). Done: reply "No tour: the text describes no code."`)
    process.exit(0)
  }
  const staged = path.join(stageDir(), `${TOUR}.json`)
  let j
  try { j = JSON.parse(fs.readFileSync(staged, 'utf8')) } catch { fail(`no tour in ${stageDir()}: run \`questions.mjs tour\`, then journey.py new … ${TOUR} --dir …`) }
  const J = journeyPy()
  if (J) {
    let out = '', code = 0
    // The count is checked below, by the change's size: journey.py only checks the rest.
    try { out = execFileSync('python3', [J, 'check', repo, TOUR, 'quiet', '--dir', stageDir(), '--steps', `1-${U.MAX_TOUR_STEPS}`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) { code = e.status ?? 1; out = `${e.stdout ?? ''}${e.stderr ?? ''}` }
    if (code) { say(out.trim()); fail('journey.py check found problems: fix them, then tour-finish again') }
  }
  // The file as it is now: answers given while the tour was written are kept.
  const check = U.readCheck(abs)
  const before = check.journey
  const n0 = before ? before.steps.length : 0
  const steps = Array.isArray(j.steps) ? j.steps : []
  const added = steps.length - n0
  if (before) {
    // A top-up only appends: the steps the questions already point at stay where they are.
    const same = before.steps.every((s, i) => steps[i] && steps[i].id === s.id && steps[i].title === s.title && steps[i].file === s.file)
    if (!same) fail(`the first ${n0} steps changed: a top-up only adds steps after step ${n0} (journey.py restore, or rmstep the new ones and add them again)`)
    if (added < TOPUP_STEPS[0] || added > TOPUP_STEPS[1]) fail(`${added} new steps: add ${TOPUP_STEPS[0]}-${TOPUP_STEPS[1]} after step ${n0}`)
  } else { const [lo, hi] = U.tourSize(U.checkKind(check), sizeOf(check)); if (steps.length < lo || steps.length > hi) fail(`${steps.length} steps: a tour of this change has ${lo}-${hi} (its size)`) }
  // No animations in a check's tour (time and cost): dropped if any.
  for (const s of steps) delete s.scene
  const given = new Map()
  for (const part of String(o.steps ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^(q\d+)\s*=\s*(\d+)$/.exec(part)
    if (!m) fail(`--steps ${part}: write it as q1=3`)
    if (!check.questions.some((q) => q.id === m[1])) fail(`--steps: there is no question ${m[1]}`)
    given.set(m[1], Number(m[2]))
  }
  const problems = []
  for (const q of check.questions) {
    const n = given.get(q.id) ?? q.step
    if (!n) { problems.push(`${q.id} has no step: --steps ${q.id}=<n>`); continue }
    if (n < 1 || n > steps.length) { problems.push(`${q.id}=${n}: the tour has ${steps.length} steps`); continue }
    if (before && given.has(q.id) && q.step && q.step !== n) { problems.push(`${q.id} is at step ${q.step} already: keep it`); continue }
    // Its answer must be visible by then: a step up to n shows the question's file (or the code it also depends on).
    // Documentation and a removal: the tour shows the code the text describes, or where the removed code was used.
    const files = new Set([q.file, ...(q.also ?? []).map((x) => x.file)])
    if (!q.docs && !q.evidence && !steps.slice(0, n).some((s) => files.has(s.file))) problems.push(`${q.id}=${n}: no step up to ${n} is in ${[...files].join(' or ')}; give a later step, or add a step there`)
    q.step = n
  }
  if (problems.length) fail(problems.join('; '))
  const model = process.env.UNDERSTANDING_MODEL_LABEL || process.env.UNDERSTANDING_MODEL || undefined
  delete check.noTour
  check.journey = { ...j, id: TOUR, commit: check.head, ...(before?.createdAt ? { createdAt: before.createdAt, updatedAt: new Date().toISOString() } : { createdAt: new Date().toISOString() }), ...(model ? { model } : {}) }
  // Its files are checked in the working tree only while its branch is checked out (they were read at its commit).
  const errs = U.validateCheck(check, U.currentBranch(repo) === branch ? { repo } : {})
  if (errs.length) fail(`the file would not be valid: ${errs.join('; ')}`)
  U.writeCheck(abs, U.stamp(check, cfg))
  fs.rmSync(stageDir(), { recursive: true, force: true })
  say(`WROTE the tour into ${rel}: ${steps.length} steps${before ? ` (${added} new)` : ''}; ${check.questions.map((q) => `${q.id} after step ${q.step}`).join(', ')}. Done: reply with the step titles, one per line.`)
  process.exit(0)
}

say(`questions.mjs start [--base <ref>] [--top-up] [--replace] | add --kind <${U.KINDS.join('|')}> --file <path> (--lines A-B | --whole-file) --text "<question>" [--also <path>:A-B,…] [--suspect] [--evidence] | list | remove <n> | finish | tour [--top-up] | tour-finish (--steps q1=<n>,… | --none) | cli <command> …`)
process.exit(cmd ? 2 : 0)
