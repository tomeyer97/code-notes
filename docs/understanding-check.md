# Understanding check (prototype)

A merge request check that asks the author a few questions about their own change — how it works, why it
is built this way, how it can fail — and lets them answer inside VS Code, next to the code. An AI grader
gives feedback and a hint, never a dead end. CI passes when enough answers show the author understands the
change.

Goal: about 30 % more understanding of the code that gets merged, not 100 %. It must feel like help (an
expert asking good questions about code you are about to own), not like an exam. If it is annoying, people
will find a way around it, so every design choice below favours little friction.

## Principles

1. **Few, good questions.** 3–5 per change (fewer for small diffs; none under a minimum size). Each one is
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
6. **The answers help the reviewer.** CI posts the questions and answers on the merge request.

## Flow

1. Dev works on a branch, pushes, opens a merge request. The CI job `understanding` fails with one friendly
   line: what to run and that it takes ~5 minutes.
   (They can also do it before pushing.)
2. In VS Code: **Code Notes: Check my understanding** (also offered from a status-bar item when the branch
   has no check yet). The extension asks the coding agent (same Claude Code runner as "Ask Claude",
   read-only tools) to read `git diff <base>...HEAD` and write the questions with the bundled skill
   `skills/understanding-check` (SKILL.md + a script that validates and writes the file).
3. The questions open in a small panel styled like a journey's storyline: one row per question with its status
   (to answer / ✓ / try again / explained); clicking one opens its code with the question as a note thread on the
   exact lines (general/design questions are file-level threads on the most relevant file). The dev replies in
   the thread (Ctrl+Enter). The threads are notes of a session `Check · <branch>`.
   *Prototype choice:* its own panel (`codeNotes.check`), not the journey panel: the journey panel carries a tour
   (current step, map, restore after reload) that a check doesn't have, and sharing it would tangle both.
   The questions are written on committed code only (uncommitted lines would count as drift at once).
4. Each reply is graded on submit (a failed grading shows "Try again" in the thread): the grader replies in the same thread —
   ✓ with one sentence of confirmation / extra insight, or "not quite" + a hint. After a second miss it
   explains, and the question counts as missed.
5. When the threshold is met the panel says so: "Commit `understanding/<branch>.json` and push".
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
      "attempts": [
        { "answer": "…", "at": "…", "by": { "name": "…", "email": "…" },   // "by" only when not answeredBy
          "verdict": "pass" | "retry" | "explained", "feedback": "…", "hint": "…", "gradedAt": "…",
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

## Belongs to this change? (staleness)

CI computes the diff from `head` to the merge request's head, ignoring `understanding/` and what never counts as
changed lines (docs: `*.md`, `docs/`; lockfiles; `.code-notes/`). If ≤ `maxDrift`
changed lines (default 40) → still valid. Otherwise: "Your change grew by N lines since the check. Run
*Check my understanding* again: it adds 1–2 questions about the new part only" (top-up, appended to the
same file, earlier answers kept).

When `head` is not in the clone (rebased or squashed branch, or a shallow clone), CI compares sizes instead: the
change's counted lines now against `diffStat`. Lenient, but a rebase must not void the check. CI jobs fetch the full
history (`GIT_DEPTH: 0`, `fetch-depth: 0`).

## CLI (one file, Node ≥ 18, no dependencies): `understanding.mjs`

Shipped in the repo (and inside the vsix) so CI can run it with `node`:

| Command | |
|---|---|
| `status [--json]` | which file, valid for this change?, answered/passed counts, what to do next |
| `validate <file>` | schema + anchors check (used by the skill's script and by CI) |
| `grade <file> [--question q2] [--answer "…"] [--write]` | grade answers with the configured backend (`--answer` adds an attempt first) |
| `ci` | the CI job: find file → check drift → check completeness + recorded verdicts vs threshold + attempt hashes → exit 0/1 with a short reason → optional MR comment. Never calls a model. Exit 2: it can't check (commits missing, API error). |

`ci` rules, in order: under `minChangedLines` → pass. Skip label (read fresh from the API when there is a token: a
re-run job keeps its pipeline's old variables) → pass only with an approval by someone other than the author. No
file / invalid file / drift / a graded attempt whose hash doesn't match → fail with what to do. Any question not
answered or not graded → fail. A question left at "try again" counts as missed (never stuck on one). Passed ≥
`ceil(passRatio × total)` → pass. The merge request comment (questions, last answers, states) is found again by the
marker `<!-- understanding-check -->` and updated in place.

The skill's script (`skills/understanding-check/scripts/questions.mjs`: `start`, `add`, `list`, `remove`,
`finish`) imports the CLI as a module, as the extension does, so the rules live in one place. `add` refuses
questions that are not near a changed line, longer than 240 characters, more than one question, or that name a line
number; `finish` wants 3–5 questions (1–2 for a top-up) of at least two kinds, one of them why/failure/edge.

Grading runs only locally (extension, or `grade` from a terminal). Grader backends: `claude` (the `claude -p` CLI, read-only tools, uses `CLAUDE_CODE_OAUTH_TOKEN` or the
logged-in user) or `anthropic` (Messages API with `ANTHROPIC_API_KEY`). The grader gets the question, the
answer, the diff and may read the code; it returns JSON `{verdict, feedback, hint}`.

## Config: `understanding/config.json` (optional, committed)

```jsonc
{ "questions": { "min": 3, "max": 5 }, "minChangedLines": 20, "passRatio": 0.6, "maxDrift": 40,
  "skipLabel": "skip-understanding", "model": null, "backend": null, "mrComment": true }
```

`backend` (`claude` | `anthropic`) and `model` apply to `grade` from a terminal (also `--backend`, `--model`,
`UNDERSTANDING_BACKEND`). In VS Code, the Claude Code runner grades (setting `codeNotes.understanding.model`).
Questions per change: 3 under 80 changed lines, 4 under 300, else 5 (within `questions.min`/`max`).

## Skipping

Small changes (< `minChangedLines`, docs-only, lockfiles) pass automatically. Otherwise: add the label
`skip-understanding` to the merge request; the job then passes only once someone other than the author has
approved the merge request (GitLab approvals API; GitHub reviews API), with a message saying exactly that.
The job does not re-run by itself on approval: the message says to re-run it (prototype limitation).

## CI recipes (in the README)

GitLab: a job on `merge_request_event` with plain `node` (no LLM CLI, no model key); `GITLAB_TOKEN` (project token,
`api` scope) for labels/approvals/comment. GitHub Actions: same CLI, `GITHUB_TOKEN`.

## Out of scope for the prototype

Server-side storage, analytics on pass rates, per-team question banks, languages other than English.
