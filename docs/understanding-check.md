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
   Questions finished after a branch switch wait in `.code-notes/.cache/checks/` (git-ignored) until that branch is
   checked out again. The first check also runs `init` (nothing goes in the workspace's settings).
3. Only question 1 opens: its code, and the question as a note thread on its lines (session `Check · <branch>`),
   with the keyboard in the thread. The list is the **Check** view in the Code Notes sidebar (the only list of them: the
   Code Notes tree doesn't repeat them): where the check stands,
   one row per question, one button (Start, Add questions, Commit & push). Ctrl+' D / A walk the open questions;
   journey lenses step aside in a file with an open question; another branch's check threads (and notes made from them) are hidden. Threads
   follow the file on disk: a changed question gets a new thread, a removed one loses it, and an answer is stored
   only for the question text it was shown with.
4. Each reply is graded on submit: ✓ "Right" confirming what the answer said (a bug it names, confirmed), at most one
   more fact on the same point; "Mostly right" + the correction when the main point is right but a detail that matters
   is wrong (`partial`, worth discussing on the merge request); or "Not quite" (what is right, what to re-check) + a hint. After a second miss the grader explains; the dev may say it back in one sentence
   (`restated`, counts as passed). The grader names code instead of giving line numbers, each name a code link
   (click: the lines light up, nothing is selected and the keyboard stays in the thread; "← Back to question"). It may
   raise a `concern` about the code itself: **Suggest a fix** (a note on the code the concern names, asked to Claude for
   the smallest change: one sentence and a suggestion block with Apply; Undo takes it back), **Add TODO** (one line of
   at most 80 characters; the thread says where it went), **Flag for reviewer** (independent of the TODO). After a grade the editor stays on the question and the
   reply box is empty; **Next question ›** under the grade (or Ctrl+' D) moves on.
   "Ask Claude" on a check question asks what you want to know and answers in a separate note; Claude is told never
   to write the check's answer.
5. When the rule is met the status bar says `✓ Understanding` and the view offers **Commit & push**, naming what it
   commits: the check file, with `.gitattributes`/`.ignore` when `init` changed them (`-u` without an upstream). A file
   a TODO was added to from the check is offered with a tick box; the person's other changes are left alone.
6. CI: finds the file, checks it belongs to this change and that the recorded verdicts meet the threshold
   (no model call), passes or fails with a short reason, and posts the Q&A as a merge request comment.

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
  "result": { "passed": 3, "total": 4, "needed": 3, "verdict": "pass", "at": "…" }   // informational only
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

**Concerns.** When the grader thinks the CODE is wrong it returns `concern` on that attempt (text only). The author
decides what happens to it; the extension then writes the question's `concern`:
`{ "text": string, "flagged": boolean, "at"?: ISO time, "by"?: { "name", "email" } }` (`by`: who flagged it, else
`answeredBy`). `flagged: true` (**Flag for reviewer**) puts it at the top of
the merge request comment under "⚠ Found during the check"; `false` (e.g. **Add TODO**, or not decided) keeps it out of
the comment. One concern per question; `text` may be edited by the author. `suspect: true` (set by the question
writer) is shown as "may be a bug" next to the question in the comment, and in VS Code only once the question has been
answered (never before: it would give the answer away), with the same actions.

CI also posts each flagged concern as a **thread on its line** that a reviewer can resolve: a GitLab discussion with a
diff position (the merge request's `diff_refs`, the last line of the question's range, else the first code link of the
attempt that raised it), a GitHub review comment (`side: RIGHT`). The text is short: "⚠ **Found during the understanding
check** (flagged by Bob)" and the concern, mentions made inert. A hidden marker with the question's id finds it again:
never posted twice, its text updated when it changed. Un-flagged, or its question gone: GitLab resolves the discussion
(and reopens it when flagged again); GitHub gets one "No longer flagged." reply (resolving a review thread needs GraphQL).
A line outside the diff falls back to a plain merge request note with a file:line link. Errors here never fail the job.

## Out of diffs and search

`understanding.mjs init` (the extension runs it on the first check) adds, once and without duplicating lines:

- `.gitattributes`: `understanding/*.json gitlab-generated linguist-generated`. GitLab (`gitlab-generated`) and GitHub
  (`linguist-generated`) collapse the files in diffs. The line an earlier version wrote (`linguist-generated=true`
  only, which GitLab ignores) is replaced.
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

When `base` or `head` is not in the clone (rebased or squashed branch, or a shallow clone), CI compares sizes instead:
the change's code lines now against `diffStat` (code lines too). Lenient, but a rebase must not void the check. CI jobs fetch the full
history (`GIT_DEPTH: 0`, `fetch-depth: 0`).

## CLI (one file, Node ≥ 18, no dependencies): `understanding.mjs`

Shipped in the repo (and inside the vsix) so CI can run it with `node`:

| Command | |
|---|---|
| `status [--json]` | which file, valid for this change?, answered/passed counts, what to do next |
| `validate <file>` | schema + anchors check (used by the skill's script and by CI) |
| `grade <file> [--question q2] [--answer "…"] [--write]` | grade answers with the configured backend (`--answer` adds an attempt first) |
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
ever. Once done: flagged concerns first (`⚠ Found during the check`), then explained questions and partial passes as `Worth discussing:
<topic>` (file:line link) with the correct point in one line, then the other questions with the author's passing answer
and at most 15 words of the grader's reasoning (`note`). Wrong guesses and retries are never posted. An answer by
someone other than `answeredBy` says `answered by <name>`. Quoted text never notifies or links: @mentions and numbered
references (`#12`, `!3`, `~5`, …) are made inert.

The skill's script (`skills/understanding-check/scripts/questions.mjs`: `start`, `add`, `list`, `remove`,
`finish`) imports the CLI as a module, as the extension does, so the rules live in one place. `add` refuses
questions that are not near a changed code line, on lines that hold only comments or blank lines, longer than 240
characters, more than one question ("…, and could…", "what happens to X, Y and Z", "…, or does…"), or that name a line
number; `--suspect` marks a question whose honest answer is "this is a bug". `finish` wants the count for the change's
size (exactly 1 or 2 for a small change, 3–5 above; 1–2 for a top-up), from 3 questions on of at least two kinds, one
of them why/failure/edge.

Grading runs only locally (extension, or `grade` from a terminal). Grader backends: `claude` (the `claude -p` CLI, read-only tools, uses `CLAUDE_CODE_OAUTH_TOKEN` or the
logged-in user) or `anthropic` (Messages API with `ANTHROPIC_API_KEY`). The grader gets the question, the
answer, the diff and may read the code; it returns JSON `{verdict, feedback, hint}`.

## Config: `understanding/config.json` (optional, committed)

```jsonc
{ "questions": { "min": 1, "max": 5 }, "exempt": [], "passRatio": 0.6, "maxDrift": 40, "mode": "required",
  "skipLabel": "skip-understanding", "model": null, "backend": null, "mrComment": true }
```

`backend` (`claude` | `anthropic`) and `model` apply to `grade` from a terminal (also `--backend`, `--model`,
`UNDERSTANDING_BACKEND`). In VS Code, the Claude Code runner grades (setting `codeNotes.understanding.model`).
Questions per change, by code lines: 1 under 20, 2 under 60, 3 under 150, 4 under 300, else 5 (within
`questions.min`/`max`; `"questions": 3` always asks 3). `exempt`: globs of files that never count (`**` any folders, `*`
within a name; a glob without `/` matches in any folder), empty by default, e.g. `["docs/**", "*.md", "package-lock.json"]`.

## Skipping

No size limit: every change with code lines needs the check (only exempt files or comment-only changes pass by
themselves). To skip one: add the label `skip-understanding`; any approval by someone other than the author waives the
check (GitLab approvals API; GitHub reviews API). The feature relies on good faith, so no reason is asked; the job and the
comment record "waived (approved by @bob)". GitLab doesn't re-run the job on an approval: the message says to re-run it
(GitHub's recipe re-runs on the review).

## CI recipes (in the README)

GitLab: a job on `merge_request_event` with plain `node` (no LLM CLI, no model key); `GITLAB_TOKEN` (project token,
`api` scope) for labels/approvals/comment; `allow_failure: { exit_codes: [3] }`. GitHub Actions: same CLI, `GITHUB_TOKEN`.

**Advisory mode** (`"mode": "advisory"`, or `UNDERSTANDING_MODE=advisory`, which overrides the file): start advisory for
a month, then switch to required. Wherever `ci` would fail (exit 1) it exits 3, its first line starts "⚠ Advisory:", and
the merge request comment is the same as in required mode plus one muted line "Advisory: this check doesn't block
merging." GitLab shows exit 3 as "passed with warnings". GitHub's `continue-on-error` can't target one exit code, so on
GitHub Actions `ci` prints a `::warning::` annotation and exits 0 instead. "Can't check" (exit 2) stays 2.

## Out of scope for the prototype

Server-side storage, analytics on pass rates, per-team question banks, languages other than English.
