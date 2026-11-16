#!/usr/bin/env node
// Writes the questions of an understanding check, one validated question at a time (SKILL.md says how to use it).
//   questions.mjs start [--base <ref>] [--top-up] [--replace]   the change, with new-file line numbers; starts a draft
//   questions.mjs add --kind <kind> --file <path> (--lines A-B | --whole-file) --text "<question>" [--also <path>:A-B,…] [--suspect]
//                     [--links "<phrase>@<path>:A-B;…"]   phrases of the text that become links to those lines
//   questions.mjs list | remove <qN> | finish
//   questions.mjs tour [--top-up]                    then journey.py (its path and --dir are printed) writes the tour
//   questions.mjs tour-finish --steps q1=3,q2=5,…    checks the tour and puts it, and each question's step, in the file
// The draft lives in the git folder (never committed); `finish` writes understanding/<branch>.json; the tour is
// written with the code-journey skill's journey.py into a staging folder there, then embedded as `journey`.
// It uses understanding.mjs (the CLI): UNDERSTANDING_CLI, else the copy that ships beside this skill.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const cliPath = [process.env.UNDERSTANDING_CLI, path.join(here, 'understanding.mjs'), path.join(here, '../../../cli/understanding.mjs')].find((p) => p && fs.existsSync(p))
if (!cliPath) { console.log('PROBLEM: understanding.mjs not found (set UNDERSTANDING_CLI to its path)'); process.exit(2) }
const U = await import(pathToFileURL(cliPath).href)

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
/** Steps a new tour has, and a top-up adds. */
const TOUR_STEPS = [6, 10], TOPUP_STEPS = [1, 4]
const fmtRange = (rs) => rs.map(([a, b]) => (a === b ? a : `${a}-${b}`)).join(', ')
const qLine = (q) => `${q.id} (${q.kind}) ${q.file}${q.target ? '' : `:${q.start}-${q.end}`}${q.also?.length ? ` (also ${q.also.map((x) => `${x.file}:${x.start}-${x.end}`).join(', ')})` : ''}${q.step ? ` · step ${q.step}` : ''}: ${q.text}`

/** How many questions a change gets: by its size in code lines (U.questionsFor); a top-up gets 1, or 2 when it grew a lot. */
function wanted(lines, topUp) {
  return topUp ? (lines < 80 ? 1 : 2) : U.questionsFor(lines, cfg)
}

if (cmd === 'start') {
  const head = U.git(repo, ['rev-parse', 'HEAD']).trim()
  const branch = U.currentBranch(repo)
  const rel = U.fileFor(branch)
  const existing = fs.existsSync(path.join(repo, rel)) ? U.readCheck(path.join(repo, rel)) : undefined
  const topUp = !!o['top-up']
  if (topUp && !existing) fail(`--top-up: ${rel} doesn't exist yet; run start without it`)
  if (!topUp && existing && !o.replace) fail(`${rel} exists already. Use --top-up to add questions about what changed since, or --replace to start over (its answers are lost)`)
  const baseRef = typeof o.base === 'string' ? o.base : U.defaultBase(repo)
  const base = baseRef && U.mergeBase(repo, baseRef, head)
  if (!base) fail('no base to compare with: pass --base <branch or commit>')
  // Committed code only: the questions record the commit they were written for (uncommitted lines would count as drift).
  // Code lines only: blank and comment-only lines don't count, nor the config's exempt files.
  // Always the branch's OWN change (from today's merge base): code that came in from the target branch is never asked.
  let files = U.numstat(repo, base, head)
  const loose = U.linesOf(U.codeStat(repo, head, undefined, cfg.exempt))
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
  if (!topUp && !lines && loose) { say(`UNCOMMITTED: this change is not committed yet (${loose} code lines). Ask the person to commit it first. Write nothing.`); process.exit(0) }
  if (!lines || (topUp && !ranges.size)) { say(`NOTHING: no code lines changed${topUp ? ' since the questions were written' : ''} (only comments, blank lines or exempt files). Write nothing.`); process.exit(0) }
  const diff = U.diffText(repo, base, head, files, cfg.exempt)
  ranges ??= U.changedRanges(diff, { codeOnly: true })
  const want = wanted(lines, topUp)
  const stat = (x) => ({ files: x.files, added: x.added, removed: x.removed })
  const fmt = (rs) => rs.map(([a, b]) => (a === b ? a : `${a}-${b}`)).join(', ')
  saveDraft({ branch, base, head, mode: topUp ? 'top-up' : 'new', want, diffStat: stat(st), ranges: Object.fromEntries(ranges), questions: [] })
  say(topUp ? `TOP-UP: branch ${branch} · ${lines} new code lines since the questions were written` : `CHANGE: branch ${branch} · ${st.files} files · ${lines} code lines (+${st.added} −${st.removed})`)
  if (loose) say(`NOTE: ${loose} uncommitted code lines are not included.`)
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
  const abs = path.join(repo, file)
  if (!fs.existsSync(abs)) fail(`${file} doesn't exist`)
  const ranges = d.ranges[file]
  if (!ranges) fail(`${file} is not part of this ${d.mode === 'top-up' ? 'new change' : 'change'}: ask about the changed files (${Object.keys(d.ranges).join(', ')})`)
  if (text.length < 25) fail('--text is too short: ask a real question about this change')
  if (text.length > U.MAX_TEXT) fail(`--text is ${text.length} characters: at most ${U.MAX_TEXT}. One question, plainly`)
  if (!text.endsWith('?')) fail('--text must be one question, ending with "?"')
  if ((text.match(/\?/g) ?? []).length > 1) fail('--text asks more than one question: ask one')
  if (/(,?\s+(and|or)( also| then)?|;|\s+as well as)\s+(how|what|why|when|where|which|who|whose|does|do|did|is|are|was|were|can|could|would|should|will|has|have|if)\b/i.test(text)) fail('--text asks two things ("…, and could …"): keep the one that matters')
  // "what happens to X, Y and Z": three things to cover is three questions.
  if (/,\s+(?!(?:what|how|why|when|where|which|who|does|do|is|are|can|could|would|should|will|if|so|but|or)\b)[^,?]{1,60},?\s+(and|or)\s+[^?]+\?$/i.test(text)) fail('--text asks about a list of things ("X, Y and Z"): ask about the one that matters')
  if (/\bline\s+\d+/i.test(text)) fail('--text names a line number: name the function, value or case instead (the question is shown on its lines)')
  if (/^(what does|what is)\b/i.test(text) && kind === 'how' && text.length < 60) say('WARNING: "what does X do" questions are trivia; ask how it behaves in a case, or why')
  const q = { id: '', kind, text, file }
  const lines = fs.readFileSync(abs, 'utf8').split('\n')
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
    const near = ranges.some(([a, b]) => q.start <= b + 5 && q.end >= a - 5)
    if (!near) fail(`--lines ${q.start}-${q.end} are not near a changed code line of ${file} (changed: ${ranges.map(([a, b]) => (a === b ? a : `${a}-${b}`)).join(', ')})`)
    q.anchor = U.compactOf(lines, q.start, q.end)
  }
  // The honest answer is "this is a bug": the author is asked to fix it or explain it.
  if (o.suspect) q.suspect = true
  // Unchanged code the answer depends on (a caller, a retry loop, a constraint): shown beside the question.
  if (typeof o.also === 'string' && o.also.trim()) {
    q.also = []
    for (const part of o.also.split(',').map((x) => x.trim()).filter(Boolean)) {
      const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(part)
      if (!m) fail(`--also ${part}: write it as path:A-B`)
      const f = m[1].replace(/^\.\//, ''), a = Number(m[2]), b = Number(m[3] ?? m[2])
      const fa = path.join(repo, f)
      if (path.isAbsolute(f) || f.split(/[\\/]/).includes('..') || !fs.existsSync(fa)) fail(`--also: ${f} doesn't exist`)
      const fl = fs.readFileSync(fa, 'utf8').split('\n')
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
    const ok = U.codeLinksIn(repo, raw)
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
  const rel = U.fileFor(d.branch)
  const abs = path.join(repo, rel)
  const model = process.env.UNDERSTANDING_MODEL_LABEL || process.env.UNDERSTANDING_MODEL || undefined
  let check
  if (d.mode === 'top-up') {
    check = U.readCheck(abs)
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
      questions: d.questions.map((q, i) => ({ ...q, id: `q${i + 1}` })) }
  }
  const errs = U.validateCheck(check, { repo })
  if (errs.length) fail(`the file would not be valid: ${errs.join('; ')}`)
  U.writeCheck(abs, U.stamp(check, cfg))
  fs.rmSync(draftPath, { force: true })
  say(`WROTE ${rel}: ${check.questions.length} questions${d.mode === 'top-up' ? ` (${n} new)` : ''}. Done: reply with one line per new question.`)
  process.exit(0)
}

if (cmd === 'tour') {
  const branch = U.currentBranch(repo)
  const rel = U.fileFor(branch)
  const abs = path.join(repo, rel)
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
  const [lo, hi] = topUp ? TOPUP_STEPS : TOUR_STEPS
  const n0 = topUp ? check.journey.steps.length : 0
  say(topUp ? `TOUR TOP-UP: the tour of ${branch} has ${n0} steps; add ${lo}-${hi} after step ${n0}, through the new part only` : `TOUR: a journey of this change (${branch}): ${lo}-${hi} steps through the changed code and the unchanged code it depends on, in the order a request or the data flows`)
  say(`JOURNEY: ${J} <command> <repo> ${TOUR} … --dir ${stage}   (repo: ${repo}; always --dir; slug ${TOUR})`)
  if (topUp) { say('STEPS SO FAR (keep them as they are):'); check.journey.steps.forEach((s, i) => say(`  ${i + 1}. ${s.title} (${s.file}:${s.range.start}-${s.range.end})`)) }
  say(`QUESTIONS ${topUp ? 'that need a step' : '(each needs the step after which its answer is visible)'}:`)
  for (const q of want) say(`  ${qLine(q)}`)
  if (ranges.size) say(`CHANGED: ${[...ranges].map(([f, rs]) => `${f}:${fmtRange(rs)}`).join(' · ')}`)
  say(`THEN: ${J} check <repo> ${TOUR} quiet --dir ${stage}; fix every PROBLEM; then questions.mjs tour-finish --steps ${want.map((q) => `${q.id}=<n>`).join(',')}`)
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
  const staged = path.join(stageDir(), `${TOUR}.json`)
  let j
  try { j = JSON.parse(fs.readFileSync(staged, 'utf8')) } catch { fail(`no tour in ${stageDir()}: run \`questions.mjs tour\`, then journey.py new … ${TOUR} --dir …`) }
  const J = journeyPy()
  if (J) {
    let out = '', code = 0
    try { out = execFileSync('python3', [J, 'check', repo, TOUR, 'quiet', '--dir', stageDir()], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) { code = e.status ?? 1; out = `${e.stdout ?? ''}${e.stderr ?? ''}` }
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
  } else if (steps.length < TOUR_STEPS[0] || steps.length > TOUR_STEPS[1]) fail(`${steps.length} steps: a tour of a change has ${TOUR_STEPS[0]}-${TOUR_STEPS[1]}`)
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
    const files = new Set([q.file, ...(q.also ?? []).map((x) => x.file)])
    if (!steps.slice(0, n).some((s) => files.has(s.file))) problems.push(`${q.id}=${n}: no step up to ${n} is in ${[...files].join(' or ')}; give a later step, or add a step there`)
    q.step = n
  }
  if (problems.length) fail(problems.join('; '))
  const model = process.env.UNDERSTANDING_MODEL_LABEL || process.env.UNDERSTANDING_MODEL || undefined
  check.journey = { ...j, id: TOUR, commit: check.head, ...(before?.createdAt ? { createdAt: before.createdAt, updatedAt: new Date().toISOString() } : { createdAt: new Date().toISOString() }), ...(model ? { model } : {}) }
  const errs = U.validateCheck(check, { repo })
  if (errs.length) fail(`the file would not be valid: ${errs.join('; ')}`)
  U.writeCheck(abs, U.stamp(check, cfg))
  fs.rmSync(stageDir(), { recursive: true, force: true })
  say(`WROTE the tour into ${rel}: ${steps.length} steps${before ? ` (${added} new)` : ''}; ${check.questions.map((q) => `${q.id} after step ${q.step}`).join(', ')}. Done: reply with the step titles, one per line.`)
  process.exit(0)
}

say(`questions.mjs start [--base <ref>] [--top-up] [--replace] | add --kind <${U.KINDS.join('|')}> --file <path> (--lines A-B | --whole-file) --text "<question>" [--also <path>:A-B,…] [--suspect] | list | remove <n> | finish | tour [--top-up] | tour-finish --steps q1=<n>,…`)
process.exit(cmd ? 2 : 0)
