---
name: code-journey
description: >-
  Answers "how does X work?" / "how do we Y?" about a codebase as a CODE JOURNEY: a small layered map (system →
  module → function, never more than 7 boxes per level) plus a storyline of 6-14 steps through the real code, each
  step a one-line fact anchored on the exact lines (the user's VS Code extension, Code Notes, shows the map, the
  storyline and a tour). Use when the user asks for a journey, a tour, a walkthrough, "explain how … works end to
  end", or wants to understand an AI-written area of the code without reading it all. Steps get code links,
  value hints and short step animations. Every claim points at code; nothing is invented.
---

# Code journey

**Goal.** One question about the code, answered by a path through it, for a developer who did not write that code
and must not be overwhelmed. They see a map and, beside it, the storyline (the numbered step titles). **Map +
storyline answer the question without opening a step.** The rest is opt-in: cut it. Every claim was seen in code.

One file per journey, `<repo>/journeys/<slug>.json`, written only through `journey.py` (never by hand). Journeys
are **committed and reviewed in PRs like code**: a change that makes a step false updates the journey in the same PR.
**`journey.py` refuses or flags everything not listed here (lengths, counts, ranges, jumps in the path, stale
anchors, near-duplicate journeys): read its messages** after every write; fix each `PROBLEM` and `WARNING`.

## Procedure

1. **Find the start and the end**: what the person does (button, CLI command, API route) and the visible result.
2. **Trace the path** through the real code, into other services too (HTTP client → handler, queued job → its
   worker). Note every asynchronous hop and every place a failure is reported.
3. **Write the storyline first**: 6-14 titles, the happy path to the result, then at most 2-3 "If … fails" titles.
4. **Self-test**: answer 4-5 reader questions (what starts it, who does the work, what is asynchronous, how do we
   know it is done, where does a failure show) from titles and box blurbs only; rewrite until you can.
5. **Build the map** top-down (`new`, `node`, `edge`): 3-6 systems, the modules crossed, a function box per step.
6. **Write each step** (`step`), then `check`: no PROBLEM, no WARNING; read the ref lines it prints.
7. **Then, step by step: links, a scene, values** (`link`, `scene`, `value`; rules below), and `check` again.
8. Reply with the storyline and the 2-3 most surprising things found.

## Writing rules

1. **A title is a fact**: subject + verb, positive, active. "The API only stores a pending order", not "What
   the request carries" or "The worker".
2. **One fact per title, with its unit**: "The worker polls the queue every 2 s". The second fact goes in the
   lead. Say who acts, what polls what, how often.
3. **Each title is a new event**: merge one that restates the step before; a background fact goes in details.
4. **Happy path first, in one go**: top to bottom the titles tell the run where everything works. Failures go in
   the details of the step that detects them, or after the last happy step ("If the payment fails, …").
5. **The gotcha is a title**: "If the card is slow, the page stops waiting at 30 s; the worker retries".
6. **Absolute claims name their subject**: "The API never charges the card", not "The shop never …". Before writing
   never/only/always, grep every binary for the counter-example. A title that needs a footnote to stay true is the
   wrong title: rewrite it ("The worker charges the card once"); never walk it back in the details.
7. **The lead is one sentence, ≤ 25 plain words**: the one reason, consequence or number the title lacks. Never the
   title again, never a second fact: that goes in details.
8. **Details are few**: gotchas, defaults, the fork not followed; no asides off the path, no bullet that defends
   the title. Name code by symbol (`runContext`, "the lookup above"); `path:line` goes only in refs (≤ 3). A ref
   points **elsewhere** (another function or file), never inside the step's own range or within 20 lines of it: that
   code is already on screen. Name a step by its title, not "step 7".
9. **A ref is one sentence saying what the reader will see there, with the path:line in it**: "The 30 s retry
   delay is set in worker/src/queue.ts:42." One `path:line` (or `path:a-b`) per ref, full path, ≤ 15
   words; read the lines first.
10. **Uncertainty has one form**: a last details line `Not verified: <what was not read>.`, one short line with no
   explanation after it. Otherwise neutral voice.
11. **Summary**: ≤ 2 plain sentences, the answer, main path first. **Question**: one natural question. **Title**:
    a topic, subject first ("Checkout flow"). People are named by what they do ("whoever places the order").

## Map

- `system` (a running part: web app, API, database, a worker) › `module` (a package) › `function` (the whole function);
  `external` = third-party code.
- **A step marks ≤ 15 lines**: the lines that make its title true (the call, the branch, the value that orders the
  work), not the whole function (that is the box) and not the code that detects the failure (that is in details).
- **One name per system, in every journey**: read the labels of this repo's existing journeys first and reuse them
  (a shop's journeys all say `Web app`, `API`, `Database`, `Worker`, never "Frontend" in one and "Web app" in the
  next). Likewise for modules (`Orders`, `Payments`). With no journey yet, pick short plain names and keep them.
- **A blurb says what the box is** ("Background loop that charges queued orders"), never what a title on the
  same screen says happens, and has no arrows or brackets. **One blurb per system, in every journey**: copy it from
  the existing journeys (`check` prints it). An `external` box does not say "third-party" or "outside" again.
- **Labels and blurbs are words, not code**: no URL template or path, HTTP verb, protocol name ("SSE", "JSON-RPC"),
  port, CLI syntax (`<file>`, flags) or "->". Write "place order", "live updates", "create order"; the syntax is in
  the code the step opens. A label names one thing: no rule ("only this shopper's cart"), no "…, sent back later".
- **The question's subject is on the path, first**: "How does a coding agent …" starts with a step in the
  `Coding agent` system (an `external` box in it), not with a grey side box.
- **`store`** = the app's **own** record, queue or table that two parts meet through ("Order record"). It
  never acts and may hold no step: both parts get an edge **to** it, never an arrow from one to the other.
- **Labels ≤ 20 chars where possible** ("API", "Worker"), never a path, no brackets or slashes; the rest goes in
  the blurb.
- Edge: `from` is the side that **acts** (poller → polled, "polls every 2 s"); the label is the fewest words that say
  how ("place order", "push"), never "calls", never the name of the box it points at; `async` when it is not a call
  (poll, watch, queue). Only calls and later events get an edge: shared code is a phrase in details.

## Links, values, scenes

Each step gets **3-6 code links** and **2-6 value hints** where something is worth showing, and a **scene** (a few
beats played in the panel, each lighting one line) where a picture adds something: a request crossing parts, a record
changing state, a worker starting. No scene for pure configuration or a list of rules.

1. **Link** = exact words of the lead or details (outside backticks), read as "this part", to the 1-8 lines doing
   it; never the step's own range. One in the lead when it names something concrete.
2. **Value** = what a variable on that line holds in the example run (`order` = `ord_7f3a… (pending)`, ≤ 40 chars);
   the note says what it IS ("the pending order"), never the code again. Within 25 lines of the step, or by a beat/link.
3. **Scene**: 3-6 beats, one thing each, none an earlier step showed; ≤ 4 actors, one per part touched.
4. **`focus`** = the actor whose line the beat lights, or the object that line changes when the change would
   otherwise be invisible. Never "all".
5. **`code`** = the line that DOES the caption (the call, the assignment, the check): never a signature, comment or
   closing brace; near the step's lines. A beat with no line in the repo (a provider, a person) is rare, never two
   in a row.
6. **Caption**: one plain present-tense sentence, < 60 chars, read in three seconds; `muted`: an optional short
   second clause. Only words the step text uses.
7. **One example story per journey**: the same ids, person ("Ana" at "Lamp & Co"), times in every step and value; reuse
   the names, actor ids and labels of the repo's finished journeys (read one scene first): the same part is always
   the same actor id and label (`api` "API"), a table is labelled by its collection with sub "database".
8. **Nothing invented**: the script reads every line; terminal lines are what the code prints (shortened).

| Actor `type` | Draws | Fields (all: `id`, `col` 0-3 left to right, same `col` stacks; `label`, `sub`) | A beat's `set` |
|---|---|---|---|
| `service` | code at work | `fn` "name()" ≤ 28; `checks` ≤ 5, each ≤ 28 chars | `done`: ticks |
| `table` | a database collection, nothing else | `rows` ≤ 3: `{id, chips: [..], old?}` (old = there before) | `show` new rows, `hi` row (-1 none), `chips` `{i: [..]}` |
| `file` | a file, folder listing or document | `lines` ≤ 34 chars (30 with `from`: the first line's number), 8 in view | `show` n (all if unset), `hi` i or [a, b], `text` `{i: "now"}` |
| `cluster` | a namespace, its pods | `pods`: `{label, note?, madeNote?, goneNote?, ghost?}`; `inner` (a cluster inside it): `{label, sub, ghost?, pods}` | `made` [i], `gone` [i], `mark` i, `inner` true, `innerMade`, `innerGone`, `innerMark` |
| `terminal` | a command and its output | `lines` ≤ 36 chars, "$ " = a command | `show` lines so far (first beat sets it), `hi` i |
| `chat` | a person and a model, an agent and its tools | `messages` `{from: me\|them, text ≤ 38, tool?}` (tool ≤ 32), 4 in view | `show` n (first beat sets it), `hi` i |
| `queue` | a bus, channel or work queue | `slots` (≤ 8 drawn), `cap` "256 events per subscriber" | `fill` n, `drop` true, `note` ≤ 44 |
| `gauge` | a limit and how much is taken | `max`, `unit`, `used` | `used`, `want` (red when it does not fit), `note` ≤ 44 |
| `app` (older name `console`) | a web app's window, drawn dark: `dialog` (a list page with a dialog over it), `detail`, `signin`, or a page of `pages` | `brand` (default "App"), `logo` 1-2 letters, `tabs` ≤ 3 (each ≤ 10; brand and tabs share the top bar), `screen`; `dialog` `{tab, title ≤ 24, item ≤ 24, lines ≤ 2 [label ≤ 12, value ≤ 18], button ≤ 18}`; `detail` `{tab, title ≤ 22, status ≤ 12 (title + status ≤ 30), tone neutral\|active\|good\|bad, empty, cards ≤ 2 {sev low\|medium\|high\|critical, title ≤ 32}, timeline (rows ≤ 36), picture ≤ 38, placeholder, chat {from: me\|them, text ≤ 32}}`; `signin` `{title ≤ 22, notice ≤ 40, provider ≤ 10, button}`; `pages` `{name: {tab, title, chip?, tone?, banner? ≤ 38, rows ≤ 4 [label ≤ 12, value ≤ 20], button?}}` (rows + banner + button ≤ 4) | `screen`, `status`, `tone`, `cards` n, `events` n, `newCard`, `newEvent`, `pane` picture\|chat, `picture`, `chat` n, `newChat`, `typing`, `rows`, `hiRow`, `banner`, `busy`, `notice`, `redirecting`; beat `click`: true (presses the shown screen's button) |
| `browser` | a web page (a small shop) | `url` ≤ 32, `title` ≤ 20 (default "Shop"), `cart` ≤ 10 (title + cart ≤ 26), `products` 2, each ≤ 14, `button` ≤ 13 (default "Add to cart"), `markLabel` ≤ 18, `lock` ok\|warn | `click`, `mark`, `lock`; beat `click`/`flash`: its id |

A terminal wherever a person or script runs a command and reads its output (a CLI, a build or deploy script, a CI log); a chat for a
conversation (a person and a model, a coding agent and the tools it calls); a queue for an in-memory bus or work queue
filling up; a gauge for a limit and its use (slots, memory budget, quota); an `inner` cluster where something runs
inside another (a virtual cluster in a namespace). **A table is only a database collection; a file, folder listing or
document is a `file`.** An app screen or page shows only what that page of the real app shows (read its view code). Older journeys' screen
names `run-dialog`, `run-page`, `login`, flat fields (`test`, `env`, `status`, `findings`, `timeline`, `chat`,
`provider`) and set keys (`findings`, `newFinding`, `ended`, `desktop`, pane `desktop`) still work. Beat:
`focus`, `caption`, `muted?`, `set?`, `packet?` `{from, to, label}` (needs a wire), `code` `{file, line}` (the script
adds the text). Example, `$J scene … 4 <<'EOF'`:

```json
{"actors": [{"id": "api", "type": "service", "col": 0, "label": "API", "sub": "orders", "fn": "createOrder()",
             "checks": ["refuse an empty cart", "store the order", "queue the job"]},
            {"id": "orders", "type": "table", "col": 1, "label": "orders", "sub": "database", "rows": [{"id": "ord_7f3a…", "chips": ["pending"]}]}],
 "wires": [["api", "orders"]],
 "beats": [{"focus": "api", "caption": "The API refuses an empty cart.", "muted": "The page shows the error.",
            "set": {"api": {"done": 1}}, "code": {"file": "api/orders.js", "line": 7}},
           {"focus": "orders", "caption": "The order is stored as pending.", "set": {"api": {"done": 2}, "orders": {"show": 1, "hi": 0}},
            "packet": {"from": "api", "to": "orders", "label": "insert"}, "code": {"file": "api/orders.js", "line": 10}},
           {"focus": "api", "caption": "A job for the worker is queued.", "muted": "Nothing is charged yet.",
            "set": {"api": {"done": 3}}, "code": {"file": "api/orders.js", "line": 11}}]}
```

## Commands

`J=.claude/skills/code-journey/scripts/journey.py` (in the repo; alone: the commands; `$J help <command>`: its arguments and rules). Exit 1 = PROBLEM or refused
write. Journeys are read from `<repo>/journeys/` (`.code-notes/journeys/` when only that exists; `--dir` overrides).

| Command | Does |
|---|---|
| `$J new <repo> <slug> "<question>" "<title>" < summary` | starts the journey |
| `$J node <repo> <slug> <id> <kind> "<label>" [parent] [file:a-b] --blurb "…" [--path dir] < tooltip` | adds a box |
| `$J edge <repo> <slug> <from> <to> "<label>" async|sync ["<detail>"]` | adds a hop |
| `$J range <repo> <file> <symbol\|Class.method\|line>` | prints the function's `file:start-end` |
| `$J step <repo> <slug> <node> <file> <a> <b> "<title>" [after N] < text` | adds a step; text = lead, blank line, details, then `refs:` and one ref sentence per line |
| `$J check <repo> <slug> [quiet\|story\|refs\|fix]` | validates; `fix` repoints code (and box paths, links, values, beats) that only moved; code that **changed** or is **gone** is a PROBLEM |
| `$J migrate-anchors <repo> <slug>\|--all` | rewrites old full-text anchors as compact ones (first 3 / last 2 lines + hash) |
| `$J restep <repo> <slug> N title\|lead\|details\|refs\|node <v>`, `restep … N range <file> <a> <b>` | changes one field (`-` = stdin; refs: one sentence per line, or ` \| ` between them) |
| `$J mvstep … N after M`, `rmstep … N` | moves / removes a step; ids are kept, so never remove and re-add |
| `$J link <repo> <slug> N "<phrase>" <file> <a> [b]` | links a phrase of step N's text to those lines (same phrase: replaces) |
| `$J value <repo> <slug> N <name> "<value>" <file> <line> ["<note>"]` | a value hint above that line (same name and line: replaces) |
| `$J scene <repo> <slug> N <<'EOF'` … `EOF` | sets step N's scene from the JSON (replaces it) |
| `$J rmlink … N "<phrase>"`, `rmvalue … N <name> [line]`, `rmscene … N` | removes one |
| `$J set … <node> label\|blurb\|path\|kind\|at\|parent <v>`, `rmnode`, `setedge`, `rmedge`, `meta … title\|question\|summary <v>`, `meta … start true` (the journey to open first), `restore` | changes the map, the journey fields; puts back the last good copy |

## Notes on a step

"Ask about this step" and "Ask the agent to update this step" write a normal note in `<repo>/.code-notes/` with
`"journey": {"id": "<slug>", "step": "<step id>", "n": 4}`: find them with `grep -l '"journey"'`, status `open`, last
message from a human. The step is the one with that **id** (`check … story` prints ids); `n` may be out of date.

- **A question**: read the step and its code, answer on the note (append an agent message, see
  `.code-notes/README.md`), leave it open. If the answer shows the step is wrong or unclear, `restep` it and say so.
- **An update request**: read the code as it is now (the note's `anchor.text` is what the step was written on);
  `check … fix` if it only moved. If `check` says the code **changed**, it shows where it is now and the changed
  lines: re-verify the title and lead against them, `restep` the facts that are no longer true, then the range;
  `rmstep` if the code is gone. Run
  `check`, then in one write: a message saying what changed, `"status": "resolved"`, the `resolved` event.
- Apart from these, don't touch the user's notes. Don't edit code.
