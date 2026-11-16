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
3. The questions open as a journey of kind `check`: the storyline lists the questions with their status;
   clicking one opens its code with the question as a note thread on the exact lines (general/design
   questions are file-level threads on the most relevant file). The dev replies in the thread.
4. Each reply is graded (on submit, or "Grade my answers" for all): the grader replies in the same thread —
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
  "model": "…", "createdAt": "…",
  "questions": [
    {
      "id": "q1",
      "kind": "how" | "why" | "failure" | "edge" | "change",   // shown as a small label
      "text": "When two requests apply the same code at the same time, what stops it being used twice?",
      "file": "api/discounts.ts", "start": 40, "end": 58,       // 1-based lines; or "target": "file"
      "anchor": { … same compact anchor as journeys/notes, so it survives edits … },
      "attempts": [
        { "answer": "…", "at": "…", "verdict": "pass" | "retry" | "explained", "feedback": "…", "hint": "…" }
      ]
    }
  ],
  "result": { "passed": 3, "total": 4, "verdict": "pass", "gradedAt": "…" }   // informational only
}
```

The answers also show as note threads in the editor; the file is the source of truth (notes are a view).

## Belongs to this change? (staleness)

CI computes the diff from `head` to the merge request's head, ignoring `understanding/`. If ≤ `maxDrift`
changed lines (default 40) → still valid. Otherwise: "Your change grew by N lines since the check. Run
*Check my understanding* again: it adds 1–2 questions about the new part only" (top-up, appended to the
same file, earlier answers kept).

## CLI (one file, Node ≥ 18, no dependencies): `understanding.mjs`

Shipped in the repo (and inside the vsix) so CI can run it with `node`:

| Command | |
|---|---|
| `status [--json]` | which file, valid for this change?, answered/passed counts, what to do next |
| `validate <file>` | schema + anchors check (used by the skill's script and by CI) |
| `grade <file> [--question q2] [--write]` | grade answers with the configured backend |
| `ci` | the CI job: find file → check drift → check completeness + recorded verdicts vs threshold + attempt hashes → exit 0/1 with a short reason → optional MR comment. Never calls a model. |

Grading runs only locally (extension, or `grade` from a terminal). Grader backends: `claude` (the `claude -p` CLI, read-only tools, uses `CLAUDE_CODE_OAUTH_TOKEN` or the
logged-in user) or `anthropic` (Messages API with `ANTHROPIC_API_KEY`). The grader gets the question, the
answer, the diff and may read the code; it returns JSON `{verdict, feedback, hint}`.

## Config: `understanding/config.json` (optional, committed)

```jsonc
{ "questions": { "min": 3, "max": 5 }, "minChangedLines": 20, "passRatio": 0.6, "maxDrift": 40,
  "skipLabel": "skip-understanding", "model": null, "mrComment": true }
```

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
