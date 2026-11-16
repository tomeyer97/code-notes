# Understanding check (prototype)

A merge request check that asks the author a few questions about their own change — how it works, why it
is built this way, how it can fail — and lets them answer inside VS Code, next to the code. An AI grader
gives feedback and a hint, never a dead end. CI passes when enough answers show the author understands the
change.

Goal: about 30 % more understanding of the code that gets merged, not 100 %. It must feel like help (an
expert asking good questions about code you are about to own), not like an exam. If it is annoying, people
will find a way around it, so every design choice below favours little friction.

## Principles

1. **Few, good questions.** Every change with code gets a check; the count follows its size in code lines: 1 under
   20, 2 under 60, 3–5 above. Each one is
   about *this* change: a specific function, a design choice, a failure mode, an edge case. No trivia, no
   "what does line 12 do".
2. **Never stuck.** Wrong answer → feedback + one hint → second try → if still wrong, the grader explains
   the answer and the dev moves on. Passing needs a share of the questions (default 60 %), not all.
3. **Answers are short.** One to three sentences is a full answer. The grader is told so.
4. **No answer key in the repo.** Only the questions are stored. The grader judges each answer against the
   code itself, so there is nothing to peek at.
5. **Everything happens locally; CI only checks the process was done.** Questions are written and answers
   graded on the dev's machine with their own agent. CI makes no model calls and needs no LLM key: it checks
   the file exists, belongs to this change, is complete and its recorded verdicts meet the threshold. This is
   cheatable by hand-editing the file, deliberately accepted: the goal is to prompt thinking, not to police.
   Each graded attempt stores a short hash of (question, answer, verdict) so CI notices accidental damage
   (e.g. a bad merge of the file) — not a security measure.
6. **The answers help the reviewer.** Once the check is done, CI posts the questions and answers on the merge request
   (never while it is in progress: no grading in public).
7. **Good faith over enforcement.** Least friction wins: an approval waives the check, every message is one short line.

## Flow

1. Dev works on a branch, pushes, opens a merge request. The CI job `understanding` fails with one friendly
   line: what to run and that it takes about 5 minutes.
   (They can also do it before pushing.)
2. In VS Code: **Code Notes: Check my understanding** (the status bar says `Understanding: start`). The
   extension asks the coding agent (same Claude Code runner as "Ask Claude", read-only tools) to write the
   questions with the bundled skill `skills/understanding-check` (SKILL.md + a script that validates and writes the
   file). Questions cover committed code only: the check starts anyway, and one line in the Check view names every uncommitted
   or new file left out.
   The branch and commit are pinned when the writing starts
   (`start --branch <b> --head <sha>`): the script reads files at that commit and, when that branch is no longer checked
   out, writes the questions to `.code-notes/.cache/checks/` (git-ignored) instead of the working tree; they are put in
   place when the branch is checked out again. Nothing is written to the branch checked out meanwhile. Nothing is written to the repository by itself: while `.gitattributes`/`.ignore` lack
   the check's lines, the Check view offers "Collapse check files in diffs: Set up · Hide"; Set up runs `init` and commits
   only those two files ("Add understanding check setup"). CI's log has a one-line tip while they are missing.
3. Only question 1 opens: its code, and the question as a note thread on its lines (session `Check · <branch>`),
   with the keyboard in its **answer box** in the Check view (a webview, so the caret really is there; VS Code can't put
   it in a thread's reply box). Opening a question from anywhere (a click, Ctrl+' D / A, Back from a code link) selects
   it and focuses its box; ↑ ↓ on the rows select without taking the keyboard. Ctrl+Enter sends (the same attempt as a
   reply in the thread, which keeps working), Esc goes back to the code; the grade shows under the box and in the
   thread, its code links light the code and leave the keyboard in the box. After a pass the box closes and
   **Next question ›** appears. An unsent answer is kept per question in the workspace's state (never in the file).
   The list is the **Check** view in the Code Notes sidebar (the only list of them: the
   Code Notes tree doesn't repeat them): where the check stands,
   one row per question, one button (Start, Add questions, Commit & push). Ctrl+' D / A walk the open questions;
   journey lenses step aside in a file with an open question; another branch's check threads (and notes made from them) are hidden. Threads
   follow the file on disk: a changed question gets a new thread, a removed one loses it, and an answer is stored
   only for the question text it was shown with.
4. Each reply is graded on submit: ✓ "Right" confirming what the answer said (a bug it names, confirmed), at most one
   more fact on the same point; "Mostly right" + the correction when the main point is right but a detail that matters
   is wrong or a part the question asks for is missing (`partial`, worth discussing on the merge request: never an answer
   completed by the grader and called "Right"); or "Not quite" (what is right, what to re-check) + a hint. After a second miss the grader explains; the dev may say it back in one sentence
   (`restated`, counts as passed). The grader names code instead of giving line numbers, each name a code link
   (click: the lines light up, nothing is selected and the keyboard stays in the thread; "← Back to question"). It may
   raise a `concern` about the code itself: **Suggest a fix** (a note on the code the concern names, asked to Claude for
   the smallest change: one sentence and a suggestion block with Apply; Undo takes it back), **Add TODO** (one line of
   at most 80 characters; the thread says where it went), **Flag for reviewer** (independent of the TODO). After a grade the editor stays on the question and the
   reply box is empty; **Next question ›** under the grade (or Ctrl+' D) moves on.
   "Ask Claude" on a check question asks what you want to know and answers in a separate note; Claude is told never
   to write the check's answer.
5. When the rule is met the status bar says `✓ Understanding` and the view offers **Commit & push**, naming what it
   commits: the check file, with `.gitattributes`/`.ignore` when someone ran `init` by hand (`-u` without an upstream). A file
   a TODO was added to from the check is offered with a tick box; the person's other changes are left alone.
6. CI: finds the file, checks it belongs to this change and that the recorded verdicts meet the threshold
   (no model call), passes or fails with a short reason, and posts the Q&A as a merge request comment.

## The tour of the change

Answering a question about code you have not read is hard to start: you open the file and read it cold. So the check
also comes with a **tour**: a short journey of the change (the journey format, docs/journey-format.md), 6-10 steps
through the changed code AND the unchanged code it depends on, in the order a request or the data flows. Each question
is placed after the step that shows its answer (`step` on the question), so the answer can be reached by clicking.

- **Written right after the questions**, by the same agent in the same session (`claude --resume`: the change is read
  already), with the skill's section "The tour": `questions.mjs tour` prints the questions, the changed lines and the
  `journey.py` command line; the agent writes the journey with the code-journey skill's `journey.py` (one-line fact
  steps on exact lines, a small map, 1-3 code links per step; no values, no animations) into a staging folder in the
  git dir; `questions.mjs tour-finish --steps q1=3,q2=5,…` runs `journey.py check`, checks the count (6-10; a top-up
  appends 1-4 and never changes the steps before), that a step up to each question's number shows its file (or the
  code it also depends on), and puts the journey in the check file. Answers given meanwhile are kept (it reads the
  file at the end). Measured on Sonnet (a 90-line change of the example shop): questions 21 s / $0.16, the tour 172 s /
  $0.75 (58 turns). So the questions open as before and can be answered while the tour is written; the Check view says
  "Writing the tour · 1:20", then one notification offers **Walk it**. A failed tour leaves the check as it was
  ("Couldn't write the tour · Try again").
- **Walking it.** Check my understanding (or **Walk the tour · 9 steps** in the Check view) opens the tour in the journey
  panel like any journey (storyline, map, code links), where it was left. The questions are rows of the storyline after
  their step ("? Why does …", ✓ when passed). Next past a step with an open question opens that question (the card's
  Next says **Question ›**): its thread on its lines, the keyboard in it. A pass walks on; Previous goes back. A row of
  the storyline or of the Check view (each says "step 3") goes to that step and question. Walking is optional: the
  rows go straight to a question.
- **Not a journey of the repository.** It is not in the Journeys view or list, has no code lenses, and lives only with
  its check (another branch: it is gone from the panel).
- **The grader** gets the tour as numbered lines and where this question's answer is; it may say "step 3", linked to
  that step's lines like any code it names.
- **See also.** When a journey of the repository walks the same code, a question's thread and the tour's last step say
  "See also: Order and payment, step 3" (a link that walks it). Ranked like "In this file" (journeyList.ts `seeAlso`):
  a step on the question's lines, then the journey with most steps in the file. No model call.
- **Reviewers.** The merge request comment starts with one line: "A guided tour of this change: open it in VS Code with
  Code Notes (Check view)". Nothing else changes in CI.
- **Why in the check file** (`journey`, not a file of its own): one file is the whole check, so the steps the questions
  point at can never disagree with the questions; Commit & push, the branch cache, `.gitattributes` and CI handle one
  file as before; older files simply have none. A tour is never required: `validate` and `ci` check its shape and the
  `step` references only when it is there, and never fail over the tour's code (a step whose file is gone later is
  shown as stale by the extension).

## The file: `understanding/<branch-slug>.json` (committed)

Named after the branch, not a commit: committing the file creates a new commit, so a commit-named file could
never match. The file records the code commit the questions were written for.

```jsonc
{
  "version": 1,
  "branch": "feat/discount-codes",
  "base": "<merge-base sha>",
  "head": "<code commit the questions were written for>",
  "diffStat": { "files": 6, "added": 212, "removed": 40 },
  "answeredBy": { "name": "…", "email": "…" },   // git user.name/email when the check is created
  "model": "…", "createdAt": "…",
  "questions": [
    {
      "id": "q1",
      "kind": "how" | "why" | "failure" | "edge" | "change",   // shown as a small label
      "text": "When two requests apply the same code at the same time, what stops it being used twice?",
      "file": "api/discounts.ts", "start": 40, "end": 58,       // 1-based lines; or "target": "file"
      "anchor": { … same compact anchor as journeys/notes, so it survives edits … },
      "round": 2,                                                // set on questions added by a top-up
      "step": 3,                             // optional: the tour step after which its answer is visible
      "suspect": true,                       // optional: the question writer thinks the honest answer is "a bug"
      "concern": { "text": "…", "flagged": true, "at": "…" },   // optional, see below
      "attempts": [
        { "verdict": "retry", "at": "…", "feedback": "…", "hint": "…", "gradedAt": "…" },   // superseded: no answer, no hash
        { "answer": "…", "at": "…", "by": { "name": "…", "email": "…" },   // "by" only when not answeredBy
          "verdict": "pass" | "retry" | "explained" | "restated", "feedback": "…", "hint": "…", "gradedAt": "…",
          "note": "…", "topic": "…", "partial": true, "concern": "…",   // from the grader, when it gives them
          "hash": "<12 hex: sha256 of question text, answer, verdict>" }
      ]
    }
  ],
  "result": { "passed": 3, "total": 4, "needed": 3, "verdict": "pass", "at": "…" },  // informational only
  "journey": { "version": 2, "id": "tour", "question": "…", "title": "…", "summary": "…", "nodes": […], "edges": […],
               "steps": […], "commit": "<head>", "createdAt": "…", "model": "…" }   // optional: the tour (journey format)
}
```

A question's state comes from its attempts: none → to answer; last without a verdict → not graded; any `pass` →
passed; any `explained` → missed; else (last is `retry`) → try again.

The answers also show as note threads in the editor; the file is the source of truth (notes are a view).

**Only the final answer is kept.** When a newer attempt is added, every earlier one loses its `answer` text and its
`hash`; its verdict, times, `by` and the grader's feedback, hint, note, topic and concern stay. A wrong guess never
stays in the repository. Whoever writes an attempt calls `pruneAttempts(question)` from the CLI module (`addAttempt`
does it itself). Only each question's last attempt must have an `answer`, and only its `hash` is verified by CI.
Files written before this (every attempt with its answer and hash) still validate.

**Concerns.** When the CODE of the change has a defect the grader checked (a bug, a race, lost data, a forgotten step;
also a slip the author admits, or a trap their answer points at that the grader confirms) it returns `concern` on that
attempt: one sentence saying what breaks and why it matters. Never a description of working code, a reassurance
("nothing calls it"), the outcome of a "what if", or a correction of the answer (that is the feedback, or a partial
pass). A concern that only repeats the feedback (the same words, or a part of them) is dropped when the reply is parsed. The author
decides what happens to it; the extension then writes the question's `concern`:
`{ "text": string, "flagged": boolean, "at"?: ISO time, "by"?: { "name", "email" } }` (`by`: who flagged it, else
`answeredBy`). `flagged: true` (**Flag for reviewer**) puts it at the top of
the merge request comment under "⚠ Found during the check" (a one-line link to its thread on the line); `false` (not decided, or un-flagged) keeps it out of
the comment. One concern per question; `text` may be edited by the author. `suspect: true` (set by the question
writer) is shown as "may be a bug" next to the question in the comment, and in VS Code only once the question has been
answered (never before: it would give the answer away), with the same actions.

CI also posts each item of the comment (below) as a **thread on the code** that a reviewer can resolve: a GitLab
discussion with a diff position (the merge request's `diff_refs`), a GitHub review comment (`side: RIGHT`). One thread
per question: a question's concern and its "Worth discussing" line share one. It goes on the line the item is about (a
concern: its grade's code link, found again by its text, else the last line of the question's range; else the question's
first line) or, when that line is not in the diff, on the nearest changed line of its hunk (or within 20 lines), with a
link to the line it is about. Only when there is none: a plain merge request note with a file:line link. The text is
short: "⚠ **Found during the understanding check** (flagged by Bob)" and the concern, mentions made inert. A hidden
marker with the question's id finds it again: never posted twice, its text updated when it changed.
**The reviewer's decisions win.** The bot never reopens a thread a person resolved, and never resolves one a person
replied to. It closes only its own concern threads whose concern is no longer flagged (or whose question is gone):
GitLab resolves the discussion (and reopens it when flagged again, only if the bot had resolved it); GitHub gets one "No
longer flagged." reply (resolving a review thread needs GraphQL). "Worth discussing" threads are left to the reviewer,
also when a top-up is pending. Errors here never fail the job.

## Out of diffs and search

`understanding.mjs init` (the extension runs it on the first check) adds, once and without duplicating lines:

- `.gitattributes`: `understanding/*.json gitlab-generated linguist-generated`. GitLab (`gitlab-generated`) and GitHub
  (`linguist-generated`) collapse the files in diffs. The line an earlier version wrote (`linguist-generated=true`
  only, which GitLab ignores) is replaced. And `understanding/config.json -gitlab-generated -linguist-generated`: the
  settings are never collapsed, so a change to them stays in sight.
- `.ignore`: `understanding/`. ripgrep and VS Code's search (`search.useIgnoreFiles`, on by default) skip the folder.
  `git grep` users can exclude it with `git grep … -- ':!understanding'`.

The files stay in the tree: CI reads them from the merge request's commit.

## Belongs to this change? (staleness)

Only **code lines** count: blank lines and whole-line comments (by file type: `//`, `#`, `/* */`, `--`, `<!-- -->`) don't,
nor `understanding/`, `.code-notes/`, the root `.gitattributes` and `.ignore` (what `init` writes) and the config's `exempt` files. Drift is measured on the branch's **own** change:
CI diffs the branch against today's merge base and compares it, line by line (file, + or −, code text), with the change
the questions were written for (`base` → `head`). Merging or rebasing onto the target branch adds nothing; lines resolved
differently in a conflict count. If ≤ `maxDrift` new code lines (default 40) → still valid. Otherwise: "Your change grew by N lines since the check. Run
*Check my understanding* again: it adds 1–2 questions about the new part only" (top-up, appended to the
same file, earlier answers kept). A top-up asks only about those new lines of the branch's own change, never about code
that came in from the target branch, and records today's merge base.

**Stacked branches.** When the branch holds another branch's committed check whose code commit lies between the merge
base and the head (a branch made from a branch that did its check), the change starts at that commit: its code was
checked in its own merge request, so it is never asked about again (status: "2 code lines changed since feat/x's
check"; CI the same). When the parent went on after its check (a fix, a small addition), the change starts where the
branch left the parent instead (when the clone has the parent's branch): the parent's later commits are its own, never
asked about on the child. Once the parent is merged, the merge base is past it and nothing special happens.

When `base` or `head` is not in the clone (rebased or squashed branch, or a shallow clone), CI compares sizes instead:
the change's code lines now against `diffStat` (code lines too). Lenient, but a rebase must not void the check. CI jobs fetch the full
history (`GIT_DEPTH: 0`, `fetch-depth: 0`).

## CLI (one file, Node ≥ 18, no dependencies): `understanding.mjs`

Shipped in the repo (and inside the vsix) so CI can run it with `node`:

| Command | |
|---|---|
| `status [--json]` | which file, valid for this change?, answered/passed counts, what to do next |
| `validate <file>` | schema + anchors check (used by the skill's script and by CI) |
| `grade [<file>] [--question q2] [--answer "…"] [--write]` | grade answers with the configured backend (`--answer` adds an attempt first; the file defaults to this branch's) |
| `init` | keeps `understanding/` out of diffs and search: writes or extends `.gitattributes` and `.ignore` (idempotent) |
| `ci` | the CI job: find file → check drift → check completeness + recorded verdicts vs threshold + attempt hashes → exit 0/1 with a short reason → optional MR comment. Never calls a model. Exit 2: it can't check (commits missing, API error). |

`ci` rules, in order:

1. No code lines changed → pass: `✓ No check needed: only exempt files changed (docs/guide.md)` or `✓ No check needed:
   no code lines changed (only comments or blank lines).` There is no size limit: one changed code line needs a check.
2. Skip label (read fresh from the API when there is a token: a re-run job keeps its pipeline's old variables) and an
   approval by anyone but the author (any approval, also one given before the label) → `✓ Understanding check waived
   (approved by @bob)`, also as the comment. Without such an approval the check below still runs; if it doesn't pass,
   the job says `Skip requested: an approval from a reviewer waives the understanding check, then re-run this job.`
   (self-approval: `✗ Approved only by alice (the author). Ask a reviewer to approve, then re-run this job.`). On GitHub
   the recipe re-runs on the review, so "then re-run this job" is left out.
3. No file / invalid file / drift / a graded attempt whose hash doesn't match → fail with what to do.
4. The rule (`checkState`, the same everywhere): every question done (pass, explained or restated; "try again" is not
   done) and `ceil(passRatio × total)` passed.

The merge request comment follows the job and is found again by the marker `<!-- understanding-check -->` and updated
in place. Its first line is the result or what is missing (no check yet, needs a top-up, file not valid). It never
grades in public: while the check is in progress it is one line (`Understanding check in progress: 2 of 4 done.`), no ✗
ever. It stays short: one problem, one line. The status line, then one line per item a reviewer can act on, each a link
to its resolvable diff thread (reviewItems): once done, a concern the grader raised on a question asked as "may be a bug"
first (`- ⚠ May be a bug: …`); flagged concerns (`- ⚠ …`); then, once done, explained questions and partial passes
(`- 💬 Worth discussing: <topic>`). A concern whose line changed since the questions' commit says "· lines changed in
<sha> · fixed?". Without an API token, the same lines carry the text and a file link instead. Once done also: concerns
no item shows (nobody flagged, dismissed or fixed them), one line each under "Also noticed while grading"; the tour
line; and every answer once in a collapsed `<details>` "All answers": the author's own words, quoted (an answer over
about 300 characters is cut: "… (full answer in the check file)"); a restatement marked "restated after an
explanation"; an explained question only "explained" (its point is in "Worth discussing"). The grader's words are
never shown as an answer, and wrong guesses and retries are
never posted. In VS Code a concern's thread offers, quietly, **Mark fixed** (once flagged) and **Dismiss** (asks for a
one-line reason; stored as `concern.dismissed = { reason, by, at }`); both take it off the merge request. An answer by
someone other than `answeredBy` says `answered by <name>`. Quoted text never notifies or links: @mentions and numbered
references (`#12`, `!3`, `~5`, …) are made inert. Answers, notes, topics and concerns are literal text: their markdown
and HTML are escaped line by line (a `---` under a line, `### ✅ waived`, `</blockquote>`, a table row or `:emoji:` shows
as typed), and every line of an answer stays inside its quote. Answers in the VS Code threads are shown as typed too.

The skill's script (`skills/understanding-check/scripts/questions.mjs`: `start`, `add`, `list`, `remove`,
`finish`) imports the CLI as a module, as the extension does, so the rules live in one place. `add` refuses
questions that are not near a changed code line, on lines that hold only comments or blank lines, longer than 240
characters, more than one question ("…, and could…", "what happens to X, Y and Z", "…, or does…"), or that name a line
number; `--suspect` marks a question whose honest answer is "this is a bug". A change made only of documentation (`*.md`, `*.txt`, `docs/`, …) gets one question about what a reader now sees
or understands differently ("4 lines changed (docs)"); the question carries `docs: true` and the grader passes an honest
"it's just wording". A moved or renamed file is detected as a move (git `-M`, both paths passed to git): it counts no line, but a change
that is only a move still gets one question about the move itself ("Renamed, 0 lines changed"), never about the
content it kept. A change that only removes code gets questions too: on the lines where code was removed, or on the code that used
it (any file). `finish` wants the count for the change's
size (exactly 1 or 2 for a small change, 3–5 above; 1–2 for a top-up), from 3 questions on of at least two kinds, one
of them why/failure/edge.

**Without VS Code.** `status` (no check yet) and CI's log say the same: copy the skill into `.claude/skills`, ask
Claude Code to "check my understanding", then answer each question with `grade --question q1 --answer "…" --write`.
The skill's script finds the CLI beside it, through `UNDERSTANDING_CLI`, or as the repository's own copy (e.g.
`tools/understanding.mjs`).

Grading runs only locally (extension, or `grade` from a terminal). Grader backends: `claude` (the `claude -p` CLI, read-only tools, uses `CLAUDE_CODE_OAUTH_TOKEN` or the
logged-in user) or `anthropic` (Messages API with `ANTHROPIC_API_KEY`). The grader gets the question, the
answer, the diff and may read the code; it returns JSON `{verdict, feedback, hint}`.

**In a stash.** A check file that is not in the tree but in a git stash (`git stash -u`) is "Your check is in a git
stash · Run git stash pop (stash@{0})." instead of Start; its threads are hidden until it is back.

**Merge conflicts.** A check file with git conflict markers is "The check file has a merge conflict" (never a parser
error): when both sides read as checks, **Keep both answers** merges them (each question once, from the side with more
graded answers); else **Open** goes to the first marker (the status item too). `status` exits 1 for a file that can't
be read.

## Config: `understanding/config.json` (optional, committed)

```jsonc
{ "questions": { "min": 1, "max": 5 }, "exempt": [], "passRatio": 0.6, "maxDrift": 40, "mode": "required",
  "skipLabel": "skip-understanding", "model": null, "backend": null, "mrComment": true }
```

`backend` (`claude` | `anthropic`) and `model` apply to `grade` from a terminal (also `--backend`, `--model`,
`UNDERSTANDING_BACKEND`). In VS Code, the Claude Code runner grades (setting `codeNotes.understanding.model`).
The Check view and the status bar tooltip say the size: "3 questions, ~2 min", "~1 min left" (about 35 s a question); the
merge request comment and the CI log say "about 2 min" (GitLab would read "~2" as a label). Questions per change, by code lines: 1 under 20, 2 under 60, 3 under 150, 4 under 300, else 5 (within
`questions.min`/`max`; `"questions": 3` always asks 3). `exempt`: globs of files that never count (`**` any folders, `*`
within a name; a glob without `/` matches in any folder), empty by default, e.g. `["docs/**", "*.md", "package-lock.json"]`.

**Settings are the target's.** CI reads `understanding/config.json` as the target branch has it (its tip when the clone
has it, else the merge base), never as the merge request brings it: a feature branch that sets `"mode": "advisory"`, a
bigger `maxDrift` or a new `exempt` glob is still judged by the settings it would change. Such a change is the
comment's headline ("**⚠ This merge request changes the understanding check's settings: mode required → advisory**
(from the merge on; this merge request follows the current settings)"), also when no code changed ("✓ No check
needed: only the check's settings changed."; then the headline is the whole comment). A key that is not a setting (a
typo, or one an older version had) is ignored, and `status` and the CI log say so. After a self-approval the comment says "Your own approval doesn't count:
ask a reviewer to approve, then re-run this job." The size is honest: "3 questions, about 2 min" (by the question count).

## Skipping

No size limit: every change with code lines needs the check (only exempt files or comment-only changes pass by
themselves). To skip one: add the label `skip-understanding`; any approval by someone other than the author waives the
check (GitLab approvals API; GitHub reviews API). The feature relies on good faith, so no reason is asked; the job and the
comment record "waived (approved by @bob)". GitLab doesn't re-run the job on an approval: the message says to re-run it
(GitHub's recipe re-runs on the review).

## CI recipes (in the README)

GitLab: a job on `merge_request_event` that runs on its own (`stage: .post`, `needs: []`) with plain `node` (no LLM CLI, no model key); `GITLAB_TOKEN` (project token,
`api` scope) for labels/approvals/comment; `allow_failure: { exit_codes: [3] }`. The last stage, because GitLab skips every later stage after a failed job: in `.pre`,
a missing check would skip lint and tests. `needs: []` starts it at once anyway, so a failing test never skips it either.
GitHub Actions: same CLI, `GITHUB_TOKEN`.

**Advisory mode** (`"mode": "advisory"`, or `UNDERSTANDING_MODE=advisory`, which overrides the file): start advisory for
a month, then switch to required. Wherever `ci` would fail (exit 1) it exits 3, its first line starts "⚠ Advisory:", and
the merge request comment starts with "Advisory: this check doesn't block merging." and never shows skip instructions
(nothing to skip; the job log neither). GitLab shows exit 3 as "passed with warnings". GitHub's `continue-on-error` can't target one exit code, so on
GitHub Actions `ci` prints a `::warning::` annotation and exits 0 instead. "Can't check" (exit 2) stays 2.

## Out of scope for the prototype

Server-side storage, analytics on pass rates, per-team question banks, languages other than English.
