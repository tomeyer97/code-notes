---
name: understanding-check
description: >-
  Writes the questions of an UNDERSTANDING CHECK for the current branch: 3-5 short questions about the author's own
  change (how a part behaves, why it is built this way, how it fails, an edge case), each anchored on the changed
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
   new file's line numbers and how many questions to write. `SMALL`, `NOTHING` or `UNCOMMITTED`: write nothing,
   reply with that one line.
2. Read the diff. Open the changed files (Read) where the diff alone doesn't show what the code does, and the code
   that calls the changed functions. Find the 3-5 places that matter most: where the behaviour is decided, where
   it can fail, what is new.
3. Pick the questions (rules below), then add each one:
   `questions.mjs add --kind failure --file api/orders.js --lines 12-18 --text "…?"`
   Use `--whole-file` (no lines) only for a question about the design of a whole file.
4. `questions.mjs finish`. It writes `understanding/<branch>.json`. Reply with one line per question, nothing more.

## What makes a good question

- **About this change, answerable from it.** It names the function, value or case it is about, so it makes sense
  on its own next to its lines. The answer is in the code (and its obvious callers), not in someone's head.
- **Answerable in 1-3 sentences.** One question, one point. No lists, no "and also".
- **Mixed kinds**, at least one `why`, `failure` or `edge`:
  - `failure`: "What happens to the order when the payment client times out after the order was stored?"
  - `edge`: "What does `applyDiscount` return when the same code is applied twice to one cart?"
  - `why`: "Why does the worker re-read the order before charging instead of using the job's copy?"
  - `how`: "How does a settled order stop a second charge for the same job?" (behaviour, not a line-by-line read)
  - `change`: "Which callers of `insertOrder` see a different result after this change, and how?"
- **Anchored on the lines that answer it** (`--lines`): the decision, the check, the catch, not the whole function.
  At most ~15 lines when you can.
- **Prefer what the author is most likely to have skipped**: error paths, retries, ordering between two writes,
  what is shared between requests, limits, what happens with empty or duplicate input, a default that changed.

## Never

- Trivia or reading aloud: "What does line 12 do?", "What is the name of …?", "Which file defines …?".
- Questions whose answer is in a comment right next to the lines, or in the question itself.
- Yes/no questions, opinion questions ("Is this a good design?"), or questions about code the change didn't touch.
- Hints of the answer in the question. Answers are never stored: the grader judges each answer against the code.

## Top-up

`start --top-up` shows only what changed since the questions were written. Add 1-2 questions about those new
lines only (the earlier questions and answers stay), then `finish`.
