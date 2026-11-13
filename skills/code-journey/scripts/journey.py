#!/usr/bin/env python3
"""journey.py — writes a code journey (format v2): an answer to "how does X work?" as a small map (nodes, edges)
plus an ordered storyline of steps, all in ONE file: <repo>/journeys/<slug>.json (committed, reviewed in PRs like
code). Rules: ../SKILL.md. The folder: <repo>/journeys/, or <repo>/.code-notes/journeys/ when only that exists;
`--dir <folder>` (anywhere on the command line; relative to <repo>) overrides. Last good copies go in its .bak/
(git-ignored).

  journey.py new   <repo> <slug> "<question>" "<title>"      < summary     (<= 2 plain sentences, no code in the first)
                   question: one natural question, <= 80 chars (it is the map header and the row's tooltip)
                   title: a topic name <= 28 chars, subject first, not a question ("Checkout flow")
  journey.py node  <repo> <slug> <id> <system|module|external|store|function> "<label>" [parent] [file:start-end]
                   [--blurb "<= 60 chars, shown in the box"] [--path src/x]              < summary (tooltip)
                   store: the app's OWN record, queue or table that two parts meet through (never third-party:
                   that is external); a side box in a system or module; it may hold no step and never acts
  journey.py edge  <repo> <slug> <from> <to> "<label>" [async|sync] ["<detail>"]
                   from = the side that ACTS (caller, poller, watcher): a poll is poller -> polled, "polls …"
                   label <= 30 chars, says HOW or WHAT FOR in words ("start run", "polls every 2 s"), never "calls"
  journey.py step  <repo> <slug> <node> <file> <start> <end> "<title>" [after N]   < text
                   <node>: a function, external or store box (a system or module box is refused: add the
                   function box first). title: a fact, <= 70 chars. <start> <end>: the lines that matter (the call,
                   the branch), <= 15 lines (WARNING above that; the whole function is the box). text on stdin:
                       first paragraph  = lead: ONE sentence, <= 25 plain words (WARNING above that; 40 is refused)
                       later paragraphs = details (optional markdown, folded in the UI)
                       last lines       = refs (optional, <= 3): a line `refs:` and under it ONE SENTENCE PER LINE,
                                          each saying what the reader will see there, with exactly one
                                          path:line (or path:a-b) in it, <= 15 words:
                                              refs:
                                              The 30 s retry delay is set in worker/src/queue.ts:42.
                                          (old form, still read: `refs: path:line path:line` = bare refs; check warns)
  journey.py range <repo> <file> <symbol-or-line>     prints file:start-end of that function/type (for node/step)
                   symbol: a function, type, or method (`click`, `Session.click`, Go `envs.List`). line: the
                   innermost function/method around it (outer ones listed as "inside …"); a line outside any
                   function is refused (exit 1), never answered with a range that does not contain it
  journey.py check <repo> <slug> [quiet|story|refs|fix]   validates; prints the outline, the storyline and every
                   referenced line (quiet: only PROBLEM/WARNING lines and one summary line, "ok: 14 steps, 0 problems";
                   story: storyline only; refs: ref lines only). A step or box
                   whose code moved (lines inserted above it, a git rename) is found again the way the extension
                   finds it: a WARNING; `fix` (or --fix) rewrites file:start-end of every one found unambiguously,
                   and a box `path` that git renamed. Code that CHANGED under a step is a PROBLEM that shows where it
                   is now and what changed: re-read it and re-verify the title and lead before re-anchoring. A git
                   that fails (dubious ownership, no repository) is reported as a git error, once. A hand-edited
                   file with a wrong shape (e.g. "at": "file:a-b") gives PROBLEM lines, exit 1, never a traceback;
                   a box with no step and no edge is one PROBLEM
  journey.py migrate <repo> <slug>         v1 (one note per step) -> v2; deletes the step notes after writing
  journey.py migrate-anchors <repo> <slug>|--all   rewrites full-text (v2) anchors as compact v3 anchors, from the
                   text they stored (so `check` still tells whether the code moved or changed since)

Links, values, scenes (once the steps are written; N = the step's number; the script reads every line's text):
  journey.py link  <repo> <slug> N "<phrase>" <file> <start> [<end>]
                   the phrase (exact words of the lead or details, outside backticks and Markdown links) becomes a
                   link to the 1-8 lines that do what it says; the same phrase again replaces it
  journey.py value <repo> <slug> N <name> "<value>" <file> <line> ["<note>"]
                   a faint hint above that line: `name = value  · note`. The line mentions <name>; value <= 40
                   chars, one line ("-" reads stdin); note = a few words on what it IS in this run. The same name
                   on the same line again replaces it
  journey.py scene <repo> <slug> N   < scene JSON  {"actors": [...], "wires": [[a, b]], "beats": [...]}
                   replaces the step's animation; a beat's code is {"file", "line"} (the script adds "text").
                   Actors and what a beat's "set" changes: SKILL.md, media/journey-scene.js of the extension
  journey.py rmlink <repo> <slug> N "<phrase>"
  journey.py rmvalue <repo> <slug> N <name> [<line>]
  journey.py rmscene <repo> <slug> N

Fixing things:
  journey.py restep  <repo> <slug> N [<file> <start> <end>] ["<title>"]  < text    (empty stdin keeps the text)
  journey.py restep  <repo> <slug> N <title|lead|details|refs|node> <value>          one field ("-" reads stdin;
                                                                    refs: one sentence per line ("-" = stdin), or
                                                                    several in one argument separated by " | ";
                                                                    "" clears details/refs)
  journey.py restep  <repo> <slug> N range <file> <start> <end>
  journey.py rmstep  <repo> <slug> N                later steps renumber (number = position); names the boxes it
                                                    leaves without a step (rmnode them, or add a step)
  journey.py mvstep  <repo> <slug> N after M        moves step N behind step M (0 = first); the step keeps its id
  journey.py stepnode <repo> <slug> N <node>        puts step N on another box
  journey.py meta    <repo> <slug> <title|question|summary|model> <value>           ("-" reads stdin)
  journey.py meta    <repo> <slug> start <true|false>     the journey to open first ("Start here" in the list)
  journey.py set     <repo> <slug> <node> <label|blurb|path|summary|kind|at|parent> <value>   ("-" reads stdin)
  journey.py rmnode  <repo> <slug> <node>           (and its edges; refuses while steps or children use it)
  journey.py rmedge  <repo> <slug> <from> <to>
  journey.py setedge <repo> <slug> <from> <to> "<label>" [async|sync] ["<detail>"]   (what you omit is kept)
  journey.py reset   <repo> <slug>                  deletes the journey file (nothing else)
  journey.py restore <repo> <slug>                  puts back the last good copy (journeys/.bak/<slug>.json,
                                                    kept on every write and every load of a valid file)

Rules (`journey.py help <command>` shows the ones for that command):
- Every step has a stable short "id" (made by `step`/`migrate`, kept by every other command): the extension follows
  a step by it when steps move.
- Every write command prints one line saying what it wrote (`question = "…" (54 chars)`, `server.label = "…"`,
  `edge a -> b: …`, `step 3 [id] …`), and under it the first/last line it anchored on.
- Anchors are compact (v3; docs/journey-format.md of the extension, "In the repo"), for steps and box `at`:
  {v: 3, head: first <= 3 non-blank lines, tail: last <= 2, lines: N, hash: sha1 of the normalized text (each
  non-blank line through `norm`, joined with "\\n") first 12 hex, before/after: the nearest non-blank line around it}.
  `check` finds the code again from head and tail: same hash = fresh (elsewhere: moved, a WARNING, `fix` repoints
  it); another hash = CHANGED (a PROBLEM showing where it is now: re-verify, then `restep N range` / `set <node> at`);
  head or tail not found = GONE (PROBLEM). Full-text (v2) anchors are still read.
- Limits are enforced when you write (exit 1, nothing is written): `new`/`meta` refuse a question > 80 chars and a
  title > 28, `step`/`restep` an over-long title or lead, `node`/`set` a label > 30 chars, a blurb > 60 and an 8th
  child of one box, `edge`/`setedge` a label > 30.
- `check` (and `new`, `meta question|title`) print a WARNING when another journey in the repo has a very similar
  question or title, or walks mostly the same code: extend that one.
- `step`/`restep`/`check` print a WARNING when the range starts or ends on a lone closing brace, stops in the middle
  of a statement, or starts on a bare `return …` with other code after it (fix it with `restep N range`), and when
  two steps are anchored on identical lines.
- `step`/`restep`/`check` print a WARNING when a title holds several facts (two or more of ", " "; " ": " " and "
  " then "; a list "A, B and C" and a leading "If …," do not count) and when the lead or details carry a path:line
  (prose names the symbol; path:line goes in refs).
- `node`/`set`/`check` print a WARNING when a system/module/external/store label is over 20 chars (30 stays the hard
  limit).
- `step`/`restep`/`check` print a WARNING when a lead is more than one sentence or more than 25 words (the rest goes
  in details), when a step marks more than 15 lines, and when a lead repeats its title (one sentence of the lead
  carries >= 70 % of the title's words, or the whole lead >= 85 %): the lead should say what the title does not.
- A ref is ONE sentence saying what the reader will see there, with the path:line inside it ("The 30 s retry delay
  is set in worker/src/queue.ts:42."): the extension shows the sentence and links the basename. `check`
  verifies the one path:line (file exists, lines in range, prints the line); `step`/`restep`/`check` print a WARNING
  for a bare ref without a sentence, for more than one path:line in a ref, for a ref over 15 words, and for a ref
  that points inside the step's own range or within 20 lines of it (that code is already on screen; a ref points
  somewhere else: another function or file).
- `node`/`set`/`edge`/`setedge`/`check` print a WARNING when a label or blurb holds code syntax (a URL template or
  path, an HTTP verb, a protocol name, CLI placeholders, "->"): say it in words ("start run").
- `link` refuses a phrase that is not a free part of the lead/details (missing, only in backticks or a Markdown link,
  overlapping another link's phrase), a range equal to the step's own range, a second link on the same lines and a
  blank or missing line (`check`: WARNING for all but a missing line); WARNING over 15 lines. `restep`/`check` print
  a WARNING naming a link whose phrase the text no longer has (a dead link).
- `value` refuses a line that does not mention the name and a value over 40 chars (`check`: WARNING), and a second
  hint on one line (`check`: PROBLEM); WARNING when the line is neither within 25 lines of the step's range nor
  within 12 of a beat or link of it.
- `scene` refuses (`check`: PROBLEM) an unknown actor type, a duplicate id, a wire, packet, focus or set naming no
  actor, focus "all", a packet with no wire, no beat with code, more than 7 beats, more than 5 checks or any over 28
  chars, more than 3 table rows, a terminal line over 36 chars (file 34, chat 38), an app screen or pane that does
  not exist, and text longer than its box holds (the message says the limit); it refuses (`check`: WARNING) more than 4 actors, fewer than 3 beats, keys the engine ignores and set
  indexes past what the actor has. WARNING: 7 beats, a caption over 70 chars (or with muted over 110), two code-less
  beats in a row, a beat lighting a signature, a comment or a lone brace.
- `check` finds every link, value and beat line again by its stored text the way the extension does (same trimmed
  line, nearest within 400 lines): moved = WARNING (`check fix` repoints it, apart from the step's range); not found
  = PROBLEM. A journey with none of them gets one WARNING; a step without links, when others have some, too.
"""
import datetime, hashlib, json, os, random, re, string, subprocess, sys

# `journey.py` alone: one line per command (the detail: `journey.py help <command>`).
SUMMARY = [
    ('new', 'starts a journey'),
    ('node', 'adds a box to the map'),
    ('edge', 'adds an arrow between two boxes'),
    ('step', 'adds a step to the storyline'),
    ('range', "prints a function's file:start-end"),
    ('check', 'validates a journey'),
    ('restep', 'changes a step'),
    ('rmstep', 'removes a step'),
    ('mvstep', 'moves a step'),
    ('stepnode', 'puts a step on another box'),
    ('meta', "changes the journey's own fields"),
    ('set', 'changes a box'),
    ('rmnode', 'removes a box and its arrows'),
    ('setedge', 'changes an arrow'),
    ('rmedge', 'removes an arrow'),
    ('link', 'links a phrase of a step to the lines doing it'),
    ('value', 'adds a value hint above a line'),
    ('scene', "sets a step's animation"),
    ('rmlink', 'removes a code link'),
    ('rmvalue', 'removes a value hint'),
    ('rmscene', "removes a step's animation"),
    ('reset', 'deletes a journey'),
    ('restore', 'puts back the last good copy'),
    ('migrate', 'converts an old (v1) journey'),
    ('migrate-anchors', 'rewrites old anchors in the compact form'),
]


def short_help():
    w = max(len(c) for c, _ in SUMMARY)
    lines = ['journey.py: writes a code journey, <repo>/journeys/<slug>.json (rules: ../SKILL.md).', '']
    lines += [f'  {c.ljust(w)}  {d}' for c, d in SUMMARY]
    lines += ['', 'journey.py help <command>: its arguments and rules. journey.py help all: everything.',
              '--dir <folder> (anywhere) reads and writes journeys there instead of <repo>/journeys/.']
    return '\n'.join(lines)


def command_help(cmd):
    """The command's usage block from the full text, and the rules that name it."""
    doc = __doc__.split('\n')
    out, inside = [], False
    for l in doc:
        if l.startswith('  journey.py '):
            inside = l.split()[1] == cmd
        elif not l.startswith('    ') or not l.strip():
            inside = False
        if inside:
            out.append(l)
    rules, cur = [], None
    for l in doc[doc.index('Rules (`journey.py help <command>` shows the ones for that command):') + 1:]:
        if l.startswith('- '):
            cur = [l]
            rules.append(cur)
        elif cur is not None and l.startswith('  '):
            cur.append(l)
    hits = [r for r in rules if re.search(r'`(?:[\w-]+/)*' + re.escape(cmd) + r'[`/ ]', ' '.join(r))]
    if hits:
        out += ['', 'Rules:'] + [l for r in hits for l in r]
    return '\n'.join(out)


def no_journey(repo, slug):
    """An unknown slug: the closest ones and every slug there is."""
    import difflib
    d = jdir(repo)
    slugs = sorted(f[:-5] for f in os.listdir(d) if f.endswith('.json')) if os.path.isdir(d) else []
    if not slugs:
        sys.exit(f"No journey '{slug}': {d} has none yet (`journey.py new` starts one).")
    near = difflib.get_close_matches(slug, slugs, n=3, cutoff=0.5)
    ask = f" Did you mean {', '.join(near)}?" if near else ''
    sys.exit(f"No journey '{slug}'.{ask}\nJourneys: {', '.join(slugs)}")

KINDS = ('system', 'module', 'function', 'external', 'store')
# external: something outside this repo (a third-party controller, a cloud API). Its steps are anchored on the repo
# code that depends on it or observes it; it may have no file.
# store: the app's own record, queue or table that two parts meet through (never third-party). A side box in a
# system or a module; it may hold no step (a hand-off box), has no children and is never the `from` of an edge.
STEP_KINDS = ('function', 'external', 'store')      # the boxes a step can sit on
PARENT_KINDS = {'system': (None,), 'module': ('system',), 'external': ('system',), 'store': ('system', 'module'),
                'function': ('system', 'module', 'external')}
MAX_CHILDREN = 7
MAX_LABEL, MAX_BLURB, MAX_EDGE_LABEL = 30, 60, 30
MIN_STEPS, MAX_STEPS = 6, 14
MAX_STEP_TITLE, MAX_LEAD_WORDS = 70, 40
SOFT_LEAD_WORDS, SOFT_RANGE_LINES = 25, 15      # over these `step`/`restep`/`check` print a WARNING
MAX_QUESTION = 80
STEP_FIELDS = ('title', 'lead', 'details', 'refs', 'node', 'range')
REF = r'((?:[\w.@-]+/)*[\w.@-]+\.[A-Za-z]{1,6}):(\d+)(?:-(\d+))?'
LINK = r'(?<![\w/])((?:[\w.@-]+/)+[\w.@-]+\.[A-Za-z]{1,6}):(\d+)(?:-(\d+))?'


def now():
    t = datetime.datetime.now(datetime.timezone.utc)
    return t.strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'


DIR = None             # --dir <folder>: where the journeys are (relative to the repo, or absolute)


def jdir(repo):
    """<repo>/journeys (committed with the code); .code-notes/journeys when only that exists; --dir overrides."""
    if DIR:
        return os.path.join(repo, DIR)
    new, old = os.path.join(repo, 'journeys'), os.path.join(repo, '.code-notes', 'journeys')
    return old if os.path.isdir(old) and not os.path.isdir(new) else new


def jpath(repo, slug):
    return os.path.join(jdir(repo), slug + '.json')


def bak_path(repo, slug, kind=''):
    return os.path.join(jdir(repo), '.bak', slug + kind + '.json')


def write_atomic(p, text):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(text)
    os.replace(tmp, p)


def keep_bak(repo, slug, raw):
    """The last good copy, in .bak/ (the extension reads journeys/*.json only, so it never shows it)."""
    b = bak_path(repo, slug)
    try:
        if os.path.exists(b) and open(b, encoding='utf-8').read() == raw:
            return
        write_atomic(b, raw)
        ig = os.path.join(os.path.dirname(b), '.gitignore')
        if not os.path.exists(ig):   # backups never reach a commit, whatever the repo ignores
            write_atomic(ig, '*\n')
    except OSError:
        pass                     # a read-only checkout: no backup, nothing else changes


def unreadable(repo, slug, why):
    """A journey file that does not parse: one PROBLEM line, exit 1 (never a traceback)."""
    b = bak_path(repo, slug)
    if os.path.exists(b):
        t = datetime.datetime.fromtimestamp(os.path.getmtime(b)).strftime('%Y-%m-%d %H:%M')
        hint = f'`journey.py restore {repo} {slug}` puts back the last good copy ({t})'
    else:
        hint = 'no backup of it exists; rewrite it with the commands (reset, new …)'
    print(f'PROBLEM: {jpath(repo, slug)}: {why}; {hint}')
    sys.exit(1)


def load(repo, slug, v1=False):
    p = jpath(repo, slug)
    if not os.path.exists(p):
        no_journey(repo, slug)
    try:
        raw = open(p, encoding='utf-8').read()
        j = json.loads(raw)
    except json.JSONDecodeError as e:
        unreadable(repo, slug, f'invalid JSON at line {e.lineno} column {e.colno} (char {e.pos} of {len(e.doc)}): {e.msg}')
    except UnicodeDecodeError as e:
        unreadable(repo, slug, f'not UTF-8 text (byte {e.start})')
    if not isinstance(j, dict) or not isinstance(j.get('version'), int):
        unreadable(repo, slug, 'not a journey (a JSON object with a "version")')
    if j.get('version') == 2:
        miss = [k for k in ('title', 'nodes', 'edges', 'steps') if k not in j]
        if miss:
            unreadable(repo, slug, 'missing ' + ', '.join(miss))
    if j.get('version') == 2:
        bad = shape_problems(repo, j)
        if bad:                  # a hand-edited file gets PROBLEM lines, never a traceback
            for b in bad:
                print('PROBLEM: ' + b)
            b = bak_path(repo, slug)
            print(f'FAILED: {jpath(repo, slug)} was edited by hand into a shape the commands cannot read; fix the lines '
                  f'above' + (f', or `journey.py restore {repo} {slug}` puts back the last good copy' if os.path.exists(b) else ''))
            sys.exit(1)
    keep_bak(repo, slug, raw)
    if not v1 and j.get('version') != 2:
        sys.exit(f'{slug} is a v{j.get("version")} journey: run `journey.py migrate {repo} {slug}` first')
    return j


SHAPE_NOTES = []       # hand-edits `load` could read anyway (an "at": "file:a-b" string): `check` reports each as a PROBLEM


def shape_problems(repo, j):
    """The shapes every command relies on, checked once on load. Returns what cannot be read; a box whose `at`
    is the CLI's own "file:start-end" string is read as that range (and noted in SHAPE_NOTES)."""
    out = []
    is_int = lambda v: isinstance(v, int) and not isinstance(v, bool)
    is_str = lambda v: isinstance(v, str)

    def anchor_ok(a):
        if not isinstance(a, dict) or not all(is_str(a.get(k, '')) for k in ('text', 'before', 'after', 'head', 'tail', 'hash')):
            return False
        return a.get('v') != 3 or (is_str(a.get('head')) and is_int(a.get('lines')))

    def reanchor(f, a, b):
        try:
            ls = open(os.path.join(repo, f), encoding='utf-8', errors='replace').read().split('\n')
        except OSError:
            return make_anchor([''], '', '')
        if not 1 <= a <= b <= len(ls):
            return make_anchor([''], '', '')
        return make_anchor(ls[a - 1:b], *around(ls, a - 1, b - 1))
    for key in ('nodes', 'edges', 'steps'):
        if not isinstance(j.get(key), list):
            out.append(f'"{key}" must be a list')
    if not is_str(j.get('title')):
        out.append('"title" must be a string (meta title "…")')
    for key in ('question', 'summary', 'commit'):
        if key in j and not is_str(j[key]):
            out.append(f'"{key}" must be a string')
    if out:
        return out
    for i, n in enumerate(j['nodes']):
        if not isinstance(n, dict) or not is_str(n.get('id')) or not n.get('id'):
            out.append(f'nodes[{i}]: a box is an object with a string "id"')
            continue
        name = f'box {n["id"]}'
        if n.get('kind') not in KINDS:
            out.append(f'{name}: kind {n.get("kind")!r} is not one of {", ".join(KINDS)}')
        if not is_str(n.get('label')):
            out.append(f'{name}: "label" must be a string')
        for key in ('blurb', 'summary', 'path', 'parent'):
            if key in n and not is_str(n[key]):
                out.append(f'{name}: "{key}" must be a string')
        if 'at' not in n:
            continue
        at = n['at']
        if is_str(at):
            m = re.fullmatch(r'(.+):(\d+)(?:-(\d+))?', at.strip())
            if not m:
                out.append(f'{name}: "at" is the string {at!r}; it must be {{file, start, end, anchor}}: remove the line, '
                           f'then `set {n["id"]} at <file:start-end>`')
                continue
            f, a, b = m.group(1), int(m.group(2)), int(m.group(3) or m.group(2))
            n['at'] = {'file': f, 'start': a, 'end': b, 'anchor': reanchor(f, a, b)}
            SHAPE_NOTES.append(f'{name}: "at" was hand-written as the string "{at}"; it must be {{file, start, end, anchor}}: '
                               f'run `set {n["id"]} at {f}:{a}-{b}` (never edit the file by hand)')
        elif not (isinstance(at, dict) and is_str(at.get('file')) and is_int(at.get('start')) and is_int(at.get('end'))):
            out.append(f'{name}: "at" must be {{file, start, end, anchor}} with whole line numbers: remove it, then '
                       f'`set {n["id"]} at <file:start-end>`')
        elif not anchor_ok(at.get('anchor')):
            at['anchor'] = reanchor(at['file'], at['start'], at['end'])
            SHAPE_NOTES.append(f'{name}: "at" has no anchor (hand-written): run `set {n["id"]} at '
                               f'{at["file"]}:{at["start"]}-{at["end"]}`')
    for i, e in enumerate(j['edges']):
        if not isinstance(e, dict) or not all(is_str(e.get(k)) for k in ('from', 'to', 'label')):
            out.append(f'edges[{i}]: an edge is an object with string "from", "to" and "label" (rewrite it with `edge`)')
        elif 'detail' in e and not is_str(e['detail']):
            out.append(f'edge {e["from"]} -> {e["to"]}: "detail" must be a string')
    for i, st in enumerate(j['steps'], 1):
        name = f'step {i}'
        if not isinstance(st, dict):
            out.append(f'{name}: a step is an object')
            continue
        for key in ('title', 'node', 'file'):
            if not is_str(st.get(key)):
                out.append(f'{name}: "{key}" must be a string')
        for key in ('lead', 'details', 'id'):
            if key in st and not is_str(st[key]):
                out.append(f'{name}: "{key}" must be a string')
        r = st.get('range')
        if is_str(r) or not (isinstance(r, dict) and is_int(r.get('start')) and is_int(r.get('end'))):
            out.append(f'{name}: "range" must be {{start, end}} with whole line numbers (and "file" beside it): put the '
                       f'old value back, then `restep {i} range <file> <start> <end>`')
        elif not anchor_ok(st.get('anchor')) and is_str(st.get('file')):
            st['anchor'] = reanchor(st['file'], r['start'], r['end'])
            SHAPE_NOTES.append(f'{name}: no anchor (hand-written range): run `restep {i} range {st["file"]} {r["start"]} {r["end"]}`')
        for key, need in (('links', ('phrase', 'file', 'start', 'end')), ('values', ('name', 'value', 'file', 'line'))):
            if key in st and not (isinstance(st[key], list) and all(isinstance(x, dict) and all(
                    (is_int if f in ('start', 'end', 'line') else is_str)(x.get(f)) for f in need) for x in st[key])):
                out.append(f'{name}: "{key}" must be a list of {{{", ".join(need)}, text}} objects (rewrite them with '
                           f'`{key[:-1]}`, after removing the line)')
        if 'scene' in st and not (isinstance(st['scene'], dict) and isinstance(st['scene'].get('actors'), list)
                                  and isinstance(st['scene'].get('beats'), list)):
            out.append(f'{name}: "scene" must be {{actors, wires, beats}} (remove it, then `scene {i}` < the JSON)')
        if 'refs' in st and not (isinstance(st['refs'], list) and all(is_str(x) for x in st['refs'])):
            out.append(f'{name}: "refs" must be a list of strings, each one sentence with a path:line in it (restep {i} refs "…")')
    return out


def new_id(used):
    while True:
        i = ''.join(random.choices(string.ascii_lowercase + string.digits, k=6))
        if i not in used:
            return i


def save(repo, slug, j):
    # every step has a stable short id (the extension follows a step by it when steps move); never changed here
    used = {s.get('id') for s in j.get('steps', [])}
    for k, s in enumerate(j.get('steps', [])):
        if not s.get('id'):
            j['steps'][k] = {'id': new_id(used), **s}
            used.add(j['steps'][k]['id'])
    raw = json.dumps(j, indent=2, ensure_ascii=False) + '\n'
    write_atomic(jpath(repo, slug), raw)
    keep_bak(repo, slug, raw)


def lines_of(repo, rel):
    try:
        return open(os.path.join(repo, rel), encoding='utf-8', errors='replace').read().split('\n')
    except (FileNotFoundError, IsADirectoryError):
        sys.exit(f'{rel}: no such file in {repo}')


ECHO = None        # a list while a step is being written: its anchor lines are printed after the step's header


def say(line):
    if ECHO is None:
        print(line)
    else:
        ECHO.append(line)


def wrote(line):
    """Every write command says what it wrote, in one line; the anchor lines it collected follow, indented."""
    global ECHO
    print(line)
    for l in ECHO or []:
        print(l)
    ECHO = None


def shown(v, n=160):
    """A value for the echo line: one line, quoted, cut when long, with its length."""
    one = ' '.join(str(v).split())
    return f'"{one[:n]}{"…" if len(one) > n else ""}" ({len(str(v))} chars)'


def question_problem(q):
    """The question is the map header (one bold line) and the sidebar row's tooltip."""
    if len(q.strip()) > MAX_QUESTION:
        return (f'is {len(q.strip())} chars (max {MAX_QUESTION}: one natural question a developer would ask; '
                f'the lists and qualifiers go in the summary)')
    return ''


# --- near-duplicate journeys. Words of question + title, without the words every question has.
STOP = set('a an the and or but of in into to on for from with by at as is are was be it its this that i we you my our '
           'how does do did what when why where which who can gets get got happen happens work works used use using '
           'end up e g eg ie etc there their them then than so not'.split())
SIMILAR, SAME_CODE = 0.5, 0.7


def key_words(*texts):
    out = set()
    for w in re.findall(r'[a-z0-9]+', ' '.join(texts).lower()):
        if w in STOP or len(w) < 2:
            continue
        for suf in ('ing', 'ed', 'es', 's'):
            if w.endswith(suf) and len(w) - len(suf) >= 4:
                w = w[:-len(suf)]
                break
        out.add(w)
    return out


def other_journeys(repo, slug):
    d = jdir(repo)
    out = []
    for f in sorted(os.listdir(d)) if os.path.isdir(d) else []:
        if not f.endswith('.json') or f[:-5] == slug:
            continue
        try:
            o = json.load(open(os.path.join(d, f), encoding='utf-8'))
        except (OSError, ValueError):
            continue
        if isinstance(o, dict) and o.get('version') == 2:
            out.append((f[:-5], o))
    return out


def similar_journeys(repo, slug, j):
    """WARNING texts naming every other journey that asks nearly the same thing or walks mostly the same code."""
    out = []
    mine = key_words(j.get('question', ''), j.get('title', ''))
    spans = [(s.get('file'), s.get('range', {}).get('start', 0), s.get('range', {}).get('end', 0)) for s in j.get('steps', [])]
    for other, o in other_journeys(repo, slug):
        name = f'journey {other} ("{o.get("question") or o.get("title", "")}")'
        same_title = j.get('title', '').strip().lower() == o.get('title', '').strip().lower() != ''
        theirs = key_words(o.get('question', ''), o.get('title', ''))
        both = mine & theirs
        ratio = len(both) / len(mine | theirs) if mine | theirs else 0
        if same_title:
            out.append(f'title "{j["title"]}" is also the title of {name}: two sidebar rows that read the same; '
                       f'rename one, or extend that journey instead')
        elif ratio >= SIMILAR:
            out.append(f'question and title are very similar to {name}: {len(both)} of {len(mine | theirs)} words shared '
                       f'({", ".join(sorted(both))}); extend that journey instead of adding a near-duplicate')
        os_ = [(s.get('file'), s.get('range', {}).get('start', 0), s.get('range', {}).get('end', 0)) for s in o.get('steps', [])]
        hit = sum(1 for f, a, b in spans if any(f == g and a <= d and c <= b for g, c, d in os_))
        if spans and hit >= 3 and hit / len(spans) >= SAME_CODE:
            out.append(f'{hit} of {len(spans)} steps are anchored on the same code as {name}: '
                       f'it tells the same story; extend that journey instead')
    return out


def anchor(repo, rel, start, end, quiet=False):
    lines = lines_of(repo, rel)
    if not (1 <= start <= end <= len(lines)):
        sys.exit(f'{rel} has {len(lines)} lines: range {start}-{end} is outside it')
    s, e = start - 1, end - 1
    if not quiet:
        say(f'  {rel} L{start}: {lines[s].strip()[:100]}')
        if end > start:
            say(f'  {rel} L{end}: {lines[e].strip()[:100]}')
    return make_anchor(lines[s:e + 1], *around(lines, s, e))


# --- a range that starts or ends on a stray closing brace, or stops in the middle of a statement, highlights
# sloppily in the editor. Heuristics on code files only (brackets are counted naively, like `range`): a WARNING.
CODE_EXT = ('.go', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.py', '.rs', '.java', '.kt', '.c', '.h',
            '.cc', '.cpp', '.cs', '.swift')
TAIL_OPS = ('&&', '||', '+', '-', '*', '/', '%', '=', '|', '&', '^', '\\')


def code_of(line, py=False):
    """The line without string literals and comments ('' for a blank or comment-only line)."""
    t = line.strip()
    if t.startswith(('*', '/*', '<!--')) or t.startswith('#' if py else '//'):
        return ''
    t = re.sub(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|`[^`]*`', '""', t)
    return re.sub(r'\s#.*$' if py else r'//.*$', '', t).strip()


def unfinished(code, py=False):
    """Why this line cannot be the end of a statement ('' when it can)."""
    if code.endswith(','):
        return 'a comma'
    if code.endswith(('(', '[')):
        return f'an open "{code[-1]}"'
    if code.endswith(TAIL_OPS) and not code.endswith(('++', '--', '*/')):
        return f'the operator "{code[-1]}"'
    if py and code.endswith(':') and not code.startswith(('case ', 'default')):
        return 'a block opener ":"'
    return ''


def range_warnings(lines, rel, start, end):
    """Problems with where the range start-end (1-based) begins and ends; [] for a file that is not code."""
    if not rel.endswith(CODE_EXT) or not (1 <= start <= end <= len(lines)):
        return []
    py = rel.endswith('.py')
    code = {k: code_of(lines[k - 1], py) for k in range(start, end + 1)}
    lone = lambda c: bool(re.fullmatch(r'[\])}]+[;,]?', c))
    stack, unmatched = [], set()          # open brackets inside the range; lines closing one opened above it
    for k in range(start, end + 1):
        for ch in code[k]:
            if ch in '([{':
                stack.append(k)
            elif ch in ')]}':
                if stack:
                    stack.pop()
                else:
                    unmatched.add(k)

    def nxt(k, step):                     # the nearest line with code in that direction, inside the range
        k += step
        while start <= k <= end and not code[k]:
            k += step
        return k if start <= k <= end else None
    out = []
    first, last = code[start], code[end]
    if lone(first):
        a = nxt(start, 1)
        hint = f'did you mean {a}-{end}?' if a else 'pick the statement itself'
        out.append(f'{rel}:{start}-{end} starts on a lone closing "{first[0]}" (the end of the block above): {hint}')
    if end > start and lone(last) and end in unmatched:
        b = nxt(end, -1)
        hint = f'did you mean {start}-{b}?' if b and not (b == start and lone(first)) else 'pick the statement itself'
        out.append(f'{rel}:{start}-{end} ends on a lone closing "{last[0]}" of a block opened above the range: {hint}')
    if end > start and re.match(r'return\b', first):
        # `return …` first, other code after it: the range starts at the tail of the block above
        depth, r = 0, None
        for k in range(start, end + 1):
            c = code[k]
            if not c:
                continue
            depth += sum(c.count(x) for x in '([{') - sum(c.count(x) for x in ')]}')
            if depth <= 0 and not unfinished(c, py):
                r = k                     # the line the return statement ends on
                break
        a = nxt(r, 1) if r else None
        while a and lone(code[a]):
            a = nxt(a, 1)
        if a:
            out.append(f'{rel}:{start}-{end} starts on a bare `{first[:40]}` (the end of the block above; the lines '
                       f'after it are other code): did you mean {a}-{end}?')
    why = unfinished(last, py) if last and not lone(last) else ''
    if why == 'a comma' and not stack and not unmatched:
        why = ''                          # whole elements of a list or literal: balanced, each ends with its comma
    prev = nxt(end, -1) if end > start else None
    if not why and last.endswith('{') and prev and not unfinished(code[prev], py) and not code[prev].endswith('{'):
        why = 'the opening "{" of a new block'     # a head on its own, or one spread over lines, is a fine anchor
    if why:
        close, depth = None, 0            # where the statement that is cut off ends: brackets back to level
        for k in range(end, min(len(lines), end + 400) + 1):
            c = code_of(lines[k - 1], py)
            depth += sum(c.count(x) for x in '([{') - sum(c.count(x) for x in ')]}')
            if k > end and depth <= 0 and c and not unfinished(c, py):
                close = k
                break
            if k == end and depth <= 0 and not last.endswith(('(', '[', '{')):
                depth = 0                 # a comma or operator inside an already balanced line: the next full line ends it
        opts = [f'{start}-{prev} (without it)'] if prev and last.endswith(('(', '[', '{')) else []
        if close:
            opts.append(f'{start}-{close} (where it ends)')
        out.append(f'{rel}:{start}-{end} ends in the middle of a statement (the last line ends with {why})'
                   + (': did you mean ' + ' or '.join(opts) + '?' if opts else ''))
    return out


def parse_at(at):
    f, _, r = at.rpartition(':')
    a, _, b = r.partition('-')
    return f, int(a), int(b or a)


def stdin_text():
    return '' if sys.stdin.isatty() else sys.stdin.read().strip()


def body(what='text'):
    b = stdin_text()
    if not b:
        sys.exit(f'nothing on stdin: {what} is missing (pass it with <<EOF … EOF)')
    return b


def value_of(v):
    return body() if v == '-' else v


def ref_tokens(ref):
    """The path:line tokens inside a ref (a sentence, or an old bare `path:line`), as regex matches."""
    return list(re.finditer(r'(?<![\w/.@-])' + REF, ref))


def ref_token(ref):
    """The ref's first path:line as a string ('' when it has none): what is checked, compared and linked."""
    t = ref_tokens(ref)
    return t[0].group(0) if t else ''


def ref_bare(ref):
    return bool(re.fullmatch(REF, ref.strip()))


MAX_REF_WORDS = 15


def parse_refs(s):
    """One ref per line (or several on one line separated by " | "): a sentence with one path:line in it. A line
    made only of bare path:line tokens (the old form, space or comma separated) gives one bare ref per token."""
    out = []
    for line in re.split(r'\n|\s\|\s', s.strip()):
        line = re.sub(r'^\s*(?:[-*]|\d+[.)])\s+', '', line.strip()).strip()
        if not line:
            continue
        parts = [r for r in re.split(r'[\s,]+', line) if r]
        if all(re.fullmatch(REF, r) for r in parts):
            out.extend(parts)
        else:
            out.append(' '.join(line.split()))
    return out


def ref_warnings(k, s):
    """A ref is one short sentence saying what is there, with exactly one path:line in it."""
    out = []
    for i, ref in enumerate(s.get('refs', []), 1):
        n = len(ref_tokens(ref))
        if ref_bare(ref):
            out.append(f'step {k}: ref {i} "{ref}" is a bare path:line: write one sentence saying what the reader will '
                       f'see there, with the path:line in it (restep {k} refs -)')
            continue
        if n > 1:
            out.append(f'step {k}: ref {i} holds {n} path:line tokens ("{ref}"): one place per ref; split it or keep one')
        w = words(ref)
        if w > MAX_REF_WORDS:
            out.append(f'step {k}: ref {i} is {w} words (max ~{MAX_REF_WORDS}: one short sentence saying what is there): "{ref}"')
    return out


def parse_step_text(text):
    """first paragraph = lead; the rest = details; a last block `refs:` + one sentence per line (each with one
    path:line), or the old last line `refs: a:1 b:2`, = refs."""
    refs = None
    lines = text.strip().split('\n')
    for i in range(len(lines) - 1, -1, -1):          # the last `refs:` line whose following lines all carry a path:line
        m = re.match(r'(?i)^refs?:\s*(.*)$', lines[i].strip())
        if m:
            tail = [l for l in lines[i + 1:] if l.strip()]
            if all(ref_tokens(l) for l in tail) and (tail or m.group(1).strip()):
                refs = parse_refs('\n'.join([m.group(1)] + tail))
                lines = lines[:i]
            break
    lead, _, details = '\n'.join(lines).strip().partition('\n\n')
    return ' '.join(lead.split()), details.strip(), refs


def flags(args, *names):
    """Pulls --name value pairs out of args."""
    out, rest, i = {}, [], 0
    while i < len(args):
        if args[i].startswith('--') and args[i][2:] in names and i + 1 < len(args):
            out[args[i][2:]] = args[i + 1]
            i += 2
        else:
            rest.append(args[i])
            i += 1
    return out, rest


def cmd_new(repo, slug, question, title):
    if os.path.exists(jpath(repo, slug)):
        sys.exit(f'journey {slug} exists')
    if journey_title_problem(title):
        sys.exit(f'title "{title}" {journey_title_problem(title)}; nothing was written')
    if question_problem(question):
        sys.exit(f'question {question_problem(question)}; nothing was written: "{question}"')
    commit = subprocess.run(['git', '-C', repo, 'rev-parse', '--short', 'HEAD'], capture_output=True, text=True).stdout.strip()
    j = {'version': 2, 'id': slug, 'question': question, 'title': title,
         'summary': body(f'the summary of journey {slug} (<= 2 plain sentences)')}
    if os.environ.get('JOURNEY_MODEL'):
        j['model'] = os.environ['JOURNEY_MODEL']
    j.update({'commit': commit, 'createdAt': now(), 'nodes': [], 'edges': [], 'steps': []})
    save(repo, slug, j)
    print(jpath(repo, slug))
    print(f'new journey {slug}: title = {shown(j["title"])}; question = {shown(j["question"])}; '
          f'summary = {shown(j["summary"])}')
    for w in similar_journeys(repo, slug, j):
        print('WARNING: ' + w)


def cmd_meta(repo, slug, field, value):
    j = load(repo, slug)
    if field == 'start':             # the one journey a newcomer should open first: the list marks it "Start here"
        on = value_of(value).strip().lower()
        if on not in ('true', 'false'):
            sys.exit('start is true or false')
        if on == 'true':
            j['start'] = True
        else:
            j.pop('start', None)
        save(repo, slug, j)
        wrote(f'start = {on}')
        return
    if field not in ('title', 'question', 'summary', 'model'):
        sys.exit('field is title, question, summary, model or start')
    j[field] = value_of(value)
    if field == 'title' and journey_title_problem(j[field]):
        sys.exit(f'title "{j[field]}" {journey_title_problem(j[field])}; nothing was written')
    if field == 'question' and question_problem(j[field]):
        sys.exit(f'question {question_problem(j[field])}; nothing was written: "{j[field]}"')
    save(repo, slug, j)
    wrote(f'{field} = {shown(j[field])}')
    if field in ('title', 'question'):
        for w in similar_journeys(repo, slug, j):
            print('WARNING: ' + w)


def refuse(why):
    sys.exit(f'{why}; nothing was written')


def label_limit(label):
    if len(label) > MAX_LABEL:
        refuse(f'label is {len(label)} chars (max {MAX_LABEL}; a path goes in --path / `set <node> path`, '
               f'the sentence in the summary): "{label}"')


def blurb_limit(blurb):
    if len(blurb) > MAX_BLURB:
        refuse(f'blurb is {len(blurb)} chars (max {MAX_BLURB}): "{blurb}"')


def child_limit(j, parent, nid):
    """The box `parent` ('' = the top level) can take `nid` as one more child."""
    n = sum(1 for x in j['nodes'] if x.get('parent', '') == parent and x['id'] != nid)
    if n >= MAX_CHILDREN:
        where = f'box {parent}' if parent else 'the top level'
        refuse(f'{where} already has {n} children (max {MAX_CHILDREN}): group some of them under a new box first')


def node_line(n):
    return (f'node {n["id"]} [{n["kind"]}] "{n["label"]}"' + (f' — {n["blurb"]}' if n.get('blurb') else '')
            + (f'  in {n["parent"]}' if n.get('parent') else '') + (f'  path {n["path"]}' if n.get('path') else '')
            + (f'  @ {n["at"]["file"]}:{n["at"]["start"]}-{n["at"]["end"]}' if 'at' in n else ''))


def edge_line(e):
    return (f'edge {e["from"]} -> {e["to"]}: {e["label"]}{"  (async)" if e.get("async") else ""}'
            + (f' — {e["detail"]}' if e.get('detail') else ''))


def cmd_node(repo, slug, nid, kind, label, *rest):
    global ECHO
    ECHO = []
    j = load(repo, slug)
    opt, rest = flags(list(rest), 'blurb', 'path')
    parent = rest[0] if rest else ''
    at = rest[1] if len(rest) > 1 else ''
    if parent and not at and re.search(r':\d+(-\d+)?$', parent):      # `node id function "x" file:1-2` has no parent
        sys.exit('a function node needs a parent before its file:start-end')
    if kind not in KINDS:
        sys.exit(f'kind is one of {", ".join(KINDS)}')
    if any(n['id'] == nid for n in j['nodes']):
        sys.exit(f'node {nid} exists')
    if parent and not any(p['id'] == parent for p in j['nodes']):
        sys.exit(f'parent {parent} not defined yet (define parents first)')
    pk = next((p['kind'] for p in j['nodes'] if p['id'] == parent), None)
    if kind == 'store' and pk not in PARENT_KINDS['store']:
        refuse(f'a store box sits in a system or a module (parent {parent or "none"} is {pk or "the top level"})')
    if pk == 'store':
        refuse(f'{parent} is a store box: it has no children (put the function that reads or writes it in its module, '
               f'with an edge to {parent})')
    label_limit(label)
    blurb_limit(opt.get('blurb', ''))
    child_limit(j, parent, nid)
    n = {'id': nid, 'kind': kind, 'label': label, **opt,
         'summary': body(f'the summary of node {nid} (one sentence, the tooltip: what "{label}" is in this journey)')}
    if parent:
        n['parent'] = parent
    if at:
        f, a, b = parse_at(at)
        n['at'] = {'file': f, 'start': a, 'end': b, 'anchor': anchor(repo, f, a, b)}
    j['nodes'].append(n)
    save(repo, slug, j)
    wrote(node_line(n))
    for w in (label_warning(n), node_text_warning(n)):
        if w:
            print('WARNING: ' + w)


def make_edge(a, b, label, flag='', detail=''):
    if flag not in ('', 'async', 'sync'):
        sys.exit('after the label: async or sync, then optionally the detail')
    if len(label) > MAX_EDGE_LABEL:
        refuse(f'edge label is {len(label)} chars (max {MAX_EDGE_LABEL}; the sentence goes in the detail): "{label}"')
    return {'from': a, 'to': b, 'label': label, **({'async': True} if flag == 'async' else {}),
            **({'detail': detail} if detail else {})}


def cmd_edge(repo, slug, a, b, label, flag='', detail=''):
    j = load(repo, slug)
    ids = {n['id'] for n in j['nodes']}
    for x in (a, b):
        if x not in ids:
            sys.exit(f'node {x} not defined')
    if any(e['from'] == a and e['to'] == b for e in j['edges']):
        sys.exit(f'edge {a} -> {b} exists: one edge per pair (setedge to change it)')
    if any(n['id'] == a and n['kind'] == 'store' for n in j['nodes']):
        refuse(f'{a} is a store box and a store never acts: draw the edge from the box that reads, writes or polls it '
               f'(edge {b} {a} "polls …" async)')
    j['edges'].append(make_edge(a, b, label, flag, detail))
    save(repo, slug, j)
    wrote(edge_line(j['edges'][-1]))
    if edge_text_warning(j['edges'][-1]):
        print('WARNING: ' + edge_text_warning(j['edges'][-1]))


def find_edge(j, a, b):
    for i, e in enumerate(j['edges']):
        if e['from'] == a and e['to'] == b:
            return i
    sys.exit(f'no edge {a} -> {b}')


def cmd_rmedge(repo, slug, a, b):
    j = load(repo, slug)
    e = j['edges'].pop(find_edge(j, a, b))
    save(repo, slug, j)
    wrote('removed ' + edge_line(e))


def cmd_setedge(repo, slug, a, b, label, flag='', detail=''):
    j = load(repo, slug)
    i = find_edge(j, a, b)
    old = j['edges'][i]
    if not flag:                                   # label only: async and detail stay as they were
        flag, detail = ('async' if old.get('async') else 'sync'), old.get('detail', '')
    elif not detail:
        detail = old.get('detail', '')
    j['edges'][i] = make_edge(a, b, label, flag, detail)
    save(repo, slug, j)
    wrote(edge_line(j['edges'][i]))
    if edge_text_warning(j['edges'][i]):
        print('WARNING: ' + edge_text_warning(j['edges'][i]))


def cmd_set(repo, slug, nid, field, value):
    global ECHO
    ECHO = []
    j = load(repo, slug)
    n = next((x for x in j['nodes'] if x['id'] == nid), None) or sys.exit(f'no node {nid}')
    value = value_of(value)
    if field in ('label', 'summary', 'blurb', 'path'):
        if field == 'label':
            label_limit(value)
        if field == 'blurb':
            blurb_limit(value)
        n[field] = value
    elif field == 'kind':
        if value not in KINDS:
            sys.exit(f'kind is one of {", ".join(KINDS)}')
        if value not in STEP_KINDS and any(s['node'] == nid for s in j['steps']):
            refuse(f'{nid} holds steps; steps go on a function, external or store box (move them first: stepnode)')
        if value == 'store' and any(x.get('parent') == nid for x in j['nodes']):
            refuse(f'{nid} has children; a store box has none (move them first: set <node> parent)')
        if value == 'store' and any(e['from'] == nid for e in j['edges']):
            refuse(f'{nid} is the `from` of an edge; a store never acts: turn the edge round first (rmedge, then edge '
                   f'<reader or writer> {nid} "polls …" async)')
        n['kind'] = value
    elif field == 'parent':
        if value and not any(p['id'] == value for p in j['nodes']):
            sys.exit(f'no node {value}')
        if value != n.get('parent', ''):
            child_limit(j, value, nid)
        if value:
            n['parent'] = value
        else:
            n.pop('parent', None)
    elif field == 'at':
        f, a, b = parse_at(value)
        n['at'] = {'file': f, 'start': a, 'end': b, 'anchor': anchor(repo, f, a, b)}
    else:
        sys.exit('field is label, blurb, path, summary, kind, at or parent')
    save(repo, slug, j)
    if field == 'at':
        wrote(f'{nid}.at = {n["at"]["file"]}:{n["at"]["start"]}-{n["at"]["end"]}')
    elif field in ('kind', 'parent', 'path'):
        wrote(f'{nid}.{field} = {n.get(field) or "(none: top level)"}')
    else:
        wrote(f'{nid}.{field} = {shown(n[field])}')
    for w in (field == 'label' and label_warning(n), field in ('label', 'blurb') and node_text_warning(n)):
        if w:
            print('WARNING: ' + w)


def cmd_rmnode(repo, slug, nid):
    j = load(repo, slug)
    if any(s['node'] == nid for s in j['steps']) or any(n.get('parent') == nid for n in j['nodes']):
        sys.exit(f'{nid} still has steps or children')
    gone = next((n for n in j['nodes'] if n['id'] == nid), None) or sys.exit(f'no node {nid}')
    j['nodes'] = [n for n in j['nodes'] if n['id'] != nid]
    print('removed ' + node_line(gone))
    for e in j['edges']:
        if nid in (e['from'], e['to']):
            print(f'removed edge {e["from"]} -> {e["to"]}: {e["label"]}')
    j['edges'] = [e for e in j['edges'] if nid not in (e['from'], e['to'])]
    save(repo, slug, j)


def step_at(j, n):
    if not str(n).isdigit() or not 1 <= int(n) <= len(j['steps']):
        sys.exit(f'step {n}: there are {len(j["steps"])} steps')
    return int(n) - 1


def need_node(j, node):
    if not any(x['id'] == node for x in j['nodes']):
        sys.exit(f'node {node} not defined')


def need_step_box(repo, slug, j, node, rel='<file>', line='<line>'):
    """A step sits on a function, external or store box; a system or module box is refused when it is written."""
    need_node(j, node)
    n = next(x for x in j['nodes'] if x['id'] == node)
    if n['kind'] not in STEP_KINDS:
        refuse(f'{node} is a {n["kind"]} box ("{n["label"]}"); steps go on a function, external or store box. Add the '
               f'function inside it first: journey.py node {repo} {slug} <id> function "<name>" {node} <file:start-end> '
               f'(`journey.py range {repo} {rel} {line}` prints the function around that line), then put the step on <id>')


def same_lines(j, s):
    """The numbers of the other steps anchored on exactly the lines of step s."""
    key = lambda x: (x.get('file'), x.get('range', {}).get('start'), x.get('range', {}).get('end'))
    return [k for k, x in enumerate(j['steps'], 1) if x is not s and key(x) == key(s)]


def say_same_lines(j, s):
    twins = same_lines(j, s)
    if twins:
        say(f'WARNING: step{"s" if len(twins) > 1 else ""} {", ".join(map(str, twins))} '
            f'{"are" if len(twins) > 1 else "is"} anchored on the same lines ({s["file"]}:{s["range"]["start"]}-'
            f'{s["range"]["end"]}): each step shows the lines its own title is about (restep N range <file> <start> <end>)')


def set_range(repo, s, rel, a, b):
    a, b = int(a), int(b)
    s['file'], s['range'], s['anchor'] = rel, {'start': a, 'end': b}, anchor(repo, rel, a, b)
    for w in range_warnings(lines_of(repo, rel), rel, a, b):
        say(f'WARNING: {w}')


def cmd_step(repo, slug, node, rel, start, end, title, after_kw='', after=''):
    global ECHO
    ECHO = []
    j = load(repo, slug)
    need_step_box(repo, slug, j, node, rel, start)
    pos = len(j['steps'])
    if after_kw:
        if after_kw != 'after' or not after.isdigit() or int(after) > len(j['steps']):
            sys.exit(f'insert with: after N (0..{len(j["steps"])})')
        pos = int(after)
    lead, details, refs = parse_step_text(body(f'the text of step "{title}" (lead, blank line, details, refs: …)'))
    s = {'id': new_id({x.get('id') for x in j['steps']}), 'title': title, 'node': node}
    set_range(repo, s, rel, start, end)
    say_same_lines(j, s)
    s['lead'] = lead
    if details:
        s['details'] = details
    s['refs'] = refs or []
    step_limits(s)
    j['steps'].insert(pos, s)
    save(repo, slug, j)
    echo_step(pos + 1, s)


def echo_step(k, s):
    global ECHO
    w = words(s.get('lead', ''))
    print(f'step {k} [{s["id"]}] {s["title"]}  ({len(s["title"])} chars; lead {w} words; '
          f'{len(s.get("refs", []))} refs{"; details" if s.get("details") else ""})')
    for line in ECHO or []:      # what it is anchored on, under its header
        print(line)
    ECHO = None
    for w in (repeat_warning(k, s), lead_warning(k, s), span_warning(k, s), *style_warnings(k, s), near_ref_warning(k, s),
              *ref_warnings(k, s), *link_warnings(k, s)):
        if w:
            print('WARNING: ' + w)


def step_limits(s):
    """An over-limit title or lead is refused when it is written, not found later by check."""
    t, w = s.get('title', ''), words(s.get('lead', ''))
    if len(t) > MAX_STEP_TITLE:
        sys.exit(f'title is {len(t)} chars (max {MAX_STEP_TITLE}); nothing was written: "{t}"')
    if w > MAX_LEAD_WORDS:
        sys.exit(f'lead is {w} words (max {MAX_LEAD_WORDS}; move the rest to details); nothing was written')


def cmd_restep(repo, slug, n, *rest):
    global ECHO
    ECHO = []
    j = load(repo, slug)
    s = j['steps'][step_at(j, n)]
    rest = list(rest)
    left = None
    if rest and rest[0] in STEP_FIELDS:
        field, args = rest[0], rest[1:]
        if field == 'range':
            if len(args) != 3:
                sys.exit('restep N range <file> <start> <end>')
            set_range(repo, s, *args)
            say_same_lines(j, s)
        elif len(args) != 1:
            sys.exit(f'restep N {field} <value>   ("-" reads stdin)')
        elif field == 'node':
            need_step_box(repo, slug, j, args[0], s['file'], s['range']['start'])
            left = {x for x, _ in unvisited(j)}
            s['node'] = args[0]
        elif field == 'refs':
            s['refs'] = parse_refs(value_of(args[0]) if args[0] else '')
        elif field == 'details':
            v = value_of(args[0]) if args[0] else ''
            if v:
                s['details'] = v
            else:
                s.pop('details', None)
        elif field == 'lead':
            s['lead'] = ' '.join(value_of(args[0]).split())
        else:
            s['title'] = value_of(args[0])
    else:
        if len(rest) >= 3:
            set_range(repo, s, *rest[:3])
            say_same_lines(j, s)
            rest = rest[3:]
        if rest:
            s['title'] = rest[0]
        text = stdin_text()
        if text:
            lead, details, refs = parse_step_text(text)
            s['lead'] = lead
            if details:
                s['details'] = details
            else:
                s.pop('details', None)
            if refs is not None:
                s['refs'] = refs
    step_limits(s)
    save(repo, slug, j)
    if rest and rest[0] in STEP_FIELDS and rest[0] != 'title':     # the one field that changed, before the step's line
        f = rest[0]
        v = (f'{s["file"]}:{s["range"]["start"]}-{s["range"]["end"]}' if f == 'range' else s['node'] if f == 'node'
             else ' | '.join(s.get('refs', [])) or '(none)' if f == 'refs' else shown(s.get(f, '')))
        print(f'step {int(n)} {f} = {v}')
    echo_step(int(n), s)
    if left is not None:
        say_left_empty(j, left)


def unvisited(j):
    """Boxes the storyline does not reach: [(node id, what is wrong and what to do)]. Shared by check and by the
    commands that take a step off a box."""
    stepped = {s['node'] for s in j['steps']}
    parents = {n.get('parent') for n in j['nodes']}
    out = []
    for n in j['nodes']:
        if n['id'] in stepped or n['id'] in parents:
            continue
        if n['kind'] == 'function':
            out.append((n['id'], f'no step visits this function box "{n["label"]}" (rmnode {n["id"]}, or add a step)'))
        if n['kind'] == 'external':     # visited through a function that has an edge with it
            via = {e['from'] if e['to'] == n['id'] else e['to'] for e in j['edges'] if n['id'] in (e['from'], e['to'])}
            if not via & stepped:
                out.append((n['id'], f'no step visits this external box "{n["label"]}" (put a step on it or on a '
                                     f'function with an edge to it, or rmnode {n["id"]})'))
    return out


def say_left_empty(j, before):
    """After a step left a box: names every box that has no step now and had one before."""
    for nid, what in unvisited(j):
        if nid not in before:
            print(f'WARNING: {nid}: {what}')


def cmd_stepnode(repo, slug, n, node):
    j = load(repo, slug)
    s = j['steps'][step_at(j, n)]
    need_step_box(repo, slug, j, node, s['file'], s['range']['start'])
    before = {x for x, _ in unvisited(j)}
    was = s['node']
    s['node'] = node
    save(repo, slug, j)
    print(f'step {int(n)} [{s["id"]}] node = {node} (was {was}): {s["title"]}')
    say_left_empty(j, before)


def cmd_rmstep(repo, slug, n):
    j = load(repo, slug)
    before = {x for x, _ in unvisited(j)}
    s = j['steps'].pop(step_at(j, n))
    save(repo, slug, j)
    print(f'removed step {int(n)} [{s.get("id", "")}]: {s["title"]}  ({len(j["steps"])} steps left)')
    say_left_empty(j, before)


def cmd_mvstep(repo, slug, n, after_kw, after):
    """Moves a step (it keeps its id, text and anchor): `mvstep N after M`, M = 0 puts it first."""
    j = load(repo, slug)
    i = step_at(j, n)
    if after_kw != 'after' or not after.isdigit() or int(after) > len(j['steps']) or int(after) == int(n):
        sys.exit(f'move with: mvstep N after M (M = 0..{len(j["steps"])}, not N itself)')
    s = j['steps'].pop(i)
    pos = int(after) - (1 if int(after) > i else 0)
    j['steps'].insert(pos, s)
    save(repo, slug, j)
    print(f'step {n} is now step {pos + 1}: {s["title"]}')


def cmd_reset(repo, slug):
    if not os.path.exists(jpath(repo, slug)):
        no_journey(repo, slug)
    os.remove(jpath(repo, slug))
    print(f'deleted {jpath(repo, slug)}')


def cmd_restore(repo, slug):
    """Puts back .bak/<slug>.json. A current file that differs is kept as .bak/<slug>.replaced.json."""
    b, p = bak_path(repo, slug), jpath(repo, slug)
    if not os.path.exists(b):
        sys.exit(f'no backup of {slug} ({b} does not exist)')
    raw = open(b, encoding='utf-8').read()
    try:
        json.loads(raw)
    except json.JSONDecodeError as e:
        sys.exit(f'the backup {b} does not parse either ({e.msg} at line {e.lineno} column {e.colno}); nothing was changed')
    cur = open(p, encoding='utf-8', errors='replace').read() if os.path.exists(p) else None
    if cur == raw:
        print(f'{p} already is the last good copy; nothing to restore')
        return
    if cur is not None:
        write_atomic(bak_path(repo, slug, '.replaced'), cur)
        print(f'kept the current file as {bak_path(repo, slug, ".replaced")}')
    write_atomic(p, raw)
    t = datetime.datetime.fromtimestamp(os.path.getmtime(b)).strftime('%Y-%m-%d %H:%M')
    print(f'restored {p} from the copy of {t}; run `journey.py check {repo} {slug}`')


def cmd_migrate(repo, slug):
    """v1 -> v2: each step's note is folded into the journey (file/range/anchor from the note; body -> lead, details,
    refs). The notes are deleted only after the v2 file is on disk. Refuses when a note is missing."""
    j = load(repo, slug, v1=True)
    if j.get('version') == 2:
        sys.exit(f'{slug} is already v2')
    d = os.path.join(repo, '.code-notes')
    notes = []
    for k, s in enumerate(j['steps'], 1):
        p = os.path.join(d, s['note'] + '.json')
        if not os.path.exists(p):
            sys.exit(f'step {k}: note {s["note"]} is missing; nothing was changed (restore it or remove the step from the v1 file)')
        notes.append((p, json.load(open(p, encoding='utf-8'))))
    steps = []
    for s, (p, note) in zip(j['steps'], notes):
        text = note['messages'][0]['body']
        text = re.sub(r'^\*\*\d+\. .*?\*\*\s*', '', text, count=1, flags=re.S).strip()   # the repeated title
        m = re.search(r'(?<=[.!?])\s+(?=[A-Z`*(\["])', text)                            # first sentence = lead
        lead, details = (text[:m.start()], text[m.end():]) if m else (text, '')
        refs = []
        for r in re.finditer(LINK, text):
            if r.group(0) not in refs:
                refs.append(r.group(0))
        st = {'id': new_id({x['id'] for x in steps}), 'title': s['title'], 'node': s['node'], 'file': note['file'], 'range': note['range'],
              'anchor': note['anchor'], 'lead': ' '.join(lead.split())}
        if details.strip():
            st['details'] = details.strip()
        st['refs'] = refs[:3]
        steps.append(st)
    out = {'version': 2}
    for key in ('id', 'question', 'title', 'summary', 'model', 'commit', 'createdAt', 'nodes', 'edges'):
        if key in j:
            out[key] = j[key]
    out['steps'] = steps
    save(repo, slug, out)
    if json.load(open(jpath(repo, slug), encoding='utf-8')).get('version') != 2:
        sys.exit('the v2 file did not read back; the step notes were kept')
    for p, _ in notes:
        os.remove(p)
    print(f'{slug}: v2 written, {len(steps)} step notes folded in and deleted. Now rewrite leads/details/refs (check).')


def cmd_range(repo, rel, what):
    """Prints file:start-end of a function/type: by name (`name`, `Class.method`), or the innermost one around a
    line. Never prints a range that does not contain the requested line. Ends are found by the closing line at the
    declaration's indentation (formatted code), else by counting braces (Python: by indentation)."""
    lines = lines_of(repo, rel)
    py = rel.endswith('.py')
    decl = re.compile(r'^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:func|function\*?|def|class|type|interface|const|let|var|struct|fn|enum)\b')
    named = re.compile(r'^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:func\s+(?:\(([^)]*)\)\s*)?|(?:function\*?|def|class|type|interface|struct|fn|enum|const|let|var)\s+)([A-Za-z_$][\w$]*)')
    nested = re.compile(r'^\s+(?:export\s+)?(?:async\s+)?(?:function\*?|class)\s+[A-Za-z_$]')
    mods = r'(?:(?:public|private|protected|static|async|override|abstract|readonly|get|set)\s+)*'
    method = re.compile(r'^\s+' + mods + r'\*?\s*(#?[A-Za-z_$][\w$]*)\s*(?:<[^(]*>)?\s*\(')
    arrow = re.compile(r'^\s*(?:export\s+)?' + mods + r'(?:(?:const|let|var)\s+)?(#?[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(|[\w$]+\s*=>).*=>\s*\{\s*$')
    notname = {'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'await', 'new', 'throw', 'typeof',
               'super', 'else', 'do', 'try', 'with', 'yield', 'delete', 'void', 'in', 'of'}

    def indent(i):
        return len(lines[i]) - len(lines[i].lstrip())

    def code_of(k):
        return re.sub(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|`[^`]*`|/\*.*?\*/|//.*$', '', lines[k])

    def method_name(i):
        """The name when line i opens a TS/JS method (`private async click(…): T {`), else None."""
        m = method.match(lines[i])
        if not m or m.group(1) in notname or lines[i].lstrip().startswith(('}', ')', '.', '?', ':')):
            return None
        depth, started = 0, False
        for k in range(i, min(i + 40, len(lines))):
            code = code_of(k)
            for pos, c in enumerate(code):
                if c == '(':
                    depth += 1
                    started = True
                elif c == ')':
                    depth -= 1
                    if started and depth == 0:
                        return m.group(1) if re.match(r'^\s*(?::.*)?\{\s*$', code[pos + 1:]) else None
        return None

    def name_of(i):
        """(name, receiver type) when line i declares something `range` may return, else None."""
        l = lines[i]
        if py:
            m = re.match(r'^\s*(?:async\s+)?(?:def|class)\s+(\w+)', l)
            return (m.group(1), '') if m else None
        if not l.strip() or l.lstrip().startswith(('//', '*', '/*')):
            return None
        m = arrow.match(l)
        if m and m.group(1) not in notname:
            return (m.group(1), '')
        if decl.match(l) and (indent(i) == 0 or nested.match(l)):
            m = named.match(l)
            recv = re.sub(r'^.*?\*?([\w$]+)(?:\[[^\]]*\])?\s*$', r'\1', m.group(1)) if m and m.group(1) else ''
            return (m.group(2), recv) if m else ('', '')
        if indent(i) > 0:
            n = method_name(i)
            if n:
                return (n, '')
        return None

    def end_of(i):
        if py:
            last = i
            for k in range(i + 1, len(lines)):
                if lines[k].strip():
                    if indent(k) <= indent(i) and not lines[k].lstrip().startswith(')'):
                        break
                    last = k
            return last
        depth, seen, counted, first, tpl = 0, False, None, None, False
        for k in range(i, len(lines)):
            code = code_of(k)
            if code.count('`') % 2:      # a multi-line `…` string opens or closes here: skip what is inside it
                code = code[code.index('`'):] if tpl else code[:code.index('`')]
                tpl = not tpl
                if tpl:
                    seen = True
            elif tpl:
                continue
            if tpl:
                for c in code:
                    depth += (c in '{([') - (c in '})]')
                first = first if k != i else max(depth, 0)
                continue
            for c in code:
                if c in '{([':
                    depth += 1
                    seen = True
                elif c in '})]':
                    depth -= 1
            if k == i:
                first = depth
            if depth <= 0 and (seen or not code.rstrip().endswith(('=', ','))):
                counted = k
                break
        if counted is None:
            counted = len(lines) - 1
        if first and first > 0:
            # The declaration stays open after its first line: in formatted code it ends on the first closing line
            # at the same indentation (a `): T {` that only ends the parameter list is not it). This survives
            # braces inside regex literals and multi-line template strings, which the count above does not.
            for k in range(i + 1, len(lines)):
                s = lines[k].strip()
                if not s:
                    continue
                if indent(k) < indent(i):
                    break
                if indent(k) == indent(i) and s[0] in '})]' and not code_of(k).rstrip().endswith(('{', '(', '[')):
                    return k
        return counted

    decls = [(i, n) for i in range(len(lines)) for n in [name_of(i)] if n]
    spans = {}

    def span(i):
        if i not in spans:
            spans[i] = end_of(i)
        return spans[i]

    def show(i, also=()):
        e = span(i)
        print(f'{rel}:{i + 1}-{e + 1}')
        print(f'  L{i + 1}: {lines[i].strip()[:100]}')
        print(f'  L{e + 1}: {lines[e].strip()[:100]}')
        for o in also:
            print(f'  inside {rel}:{o + 1}-{span(o) + 1}  {lines[o].strip()[:70]}')

    if what.isdigit():
        n = int(what) - 1
        if n < 0 or n >= len(lines):
            sys.exit(f'{rel}: no line {what} (the file has {len(lines)} lines)')
        around = [i for i, _ in decls if i <= n <= span(i)]
        if not around:
            prev = [i for i, _ in decls if i <= n]
            hint = f'; the declaration above it is {rel}:{prev[-1] + 1}-{span(prev[-1]) + 1}, which ends before it' if prev else ''
            sys.exit(f'{rel}:{what}: no function or type contains this line{hint}. Nothing printed: read the file and '
                     f'pass the lines yourself.')
        show(around[-1], reversed(around[:-1]))
        return
    owner, _, name = what.rpartition('.')
    starts = [i for i, (nm, _) in decls if nm == name]
    if owner:
        inside = [(i, span(i)) for i, (nm, _) in decls if nm == owner]
        starts = [i for i in starts if decls_recv(decls, i) == owner or any(a < i <= b for a, b in inside)]
    if not starts:
        near = sorted({(o + '.' if o else '') + nm for i, (nm, _) in decls if nm and name.lower() in nm.lower()
                       for o in [next((dn for j, (dn, _) in reversed(decls) if j < i and indent(j) < indent(i)
                                       and i <= span(j)), '')]})[:6]
        sys.exit(f'{rel}: no definition of {what} found' + (f' (close: {", ".join(near)})' if near else '')
                 + ' (try Class.method or a line number)')
    for i in starts:
        show(i)


def decls_recv(decls, i):
    return next((r for j, (_, r) in decls if j == i), '')


def words(s):
    return len(s.split())


def plain(s):
    """Text without code spans and URLs (for the bare-:NNN and sentence checks)."""
    return re.sub(r'\b\w+://\S+', 'URL', re.sub(r'`[^`]*`', 'CODE', s))


SENT = r'(?<=[.!?])\s+(?=[A-Z"\'(\[*`])'


def sentences(s):
    s = re.sub(r'\([^)]*\)', '', plain(s))
    s = re.sub(r'\b(e\.g|i\.e|etc|vs)\.', r'\1', s)
    return [x for x in re.split(SENT, s.strip()) if x.strip()]


def title_problem(t, labels):
    if len(t) > 70:
        return f'is {len(t)} chars (max 70)'
    if re.match(r'(?i)^(step|part|phase|stage|hop)\s*\d+\b', t):
        return 'is a heading; write the fact that happens here ("The server only stores a pending record")'
    if re.match(r'(?i)^(what|how|why|where|when|which|about|overview|intro)\b', t):
        return 'names a topic; state the fact instead ("The request carries the spec and the built image tags")'
    if t.strip().lower() in labels or words(t) < 4:
        return 'is a name, not a fact: say what happens (subject + verb, at least 4 words)'
    if t.rstrip().endswith((':', '?')):
        return 'ends with ":" or "?"; state the fact'
    return ''


MAX_TITLE = 28


def journey_title_problem(t):
    """The journey's title is a short topic name for a sidebar row that cannot wrap."""
    t = t.strip()
    if len(t) > MAX_TITLE:
        return f'is {len(t)} chars (max {MAX_TITLE}: a short topic name, subject first, e.g. "Checkout flow")'
    if t.endswith('?') or re.match(r'(?i)^(how|why|what|when)\b', t):
        return 'is a question; the title is a topic name (noun phrase, subject first: "Upgrade in place"); the question stays in `question`'
    return ''


def check_ref(repo, ref):
    """Returns (problem, [(line number, text)...])."""
    m = re.fullmatch(REF, ref)
    if not m:
        return 'not a full path:line (or path:line-line)', []
    f, a, b = m.group(1), int(m.group(2)), int(m.group(3) or m.group(2))
    p = os.path.join(repo, f)
    if not os.path.isfile(p):
        return 'no such file', []
    ls = open(p, encoding='utf-8', errors='replace').read().split('\n')
    if b > len(ls) or b < a or a < 1:
        return f'the file has {len(ls)} lines', []
    return '', [(a, ls[a - 1].strip()[:90])] + ([(b, ls[b - 1].strip()[:90])] if b > a else [])


# --- finding a step again after the code moved: the same rules as the extension (src/anchor.ts;
# keep the two in step). Lines compare without whitespace, with one quote style and no trailing ; or , (`norm`).
def norm(s):
    return re.sub(r'[;,]+$', '', re.sub(r"['`]", '"', re.sub(r'\s+', '', s)))


def blank(s):
    return norm(s) == ''


def weak(s):                     # `}` or `);` says nothing about where code is: not context
    return len(norm(s)) < 3


# --- compact anchors (v3), as in docs/journey-format.md ("In the repo"); the extension does the same in
# src/compact.ts (keep the two in step).
def text_hash(text_lines, blanks=False):
    """sha1 of the non-blank lines through `norm`, joined by "\n" (compact.ts blockHash): a blank line added or
    removed is not a change. blanks=True: the other reading (every line, blank ones as ""), accepted when read."""
    keep = [norm(l) for l in text_lines if blanks or not blank(l)]
    return hashlib.sha1('\n'.join(keep).encode('utf-8')).hexdigest()[:12]


def same_hash(text_lines, h):
    return not h or h in (text_hash(text_lines), text_hash(text_lines, True))


def around(lines, s, e):
    """The nearest non-blank line above line s and under line e (0-based): an anchor's before / after."""
    b = next((lines[i] for i in range(s - 1, -1, -1) if not blank(lines[i])), '')
    a = next((lines[i] for i in range(e + 1, len(lines)) if not blank(lines[i])), '')
    return b, a


def make_anchor(text_lines, before, after):
    """The v3 anchor of these lines: enough to find them again and to tell whether they changed, small in a diff."""
    nb = [l.rstrip() for l in text_lines if not blank(l)]
    return {'v': 3, 'head': '\n'.join(nb[:3]), 'tail': '\n'.join(nb[-2:]), 'lines': len(text_lines),
            'hash': text_hash(text_lines), 'before': before.rstrip(), 'after': after.rstrip()}


def as_v3(a):
    """A full-text (v2) anchor read as v3: before / after = the nearest non-blank line it stored around the text."""
    if a.get('v') == 3:
        return a
    before = ([l for l in a.get('before', '').split('\n') if not blank(l)] or [''])[-1]
    after = ([l for l in a.get('after', '').split('\n') if not blank(l)] or [''])[0]
    return make_anchor(a.get('text', '').split('\n'), before, after)


def place(lines, a, start0):
    """Where a v3 anchor is in these lines: (start0, end0, same_hash), or None when its head or tail is not there.
    Starts where the head lines match (blank lines between them are skipped); ends where the tail matches with a
    length in [lines*0.5, lines*1.5 + 5]. Best: the same hash, then the closest line count, then matching
    before/after (the nearest non-blank line around it), then nearest to where it was."""
    head = [norm(x) for x in a.get('head', '').split('\n') if not blank(x)]
    tail = [norm(x) for x in a.get('tail', '').split('\n') if not blank(x)] or head[-2:]
    n = a.get('lines', 1)
    N = [norm(l) for l in lines]
    if not head:                 # a range of blank lines cannot be followed: fresh while it is still blank
        ok = 0 <= start0 and start0 + n <= len(N) and not any(N[start0:start0 + n])
        return (start0, start0 + n - 1, True) if ok else None
    nbi = [i for i, x in enumerate(N) if x]
    lo, hi = n * 0.5, n * 1.5 + 5
    before, after = norm(a.get('before', '')), norm(a.get('after', ''))
    best = None
    for p, i in enumerate(nbi):
        if N[i] != head[0] or p + len(head) > len(nbi) or any(N[nbi[p + k]] != head[k] for k in range(1, len(head))):
            continue
        ctx = (len(before) >= 3 and p > 0 and N[nbi[p - 1]] == before)
        for q in range(p + len(head) - 1, len(nbi)):
            e = nbi[q]
            size = e - i + 1
            if size > hi:
                break
            if size < lo or q - len(tail) + 1 < p or any(N[nbi[q - len(tail) + 1 + k]] != tail[k] for k in range(len(tail))):
                continue
            # a range stored with blank lines at its end is tried at its stored length too
            ends = [e] + ([i + n - 1] if e < i + n - 1 < len(N) and not any(N[e + 1:i + n]) else [])
            for e2 in ends:
                same = same_hash(lines[i:e2 + 1], a.get('hash'))
                c = ctx + (len(after) >= 3 and q + 1 < len(nbi) and N[nbi[q + 1]] == after)
                key = (not same, abs(e2 - i + 1 - n), -c, abs(i - start0))
                if best is None or key < best[0]:
                    best = (key, i, e2, same)
    return best[1:] if best else None


RENAMES = None
GIT_ERROR = ''         # the first thing git said when it failed (dubious ownership, not a repository, no git)


def renames(repo, since):
    """old path -> new path from git: renames committed since the journey's commit (or in the last 500 commits),
    then staged/uncommitted ones (git diff -M HEAD, git status)."""
    global RENAMES
    if RENAMES is not None:
        return RENAMES
    RENAMES = {}

    def git(*a):
        global GIT_ERROR
        try:
            r = subprocess.run(['git', '-C', repo, *a], capture_output=True, text=True)
        except OSError as e:     # no git binary
            GIT_ERROR = GIT_ERROR or f'{e.strerror or e}'
            return ''
        if r.returncode != 0 and r.stderr.strip():     # a git that did not run is not "no rename"
            GIT_ERROR = GIT_ERROR or ' '.join(r.stderr.strip().split('\n')[0].split())[:200]
        return r.stdout if r.returncode == 0 else ''
    ok = since and git('rev-parse', '--verify', '--quiet', since + '^{commit}').strip()
    rng = [f'{since}..HEAD'] if ok else ['-n', '500']
    out = git('log', '-M', '--diff-filter=R', '--name-status', '--format=', '--reverse', *rng)
    out += git('diff', '-M', '--name-status', 'HEAD')
    for line in out.splitlines():
        f = line.split('\t')
        if len(f) == 3 and f[0].startswith('R'):
            RENAMES[f[1]] = f[2]
    for line in git('status', '--porcelain=v1').splitlines():
        if line[:1] == 'R' and ' -> ' in line:
            a, b = line[3:].split(' -> ', 1)
            RENAMES[a.strip('"')] = b.strip('"')
    return RENAMES


def renamed(repo, since, f):
    seen = {f}
    while f in renames(repo, since):
        f = renames(repo, since)[f]
        if f in seen:
            break
        seen.add(f)
    return f


def renamed_path(repo, since, p):
    """Where a box's `path` (a file or a directory) went, from the same git renames; '' when git does not say."""
    p = p.rstrip('/')
    new = renamed(repo, since, p)
    if new != p:
        return new
    dirs = set()
    for old in renames(repo, since):
        if old.startswith(p + '/'):
            rest, to = old[len(p):], renamed(repo, since, old)
            if not to.endswith(rest):
                return ''        # files of the directory were renamed, not the directory
            dirs.add(to[:-len(rest)])
    return dirs.pop() if len(dirs) == 1 else ''


def nearest(repo, file, a):
    """Where changed code most likely is now: the window of the file most like the anchored text.
    Returns (start, end, [diff lines]) or None when nothing in the file resembles it."""
    import difflib
    if 'text' not in a:          # a compact anchor does not keep the old text
        return None
    old = a.get('text', '').split('\n')
    try:
        lines = open(os.path.join(repo, file), encoding='utf-8', errors='replace').read().split('\n')
    except OSError:
        return None
    key = [norm(x) for x in old]
    now = [norm(x) for x in lines]
    sm = difflib.SequenceMatcher(None, key, now, autojunk=False)
    blocks = [b for b in sm.get_matching_blocks() if b.size and any(not weak(old[b.a + i]) for i in range(b.size))]
    if not blocks:
        return None
    best = max(blocks, key=lambda b: b.size)
    near = [b for b in blocks if abs((b.b - b.a) - (best.b - best.a)) <= max(3, len(old))]
    start = max(0, min(b.b - b.a for b in near))
    end = min(len(lines), max(b.b + (len(old) - b.a) for b in near))
    if sum(b.size for b in near) < max(1, len([x for x in old if not weak(x)]) // 3):
        return None
    while start < end and blank(lines[start]):
        start += 1
    while end > start and blank(lines[end - 1]):
        end -= 1
    diff = [d for d in difflib.unified_diff([x.rstrip() for x in old], [x.rstrip() for x in lines[start:end]], lineterm='', n=0)
            if d[:1] in '+-' and d[:3] not in ('+++', '---')]
    return start + 1, end, diff


def where(repo, since, file, start, end, a):
    """Where anchored code is now, as the extension finds it: in its file, or in the file git renamed it to.
    Returns (state, file, start, end, detail); state is ok (fresh, in place), moved (fresh, elsewhere), changed
    (found by its head and tail, other content), gone (not found; detail: the renamed file) or nofile."""
    files = [file] if os.path.isfile(os.path.join(repo, file)) else []
    new = renamed(repo, since, file)
    if new != file and os.path.isfile(os.path.join(repo, new)):
        files.append(new)
    if not files:
        return 'nofile', file, start, end, ''
    a3 = as_v3(a)
    changed = None
    for f in files:
        lines = open(os.path.join(repo, f), encoding='utf-8', errors='replace').read().split('\n')
        got = place(lines, a3, start - 1 if f == file else 0)
        if not got:
            continue
        s0, e0, same = got
        if same:
            here = f == file and (s0 + 1, e0 + 1) == (start, end)
            return ('ok' if here else 'moved'), f, s0 + 1, e0 + 1, ''
        changed = changed or ('changed', f, s0 + 1, e0 + 1, '')
    return changed or ('gone', file, start, end, (f'renamed to {new}' if new != file else ''))


def code_at(repo, at):
    """The lines a box is anchored on, as they are now."""
    if not at:
        return []
    return lines_of(repo, at['file'])[at['start'] - 1:at['end']] if os.path.isfile(os.path.join(repo, at['file'])) else []


def old_diff(a, now):
    """What changed, when the anchor still has its full text (v2); a compact anchor shows the code as it is now."""
    import difflib
    if 'text' in a:
        d = [x for x in difflib.unified_diff([x.rstrip() for x in a['text'].split('\n')], [x.rstrip() for x in now], lineterm='', n=0)
             if x[:1] in '+-' and x[:3] not in ('+++', '---')]
    else:
        d = ['  ' + x.rstrip() for x in now]
    d = d[:12] + ([f'  … {len(d) - 12} more lines'] if len(d) > 12 else [])
    return ''.join('\n      ' + x[:140] for x in d)


def cmd_migrate_anchors(repo, slug):
    """Full-text (v2) anchors -> compact v3, from the text they stored: no file is read, so `check` afterwards still
    says whether the code moved or changed since the anchor was written."""
    if slug in ('--all', 'all'):
        slugs = sorted(f[:-5] for f in os.listdir(jdir(repo)) if f.endswith('.json')) if os.path.isdir(jdir(repo)) else []
        if not slugs:
            sys.exit(f'no journeys in {jdir(repo)}')
    else:
        slugs = [slug]
    for sl in slugs:
        p = jpath(repo, sl)
        if not os.path.exists(p):
            no_journey(repo, sl)
        size = os.path.getsize(p)
        j = load(repo, sl)
        holders = [s for s in j['steps']] + [n['at'] for n in j['nodes'] if 'at' in n]
        todo = [h for h in holders if h['anchor'].get('v') != 3]
        for h in todo:
            h['anchor'] = as_v3(h['anchor'])
        if todo:
            save(repo, sl, j)
        print(f'{sl}: {len(todo)} of {len(holders)} anchors rewritten as v3, {size} -> {os.path.getsize(p)} bytes')


STOP = set("""a an the and or but of to in on at by for from with without into onto as is are was were be been being it
its this that these those then than so not no only one each every all any which who what when where how why if there
here can will would may has have had do does did up out over under after before per via also own same just now more
most them they their he she we you i""".split())


def stem(w):
    for suf in ('ing', 'ed', 'es', 's'):
        if len(w) > len(suf) + 3 and w.endswith(suf):
            return w[:-len(suf)]
    return w


def content_words(text):
    return [stem(w) for w in re.findall(r"[a-z0-9][a-z0-9'-]*", plain(text).lower()) if w not in STOP and len(w) > 1]


def lead_repeats_title(title, lead):
    """A lead that says the title again adds nothing to the card. The share of the title's words (stop words
    dropped, crude stems) found again in one sentence of the lead, or in the whole lead; returns that share when one
    sentence carries >= 70 % of them or the lead >= 85 %, else None. Titles under 4 such words are not judged."""
    tw = set(content_words(title))
    if len(tw) < 4:
        return None
    one = max((len(tw & set(content_words(x))) / len(tw) for x in sentences(lead)), default=0)
    whole = len(tw & set(content_words(lead))) / len(tw)
    return max(one, whole) if one >= 0.7 or whole >= 0.85 else None


SOFT_LABEL = 20


def label_warning(n):
    """A box label is read at a glance; over 20 chars it wraps or shrinks (a function box is a symbol name)."""
    if n.get('kind') != 'function' and SOFT_LABEL < len(n.get('label', '')) <= MAX_LABEL:
        return (f'{n["id"]}: label "{n["label"]}" is {len(n["label"])} chars; aim for <= {SOFT_LABEL} ("CLI", "Worker"): '
                f'the rest goes in the blurb (set {n["id"]} label "…")')
    return ''


NEAR_REF = 20        # a ref this close to the step's own lines shows nothing new


def near_refs(s):
    """The refs of step `s` that point inside its own range or within NEAR_REF lines of it (same file)."""
    r = s.get('range') or {}
    out = []
    for ref in s.get('refs', []):
        m = re.fullmatch(REF, ref_token(ref))
        if not m or m.group(1) != s.get('file') or 'start' not in r:
            continue
        a, b = int(m.group(2)), int(m.group(3) or m.group(2))
        if a <= r['end'] + NEAR_REF and b >= r['start'] - NEAR_REF:
            out.append(ref)
    return out


def near_ref_warning(k, s):
    near = near_refs(s)
    if not near:
        return ''
    r = s['range']
    keep = [x for x in s.get('refs', []) if x not in near]
    return (f'step {k}: ref{"s" if len(near) > 1 else ""} {" ".join(map(ref_token, near))} point{"" if len(near) > 1 else "s"} at the '
            f'step\'s own code ({s["file"]}:{r["start"]}-{r["end"]}, or within {NEAR_REF} lines of it): it is already on '
            f'screen; a ref points elsewhere (another function or file). Drop it: restep {k} refs "{" | ".join(keep)}"')


CODE_IN_LABEL = (
    (r'\{[^}]*\}|<[\w-]+>', 'a placeholder'),
    (r'(?<![\w<])/[\w{:.-]+', 'a URL or path'),
    (r'\b(?:GET|POST|PUT|PATCH|DELETE)\b', 'an HTTP verb'),
    (r'\b(?:SSE|WS|WSS|JSON-RPC|gRPC|OIDC|Set-Cookie)\b', 'a protocol name'),
    (r'->|=>', 'an ASCII arrow'),
    (r':\d{2,5}\b', 'a port number'),
    (r'(?<!\w)--\w', 'a CLI flag'),
)


def code_in_text(text):
    """What in a label or blurb is code rather than words ('' = nothing)."""
    found = [what for rx, what in CODE_IN_LABEL if re.search(rx, text or '')]
    return ', '.join(found)


def node_text_warning(n):
    for field in ('label', 'blurb'):
        if n.get('kind') == 'function' and field == 'label':       # a function box is named by its symbol
            continue
        what = code_in_text(n.get(field, ''))
        if what:
            return (f'{n["id"]}: the {field} "{n[field]}" holds {what}: the map is the overview, say it in words '
                    f'(what the box is); the syntax is in the code the step opens (set {n["id"]} {field} "…")')
    return ''


def edge_text_warning(e):
    what = code_in_text(e.get('label', ''))
    if what:
        return (f'edge {e["from"]} -> {e["to"]}: the label "{e["label"]}" holds {what}: name the hop in words '
                f'("start run", "live events", "polls every 2 s") (setedge {e["from"]} {e["to"]} "…")')
    return ''


def style_warnings(k, s):
    """One fact per title. Prose names code by symbol; path:line only in refs."""
    out = []
    t = s.get('title', '')
    bare = re.sub(r'^If [^,;:]*, ', '', t)                                          # the condition of an "If …," title
    bare = re.sub(r"(?:[\w'/-]+(?: [\w'/-]+){0,2}, )+[\w'/-]+(?: [\w'/-]+){0,2},? (?:and|or) ", 'LIST ', bare)   # "A, B and C" is one thing
    if len(re.findall(r'[,;:] | then | and ', bare)) >= 2:
        out.append(f'step {k}: the title holds several facts ("{t}"): keep the one the story needs, the rest goes '
                   f'in the lead or details (restep {k} title "…")')
    inline = [m.group(0) for m in re.finditer(LINK, s.get('lead', '') + '\n' + s.get('details', ''))]
    if inline:
        out.append(f'step {k}: {len(inline)} path:line in the text ({", ".join(inline[:2])}{", …" if len(inline) > 2 else ""}): '
                   f'in prose name the code by symbol (`runContext`, "the lookup above"); path:line goes in refs only')
    return out


def lead_warning(k, s):
    """The lead is one sentence a reader takes in at a glance; everything else is behind More."""
    lead = s.get('lead', '')
    n, w = len(sentences(lead)), words(lead)
    if n > 1 or w > SOFT_LEAD_WORDS:
        what = ' and '.join(x for x in (f'{n} sentences' if n > 1 else '', f'{w} words' if w > SOFT_LEAD_WORDS else '') if x)
        return (f'step {k}: the lead is {what}; write one sentence of <= {SOFT_LEAD_WORDS} words (the one thing the title '
                f'does not say) and move the rest to details (restep {k} lead "…")')
    return ''


def span_warning(k, s):
    """A step marks the lines that prove its title (the call, the branch); a mark longer than a screen points
    at nothing. The rest of the function stays reachable through the step's box."""
    r = s.get('range') or {}
    n = r.get('end', 0) - r.get('start', 0) + 1
    if n > SOFT_RANGE_LINES:
        return (f'step {k}: marks {n} lines ({s.get("file")}:{r["start"]}-{r["end"]}); aim for <= {SOFT_RANGE_LINES}: '
                f'the lines that matter (the call, the branch), the whole function is the box '
                f'(restep {k} range <file> <start> <end>)')
    return ''


def repeat_warning(k, s):
    rep = lead_repeats_title(s.get('title', ''), s.get('lead', ''))
    if rep:
        return (f'step {k}: the lead repeats the title ({round(rep * 100)}% of the title\'s words come again): say '
                f'only what the title does not (why it matters, what happens next, the number) (restep {k} lead "…")')
    return ''


# --- step extras (format: media/journey-scene.js, src/codeLinkText.ts, src/valueHints.ts): a step's
# animation (`scene`), its code links (`links`: phrases of the lead/details that open the lines doing that part) and
# its value hints (`values`: what a variable holds in the example run, above its line). Every line is read from the
# source by the commands below; the author never types a line's text.
FIND_NEAR = 400        # beatLine.ts findLine: how far the same trimmed text is still taken for a line that moved
MIN_BEATS, SOFT_BEATS, MAX_BEATS = 3, 6, 7
MAX_ACTORS = 4
SOFT_LINK_LINES = 15
MAX_VALUE, SOFT_NOTE = 40, 60          # valueHints.ts cuts a value at 40 (capValue); a note is a few words
VALUE_NEAR, BEAT_NEAR = 25, 12         # a hint sits near the step's lines, or near a beat or link of the step
SOFT_CAPTION, SOFT_CAPTION_ALL = 70, 110
MAX_CHECKS, MAX_CHECK, MAX_ROWS, MAX_TERM_LINE = 5, 28, 3, 36
MAX_PACKET = 24
# What each actor type reads (the builders in journey-scene.js), what a beat's `set` may change on it, and the beat's own
# keys. Anything else is ignored by the engine.
APP_OLD_KEYS = {'test', 'env', 'findings', 'timeline', 'status', 'provider', 'chat'}     # older journeys' flat fields
ACTOR_KEYS = {'app': {'brand', 'logo', 'tabs', 'dialog', 'detail', 'signin', 'pages', 'screen'} | APP_OLD_KEYS,
              'service': {'fn', 'checks'}, 'table': {'rows'}, 'cluster': {'pods', 'inner'},
              'browser': {'url', 'title', 'shop', 'products', 'button', 'cart', 'markLabel', 'lock'}, 'terminal': {'lines'},
              'file': {'from', 'lines'}, 'chat': {'messages'}, 'queue': {'slots', 'cap'}, 'gauge': {'max', 'unit', 'used'}}
TYPE_ALIAS = {'console': 'app'}                      # the app actor's type in older journeys
COMMON_KEYS = {'id', 'type', 'col', 'label', 'sub'}
SET_KEYS = {'app': {'screen', 'status', 'tone', 'findings', 'cards', 'events', 'newFinding', 'newCard', 'newEvent', 'ended',
                    'notice', 'redirecting', 'busy', 'pane', 'desktop', 'picture', 'chat', 'newChat', 'typing', 'rows',
                    'hiRow', 'banner'},
            'service': {'done'}, 'table': {'show', 'hi', 'chips'},
            'cluster': {'mark', 'made', 'gone', 'inner', 'innerMade', 'innerMark', 'innerGone'},
            'browser': {'click', 'mark', 'lock'}, 'terminal': {'show', 'hi'}, 'file': {'show', 'hi', 'text'},
            'chat': {'show', 'hi'}, 'queue': {'fill', 'drop', 'note'}, 'gauge': {'used', 'want', 'note'}}
BEAT_KEYS = {'focus', 'caption', 'muted', 'set', 'packet', 'click', 'flash', 'code', 'example', 'hold'}
SCREENS = ('dialog', 'detail', 'signin')             # and the names of the actor's own `pages`
SCREEN_ALIAS = {'run-dialog': 'dialog', 'run-page': 'detail', 'login': 'signin'}     # older journeys' screen names
PANES = ('picture', 'chat', 'desktop')               # desktop: the older name of picture
TONES = ('neutral', 'active', 'good', 'bad')
LOCKS = ('ok', 'warn')
DEFAULT_LABEL = {'app': ('Web app', ''), 'browser': ('Browser', ''), 'terminal': ('Terminal', ''),
                 'file': ('file', ''), 'chat': ('Chat', '')}
STARTS_EMPTY = ('terminal', 'chat')                  # nothing is shown until a beat sets `show`
# Text that must fit its box (journey-scene.css; the box is drawn at about scale 1 in a 400 px scene): characters, at
# an average glyph width calibrated with test/journey-scene/check.mjs. Over these a label is cut or sticks out of its
# box (the panel check fails).
LABEL_CHARS = {'service': 38, 'app': 42, 'browser': 42, 'terminal': 42, 'file': 42, 'chat': 42, 'table': 46,
               'cluster': 46, 'queue': 46, 'gauge': 46}
# The app window (.ap-win: 304 px wide, 207 px tall under its label). The top bar holds the logo, the brand (12.5 px
# bold, about 7.8 px a character) and the tabs (12 px, about 6.8 px a character, 12 px apart) in TOP_PX.
TOP_PX, BRAND_PX, TAB_PX, TAB_GAP, MAX_TABS, TAB_CHARS = 280, 7.8, 6.8, 12, 3, 10
DIALOG_CHARS = {'title': 24, 'item': 24, 'button': 18}
DIALOG_LINES, LINE_KEY, LINE_VALUE = 2, 12, 18
DETAIL_CHARS = {'title': 22, 'status': 12, 'empty': 30, 'picture': 38, 'placeholder': 32}
TITLE_CHIP = 30                                      # a page's title and its status chip share one line
SIGNIN_CHARS = {'title': 22, 'notice': 40, 'provider': 10, 'button': 24}
OLD_CHARS = {'test': 22, 'env': LINE_VALUE, 'provider': SIGNIN_CHARS['provider'], 'status': DETAIL_CHARS['status']}
BROWSER_CHARS = {'url': 32, 'title': 20, 'shop': 20, 'button': 13, 'cart': 10, 'markLabel': 18}
SHOP_TOP = 26                                        # the shop's name and the cart share one line
FN_CHARS, CARD_CHARS, TIMELINE_CHARS, PRODUCT_CHARS, INNER_LABEL_CHARS = 28, 32, 36, 14, 40
ROW_PX, PODS_PX, INNER_PODS_PX = 300, 320, 296
FILE_CHARS, FILE_NUM_CHARS, FILE_VIEW = 34, 30, 8     # .fl-line: 12 px mono, cut beyond; a gutter when `from` is set
CHAT_CHARS, CHAT_TOOL_CHARS, CHAT_VIEW = 38, 32, 4    # .ch-msg: one line, 13 px (a tool call 12 px mono), cut beyond
APP_CHAT_CHARS, NOTE_CHARS, QUEUE_SLOTS = 32, 44, 8
PAGE_ROWS, PAGE_KEY, PAGE_VALUE, PAGE_BANNER = 4, 12, 20, 38
PAGE_ITEMS = 4                                       # rows, the banner and the button: what fits under the title
PAGE_CHARS = {'title': 22, 'chip': 12, 'tab': TAB_CHARS, 'button': 20}


def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def find_line(lines, line, text):
    """BeatLine.ts findLine: the written line if it still says `text` (trimmed), else the nearest line within
    FIND_NEAR that does; -1 when none does. 0-based."""
    want = (text or '').strip()
    if not want:
        return -1
    at = line - 1
    if 0 <= at < len(lines) and lines[at].strip() == want:
        return at
    for d in range(1, FIND_NEAR + 1):
        for i in (at - d, at + d):
            if 0 <= i < len(lines) and lines[i].strip() == want:
                return i
    return -1


def source_line(repo, rel, line, what):
    """The trimmed source line `rel`:`line` for a write; refuses a missing file, a line outside it and a blank line."""
    if not str(line).lstrip('-').isdigit():
        refuse(f'{what}: line "{line}" is not a number')
    line = int(line)
    p = os.path.join(repo, rel)
    if not os.path.isfile(p):
        refuse(f'{what}: {rel} is not a file in {repo}')
    ls = lines_of(repo, rel)
    if not 1 <= line <= len(ls):
        refuse(f'{what}: {rel} has {len(ls)} lines, there is no line {line}')
    if not ls[line - 1].strip():
        refuse(f'{what}: {rel}:{line} is a blank line (the extension finds a line again by its text): pick the line itself')
    return ls[line - 1].strip()


def odd_line(text, rel):
    """What makes a line a poor one to light for a beat ('' = a fine line): a comment, a lone closing brace, or a
    function signature (the line that DOES the thing is in the body)."""
    py = rel.endswith('.py')
    if not rel.endswith(CODE_EXT):
        return ''
    c = code_of(text, py)
    if not c:
        return 'a comment'
    if re.fullmatch(r'[\])}]+[;,)]*', c):
        return 'a lone closing brace'
    sig = (r'^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:func|function\*?|def|fn|class)(?:\s+[\w$(*]|\()',
           r'^(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*(?::[^=]+)?=>\s*\{$',
           r'^(?:(?:public|private|protected|static|async|override|get|set)\s+)*(?!(?:if|for|while|switch|catch|return|else)\b)'
           r'#?[\w$]+\s*(?:<[^(]*>)?\(.*\)\s*(?::\s*[^={]+)?\{$')
    if any(re.match(x, c) for x in sig):
        return 'a function signature'
    return ''


def _taken(text, i, n):
    """CodeLinkText.ts taken(): inside a Markdown link or a code span."""
    return any(i < m.end() and i + n > m.start() for m in re.finditer(r'\[[^\]]*\]\([^)]*\)|`[^`]*`', text))


def placed_links(s, links=None):
    """CodeLinkText.ts linkPhrases over the lead, then the details: the indexes of the links that become links (each
    phrase's first free occurrence, outside backticks and Markdown links, not overlapping an earlier phrase)."""
    links = s.get('links', []) if links is None else links
    used = set()
    for text in (s.get('lead', ''), s.get('details', '')):
        cuts = []
        for i, l in enumerate(links):
            ph = str(l.get('phrase', '')).strip()
            if i in used or not ph:
                continue
            frm, at = 0, -1
            while True:
                at = text.find(ph, frm)
                if at < 0 or (not _taken(text, at, len(ph)) and not any(at < c + n and at + len(ph) > c for c, n in cuts)):
                    break
                frm = at + 1
            if at >= 0:
                cuts.append((at, len(ph)))
                used.add(i)
    return used


def why_unplaced(s, l):
    ph = str(l.get('phrase', '')).strip()
    text = s.get('lead', '') + '\n' + s.get('details', '')
    if ph not in text:
        return 'is not in the lead or details (it must be the exact words, same case)'
    if all(_taken(text, m.start(), len(ph)) for m in re.finditer(re.escape(ph), text)):
        return 'occurs only inside backticks or a Markdown link (the extension leaves those alone): pick words outside them'
    return 'overlaps the phrase of an earlier link of this step everywhere it occurs: pick other words'


def link_warnings(k, s):
    """Links of step k whose phrase is no longer a link in its text (after the lead or details changed)."""
    links = s.get('links', [])
    ok = placed_links(s)
    return [f'step {k}: the link "{l.get("phrase")}" ({l.get("file")}:{l.get("start")}) is dead: the phrase '
            f'{why_unplaced(s, l)} (rmlink {k} "{l.get("phrase")}", or link {k} "<new phrase>" {l.get("file")} '
            f'{l.get("start")} {l.get("end")})' for i, l in enumerate(links) if i not in ok]


def value_far(s, v):
    """True when value hint v is neither within VALUE_NEAR lines of the step's range nor BEAT_NEAR of a beat or a
    link of the same step (same file)."""
    r = s.get('range') or {}
    if v.get('file') == s.get('file') and r.get('start', 0) - VALUE_NEAR <= v.get('line', 0) <= r.get('end', 0) + VALUE_NEAR:
        return False
    near = [b['code'].get('line') for b in (s.get('scene') or {}).get('beats', []) if isinstance(b, dict)
            and isinstance(b.get('code'), dict) and b['code'].get('file') == v.get('file')]
    for l in s.get('links', []):
        if l.get('file') == v.get('file'):
            if l.get('start', 0) <= v.get('line', 0) <= l.get('end', 0):
                return False
            near += [l.get('start'), l.get('end')]
    return not any(is_int(x) and abs(v.get('line', 0) - x) <= BEAT_NEAR for x in near)


def value_issues(k, s, v, others):
    """(level, text) for one value hint; level P = a PROBLEM (refused when written), R = refused when written and a
    WARNING in check, W = a WARNING."""
    out = []
    name, val = str(v.get('name', '')), str(v.get('value', ''))
    where = f'step {k}: value {name} at {v.get("file")}:{v.get("line")}'
    if not name.strip() or not val.strip():
        out.append(('P', f'{where}: a hint needs a name and a value'))
    if name and name not in str(v.get('text', '')):
        out.append(('R', f'{where}: the line does not mention "{name}" ("{str(v.get("text", ""))[:70]}"): a hint sits on '
                         f'the line that declares or uses that variable'))
    if len(val) > MAX_VALUE:
        out.append(('R', f'{where}: the value is {len(val)} chars (max {MAX_VALUE}; the extension cuts it there): '
                         f'"{val}": say less ("[2 items]", "ord_7f3a…")'))
    if len(str(v.get('note', ''))) > SOFT_NOTE:
        out.append(('W', f'{where}: the note is {len(v["note"])} chars (aim for <= {SOFT_NOTE}: a few words on what '
                         f'the value IS in this run)'))
    twin = [o for o in others if o is not v and o.get('file') == v.get('file') and o.get('line') == v.get('line')]
    if twin:
        out.append(('P', f'{where}: {twin[0].get("name")} already has a hint on that line (one hint per line: the '
                         f'CodeLens row holds one)'))
    if value_far(s, v):
        out.append(('W', f'{where} is neither within {VALUE_NEAR} lines of the step\'s range nor within {BEAT_NEAR} '
                         f'lines of a beat or link of this step: the reader never sees it there (rmvalue {k} {name})'))
    return out


def scene_issues(k, s, sc):
    """(level, text) for a step's scene, against what journey-scene.js draws (levels as in value_issues)."""
    out = []
    W = lambda m: out.append(('W', f'step {k} scene: {m}'))
    R = lambda m: out.append(('R', f'step {k} scene: {m}'))
    P = lambda m: out.append(('P', f'step {k} scene: {m}'))
    if not isinstance(sc, dict):
        P('must be an object {actors, wires, beats}')
        return out
    for key in set(sc) - {'actors', 'wires', 'beats'}:
        R(f'"{key}" is not part of a scene (actors, wires, beats); the engine ignores it')
    actors, beats, wires = sc.get('actors'), sc.get('beats'), sc.get('wires', [])
    if not isinstance(actors, list) or not actors or not isinstance(beats, list) or not beats:
        P('needs a non-empty "actors" list and a non-empty "beats" list')
        return out
    ids = {}
    for i, a in enumerate(actors):
        if not isinstance(a, dict) or not isinstance(a.get('id'), str) or not a.get('id'):
            P(f'actors[{i}] needs a string "id"')
            continue
        aid, t = a['id'], TYPE_ALIAS.get(a.get('type'), a.get('type'))
        if aid in ids:
            P(f'two actors have the id "{aid}"')
        if aid == 'all':
            P('"all" is not an actor id')
        ids[aid] = a
        if t not in ACTOR_KEYS:
            P(f'actor {aid}: type {t!r} does not exist (types: {", ".join(ACTOR_KEYS)}): the engine skips it')
            continue
        extra = set(a) - COMMON_KEYS - ACTOR_KEYS[t]
        if extra:
            R(f'actor {aid}: {", ".join(sorted(extra))} {"is" if len(extra) == 1 else "are"} not read by a {t} '
              f'(it reads {", ".join(sorted(ACTOR_KEYS[t]))}): the engine ignores it')
        if 'col' in a and not (is_int(a['col']) and 0 <= a['col'] <= 3):
            P(f'actor {aid}: "col" is a column number 0-3')
        dl, ds = DEFAULT_LABEL.get(t, (aid, ''))
        lab = str(a.get('label') or dl) + (f' · {a.get("sub") or ds}' if (a.get('sub') or ds) else '')
        if len(lab) > LABEL_CHARS[t]:
            P(f'actor {aid}: label and sub "{lab}" are {len(lab)} chars; a {t} box holds about {LABEL_CHARS[t]} on '
              f'its top line: shorten them')
        lst = lambda key: a.get(key) if isinstance(a.get(key), list) else []
        if t == 'service':
            if len(str(a.get('fn', ''))) > FN_CHARS:
                P(f'actor {aid}: fn "{a["fn"]}" is {len(a["fn"])} chars (max {FN_CHARS}: the name and "()")')
            cs = lst('checks')
            if len(cs) > MAX_CHECKS:
                P(f'actor {aid}: {len(cs)} checks (max {MAX_CHECKS})')
            for c in cs:
                if len(str(c)) > MAX_CHECK:
                    P(f'actor {aid}: check "{c}" is {len(str(c))} chars (max {MAX_CHECK})')
        elif t == 'table':
            rows = lst('rows')
            if len(rows) > MAX_ROWS:
                P(f'actor {aid}: {len(rows)} rows (max {MAX_ROWS})')
            for r in rows:
                if not isinstance(r, dict) or not isinstance(r.get('id'), str):
                    P(f'actor {aid}: a row is {{"id": "…", "chips": ["…"], "old"?: true}}')
                    continue
                px = row_px(r['id'], r.get('chips') or [])
                if px > ROW_PX:
                    P(f'actor {aid}: row "{r["id"]}" with chips {r.get("chips")} is about {px} px wide (the row holds '
                      f'{ROW_PX}): a shorter id or fewer, shorter chips')
        elif t == 'cluster':
            pods = lst('pods')
            for msg in pods_issues(pods, PODS_PX, 32, 12):
                P(f'actor {aid}: {msg}')
            inner = a.get('inner')
            if inner is not None:
                if not isinstance(inner, dict):
                    P(f'actor {aid}: "inner" is {{"label", "sub"?, "ghost"?, "pods"}}')
                else:
                    il = str(inner.get('label') or 'cluster') + (f' · {inner["sub"]}' if inner.get('sub') else '')
                    if len(il) > INNER_LABEL_CHARS:
                        P(f'actor {aid}: inner label and sub "{il}" are {len(il)} chars (about {INNER_LABEL_CHARS} fit)')
                    for msg in pods_issues(inner.get('pods') if isinstance(inner.get('pods'), list) else [], INNER_PODS_PX, 24, 10):
                        P(f'actor {aid}: inner {msg}')
                    if len(pods) > 2:
                        P(f'actor {aid}: {len(pods)} pods above an inner cluster (1 or 2 fit)')
        elif t == 'app':
            for msg in app_issues(a):
                (W if msg.startswith('W:') else P)(f'actor {aid}: {msg.removeprefix("W:")}')
        elif t == 'browser':
            for key, n in BROWSER_CHARS.items():
                if len(str(a.get(key, ''))) > n:
                    P(f'actor {aid}: {key} "{a[key]}" is {len(str(a[key]))} chars (max {n})')
            name, cart = str(a.get('title') or a.get('shop') or 'Shop'), str(a.get('cart') or 'Cart 0')
            if len(name) + len(cart) > SHOP_TOP:
                P(f'actor {aid}: title "{name}" and cart "{cart}" share one line: {len(name) + len(cart)} chars (max {SHOP_TOP})')
            for p in lst('products')[:2]:
                nm = p[0] if isinstance(p, list) and p else p
                if len(str(nm)) > PRODUCT_CHARS:
                    P(f'actor {aid}: product "{nm}" is {len(str(nm))} chars (max {PRODUCT_CHARS})')
        elif t == 'file':
            lim = FILE_NUM_CHARS if a.get('from') else FILE_CHARS
            if 'from' in a and not (is_int(a['from']) and a['from'] >= 1):
                P(f'actor {aid}: "from" is the number of the first line (omit it for a folder or a made-up document)')
            for ln in lst('lines'):
                if len(str(ln)) > lim:
                    P(f'actor {aid}: line "{ln}" is {len(str(ln))} chars (max {lim}{" with line numbers" if a.get("from") else ""}; '
                      f'a longer one is cut)')
        elif t == 'chat':
            for m in lst('messages'):
                if not (isinstance(m, dict) and m.get('from') in ('me', 'them') and isinstance(m.get('text'), str)):
                    P(f'actor {aid}: a message is {{"from": "me" | "them", "text": "…", "tool"?: true}}')
                    continue
                lim = CHAT_TOOL_CHARS if m.get('tool') else CHAT_CHARS
                if len(m['text']) > lim:
                    P(f'actor {aid}: message "{m["text"]}" is {len(m["text"])} chars (max {lim}{" for a tool call" if m.get("tool") else ""}; one line)')
        elif t == 'queue':
            if 'slots' in a and not (is_int(a['slots']) and 1 <= a['slots']):
                P(f'actor {aid}: "slots" is a number of places ({QUEUE_SLOTS} are drawn at most; "cap" says the real size)')
            if len(str(a.get('cap', ''))) > NOTE_CHARS:
                P(f'actor {aid}: cap "{a["cap"]}" is {len(str(a["cap"]))} chars (max {NOTE_CHARS})')
        elif t == 'gauge':
            if not (isinstance(a.get('max'), (int, float)) and a['max'] > 0):
                P(f'actor {aid}: "max" is the limit, a number above 0')
        elif t == 'terminal':
            for ln in lst('lines'):
                if len(str(ln)) > MAX_TERM_LINE:
                    P(f'actor {aid}: line "{ln}" is {len(str(ln))} chars (max {MAX_TERM_LINE}; a longer one is cut): '
                      f'shorten it, keeping what the code prints')
    if len(actors) > MAX_ACTORS:
        R(f'{len(actors)} actors (max {MAX_ACTORS}: the parts this step touches; one box per part)')
    pairs = set()
    if not isinstance(wires, list):
        P('"wires" is a list of [fromId, toId] pairs')
        wires = []
    for w in wires:
        if not (isinstance(w, list) and len(w) == 2 and all(x in ids for x in w)):
            P(f'wire {w}: a wire is [fromId, toId] between two actors of this scene')
            continue
        pairs |= {tuple(w), tuple(w[::-1])}
    if len(beats) > MAX_BEATS:
        P(f'{len(beats)} beats (max {MAX_BEATS}; aim for {MIN_BEATS}-{SOFT_BEATS}): one thing happening per beat')
    elif len(beats) > SOFT_BEATS:
        W(f'{len(beats)} beats (aim for {MIN_BEATS}-{SOFT_BEATS}): merge two')
    elif len(beats) < MIN_BEATS:
        R(f'{len(beats)} beats (want {MIN_BEATS}-{SOFT_BEATS}); a step with less to show gets no scene (rmscene {k})')
    bare = 0
    shown = {}             # terminal ids -> lines shown so far
    for i, b in enumerate(beats, 1):
        bn = f'beat {i}'
        if not isinstance(b, dict):
            P(f'{bn} is not an object')
            continue
        extra = set(b) - BEAT_KEYS
        if extra:
            R(f'{bn}: {", ".join(sorted(extra))} {"is" if len(extra) == 1 else "are"} not part of a beat '
              f'({", ".join(sorted(BEAT_KEYS))})')
        f = b.get('focus')
        if f == 'all':
            P(f'{bn}: focus "all" (a zoomed-out view too small to read): focus the one actor whose line the beat lights')
        elif f not in ids:
            P(f'{bn}: focus {f!r} is not an actor of this scene ({", ".join(ids)})')
        cap, mut = str(b.get('caption', '')).strip(), str(b.get('muted', '')).strip()
        if not cap:
            P(f'{bn}: no caption')
        elif len(cap) > SOFT_CAPTION:
            W(f'{bn}: the caption is {len(cap)} chars (aim for < 60, max ~{SOFT_CAPTION}: read in three seconds); '
              f'move a clause to "muted" or cut it: "{cap}"')
        elif len(cap) + len(mut) > SOFT_CAPTION_ALL:
            W(f'{bn}: caption and muted are {len(cap) + len(mut)} chars together (aim for <= {SOFT_CAPTION_ALL}: read '
              f'in three seconds)')
        st = b.get('set', {})
        if not isinstance(st, dict):
            P(f'{bn}: "set" is {{actorId: {{…}}}}')
            st = {}
        for aid, ch in st.items():
            a = ids.get(aid)
            if a is None:
                P(f'{bn}: set on {aid!r}, which is not an actor of this scene')
                continue
            t = TYPE_ALIAS.get(a.get('type'), a.get('type'))
            if not isinstance(ch, dict):
                P(f'{bn}: set.{aid} is an object of what changes')
                continue
            bad = set(ch) - SET_KEYS.get(t, set())
            if bad:
                R(f'{bn}: set.{aid}: {", ".join(sorted(bad))} does nothing on a {t} (it takes '
                  f'{", ".join(sorted(SET_KEYS.get(t, set())))})')
            for m in state_issues(a, ch):
                R(f'{bn}: set.{aid}: {m}')
            if t in STARTS_EMPTY and 'show' in ch:
                shown[aid] = ch['show']
        if f in ids and ids[f].get('type') in STARTS_EMPTY and not shown.get(f):
            W(f'{bn}: focus on {ids[f]["type"]} {f} while none of its lines is shown yet (set {{"{f}": {{"show": 1}}}})')
        p = b.get('packet')
        if p is not None:
            if not (isinstance(p, dict) and p.get('from') in ids and p.get('to') in ids):
                P(f'{bn}: a packet is {{from, to, label}} between two actors of this scene')
            elif (p['from'], p['to']) not in pairs:
                P(f'{bn}: packet {p["from"]} -> {p["to"]} has no wire to travel on (add ["{p["from"]}", "{p["to"]}"] '
                  f'to wires): the engine does not show it')
            elif len(str(p.get('label', ''))) > MAX_PACKET:
                W(f'{bn}: packet label "{p["label"]}" is {len(str(p["label"]))} chars (aim for <= {MAX_PACKET})')
        types = {TYPE_ALIAS.get(x.get('type'), x.get('type')) for x in ids.values()}
        v = b.get('click')
        if v and not types & {'browser', 'app'}:
            R(f'{bn}: "click" does nothing without a browser or app actor')
        elif v and 'app' not in types and (v not in ids or ids[v].get('type') != 'browser'):
            R(f'{bn}: click {v!r} must be the id of the browser actor the click happens in')
        v = b.get('flash')
        if v and (v not in ids or ids[v].get('type') != 'browser'):
            R(f'{bn}: flash {v!r} must be the id of a browser actor (the screenshot flash)')
        c = b.get('code')
        if c is None:
            bare += 1
            if bare == 2:
                W(f'beats {i - 1} and {i} have no code line: never two in a row (a beat without code is for something '
                  f'with no line in this repo; keep those rare)')
        else:
            bare = 0
            if not (isinstance(c, dict) and isinstance(c.get('file'), str) and is_int(c.get('line'))):
                P(f'{bn}: code is {{"file": "<repo path>", "line": <n>}} (the script reads the text)')
    if not any(isinstance(b, dict) and b.get('code') for b in beats):
        P('no beat has a code line: a scene lights the code that does what it shows')
    return out


def screens_of(a):
    """The app screens there are: the three built in (also by their older names) and the actor's own `pages`."""
    return SCREENS + tuple(SCREEN_ALIAS) + tuple(a.get('pages', {}) if isinstance(a.get('pages'), dict) else ())


def sub_of(a, key):
    """One of the app actor's screen objects (`dialog`, `detail`, `signin`); {} when it has none."""
    return a.get(key) if isinstance(a.get(key), dict) else {}


def app_list(a, key, old):
    """A list of the app's detail page (`detail.<key>`), else the older flat field `old`."""
    v = sub_of(a, 'detail').get(key)
    v = v if v is not None else a.get(old)
    return v if isinstance(v, list) else []


def app_issues(a):
    """What in an app actor does not fit the window it draws (or is not what the engine reads); "W:" = a WARNING."""
    out = []
    long = lambda what, v, n: out.append(f'{what} "{v}" is {len(str(v))} chars (max {n})') if len(str(v)) > n else None
    brand = str(a.get('brand') or 'App')
    logo = str(a.get('logo') or brand[:1])
    if len(logo) > 2:
        out.append(f'logo "{logo}" is 1 or 2 letters')
    tabs = a.get('tabs', [])
    if not isinstance(tabs, list) or len(tabs) > MAX_TABS or not all(isinstance(x, str) for x in tabs):
        out.append(f'"tabs" is a list of at most {MAX_TABS} short names')
        tabs = []
    for x in tabs:
        long('tab', x, TAB_CHARS)
    top = (28 if len(logo) > 1 else 20) + 16 + BRAND_PX * len(brand) + (sum(TAB_PX * len(x) for x in tabs) + TAB_GAP * (len(tabs) - 1) if tabs else 0)
    if top > TOP_PX:
        out.append(f'brand "{brand}" and tabs {tabs} are about {round(top)} px in the top bar ({TOP_PX} fit): shorter names or fewer tabs')
    if a.get('screen') and a['screen'] not in screens_of(a):
        out.append(f'screen {a["screen"]!r} does not exist ({", ".join(screens_of(a))})')
    for key, allowed in (('dialog', {'tab', 'title', 'item', 'lines', 'button'}),
                         ('detail', {'tab', 'title', 'status', 'tone', 'empty', 'cards', 'timeline', 'picture', 'placeholder', 'chat'}),
                         ('signin', {'title', 'notice', 'provider', 'button'})):
        if key in a and not isinstance(a[key], dict):
            out.append(f'"{key}" is an object ({", ".join(sorted(allowed))})')
        extra = set(sub_of(a, key)) - allowed
        if extra:
            out.append(f'{key}: {", ".join(sorted(extra))} is not read (it reads {", ".join(sorted(allowed))})')
        tab = sub_of(a, key).get('tab')
        if tab is not None and tabs and tab not in tabs:
            out.append(f'{key} tab {tab!r} is not one of its tabs {tabs}')
    for key, n in OLD_CHARS.items():
        long(key, a.get(key, ''), n)
    dg, dt, sg = sub_of(a, 'dialog'), sub_of(a, 'detail'), sub_of(a, 'signin')
    for key, n in DIALOG_CHARS.items():
        long(f'dialog {key}', dg.get(key, ''), n)
    lines = dg.get('lines', [])
    if not isinstance(lines, list) or len(lines) > DIALOG_LINES:
        out.append(f'dialog "lines" is a list of at most {DIALOG_LINES} [label, value] pairs')
        lines = []
    for ln in lines:
        if not (isinstance(ln, list) and len(ln) == 2):
            out.append('dialog: a line is ["label", "value"]')
        elif len(str(ln[0])) > LINE_KEY or len(str(ln[1])) > LINE_VALUE:
            out.append(f'dialog line {ln}: label max {LINE_KEY} chars, value max {LINE_VALUE}')
    for key, n in DETAIL_CHARS.items():
        long(f'detail {key}', dt.get(key, ''), n)
    title = str(dt.get('title') or dg.get('item') or a.get('test') or 'Item')
    status = str(dt.get('status') or a.get('status') or 'New')
    if len(title) + len(status) > TITLE_CHIP:
        out.append(f'detail title "{title}" and status "{status}" share one line: {len(title) + len(status)} chars (max {TITLE_CHIP})')
    if dt.get('tone') not in (None,) + TONES:
        out.append(f'detail tone {dt["tone"]!r} is one of {", ".join(TONES)}')
    cards = app_list(a, 'cards', 'findings')
    if len(cards) > 2:
        out.append(f'W:{len(cards)} cards; the detail page draws the first 2')
    for c in cards:
        if not isinstance(c, dict):
            out.append('a card is {"sev"?: "low" | "medium" | "high" | "critical", "title": "…"}')
        else:
            long('card', c.get('title', ''), CARD_CHARS)
    for e in app_list(a, 'timeline', 'timeline'):
        long('timeline row', e, TIMELINE_CHARS)
    for m in app_list(a, 'chat', 'chat'):
        if not (isinstance(m, dict) and m.get('from') in ('me', 'them', 'you', 'agent') and isinstance(m.get('text'), str)):
            out.append('a chat message is {"from": "me" | "them", "text": "…"}')
        else:
            long('chat message', m['text'], APP_CHAT_CHARS)
    for key, n in SIGNIN_CHARS.items():
        long(f'signin {key}', sg.get(key, ''), n)
    st = str(sg.get('title') or f'Sign in to {brand}')
    if len(st) > SIGNIN_CHARS['title']:
        out.append(f'the sign-in title "{st}" is {len(st)} chars (max {SIGNIN_CHARS["title"]}): a shorter brand or signin.title')
    pages = a.get('pages', {})
    if not isinstance(pages, dict):
        out.append('"pages" is {name: {tab, title, chip?, tone?, banner?, rows: [[label, value]], button?}}')
        pages = {}
    for name, pg in pages.items():
        if name in SCREENS or name in SCREEN_ALIAS or not isinstance(pg, dict):
            out.append(f'page {name!r} must be an object with a name other than {", ".join(SCREENS + tuple(SCREEN_ALIAS))}')
            continue
        for key, lim in PAGE_CHARS.items():
            long(f'page {name} {key}', pg.get(key, ''), lim)
        if pg.get('tab') is not None and tabs and pg['tab'] not in tabs:
            out.append(f'page {name} tab {pg["tab"]!r} is not one of its tabs {tabs}')
        if len(str(pg.get('title') or name)) + len(str(pg.get('chip', ''))) > TITLE_CHIP:
            out.append(f'page {name}: title and chip share one line (max {TITLE_CHIP} chars together)')
        if pg.get('tone') not in (None,) + TONES:
            out.append(f'page {name} tone {pg["tone"]!r} is one of {", ".join(TONES)}')
        long(f'page {name} banner', pg.get('banner', ''), PAGE_BANNER)
        rows = pg.get('rows', [])
        if len(rows) > PAGE_ROWS:
            out.append(f'page {name} has {len(rows)} rows (the page draws {PAGE_ROWS})')
        items = len(rows) + bool(pg.get('banner')) + bool(pg.get('button'))
        if items > PAGE_ITEMS:
            out.append(f'page {name}: {len(rows)} rows{", a banner" if pg.get("banner") else ""}'
                       f'{", a button" if pg.get("button") else ""}: {PAGE_ITEMS} of these fit under the title')
        for r in rows:
            if not (isinstance(r, list) and len(r) == 2):
                out.append(f'page {name}: a row is ["label", "value"]')
            elif len(str(r[0])) > PAGE_KEY or len(str(r[1])) > PAGE_VALUE:
                out.append(f'page {name} row {r}: label max {PAGE_KEY} chars, value max {PAGE_VALUE}')
    return out


def row_px(rid, chips):
    """A table row's width in px (journey-scene.css .scn-row: id in 13 px mono, min 70; pills of 12 px, gap 9)."""
    return round(max(70, 7.8 * len(str(rid))) + sum(9 + 18 + 6.2 * len(str(c)) for c in chips))


def pods_issues(pods, room, pad, gap):
    """Pods side by side (.scn-pod: nowrap, 14 px label over a 12 px note): problems when they do not fit `room` px."""
    out = []
    w = 0
    for p in pods:
        if not isinstance(p, dict) or not isinstance(p.get('label'), str):
            out.append('a pod is {"label", "note"?, "madeNote"?, "ghost"?}')
            continue
        w += pad + max(7.2 * len(p['label']), 6.4 * max(len(str(p.get('note', ''))), len(str(p.get('madeNote', '')))))
    w += gap * max(0, len(pods) - 1)
    if w > room:
        out.append(f'pods {", ".join(str((p or {}).get("label")) for p in pods if isinstance(p, dict))} are about '
                   f'{round(w)} px side by side ({room} fit): fewer pods, or shorter labels and notes')
    return out


def state_issues(a, ch):
    """Indexes and values a beat's `set` gives an actor that point at nothing it has."""
    out = []
    t = TYPE_ALIAS.get(a.get('type'), a.get('type'))
    n = lambda key: len(a.get(key)) if isinstance(a.get(key), list) else 0
    idx = lambda v, m: is_int(v) and -1 <= v < m

    def need(key, m, what):
        if key in ch and not idx(ch[key], m):
            out.append(f'{key} {ch[key]!r} is not one of its {m} {what} (0-{m - 1}, or -1 for none)')
    if t == 'service' and 'done' in ch and not (is_int(ch['done']) and 0 <= ch['done'] <= n('checks')):
        out.append(f'done {ch["done"]!r}: it has {n("checks")} checks')
    if t == 'table':
        need('hi', n('rows'), 'rows')
        for r in (ch.get('chips') or {}):
            if not (str(r).isdigit() and int(r) < n('rows')):
                out.append(f'chips for row {r!r}: it has {n("rows")} rows')
            elif row_px(a['rows'][int(r)].get('id', ''), ch['chips'][r] or []) > ROW_PX:
                out.append(f'chips {ch["chips"][r]} make row {r} wider than the box ({ROW_PX} px)')
    if t == 'cluster':
        need('mark', n('pods'), 'pods')
        for key in ('made', 'gone'):
            if any(not idx(x, n('pods')) for x in (ch.get(key) or [])):
                out.append(f'{key} {ch[key]}: it has {n("pods")} pods')
        inner = a.get('inner') if isinstance(a.get('inner'), dict) else None
        if inner is None and set(ch) & {'inner', 'innerMade', 'innerMark', 'innerGone'}:
            out.append('inner/innerMade/innerMark/innerGone need an "inner" cluster on the actor')
        elif inner is not None:
            m = len(inner.get('pods') or [])
            need('innerMark', m, 'inner pods')
            for key in ('innerMade', 'innerGone'):
                if any(not idx(x, m) for x in (ch.get(key) or [])):
                    out.append(f'{key} {ch[key]}: the inner cluster has {m} pods')
    if t == 'browser' and ch.get('lock') not in (None, '') + LOCKS:
        out.append(f'lock {ch["lock"]!r} is "ok" (a padlock) or "warn" ("Not secure")')
    if t == 'file':
        m = n('lines')
        if 'show' in ch and not (is_int(ch['show']) and 0 <= ch['show'] <= m):
            out.append(f'show {ch["show"]!r}: it has {m} lines')
        hi = ch.get('hi')
        if hi is not None and not (idx(hi, m) or (isinstance(hi, list) and len(hi) == 2 and all(idx(x, m) for x in hi) and hi[0] <= hi[1])):
            out.append(f'hi {hi!r} is a line index or [first, last] of its {m} lines')
        lim = FILE_NUM_CHARS if a.get('from') else FILE_CHARS
        for i, v in (ch.get('text') or {}).items():
            if not (str(i).isdigit() and int(i) < m):
                out.append(f'text for line {i!r}: it has {m} lines')
            elif len(str(v)) > lim:
                out.append(f'text "{v}" is {len(str(v))} chars (max {lim})')
    if t == 'chat':
        need('hi', n('messages'), 'messages')
        if 'show' in ch and not (is_int(ch['show']) and 0 <= ch['show'] <= n('messages')):
            out.append(f'show {ch["show"]!r}: it has {n("messages")} messages')
    if t == 'queue':
        room = min(QUEUE_SLOTS, a.get('slots') or 6) if is_int(a.get('slots') or 6) else QUEUE_SLOTS
        if 'fill' in ch and not (is_int(ch['fill']) and 0 <= ch['fill'] <= room):
            out.append(f'fill {ch["fill"]!r}: it draws {room} places')
    if t in ('queue', 'gauge') and len(str(ch.get('note', ''))) > NOTE_CHARS:
        out.append(f'note "{ch["note"]}" is {len(str(ch["note"]))} chars (max {NOTE_CHARS}; one line)')
    if t == 'gauge':
        for key in ('used', 'want'):
            if key in ch and not (isinstance(ch[key], (int, float)) and ch[key] >= 0):
                out.append(f'{key} {ch[key]!r} is a number')
    if t == 'terminal':
        need('hi', n('lines'), 'lines')
        if 'show' in ch and not (is_int(ch['show']) and 0 <= ch['show'] <= n('lines')):
            out.append(f'show {ch["show"]!r}: it has {n("lines")} lines')
    if t == 'app':
        if 'screen' in ch and ch['screen'] not in screens_of(a):
            out.append(f'screen {ch["screen"]!r} does not exist ({", ".join(screens_of(a))})')
        if ch.get('pane') not in (None, '') + PANES:
            out.append(f'pane {ch["pane"]!r} is "picture" or "chat" (the detail page; none: cards and timeline)')
        nchat, ncards, nevents = len(app_list(a, 'chat', 'chat')), len(app_list(a, 'cards', 'findings')), len(app_list(a, 'timeline', 'timeline'))
        if 'chat' in ch and not (is_int(ch['chat']) and 0 <= ch['chat'] <= nchat):
            out.append(f'chat {ch["chat"]!r}: the actor has {nchat} chat messages')
        need('newChat', nchat, 'chat messages')
        if len(str(ch.get('typing', ''))) > APP_CHAT_CHARS:
            out.append(f'typing "{ch["typing"]}" is over {APP_CHAT_CHARS} chars')
        for key in ('picture', 'desktop'):
            if len(str(ch.get(key, ''))) > DETAIL_CHARS['picture']:
                out.append(f'{key} "{ch[key]}" is over {DETAIL_CHARS["picture"]} chars')
        most = max([len(p.get('rows') or []) for p in (a.get('pages') or {}).values() if isinstance(p, dict)] or [0])
        if 'rows' in ch and not (is_int(ch['rows']) and 0 <= ch['rows'] <= most):
            out.append(f'rows {ch["rows"]!r}: its pages have at most {most} rows')
        need('hiRow', most, 'page rows')
        for key, m, what in (('findings', ncards, 'cards'), ('cards', ncards, 'cards'), ('events', nevents, 'timeline rows')):
            if key in ch and not (is_int(ch[key]) and 0 <= ch[key] <= m):
                out.append(f'{key} {ch[key]!r}: it has {m} {what}')
        need('newFinding', ncards, 'cards')
        need('newCard', ncards, 'cards')
        need('newEvent', nevents, 'timeline rows')
        if len(str(ch.get('status', ''))) > DETAIL_CHARS['status']:
            out.append(f'status "{ch["status"]}" is over {DETAIL_CHARS["status"]} chars')
        if ch.get('tone') not in (None,) + TONES:
            out.append(f'tone {ch["tone"]!r} is one of {", ".join(TONES)}')
    return out


def link_issues(k, s, l):
    """(level, text) for one code link, without its anchor (checked apart)."""
    out = []
    ph = str(l.get('phrase', ''))
    where = f'step {k}: link "{ph}"'
    r = s.get('range') or {}
    a, b = l.get('start'), l.get('end')
    if is_int(a) and is_int(b) and b < a:
        out.append(('P', f'{where}: end {b} is before start {a}'))
    elif is_int(a) and is_int(b):
        if l.get('file') == s.get('file') and (a, b) == (r.get('start'), r.get('end')):
            out.append(('R', f'{where} points at the step\'s whole own range ({s["file"]}:{a}-{b}): that is already '
                             f'lit; a link opens the few lines that do what the phrase says'))
        if b - a + 1 > SOFT_LINK_LINES:
            out.append(('W', f'{where} marks {b - a + 1} lines ({l.get("file")}:{a}-{b}); aim for 1-8, max ~'
                             f'{SOFT_LINK_LINES}: the lines that do what the phrase says'))
    same = [o for o in s.get('links', []) if o is not l and (o.get('file'), o.get('start'), o.get('end')) == (l.get('file'), a, b)]
    if same:
        out.append(('R', f'{where} points at the same lines as the link "{same[0].get("phrase")}" '
                         f'({l.get("file")}:{a}-{b}): one link per place'))
    if [o.get('phrase') for o in s.get('links', [])].count(ph) > 1:
        out.append(('P', f'{where}: two links of this step have this phrase (only the first can be a link)'))
    return out


def say_issues(issues, write):
    """For a write: refuses on P and R (nothing written); prints the W lines after the echo."""
    stop = [m for lv, m in issues if lv in ('P', 'R')] if write else []
    if stop:
        print('\n'.join('PROBLEM: ' + m for m in stop[1:]))
        refuse(stop[0])
    return [m for lv, m in issues if lv == 'W']


def extras_line(s):
    """`, 5 links, 3 values, scene 5 beats` for the storyline row."""
    sc = s.get('scene') if isinstance(s.get('scene'), dict) else None
    return (f', {len(s.get("links", []))} links, {len(s.get("values", []))} values'
            + (f', scene {len(sc.get("beats") or [])} beats' if sc else ''))


def cmd_link(repo, slug, n, phrase, rel, start, end=''):
    global ECHO
    ECHO = []
    j = load(repo, slug)
    k = step_at(j, n) + 1
    s = j['steps'][k - 1]
    phrase = phrase.strip()
    if not phrase:
        refuse('the phrase is empty: give the words of the lead or details that become the link')
    text = source_line(repo, rel, start, f'link "{phrase}"')
    a = int(start)
    if end and not end.isdigit():
        refuse(f'link "{phrase}": end "{end}" is not a line number')
    b = int(end or start)
    ls = lines_of(repo, rel)
    if not a <= b <= len(ls):
        refuse(f'link "{phrase}": {rel}:{a}-{b} is not a range in the file ({len(ls)} lines)')
    links = list(s.get('links', []))
    old = next((i for i, l in enumerate(links) if l.get('phrase') == phrase), None)
    new = {'phrase': phrase, 'file': rel, 'start': a, 'end': b, 'text': text}
    if old is None:
        links.append(new)
    else:
        links[old] = new
    trial = {**s, 'links': links}
    if links.index(new) not in placed_links(trial):
        refuse(f'link "{phrase}": the phrase {why_unplaced(s, new)}')
    warns = say_issues(link_issues(k, trial, new), True)
    s['links'] = links
    save(repo, slug, j)
    say(f'  {rel} L{a}: {text[:100]}')
    if b > a:
        say(f'  {rel} L{b}: {ls[b - 1].strip()[:100]}')
    wrote(f'step {k} link "{phrase}" -> {rel}:{a}-{b}{" (replaced)" if old is not None else ""}  ({len(links)} links)')
    for w in warns:
        print('WARNING: ' + w)


def cmd_rmlink(repo, slug, n, phrase):
    j = load(repo, slug)
    k = step_at(j, n) + 1
    s = j['steps'][k - 1]
    links = s.get('links', [])
    gone = next((l for l in links if l.get('phrase') == phrase.strip()), None)
    if gone is None:
        sys.exit(f'step {k} has no link "{phrase}" (its links: {", ".join(repr(l.get("phrase")) for l in links) or "none"})')
    s['links'] = [l for l in links if l is not gone]
    if not s['links']:
        s.pop('links')
    save(repo, slug, j)
    print(f'removed step {k} link "{gone["phrase"]}" -> {gone["file"]}:{gone["start"]}-{gone["end"]}')


def cmd_value(repo, slug, n, name, value, rel, line, note=''):
    global ECHO
    ECHO = []
    j = load(repo, slug)
    k = step_at(j, n) + 1
    s = j['steps'][k - 1]
    name, value, note = name.strip(), ' '.join(value_of(value).split()), ' '.join(note.split())
    text = source_line(repo, rel, line, f'value {name}')
    v = {'name': name, 'value': value, **({'note': note} if note else {}), 'file': rel, 'line': int(line), 'text': text}
    vals = list(s.get('values', []))
    old = next((i for i, o in enumerate(vals) if o.get('name') == name and o.get('file') == rel and o.get('line') == int(line)), None)
    if old is None:
        vals.append(v)
    else:
        vals[old] = v
    warns = say_issues(value_issues(k, s, v, vals), True)
    s['values'] = vals
    save(repo, slug, j)
    say(f'  {rel} L{line}: {text[:100]}')
    wrote(f'step {k} value {name} = {shown(value, 60)}{f"  · {note}" if note else ""}  @ {rel}:{line}'
          f'{" (replaced)" if old is not None else ""}')
    for w in warns:
        print('WARNING: ' + w)


def cmd_rmvalue(repo, slug, n, name, line=''):
    j = load(repo, slug)
    k = step_at(j, n) + 1
    s = j['steps'][k - 1]
    hits = [v for v in s.get('values', []) if v.get('name') == name and (not line or str(v.get('line')) == line)]
    if not hits:
        have = ', '.join(f'{v.get("name")} @ {v.get("line")}' for v in s.get('values', [])) or 'none'
        sys.exit(f'step {k} has no value hint {name}{f" on line {line}" if line else ""} (its hints: {have})')
    if len(hits) > 1:
        sys.exit(f'step {k} has {len(hits)} hints {name} (lines {", ".join(str(v["line"]) for v in hits)}): '
                 f'rmvalue {k} {name} <line>')
    s['values'] = [v for v in s['values'] if v is not hits[0]]
    if not s['values']:
        s.pop('values')
    save(repo, slug, j)
    print(f'removed step {k} value {name} @ {hits[0]["file"]}:{hits[0]["line"]}')


def cmd_scene(repo, slug, n):
    global ECHO
    ECHO = []
    j = load(repo, slug)
    k = step_at(j, n) + 1
    s = j['steps'][k - 1]
    raw = body(f'the scene of step {k} (JSON: {{"actors": […], "wires": […], "beats": […]}})')
    try:
        sc = json.loads(raw)
    except json.JSONDecodeError as e:
        refuse(f'the scene is not valid JSON (line {e.lineno} column {e.colno}: {e.msg})')
    issues = scene_issues(k, s, sc)
    if not any(lv == 'P' for lv, _ in issues):
        for i, b in enumerate(sc['beats'], 1):     # the script reads each beat's line; a given text must agree
            c = b.get('code')
            if not c:
                continue
            text = source_line(repo, c['file'], c['line'], f'beat {i}')
            if 'text' in c and str(c['text']).strip() != text:
                refuse(f'beat {i}: {c["file"]}:{c["line"]} reads "{text[:80]}", not "{str(c["text"])[:80]}" (give file and '
                       f'line only; the script reads the text)')
            b['code'] = {'file': c['file'], 'line': c['line'], 'text': text}
            why = odd_line(text, c['file'])
            if why:
                issues.append(('W', f'step {k} scene: beat {i} lights {why} ({c["file"]}:{c["line"]}): light the line '
                                    f'that DOES what the caption says (the call, the assignment, the check)'))
    warns = say_issues(issues, True)
    s['scene'] = {'actors': sc['actors'], 'wires': sc.get('wires', []), 'beats': sc['beats']}
    save(repo, slug, j)
    coded = sum(1 for b in sc['beats'] if b.get('code'))
    print(f'step {k} scene: {len(sc["actors"])} actors ({", ".join(a["id"] for a in sc["actors"])}), '
          f'{len(sc["beats"])} beats ({coded} with code)')
    for i, b in enumerate(sc['beats'], 1):
        c = b.get('code')
        print(f'  beat {i} [{b["focus"]}] {b["caption"]}' + (f'\n      {c["file"]} L{c["line"]}: {c["text"][:90]}' if c else '  (no code)'))
    ECHO = None
    for w in warns:
        print('WARNING: ' + w)


def cmd_rmscene(repo, slug, n):
    j = load(repo, slug)
    k = step_at(j, n) + 1
    s = j['steps'][k - 1]
    if 'scene' not in s:
        sys.exit(f'step {k} has no scene')
    sc = s.pop('scene')
    save(repo, slug, j)
    print(f'removed step {k} scene ({len(sc.get("beats", []))} beats)')


def check_extras(repo, since, j, fix, P, warnings, fixed):
    """`check` on every step's links, values and scene: the static rules above, and each stored line found again the
    way the extension finds it (findLine): moved = WARNING (`fix` repoints it), gone = PROBLEM."""
    def relocate(name, h, fkey, lkey, how, span=None):
        f, ln, text = h.get(fkey), h.get(lkey), str(h.get('text', ''))
        if not isinstance(f, str) or not is_int(ln):
            return P(f'{name}: needs a file and a line number ({how})')
        if not text.strip():
            return P(f'{name}: no "text" (the line it is on); rewrite it with the command ({how})')
        cur = f
        if not os.path.isfile(os.path.join(repo, f)):
            cur = renamed(repo, since, f)
            if cur == f or not os.path.isfile(os.path.join(repo, cur)):
                return P(f'{name}: {f} no longer exists{" (git could not be asked about a rename)" if GIT_ERROR else ""} ({how})')
        ls = lines_of(repo, cur)
        i = find_line(ls, ln, text)
        if i < 0:
            return P(f'{name}: {f}:{ln} no longer reads "{text[:70]}", and no line within {FIND_NEAR} lines does: '
                     f'the code changed; re-read it and rewrite this ({how})')
        if (cur, i + 1) == (f, ln):
            return
        if fix:
            h[fkey], d = cur, i + 1 - ln
            h[lkey] = i + 1
            if span:
                h[span] = h.get(span, ln) + d
            fixed.append(f'{name}: {f}:{ln} -> {cur}:{i + 1}')
        else:
            warnings.append(f'{name} moved to {cur}:{i + 1} (was {f}:{ln}; run check fix)')
    any_extra = False
    some_links = any(x.get('links') for x in j['steps'])
    for k, s in enumerate(j['steps'], 1):
        links, vals, sc = s.get('links', []), s.get('values', []), s.get('scene')
        any_extra = any_extra or bool(links or vals or sc)
        for l in links:
            relocate(f'step {k}: link "{l.get("phrase")}"', l, 'file', 'start', f'link {k} "{l.get("phrase")}" <file> <start> <end>', 'end')
            for lv, m in link_issues(k, s, l):
                (P if lv == 'P' else warnings.append)(m)
        warnings.extend(link_warnings(k, s))      # dead links: refused when written; old files stay valid
        for v in vals:
            relocate(f'step {k}: value {v.get("name")}', v, 'file', 'line', f'value {k} {v.get("name")} "<value>" <file> <line>')
            for lv, m in value_issues(k, s, v, vals):
                (P if lv == 'P' else warnings.append)(m)
        if sc is not None:
            issues = scene_issues(k, s, sc)
            for lv, m in issues:
                (P if lv == 'P' else warnings.append)(m)
            if not any(lv == 'P' for lv, _ in issues):
                for i, b in enumerate(sc['beats'], 1):
                    c = b.get('code')
                    if isinstance(c, dict):
                        relocate(f'step {k} scene: beat {i} ("{str(b.get("caption", ""))[:40]}")', c, 'file', 'line',
                                 f'scene {k}: give the beat its line again')
                        why = odd_line(str(c.get('text', '')), str(c.get('file', '')))
                        if why:
                            warnings.append(f'step {k} scene: beat {i} lights {why} ({c.get("file")}:{c.get("line")}): '
                                            f'light the line that DOES what the caption says')
        if some_links and not links:
            warnings.append(f'step {k}: no code links (aim for 3-6: the phrases of the lead and details that name '
                            f'what a few lines do; link {k} "<phrase>" <file> <start> <end>)')
    if not any_extra and j['steps']:
        warnings.append('no step has code links, value hints or an animation: add them once the steps are written '
                        '(link, value, scene: SKILL.md "Links, values, scenes")')


def cmd_check(repo, slug, flag=''):
    flag = {'--fix': 'fix'}.get(flag, flag)
    if flag not in ('', 'quiet', 'story', 'refs', 'fix'):
        sys.exit('check <repo> <slug> [quiet|story|refs|fix]   quiet: PROBLEM/WARNING lines + a one-line summary; story: storyline only; '
                 'refs: ref lines only; fix: repoint steps/boxes whose code moved')
    fix = flag == 'fix'
    show_links = flag in ('', 'refs', 'fix')
    j = load(repo, slug)
    ids = {n['id']: n for n in j['nodes']}
    problems, warnings, fixed = [], [], []
    since = j.get('commit', '')

    def follow(name, loc, a, how):
        """Loc: a dict with file/start/end (a box's `at`) or a step; a: its anchor. Moves it on fix, else reports."""
        r = loc.get('range', loc)
        st, f, s0, e0, more = where(repo, since, loc['file'], r['start'], r['end'], a)
        old = f'{loc["file"]}:{r["start"]}-{r["end"]}'
        k = name.split()[-1]
        if st == 'moved':
            if fix:
                loc['file'] = f
                r['start'], r['end'] = s0, e0
                if 'anchor' in loc:      # its hash is the same; the line count and the lines around it may not be
                    loc['anchor'] = anchor(repo, f, s0, e0, quiet=True)
                fixed.append(f'{name}: {old} -> {f}:{s0}-{e0}')
            else:
                warnings.append(f'{name} moved to {f}:{s0}-{e0} (was {old}; run check --fix)')
        elif st == 'nofile':
            if GIT_ERROR:
                P(f'{name}: {old} no longer exists; git could not be asked about a rename (see the WARNING): {how}')
            else:
                P(f'{name}: {old} no longer exists (and git shows no rename): {how}')
        elif st in ('changed', 'gone'):
            # changed code may have made the step false; moving the anchor alone would bless it
            if st == 'changed':
                seen, diff = f'now at {f}:{s0}-{e0}, was {old}', old_diff(a, lines_of(repo, f)[s0 - 1:e0])
                verb = 'changed'
            else:
                cur = more.replace('renamed to ', '') if more else loc['file']
                near = nearest(repo, cur, a)
                verb = 'changed' if near else 'is gone'
                if near:
                    seen = f'now about {cur}:{near[0]}-{near[1]}, was {old}'
                    lines = near[2][:12] + ([f'  … {len(near[2]) - 12} more changed lines'] if len(near[2]) > 12 else [])
                    diff = ''.join('\n      ' + d[:140] for d in lines)
                else:
                    head = as_v3(a).get('head', '').split('\n')[0].strip()[:80]
                    seen = (f'was {old}' + (f', file {more}' if more else '') + f'; its first lines ("{head}" …) and '
                            f'its last ones are not found together in the file any more')
                    diff = ''
            if 'range' in loc:
                P(f'{name} "{loc.get("title", "")}": its code {verb} ({seen}). Re-read the code and re-verify the '
                  f'title and the lead: if they are still true, {how}; if not, correct them first '
                  f'(restep {k} title|lead|details "…") and then re-anchor; if the code is gone, rmstep {k}{diff}')
            else:
                P(f'{name}: its code {verb} ({seen}). Re-read the function, check the steps on this box still say '
                  f'what it does, then {how}{diff}')
        return f, s0, e0
    P = problems.append
    kids = {}
    # --- header
    tp = journey_title_problem(j['title'])
    if tp:
        P(f'title "{j["title"]}" {tp} (meta title "…")')
    if not j.get('question', '').strip():
        P('no question (meta question "…")')
    elif question_problem(j['question']):
        P(f'question {question_problem(j["question"])} (meta question "…")')
    warnings.extend(similar_journeys(repo, slug, j))
    sm = sentences(j.get('summary', ''))
    if not sm:
        P('no summary')
    else:
        if len(sm) > 2:
            P(f'summary has {len(sm)} sentences (max 2, plain words; the rest belongs in the steps)')
        if '`' in re.split(SENT, j['summary'].strip())[0]:
            P('summary: code (backticks) in the first sentence; say it in plain words')
    # --- map
    for n in j['nodes']:
        kids.setdefault(n.get('parent', ''), []).append(n)
        want = PARENT_KINDS[n['kind']]
        par = ids.get(n.get('parent', ''))
        if (par['kind'] if par else None) not in want:
            P(f'{n["id"]}: a {n["kind"]} node has parent {par["kind"] if par else "none"}, expected {" or ".join(w or "none" for w in want)}')
        if n['kind'] == 'function' and 'at' not in n:
            P(f'{n["id"]}: a function node needs file:start-end')
        if len(n['label']) > 30:
            P(f'{n["id"]}: label is {len(n["label"])} chars (max 30; paths go in `set {n["id"]} path`)')
        if label_warning(n):
            warnings.append(label_warning(n))
        if node_text_warning(n):
            warnings.append(node_text_warning(n))
        if n['kind'] != 'function' and not n.get('blurb'):
            P(f'{n["id"]}: no blurb (set {n["id"]} blurb "<= 60 chars")')
        if len(n.get('blurb', '')) > 60:
            P(f'{n["id"]}: blurb is {len(n["blurb"])} chars (max 60)')
        if n.get('path') and not os.path.exists(os.path.join(repo, n['path'])):
            to = renamed_path(repo, since, n['path'])          # a box path follows a git rename like an anchor
            if to and os.path.exists(os.path.join(repo, to)):
                if fix:
                    fixed.append(f'{n["id"]} path: {n["path"]} -> {to}')
                    n['path'] = to
                else:
                    warnings.append(f'{n["id"]}: path {n["path"]} moved to {to} (run check --fix)')
            elif GIT_ERROR:
                P(f'{n["id"]}: path {n["path"]} does not exist; git could not be asked about a rename (see the WARNING) '
                  f'(set {n["id"]} path <dir or file>)')
            else:
                P(f'{n["id"]}: path {n["path"]} does not exist (set {n["id"]} path <dir or file>)')
        if 'at' in n:
            follow(f'box {n["id"]}', n['at'], n['at']['anchor'], f'set {n["id"]} at file:start-end')
    for p, ks in kids.items():
        if len(ks) > MAX_CHILDREN:
            P(f'{p or "top level"}: {len(ks)} children (max {MAX_CHILDREN}: group them)')
    seen = set()
    for e in j['edges']:
        name = f'edge {e["from"]} -> {e["to"]}'
        for x in (e['from'], e['to']):
            if x not in ids:
                P(f'{name}: node {x} not defined')
        if ids.get(e['from'], {}).get('kind') == 'store':
            P(f'{name}: "{ids[e["from"]]["label"]}" is a store box and a store never acts; draw the edge from the box '
              f'that reads or polls it (rmedge {e["from"]} {e["to"]}; edge {e["to"]} {e["from"]} "polls …" async)')
        if (e['from'], e['to']) in seen:
            P(f'{name}: twice (one edge per pair; put both hops in the label/detail)')
        seen.add((e['from'], e['to']))
        if len(e['label']) > 30:
            P(f'{name}: label is {len(e["label"])} chars (max 30; the sentence goes in detail)')
        if e['label'].strip().endswith('?'):
            P(f'{name}: label "{e["label"]}" is a question; say what flows or who acts ("reads the status", "writes the receipt")')
        if re.match(r'(?i)^(calls?|uses?|invokes?)\b', e['label'].strip()):
            P(f'{name}: label "{e["label"]}" says nothing; say what for or how ("renders the plan", "start run", "polls every 2 s")')
        if edge_text_warning(e):
            warnings.append(edge_text_warning(e))

    def touched(nid):          # an edge touches this box or something inside it
        if any(nid in (e['from'], e['to']) for e in j['edges']):
            return True
        return any(touched(c['id']) for c in kids.get(nid, []))
    stray = dict(unvisited(j))
    unused = set()             # a box with no step and no edge is one problem, not two
    if len(j['nodes']) > 1:
        for n in j['nodes']:
            if not touched(n['id']):
                if n['id'] in stray:
                    unused.add(n['id'])
                    P(f'{n["id"]}: "{n["label"]}" is unused (no step, no edge): rmnode {n["id"]}')
                else:
                    P(f'{n["id"]}: no edge touches this box; connect it (edge) or drop it')
    # --- steps
    if not MIN_STEPS <= len(j['steps']) <= MAX_STEPS:
        P(f'{len(j["steps"])} steps (want {MIN_STEPS}-{MAX_STEPS}: merge or split)')
    for nid, what in stray.items():
        if nid not in unused:
            P(f'{nid}: {what}')
    labels = {n['label'].lower() for n in j['nodes']}
    links = []

    def up(nid):               # the box and the boxes around it
        out = []
        while nid in ids:
            out.append(nid)
            nid = ids[nid].get('parent', '')
        return out
    lifted = {(a, b) for e in j['edges'] if e['from'] in ids and e['to'] in ids for a in up(e['from']) for b in up(e['to'])}

    def callers(nid):          # every box the path came through to get here (edges followed backwards)
        out, todo = set(), [nid]
        while todo:
            x = todo.pop()
            for e in j['edges']:
                if e['to'] == x and e['from'] not in out and e['from'] != nid:
                    out.add(e['from'])
                    todo.append(e['from'])
        return out

    def joined(x, y):
        ux, uy = up(x), up(y)
        return any(((p, q) in lifted or (q, p) in lifted) for p in ux for q in uy if p not in uy and q not in ux)

    def linked(a, b):
        # an edge joins the two boxes at some level (either way); or the path returns to a box it came through
        # (a caller) and that box has the edge to b; or both have an edge with one same box (a store, a queue).
        if joined(a, b) or b in callers(a) or any(joined(x, b) for x in callers(a) if x in ids and x != b):
            return True
        direct = {(e['from'], e['to']) for e in j['edges']} | {(e['to'], e['from']) for e in j['edges']}
        return any((a, x) in direct and (b, x) in direct for x in ids if x not in (a, b))

    def names(nid):            # the identifiers a call of this box would use: its label and what its first line declares
        n = ids[nid]
        head = as_v3(n['at']['anchor']).get('head', '').split('\n')[0] if 'at' in n else ''
        m = re.search(r'\bfunc\s+(?:\([^)]*\)\s*)?(\w+)|\bfunction\s+(\w+)|\bdef\s+(\w+)|\b(?:const|let|var)\s+(\w+)'
                      r'|^\s*(?:export\s+)?(?:async\s+)?(\w+)\s*\(', head)
        out = {g for g in (m.groups() if m else ()) if g}
        out |= {w for w in re.findall(r'[A-Za-z_]\w{3,}', n['label']) if re.search(r'[a-z][A-Z]|_', w) or ' ' not in n['label']}
        return out

    def mentions(x, y):        # the code of box x names box y
        text = '\n'.join(code_at(repo, ids[x].get('at')))
        return any(re.search(r'\b' + re.escape(w) + r'\b', text) for w in names(y))

    def hop_hint(a, b):
        """How to join two boxes the path jumps between. A call is only suggested when the code of one names the
        other; when they can only meet through a stored record, the hint is a store box, never an arrow between them."""
        direct = {(e['from'], e['to']) for e in j['edges']}
        for x, y in ((a, b), (b, a)):
            st = [s for s in ids.values() if s['kind'] == 'store' and (x, s['id']) in direct]
            if st:             # one side already writes or reads a store box
                return (f'"{ids[x]["label"]}" already has an edge to the store box "{st[0]["label"]}": if "{ids[y]["label"]}" '
                        f'meets it there, edge {y} {st[0]["id"]} "polls … / reads …" async (not an arrow between the two)')
        if 'at' in ids[a] and 'at' in ids[b] and (mentions(a, b) or mentions(b, a)):
            x, y = (a, b) if mentions(a, b) else (b, a)
            return f'"{ids[x]["label"]}" names "{ids[y]["label"]}" in its code: add the hop (edge {x} {y} "…")'
        par = next((p for p in up(a)[1:] + up(b)[1:] if ids[p]['kind'] in PARENT_KINDS['store']), '<system or module>')
        return (f'if they only meet through a record, queue or table of the app (one writes it, the other polls or reads '
                f'it), add a store box both have an edge to: node <id> store "<the record>" {par} --blurb "…"; '
                f'edge {a} <id> "inserts …"; edge {b} <id> "polls every … s" async. Draw an edge between the two only if '
                f'one really reaches the other (a call, an HTTP request, a watch), labelled with how')
    for k in range(1, len(j['steps'])):
        a, b = j['steps'][k - 1]['node'], j['steps'][k]['node']
        if a != b and a in ids and b in ids and not linked(a, b):
            P(f'steps {k} -> {k + 1}: the path jumps from "{ids[a]["label"]}" to "{ids[b]["label"]}" but no edge joins those boxes '
              f'(at any level), not even from a box the path came through: {hop_hint(a, b)}')
    seen_ids, placed = set(), {}
    for k, s in enumerate(j['steps'], 1):
        if not s.get('id') or s['id'] in seen_ids:
            P(f'step {k}: {"duplicate" if s.get("id") else "no"} id (any write command, e.g. `meta`, gives every step one)')
        seen_ids.add(s.get('id'))
    for k, s in enumerate(j['steps'], 1):
        name = f'step {k}'
        kind = ids.get(s['node'], {}).get('kind')
        if kind not in STEP_KINDS:
            P(f'{name}: on a {kind} box; steps go on a function, external or store box (add the function box, then '
              f'stepnode {k} <id>)')
        tp = title_problem(s['title'], labels)
        if tp:
            P(f'{name}: title "{s["title"]}" {tp}')
        lead = s.get('lead', '')
        if not lead:
            P(f'{name}: no lead')
        elif words(lead) > 40:
            P(f'{name}: lead is {words(lead)} words (max 40; move the rest to details)')
        if lead and repeat_warning(k, s):
            warnings.append(repeat_warning(k, s))
        warnings.extend(w for w in (lead and lead_warning(k, s), span_warning(k, s)) if w)
        warnings.extend(style_warnings(k, s))
        if near_ref_warning(k, s):
            warnings.append(near_ref_warning(k, s))
        warnings.extend(ref_warnings(k, s))
        sf, ss, se = follow(name, s, s['anchor'], f'restep {k} range <file> <start> <end>')
        placed.setdefault((sf, ss, se), []).append(k)
        if os.path.isfile(os.path.join(repo, sf)):
            for w in range_warnings(lines_of(repo, sf), sf, ss, se):
                warnings.append(f'{name}: {w} (restep {k} range <file> <start> <end>)')
        at = ids.get(s['node'], {}).get('at')
        if at:
            af, aa, ab = where(repo, since, at['file'], at['start'], at['end'], at['anchor'])[1:4] if not fix else \
                (at['file'], at['start'], at['end'])
            if af == sf and (se < aa or ss > ab):
                P(f'{name}: anchored at {sf}:{ss}-{se}, outside its box "{ids[s["node"]]["label"]}" '
                  f'({aa}-{ab} in the same file): move the step (restep {k} node|range) or fix the box (set {s["node"]} at)')
        refs = s.get('refs', [])
        if len(refs) > 3:
            P(f'{name}: {len(refs)} refs (max 3: keep the lines a reader should open)')
        for ref in refs:
            tok = ref_token(ref)
            if not tok:
                P(f'{name}: ref "{ref}" has no full path:line (or path:line-line) in it: a ref is one sentence with '
                  f'the repo-relative path:line inside (restep {k} refs -)')
                continue
            prob, got = check_ref(repo, tok)
            if prob:
                P(f'{name}: ref {tok}: {prob}')
            links.append((k, 'ref', tok, got, '' if ref_bare(ref) else ref))
        text = lead + '\n' + s.get('details', '')
        for m in re.finditer(LINK, text):
            if m.group(0) in [ref_token(x) for x in refs]:
                continue
            prob, got = check_ref(repo, m.group(0))
            if prob:
                P(f'{name}: link {m.group(0)}: {prob}')
            links.append((k, 'link', m.group(0), got, ''))
        if re.search(r'(?i)\bsteps? \d+\b', text):
            P(f'{name}: the text says "step N"; numbers change when steps move: name the step instead')
        if re.search(r'(?<![\w/.]):\d+(?:-\d+)?\b', plain(text)):
            P(f'{name}: a bare ":NNN" reference; write the full path:line so it is a link and gets checked')

    for (sf, ss, se), ks in placed.items():      # two steps showing the very same lines
        if len(ks) > 1:
            warnings.append(f'steps {" and ".join(map(str, ks))} are anchored on the same lines ({sf}:{ss}-{se}): each '
                            f'step shows the lines its own title is about (restep N range <file> <start> <end>)')
    check_extras(repo, since, j, fix, P, warnings, fixed)
    for note in SHAPE_NOTES:
        P(note)
    if GIT_ERROR and any('git could not be asked about a rename' in p for p in problems):      # said once, as what it is
        warnings.insert(0, f'git failed ({GIT_ERROR}), so renames cannot be followed and `check fix` cannot repoint moved '
                           f'files: run check as the owner of the repo, or `git config --global --add safe.directory '
                           f'{os.path.abspath(repo)}`, then check again')
    if fixed:
        save(repo, slug, j)
    # --- outline
    def show(parent, depth):
        for n in kids.get(parent, []):
            st = [str(k) for k, s in enumerate(j['steps'], 1) if s['node'] == n['id']]
            at = f' @ {n["at"]["file"]}:{n["at"]["start"]}' if 'at' in n else ''
            bl = f' — {n["blurb"]}' if n.get('blurb') else ''
            print(f'{"  " * depth}- [{n["kind"]}] {n["label"]}{bl}{at}{"  steps " + ",".join(st) if st else ""}')
            show(n['id'], depth + 1)
    quiet = flag == 'quiet'
    if not quiet:
        print(f'# {j["title"]}  ({len(j["nodes"])} nodes, {len(j["edges"])} edges, {len(j["steps"])} steps)')
    if flag not in ('story', 'refs', 'quiet'):
        print(f'  {j.get("summary", "")}')
        show('', 0)
        for e in j['edges']:
            print(f'  {e["from"]} -> {e["to"]}: {e["label"]}{"  (async)" if e.get("async") else ""}')
    if flag not in ('refs', 'quiet'):
        print('Storyline (with the map it must answer the question, without opening a step):')
    for k, s in enumerate(j['steps'], 1):
        if flag not in ('refs', 'quiet'):
            print(f'  {k:2}. {s["title"]}   [{s["id"]} on {s["node"]}, {words(s.get("lead", ""))}w, {len(s.get("refs", []))} refs'
                  f'{extras_line(s)}]')
    if show_links:
        last = 0
        for k, kind, ref, got, sentence in links:
            if k != last:        # the step's header, then the lines it points at
                st = j['steps'][k - 1]
                r = st['range']
                print(f'step {k} [{st["node"]}] {st["title"]}   @ {st["file"]}:{r["start"]}-{r["end"]}')
                last = k
            if sentence:         # the sentence the reader sees, then the line it must describe
                print(f'  ref  "{sentence}"')
            for i, (ln, txt) in enumerate(got):
                print(f'  {kind:4} {ref}: {txt}' if i == 0 else f'       … L{ln}: {txt}')
    for f in fixed:
        print('FIXED: ' + f)
    for w in warnings:
        print('WARNING: ' + w)
    for p in problems:
        print('PROBLEM: ' + p)
    if quiet:
        plural = lambda n, w: f'{n} {w}{"" if n == 1 else "s"}'
        warn = f', {plural(len(warnings), "warning")}' if warnings else ''
        print(f'{"FAILED" if problems else "ok"}: {plural(len(j["steps"]), "step")}, {plural(len(problems), "problem")}{warn}')
    sys.exit(1 if problems else 0)


if __name__ == '__main__':
    cmds = {'new': cmd_new, 'node': cmd_node, 'edge': cmd_edge, 'step': cmd_step, 'check': cmd_check,
            'restep': cmd_restep, 'rmstep': cmd_rmstep, 'stepnode': cmd_stepnode, 'set': cmd_set, 'rmnode': cmd_rmnode,
            'rmedge': cmd_rmedge, 'setedge': cmd_setedge, 'reset': cmd_reset, 'migrate': cmd_migrate,
            'meta': cmd_meta, 'range': cmd_range, 'restore': cmd_restore, 'mvstep': cmd_mvstep,
            'migrate-anchors': cmd_migrate_anchors, 'link': cmd_link, 'rmlink': cmd_rmlink, 'value': cmd_value,
            'rmvalue': cmd_rmvalue, 'scene': cmd_scene, 'rmscene': cmd_rmscene}
    def usage(cmd, why):
        """A usage error is exit 2 (a failed validation is exit 1), with the command's own usage line."""
        lines = [l.strip() for l in __doc__.split('\n') if l.strip().startswith(f'journey.py {cmd} ')]
        print(f'{cmd}: {why}', file=sys.stderr)
        for l in lines:
            print(f'usage: {l}', file=sys.stderr)
        sys.exit(2)
    for i, x in enumerate(sys.argv):          # --dir <folder> | --dir=<folder>, anywhere
        if x == '--dir' and i + 1 < len(sys.argv):
            DIR = sys.argv[i + 1]
            del sys.argv[i:i + 2]
            break
        if x.startswith('--dir='):
            DIR = x[6:]
            del sys.argv[i]
            break
    if len(sys.argv) < 2 or sys.argv[1] in ('-h', '--help', 'help'):
        what = sys.argv[2] if len(sys.argv) > 2 and sys.argv[1] == 'help' else ''
        if what == 'all':
            print(__doc__.strip())
        elif what in cmds:
            print(command_help(what))
        elif what:
            print(f'unknown command {what!r}\n\n{short_help()}', file=sys.stderr)
            sys.exit(2)
        else:
            print(short_help())
        sys.exit(0 if len(sys.argv) > 1 else 2)
    if sys.argv[1] not in cmds:
        print(f'unknown command {sys.argv[1]!r} (journey.py alone lists them)', file=sys.stderr)
        sys.exit(2)
    import inspect
    fn = cmds[sys.argv[1]]
    params = list(inspect.signature(fn).parameters.values())
    need = [p.name for p in params if p.default is p.empty and p.kind is p.POSITIONAL_OR_KEYWORD]
    given = sys.argv[2:]
    if len(given) >= 1 and not os.path.isdir(given[0]):
        usage(sys.argv[1], f'missing <repo>: {given[0]!r} is not a directory (the repo comes first)')
    if len(given) < len(need):
        usage(sys.argv[1], 'missing ' + ' '.join(f'<{n}>' for n in need[len(given):]))
    if not any(p.kind is p.VAR_POSITIONAL for p in params) and len(given) > len(params):
        usage(sys.argv[1], f'{len(given) - len(params)} argument(s) too many')
    fn(*given)
