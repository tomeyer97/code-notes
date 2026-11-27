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
anchors, near-duplicate journeys): read its messages** after every write; fix each `PROBLEM` and `WARNING`. Its
numbers are in [Limits](#limits).

Rules marked *(style)* are this skill's house style: `journey.py` does not check them, and a project adopting the
skill may change them. The others are the tool's: it refuses or warns.

## Procedure

1. **Find the start and the end**: what the person does (button, CLI command, API route) and the visible result.
2. **Trace the path** through the real code, into other services too (HTTP client → handler, queued job → its
   worker). Note every asynchronous hop and every place a failure is reported.
3. **Write the storyline first**: the titles of the happy path to the result, then at most 2-3 "If … fails" titles.
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
3. **Each title is a new event**: merge one that restates the step before; a background fact goes in details. *(style)*
4. **Happy path first, in one go**: top to bottom the titles tell the run where everything works. Failures go in
   the details of the step that detects them, or after the last happy step ("If the payment fails, …"). *(style)*
5. **The gotcha is a title**: "If the card is slow, the page stops waiting at 30 s; the worker retries". *(style)*
6. **Absolute claims name their subject**: "The API never charges the card", not "The shop never …". Before writing
   never/only/always, grep every binary for the counter-example. A title that needs a footnote to stay true is the
   wrong title: rewrite it ("The worker charges the card once"); never walk it back in the details. *(style)*
7. **The lead is one short sentence in plain words**: the one reason, consequence or number the title lacks. Never
   the title again, never a second fact: that goes in details.
8. **Details are few**: gotchas, defaults, the fork not followed; no asides off the path, no bullet that defends
   the title. Name code by symbol (`runContext`, "the lookup above"); `path:line` goes only in refs (a few). A ref
   points **elsewhere** (another function or file), never inside or near the step's own range: that code is
   already on screen. Name a step by its title, not "step 7".
9. **A ref is one short sentence saying what the reader will see there, with the path:line in it**: "The 30 s
   retry delay is set in worker/src/queue.ts:42." One `path:line` (or `path:a-b`) per ref, full path; read the
   lines first.
10. **Uncertainty has one form**: a last details line `Not verified: <what was not read>.`, one short line with no
   explanation after it. Otherwise neutral voice. *(style)*
11. **Summary**: one or two plain sentences, the answer, main path first. **Question**: one natural question.
    **Title**: a topic, subject first ("Checkout flow"). People are named by what they do ("whoever places the
    order") *(style)*.

## Map

- `system` (a running part: web app, API, database, a worker) › `module` (a package) › `function` (the whole function);
  `external` = third-party code.
- **A step marks a few lines**: the lines that make its title true (the call, the branch, the value that orders the
  work), not the whole function (that is the box) and not the code that detects the failure (that is in details).
- **One name per system, in every journey**: read the labels of this repo's existing journeys first and reuse them
  (a shop's journeys all say `Web app`, `API`, `Database`, `Worker`, never "Frontend" in one and "Web app" in the
  next). Likewise for modules (`Orders`, `Payments`). With no journey yet, pick short plain names and keep them.
  *(style)*
- **A blurb says what the box is** ("Background loop that charges queued orders"), never what a title on the
  same screen says happens, and has no arrows or brackets. **One blurb per system, in every journey**: copy it from
  the existing journeys (`check` prints it). An `external` box does not say "third-party" or "outside" again. *(style)*
- **Labels and blurbs are words, not code**: no URL template or path, HTTP verb, protocol name ("SSE", "JSON-RPC"),
  port, CLI syntax (`<file>`, flags) or "->". Write "place order", "live updates", "create order"; the syntax is in
  the code the step opens. A label names one thing: no rule ("only this shopper's cart"), no "…, sent back later".
- **The question's subject is on the path, first**: "How does a coding agent …" starts with a step in the
  `Coding agent` system (an `external` box in it), not with a grey side box. *(style)*
- **`store`** = the app's **own** record, queue or table that two parts meet through ("Order record"). It
  never acts and may hold no step: both parts get an edge **to** it, never an arrow from one to the other.
- **Labels are short** ("API", "Worker"), never a path, no brackets or slashes; the rest goes in the blurb.
- Edge: `from` is the side that **acts** (poller → polled, "polls every 2 s"); the label is the fewest words that say
  how ("place order", "push"), never "calls", never the name of the box it points at; `async` when it is not a call
  (poll, watch, queue). Only calls and later events get an edge: shared code is a phrase in details.

## Links, values, marks, scenes

Each step gets **3-6 code links** and **2-6 value hints** where something is worth showing, **marks** where its point
is a part of a line, and a **scene** (a few beats played in the panel, each lighting one line) where a picture adds
something: a request crossing parts, a record changing state, a worker starting. No scene for pure configuration or a
list of rules.

1. **Link** = exact words of the lead or details (outside backticks), read as "this part", to the few lines doing
   it; never the step's own range. One in the lead when it names something concrete.
2. **Value** = what a variable on that line holds in the example run (`order` = `ord_7f3a… (pending)`, short); the
   note says what it IS ("the pending order"), never the code again. Near the step's lines, or by a beat or link.
3. **Scene**: a few beats, one thing each, none an earlier step showed; a few actors, one per part touched.
4. **`focus`** = the actor whose line the beat lights, or the object that line changes when the change would
   otherwise be invisible. Never "all".
5. **`code`** = the line that DOES the caption (the call, the assignment, the check): never a signature, comment or
   closing brace; near the step's lines. A beat with no line in the repo (a provider, a person) is rare, never two
   in a row.
6. **Caption**: one short plain present-tense sentence, read in three seconds; `muted`: an optional short second
   clause. Only words the step text uses.
7. **One example story per journey**: the same ids, person ("Ana" at "Lamp & Co"), times in every step and value;
   reuse the names, actor ids and labels of the repo's finished journeys (read one scene first): the same part is
   always the same actor id and label (`api` "API"), a table is labelled by its collection with sub "database".
   *(style)*
8. **Nothing invented**: the script reads every line; terminal lines are what the code prints (shortened).
9. **Mark the part, not the line**: when a step's or beat's point is ONE call, argument, condition or field, mark
   just those characters (`$J mark … N <file> <line> "<match>"`, a beat `N.B`, or `"marks"` in the beat's JSON).
   The reader's eye goes straight to `total <= 0`, not to a line of `if (…) throw …`; the step's lines then only get a
   thin bar. Sparse: a few per step or beat, only what its text (a beat: its caption) names, never the whole line or
   the whole range. A step about a whole block gets none. Preview with `$J marks <repo> <slug> [N]`.

**Which actor**: a `service` for code at work; a `table` only for a database collection (a file, folder listing or
document is a `file`); a `terminal` wherever a person or script runs a command and reads its output (a CLI, a build or
deploy script, a CI log); a `chat` for a conversation (a person and a model, a coding agent and the tools it calls); a
`queue` for an in-memory bus or work queue filling up; a `gauge` for a limit and its use (slots, memory budget,
quota); a `cluster` for a namespace and its pods, with an `inner` cluster where something runs inside another; an
`app` for a web app's window and a `browser` for a web page. An app screen or page shows only what that page of the
real app shows (read its view code). Each actor's fields, what a beat's `set` changes and how much text fits:
`$J help scene`. Example, `$J scene … 4 <<'EOF'`:

```json
{"actors": [{"id": "api", "type": "service", "col": 0, "label": "API", "sub": "orders", "fn": "createOrder()",
             "checks": ["refuse an empty cart", "store the order", "queue the job"]},
            {"id": "orders", "type": "table", "col": 1, "label": "orders", "sub": "database", "rows": [{"id": "ord_7f3a…", "chips": ["pending"]}]}],
 "wires": [["api", "orders"]],
 "beats": [{"focus": "api", "caption": "The API refuses an empty cart.", "muted": "The page shows the error.",
            "set": {"api": {"done": 1}}, "code": {"file": "api/orders.js", "line": 7}},
           {"focus": "orders", "caption": "The order is stored as pending.", "set": {"api": {"done": 2}, "orders": {"show": 1, "hi": 0}},
            "packet": {"from": "api", "to": "orders", "label": "insert"}, "code": {"file": "api/orders.js", "line": 10},
            "marks": [{"lines": [10, 10], "match": "status: 'pending'"}]},
           {"focus": "api", "caption": "A job for the worker is queued.", "muted": "Nothing is charged yet.",
            "set": {"api": {"done": 3}}, "code": {"file": "api/orders.js", "line": 11}}]}
```

## Commands

`J=.claude/skills/code-journey/scripts/journey.py` (in the repo). `$J help` lists every command, `$J help <command>`
gives its arguments and rules. Exit 1 = PROBLEM or refused write. Journeys are read from `<repo>/journeys/`
(`.code-notes/journeys/` when only that exists; `--dir` overrides). The ones the procedure uses:

| Command | Does |
|---|---|
| `$J new <repo> <slug> "<question>" "<title>" < summary` | starts the journey |
| `$J node <repo> <slug> <id> <kind> "<label>" [parent] [file:a-b] --blurb "…" [--path dir] < tooltip` | adds a box |
| `$J edge <repo> <slug> <from> <to> "<label>" [async\|sync] ["<detail>"]` | adds a hop |
| `$J range <repo> <file> <symbol\|Class.method\|line>` | prints the function's `file:start-end` |
| `$J step <repo> <slug> <node> <file> <a> <b> "<title>" [after N] < text` | adds a step; text = lead, blank line, details, then `refs:` and one ref sentence per line |
| `$J check <repo> <slug> [quiet\|story\|refs\|fix]` | validates; `fix` repoints code (and box paths, links, values, beats) that only moved; code that **changed** or is **gone** is a PROBLEM |
| `$J restep <repo> <slug> N <field> <value>` | changes one field of step N: `title`, `lead`, `details`, `refs`, `node`, or `range <file> <a> <b>` (`-` = stdin) |
| `$J link <repo> <slug> N "<phrase>" <file> <a> [b]` | links a phrase of step N's text to those lines (same phrase: replaces) |
| `$J value <repo> <slug> N <name> "<value>" <file> <line> ["<note>"]` | a value hint above that line (same name and line: replaces) |
| `$J scene <repo> <slug> N <<'EOF'` … `EOF` | sets step N's scene from the JSON (replaces it) |
| `$J mark <repo> <slug> N\|N.B <file> <a>[-b] ["<match>"] [nth]` | marks only `match` within those lines while step N (or its beat B) is open |
| `$J marks <repo> <slug> [N]` | prints every mark with `^^^` under what it lights, and its problems |
| `$J podcast <repo> <slug> [<audio seconds>]` | checks the journey's podcast |

The others (`$J help` lists them) remove, move and change things: steps (`rmstep`, `mvstep`, `stepnode`; a step
keeps its id, so never remove and re-add one), boxes and edges (`set`, `rmnode`, `setedge`, `rmedge`), the journey's
own fields (`meta`; `meta … start true` marks the journey to open first), links, values, scenes and marks (`rmlink`,
`rmvalue`, `rmscene`, `rmmark`), and the file (`restore` puts back the last good copy, `migrate-anchors` rewrites old
anchors).

## Podcasts

A journey may have an audio episode next to it: `journeys/<slug>.podcast.json` plus its audio file (format:
`docs/podcast-format.md` in the Code Notes extension, also on its GitHub page). The extension plays it and moves the
walk with the voice. Segments link to steps **by id** (`check … story` prints them) and to beats **by position**
(1-based), so a podcast must be checked again after `rmstep`, `scene` or `rmscene` on its journey. After writing or
editing one, run `$J podcast <repo> <slug> [<audio seconds>]` (`check` runs it too): fix every PROBLEM (the extension
won't play the file) and WARNING (a part points at a step or beat that isn't there, times overlap or run past the
audio). The audio goes inside `journeys/`, `audio` relative to the podcast file. Extra segment fields (`say`, the
spoken form) are ignored.

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

## Limits

What `journey.py` holds a journey to (`$J help limits` prints this table; a test keeps the two the same):

| What | Limit |
|---|---|
| Steps in a journey | 6-14 (`--steps A-B` for a short tour); `check`: PROBLEM |
| Question | <= 80 chars, one natural question; refused |
| Journey title | <= 28 chars, a topic name; refused |
| Summary | <= 2 plain sentences; `check`: PROBLEM |
| Step title | <= 70 chars; refused |
| Lead | one sentence, <= 25 words (WARNING); 40 refused |
| Lines a step marks | <= 15 (WARNING) |
| Refs of a step | <= 3 (`check`: PROBLEM), each <= 15 words (WARNING), not within 20 lines of the step (WARNING) |
| Box label | <= 20 chars (WARNING; not for a function box), 30 refused |
| Box blurb | <= 60 chars; refused |
| Boxes in one box | <= 7; refused |
| Edge label | <= 30 chars; refused |
| Link | 1-8 lines, WARNING over 15 |
| Value | <= 40 chars (refused), its note <= 60 (WARNING); within 25 lines of the step or 12 of a beat or link (WARNING) |
| Scene | 3-7 beats (7: WARNING), <= 4 actors; a caption <= 70 chars, with `muted` <= 110 (WARNING) |
| Marks | <= 3 per step or beat (WARNING) |
