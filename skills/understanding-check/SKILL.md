---
name: understanding-check
description: >-
  Writes the questions of an UNDERSTANDING CHECK for the current branch: 1-5 short questions (by the change's size)
  about the author's own change (how a part behaves, why it is built this way, how it fails, an edge case), each anchored on the changed
  lines it is about, written to understanding/<branch>.json with the bundled script. The author answers them next to
  the code (Code Notes in VS Code) and a grader checks the answers. Use when asked to "check my understanding",
  write understanding-check questions, or top up a check after the change grew.
---

# Understanding check: writing the questions

**Goal.** The author is about to merge a change, often written with an AI agent. Ask the few questions a sharp
senior colleague would ask in review to find out whether the author really owns this code. Answering takes about
5 minutes in total, 1-3 sentences each. It must feel like help, not an exam: a good question makes the author look
at something they would otherwise have skipped.

Write only through `scripts/questions.mjs` (never write the JSON by hand); read every line it prints and fix each
`PROBLEM`. Run it by its full path, one command per call: no shell variables, no `&&` or pipes.

## Procedure

1. `questions.mjs start` (or `start --top-up` when asked to top up an existing check). It prints the change with the
   new file's line numbers and how many questions to write (1 for a small change, up to 5 for a big one; write that
   many). `NOTHING` or `UNCOMMITTED`: write nothing, reply with that one line. `REMOVED ONLY`: the change only removes
   code; ask what the removal changes (what still used it, what now happens instead), on the lines where it was removed
   or on the code that used it (any file). `RENAMED ONLY`: one question about what the move changes, `--whole-file`.
2. Read the diff. Open the changed files (Read) where the diff alone doesn't show what the code does, and the code
   that calls the changed functions. Find the places that matter most: where the behaviour is decided, where it can
   fail, what is new.
3. Pick the questions (rules below), then add each one:
   `questions.mjs add --kind failure --file api/orders.js --lines 12-18 --text "…?"`
   Use `--whole-file` (no lines) only for a question about the design of a whole file.
   When the answer depends on code the change did NOT touch (the loop that retries a failing handler, the
   constraint that rejects a duplicate, the caller that ignores an error), add it: `--also worker/queue.js:84-96`
   (up to 3, comma-separated). It is shown beside the question, so the author knows where to look.
   Name code in the question by what it is ("the catch block in `tick()`", "the INSERT"), never by line number, and
   link those words to their lines: `--links "the catch block in tick()@worker/queue.js:88-96"` (up to 3,
   `;`-separated; the phrase exactly as in the text). The author clicks the phrase to see the code. A phrase linked
   to an `--also` range is all the pointer that range needs.
   When the honest answer to a question is "this is a bug" (the code really does lose data, double-charge, race,
   skip a check), still ask it neutrally and add `--suspect`: once they have answered, the author is offered a fix. Only
   when you read the code and are confident; never as a trick.
4. `questions.mjs finish`. It writes `understanding/<branch>.json`. Reply with one line per question, nothing more.

## What makes a good question

- **About this change, answerable from it.** It names the function, value or case it is about, so it makes sense
  on its own next to its lines. The answer is in the code (and its obvious callers), not in someone's head.
- **Answerable in 1-3 sentences.** One question, one point, under ~140 characters. "…, and could the customer …?"
  is two questions, and "what happens to the row, the counters and the job?" is three: keep the one that matters.
- **About code, never comments.** Ask about what the code does, not what a comment claims ("finance audits this
  monthly" is not a requirement). Lines that hold only comments or blank lines can't carry a question.
- **Mixed kinds** (from 3 questions on): at least one `failure` or `edge`, and one `why` when the change makes a design choice (it
  almost always does: a limit, an order of operations, where something is stored, what is retried):
  - `failure`: "What happens to the order when the payment client times out after the order was stored?"
  - `edge`: "What does `applyDiscount` return when the same code is applied twice to one cart?"
  - `why`: "Why does the worker re-read the order before charging instead of using the job's copy?"
  - `how`: "How does a settled order stop a second charge for the same job?" (behaviour, not a line-by-line read)
  - `change`: "Which callers of `insertOrder` get a different result after this change?"
- **Anchored on the lines that answer it** (`--lines`): the decision, the check, the catch, not the whole function.
  At most ~15 lines when you can.
- **At most one computed value.** "What does `rule59` return for a 200-cent item at qty 61?" is a calculator drill
  unless it says why it matters: ask it once at most, and say what is at stake ("… is that a valid price?"). Prefer why,
  failure and edge questions.
- **Prefer what the author is most likely to have skipped**: error paths, retries, ordering between two writes,
  what is shared between requests, limits, what happens with empty or duplicate input, a default that changed.

## Never

- Trivia or reading aloud: "What does line 12 do?", "What is the name of …?", "Which file defines …?".
- Questions whose answer is in a comment right next to the lines, or in the question itself.
- Yes/no questions, opinion questions ("Is this a good design?"), or questions about code the change didn't touch.
- Hints of the answer in the question. Answers are never stored: the grader judges each answer against the code.

## The tour (when asked to write it)

After the questions, the author can walk a short **journey of the change** and click their way to each answer
instead of reading the code cold. Write it only when the request asks for the tour.

1. `questions.mjs tour` (`tour --top-up` when topping up). It prints the questions, the changed lines and the exact
   `journey.py` path and `--dir` to use (always that `--dir`; the slug is `tour`).
2. Write the journey with `journey.py` (the code-journey skill's script; `journey.py help <command>` gives its rules):
   - **6-10 steps** through the changed code AND the unchanged code it depends on (the caller, the table, the retry
     loop), in the order a request or the data actually flows. A top-up adds 1-4 steps after the last one, about
     the new part only; never change the earlier steps.
   - `new <repo> tour "<question>" "<title>" --dir … < summary`: the question one developer would ask about this
     change ("What happens when a shopper asks for a refund?"), a short topic title ("Refunds"), a 2-sentence summary.
   - A small map: 1-3 `system` boxes (reuse the names of the repo's journeys in `journeys/` when there are some), a
     `function` box per function a step is in (`range` prints its lines), and an `edge` for each hop between them.
   - Each `step`: a title that is one fact (≤ 70 chars), a lead of one plain sentence (≤ 25 words), lines that make
     the title true (≤ 15). Details and refs only where they save a click.
   - **Each question's answer must be visible by its step**: a step up to it shows the question's lines (or the code
     it depends on). Order the steps so the questions come along the way, not all at the end.
   - **Show the way to an answer, never the answer**: the steps state what the code does, one fact each; the author
     puts two facts together to answer. A title or lead that says what a question asks for ("so a failed refund is
     not listed", "so a restart loses the job") gives it away: cut that clause.
   - Then 1-3 `link`s per step (a phrase of the lead to the lines doing it). No `value`, no `scene`.
   - `check <repo> tour quiet --dir …`: fix every PROBLEM and WARNING it prints.
3. `questions.mjs tour-finish --steps q1=3,q2=5,…`: for each question, the step after which its answer can be seen.
   Reply with the step titles, one per line.

## Top-up

`start --top-up` lists the NEW LINES of the branch's own change since the questions were written (code merged in
from the target branch is never among them). Add 1-2 questions about those lines only (the earlier questions and
answers stay), then `finish`.
