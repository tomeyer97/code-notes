# Journey format v2

A journey step is not a note. A journey is one self-contained JSON file, committed to the repo and shared; notes stay
personal.

```jsonc
{
  "version": 2,
  "id": "place-order",
  "question": "What happens when a shopper places an order?",
  "title": "Placing an order",                             // ≤ 50 chars
  "summary": "Plain words, ≤ 2 sentences, no code in the first one.",
  "model": "<model name>",                                 // optional: who wrote it
  "commit": "609d0bb", "createdAt": "2026-11-11T16:01:33.000Z",
  "start": true,                                           // optional: the Journeys list marks it "Start here"
  "nodes": [ /* id, kind (system|module|external|store|function; `store`: see below), label ≤30, blurb ≤60, path?,
               summary, parent?, at? {file,start,end,anchor}, lane? ("main" | "side"; read but not used for layout,
               see "The whole map") */ ],
  "edges": [ /* from, to, label ≤30, async?, detail? */ ],
  "steps": [
    {
      "id": "pending-order",                                 // stable, short, unique in the journey (see below)
      "title": "The API only stores a pending order",        // a FACT, ≤ 70 chars: the storyline line
      "node": "create",                                      // the box it happens in (function, external or store)
      "file": "api/orders.js",
      "range": { "start": 10, "end": 12 },                   // the lines that matter
      "anchor": { "v": 3, "head": "…", "tail": "…", "lines": 3, "hash": "…", "before": "…", "after": "…" },
      "lead": "≤ 40 words, plain language: what happens here and why it matters.",
      "details": "optional markdown: the rest (gotchas, timeouts, why). Folded by default.",
      "refs": [                                              // ≤ 3; each ONE sentence with ONE path:line in it (see below)
        "The 30 s retry delay is set in worker/src/queue.ts:42.",
        "The order record's fields are in api/db.js:12-30."
      ],
      "links": [ /* { phrase, file, start, end, anchor }: a phrase of the lead or details linked to those lines */ ],
      "values": [ /* { name, value, file, line, text, note? }: a value hint above that line */ ],
      "scene": { /* the step's animation: actors, wires, beats (see "Step animations") */ }
    }
  ]
}
```

- Step number = position (1-based). No `n`, no note ids.
- Node kind `store`: the app's **own** record, queue or table that two parts of the path meet through
  ("Order record", "Job queue"). `external` is third-party code only; a store is in-repo and usually has a `path`
  (the package that owns it, e.g. `api/db`), optionally an `at`.
  ```jsonc
  { "id": "orders", "kind": "store", "label": "Order record", "parent": "api",   // parent: a system or a module
    "blurb": "In the database; the only hand-off between API and worker", "path": "api/db", "summary": "…" }
  ```
  - Parent: a `system` (the store shows at module level) or a `module` (it shows at function level). It has no
    children, so it cannot be entered.
  - It may hold no step at all (a hand-off box); a step may sit on it. It is never the `from` of an edge: the boxes
    that write, read or poll it point at it (`create -> orders "stores pending order"`,
    `worker -> orders "polls every 2 s"`, async).
  - The extension draws it with its own look (one "store" tag; not the "external" tag) and opens `path` on click
    like a module box. An extension that does not know the kind yet shows it as a module.
  - `journey.py check` enforces parent, no children, no outgoing edge; `node`, `edge` and `set … kind` refuse them
    when written.
- Step `refs`: an array of ≤ 3 strings. Each ref is **one short sentence (≤ ~15 words) saying what is there,
  containing exactly one location token**: `path:line` or `path:a-b`, the full repo-relative path
  (`worker/src/queue.ts:42`, `config/payments.yaml:12-30`). The token may stand anywhere in the sentence; a full stop
  or comma may follow it. Token grammar: `((?:[\w.@-]+/)*[\w.@-]+\.[A-Za-z]{1,6}):(\d+)(?:-(\d+))?`.
  - The extension shows the sentence as text and turns the token into the link: it displays the **basename**
    (`queue.ts:42`) and opens the full path at that line (or selects `a-b`). The rest of the sentence is plain text.
  - Old form, still valid: a ref that is only the token (`"api/db.js:88"`). It is shown as the link alone;
    `journey.py check` prints a WARNING for it. A string with no token is a PROBLEM in `check` and is shown as plain
    text. With more than one token, the first is linked (`check` warns).
  - A ref points elsewhere: not inside the step's own range or within 20 lines of it (`check` warns).
  - `journey.py check` verifies the token (file exists, lines in range), prints the sentence and the code line
    under it, and warns on a bare ref, on more than one token and on more than 15 words.
- Step `id`: a short string, unique in the journey, that never changes when steps are inserted, removed or
  reordered (journey.py writes it). The extension follows the current tour step and remembers where a journey was
  left by id, so editing a journey mid-tour keeps the reader on the same step; if that step is removed, the tour
  moves to its neighbour. A step without an id is tracked by position (and a duplicate id counts as missing).
- Problems (a dropped node/edge/step, a label over 30 characters, more than 7 boxes on a level, more than 3 refs, an
  unreadable file) are shown as one short line on the map, not only in the Output channel.
- The extension relocates each step's range in memory with the note anchoring code (anchor.ts) when files change;
  it never rewrites the journey file. A step whose anchor can't be found is shown as stale (amber).
- v1 files (steps pointing at note ids) are migrated by `journey.py migrate` (the step notes are folded in and
  deleted). The extension may ignore v1 files with one log line.

## In the repo: location, compact anchors, the explain request

**Location.** Journeys are committed at `<repo>/journeys/<slug>.json` (shared with the team). Personal notes stay in
the git-ignored `.code-notes/`. The extension reads `codeNotes.journeys.folder` (default `journeys`, workspace
relative) and, for compatibility, `<notes folder>/journeys/`. `journey.py` defaults to `<repo>/journeys/` (falls back
to `.code-notes/journeys/` when only that exists; `--dir` overrides).

**Compact anchors (v3)** — journeys must be reviewable in a PR, so anchors do not copy whole functions. Used for
steps (`anchor`) and box `at.anchor`:
```jsonc
"anchor": { "v": 3, "head": "first ≤ 3 non-blank lines", "tail": "last ≤ 2 non-blank lines",
            "lines": 14, "hash": "sha1 of the normalized full text, first 12 hex", "before": "1 line", "after": "1 line" }
```
Exact definitions (the extension and `journey.py` agree): `hash` = sha1 over the NON-BLANK lines of the range, each
through `norm`, joined by `\n` (readers also accept the every-line variant); `before`/`after` = the nearest
non-blank line above/below the range. A stored range that ends in blank lines is also tried at its stored length, so
trailing blank lines don't turn a fresh anchor into "moved".
Normalization = anchor.ts `norm` (whitespace, quote style, trailing `;`/`,`). Relocation: candidate starts where the
`head` lines match; for each, the end where `tail` matches within [lines·0.5, lines·1.5 + 5]; prefer an exact `hash`,
then the closest line count, then `before`/`after` context, then nearness to the stored range. Outcomes: found with
the same hash → fresh; found with a different hash → **changed** (the step is shown at its new place, with the
"code changed" marker); not found → **gone**. v2 full-text anchors stay readable (converted in memory);
`journey.py migrate-anchors` rewrites files to v3.

**The explain request.** A script or another tool can ask the editor window that has a repo open to show the
journeys or answer a question: it writes `.code-notes/.request.json` in the repo and brings that window to the front
(for example by running the editor's CLI, `code <repo>`). Such a script may first install or update the extension
when the installed one is older than the one it needs.

Request (written by the caller): `{"action":"overview"|"ask","question":"…","model":"…","at":"<iso time>",
"id":"<request id>","needs":"<semver>"}`. The window that has the repo open handles it (a watcher on the file, also in
a window that starts just now). Older than 2 min: ignored (and deleted). `needs` newer than the extension: left alone
for a reloaded window with the newer version. Otherwise it is deleted once read.

Result (written by the extension, atomically: temp file + rename): `.code-notes/.result.json`, a flat object of string
values `{"id":<request id>,"outcome":…,"title"?,"model"?,"message"?,"text"?}`; a caller can wait a few seconds for it
and print one line. Outcomes: `overview` (the Journeys list opened), `opened` (+ `title`: the journey that answers
it), `confirm` (no journey answers it; the "Write one with Claude (<model>, about 3 min)?" prompt is showing,
+ `model`), `writing` (+ `model`; after the person chose Write, may come after the caller stopped waiting),
`untrusted` (the folder is in Restricted Mode: Claude never runs there), `error` (+ `message`).

`ask` matching: the same question or title, else the journey matching most of the question's telling words (stop
words dropped, light stems and synonyms: "change" finds "update"; all of one or two words, else 60 %), title and
question weighing more than the summary and step titles. No match: one confirm first (the closest journeys listed
first, then Write, Cancel); Write starts Claude Code headless with the code-journey skill (only in a trusted folder),
with `model` and `JOURNEY_MODEL=<model or "Claude Code default">`. It writes into a staging folder
(`.code-notes/.writing/<id>/`, journey.py `--dir`); the journey moves into the journeys folder only when `journey.py
check` passes, stamped with `model`, and is announced ("Journey written: <title> · 2 min"). If Claude asks a question
instead, it is shown with a reply box that resumes the same session; if it names an existing journey, that one opens.

The `vscode://<publisher>.code-notes/explain?action=…&q=…[&repo=…]` URI handler stays for older callers: it opens the
overview or a matching journey, never starts Claude (a link can come from any web page) and ignores `model`. The
same action + question within 30 s is handled once (a link and a request file for the same ask both arrive).
`overview` opens the journey panel's Journeys list (title, the question under it, where it was left); `ask`, and
opening a journey from the sidebar or the list, walks it at once: step 1, or where it was left. The map has no
Start/Resume button. A journey with `"start": true` is marked **Start here** in the list.

## The whole map

The extension draws every node at once, nested by `parent` (systems hold modules, modules hold functions; `external`
and `store` boxes sit in their parent), with every edge between its real ends, laid out by ELK (layered, top →
bottom, hierarchical). `lane` is still read but ignored; a store is drawn dashed where ELK puts it. The ≤ 7 boxes per
parent rule stays a `check` problem for readability, but nothing is hidden when it is broken. Edge labels are
shortened (first clause, no timings; a generic "calls" is not drawn); the whole label and `detail` are the label's
tooltip. Function boxes open `at` (lines selected), else `path`, else their first step's lines.

## Step animations (`scene`)

A step may carry a `scene`: a few actors (`app`, `browser`, `service`, `table`, `cluster`, `terminal`, `file`,
`chat`, `queue`, `gauge`), the wires between them and 3-6 beats, each lighting one line of code. The format is
documented at the top of `media/journey-scene.js` and in the actor table of `skills/code-journey/SKILL.md`;
`journey.py scene` validates it (types, ids, what each actor reads, text that would not fit its box).
`test/journey-scene/sample.json` uses every actor type; `npm run test:scenes` plays it in the panel at three widths.

The `app` actor draws a web app's window from data: brand, logo, tabs, a dialog screen, a detail screen (with a live
picture and a chat pane), a sign-in screen, and any number of plain pages. Older journeys call it `console` and its
screens `run-dialog`, `run-page`, `login`; those names, and the older flat fields and set keys, still play.
