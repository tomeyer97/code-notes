#!/usr/bin/env python3
"""journey.py: writes and checks a code journey, <repo>/journeys/<slug>.json (format v2). `journey.py help` lists
the commands, `journey.py help <command>` gives one's arguments and rules, `journey.py help all` is the manual.

One file, so the skill can ship it alone. Its sections, in order: limits · vocabulary · failing · the run's context ·
git · the extension's rules · the journeys folder · a journey's shape · text · near-duplicate journeys · anchors ·
ranges · refs · style · links and values · scenes · marks · podcasts · check · the commands · the manual and the
command line. The tests are in the Code Notes repository, test/journey-py/.
"""
import argparse, datetime, enum, hashlib, json, math, os, random, re, shutil, string, subprocess, sys
from collections import namedtuple
from contextlib import contextmanager


# ======================================================================================================================
# Limits. Every number a check holds a journey to (`journey.py help limits` lists the ones a writer meets).
# ======================================================================================================================

# The journey
MAX_QUESTION = 80          # chars: the question is the map's one-line header and the list row's tooltip
MAX_TITLE = 28             # chars: the title is a list row that cannot wrap
MAX_SUMMARY_SENTENCES = 2
MIN_STEPS = 6              # `--steps A-B` changes the count `check` wants (a short tour of a change)
MAX_STEPS = 14
# The map
MAX_CHILDREN = 7           # boxes in one box (or at the top level)
MAX_LABEL = 30             # chars of a box label: refused over it
SOFT_LABEL = 20            # chars of a box label (not a function box): a WARNING over it, it wraps or shrinks
MAX_BLURB = 60             # chars of the line shown in a box
MAX_EDGE_LABEL = 30        # chars of an arrow's label
# A step
MAX_STEP_TITLE = 70        # chars
MAX_LEAD_WORDS = 40        # refused over it
SOFT_LEAD_WORDS = 25       # a WARNING over it: the lead is one sentence
SOFT_RANGE_LINES = 15      # lines a step marks: a WARNING over it (the whole function is the box)
REPEAT_SENTENCE = 0.7      # a lead repeats its title when one sentence of it carries this share of the title's words
REPEAT_LEAD = 0.85         # … or the whole lead this share
MAX_REFS = 3
MAX_REF_WORDS = 15         # a ref is one short sentence
NEAR_REF = 20              # lines: a ref this close to the step's own lines shows nothing new
# Links and value hints
SOFT_LINK_LINES = 15       # a link opens 1-8 lines; a WARNING over this
MAX_VALUE = 40             # chars: the extension cuts a value there (valueHints.ts capValue)
SOFT_NOTE = 60             # chars of a value's note: a few words
VALUE_NEAR = 25            # lines: a hint sits this near the step's lines …
BEAT_NEAR = 12             # … or this near a beat or a link of the step
FIND_NEAR = 400            # lines: how far a moved line is still found by its text (the extension's SAME_TEXT_RADIUS)
# Marks
MAX_MARKS = 3              # per step or beat: more, and nothing stands out
MARK_REFIND = 20           # lines: a match is looked for this far up and down when the code moved
MARK_SLACK = 0.05          # s: a podcast mark this close to its segment is in it
# Podcasts
POD_SLACK = 0.05           # s: times this close are the same time
POD_DUR_SLACK = 1          # s, or 1 % of the audio: the declared duration may differ this much from the audio
# A scene, for the Python rules (without node). The helper reads them from the extension's journey schema
# (src/core/format/schema/journey.schema.json); the extension's tests check that these say the same.
MIN_BEATS = 3
SOFT_BEATS = 6             # a WARNING over it
MAX_BEATS = 7
MAX_ACTORS = 4
SOFT_CAPTION = 70          # chars of a caption
SOFT_CAPTION_ALL = 110     # chars of a caption and its muted clause
MAX_CHECKS = 5             # a service's checks
MAX_CHECK = 28             # chars of one check
MAX_ROWS = 3               # a table's rows
MAX_TERM_LINE = 36         # chars of a terminal line
MAX_PACKET = 24            # chars of a packet's label
# Characters that fit a scene's box. Over these a label is cut or sticks out of its box (the panel check fails).
LABEL_CHARS = {'service': 38, 'app': 42, 'browser': 42, 'terminal': 42, 'file': 42, 'chat': 42, 'table': 46,
               'cluster': 46, 'queue': 46, 'gauge': 46}
MAX_TABS = 3
TAB_CHARS = 10
DIALOG_CHARS = {'title': 24, 'item': 24, 'button': 18}
DIALOG_LINES = 2
LINE_KEY = 12              # a dialog line's label
LINE_VALUE = 18            # a dialog line's value
DETAIL_CHARS = {'title': 22, 'status': 12, 'empty': 30, 'picture': 38, 'placeholder': 32}
TITLE_CHIP = 30            # a page's title and its status chip share one line
SIGNIN_CHARS = {'title': 22, 'notice': 40, 'provider': 10, 'button': 24}
OLD_CHARS = {'test': 22, 'env': LINE_VALUE, 'provider': SIGNIN_CHARS['provider'], 'status': DETAIL_CHARS['status']}
BROWSER_CHARS = {'url': 32, 'title': 20, 'shop': 20, 'button': 13, 'cart': 10, 'markLabel': 18}
SHOP_TOP = 26              # the shop's name and the cart share one line
FN_CHARS = 28              # a service's function name
CARD_CHARS = 32
TIMELINE_CHARS = 36
PRODUCT_CHARS = 14
INNER_LABEL_CHARS = 40     # a cluster inside a cluster
FILE_CHARS = 34            # a file's line …
FILE_NUM_CHARS = 30        # … with line numbers (`from`)
CHAT_CHARS = 38            # a chat message
CHAT_TOOL_CHARS = 32       # a chat's tool call
APP_CHAT_CHARS = 32
NOTE_CHARS = 44            # a queue's or gauge's note
QUEUE_SLOTS = 8
PAGE_ROWS = 4
PAGE_KEY = 12
PAGE_VALUE = 20
PAGE_BANNER = 38
PAGE_ITEMS = 4             # rows, the banner and the button: what fits under the title
PAGE_CHARS = {'title': 22, 'chip': 12, 'tab': TAB_CHARS, 'button': 20}


# ======================================================================================================================
# Vocabulary
# ======================================================================================================================

KINDS = ('system', 'module', 'function', 'external', 'store')
# external: something outside this repo (a third-party controller, a cloud API). Its steps are anchored on the repo
# code that depends on it or observes it; it may have no file.
# store: the app's own record, queue or table that two parts meet through (never third-party). A side box in a
# system or a module; it may hold no step (a hand-off box), has no children and is never the `from` of an edge.
STEP_KINDS = ('function', 'external', 'store')      # the boxes a step can sit on
PARENT_KINDS = {'system': (None,), 'module': ('system',), 'external': ('system',), 'store': ('system', 'module'),
                'function': ('system', 'module', 'external')}
# path:line in a ref or in prose. REF takes any path, a bare file name too; LINK (in prose) needs a folder and must
# not be glued to a word.
_DIR = r'[\w.@-]+/'
_FILE = r'[\w.@-]+\.[A-Za-z]{1,6}'
_LINES = r':(\d+)(?:-(\d+))?'
REF = rf'((?:{_DIR})*{_FILE}){_LINES}'
LINK = rf'(?<![\w/])((?:{_DIR})+{_FILE}){_LINES}'

# What a check finds: PROBLEM = refused when written and a PROBLEM in `check`; REFUSE = refused when written and a
# WARNING in `check`; WARN = a WARNING.
PROBLEM, REFUSE, WARN = 'problem', 'refuse', 'warning'
Issue = namedtuple('Issue', 'level text')
# A change `check fix` makes: `apply()` makes it and `text` says so; without fix, `warning` is said instead.
Fix = namedtuple('Fix', 'warning text apply')


# ======================================================================================================================
# Failing. A command that stops raises Failed (exit 1) or UsageError (exit 2); `main` says it, once.
# ======================================================================================================================

class Failed(Exception):
    """Exit 1, with `text` on stderr ('' when the command printed its own PROBLEM lines)."""
    code = 1

    def __init__(self, text=''):
        super().__init__(text)
        self.text = text


class UsageError(Failed):
    """Exit 2: the command line is wrong. `command`'s usage lines follow the text."""
    code = 2

    def __init__(self, command, why):
        super().__init__(f'{command}: {why}')
        self.command = command


def fail(text):
    raise Failed(text)


def refuse(why):
    """A write that is refused: nothing was written."""
    raise Failed(f'{why}; nothing was written')


# ======================================================================================================================
# The run's context: what a command works on, passed to it (nothing here is a module-level setting).
# ======================================================================================================================

class Ctx:
    """The repo, where its journeys are (`--dir`), git, the step count `check` wants (`--steps`) and stdin."""
    def __init__(self, repo, dir=None, steps=(MIN_STEPS, MAX_STEPS), stdin=None):
        self.repo = repo
        self.git = Git(repo)
        self.journeys = Journeys(repo, dir)
        self.steps = steps
        self.stdin = stdin or sys.stdin

    def stdin_text(self):
        return '' if self.stdin.isatty() else self.stdin.read().strip()

    def body(self, what='text'):
        b = self.stdin_text()
        if not b:
            fail(f'nothing on stdin: {what} is missing (pass it with <<EOF … EOF)')
        return b

    def value_of(self, v):
        """A value given on the command line; "-" reads it from stdin."""
        return self.body() if v == '-' else v

    def code(self, since):
        return Code(self.repo, self.git, since)


class Echo:
    """The lines a write collects while it works (what it anchored on, warnings about its range), printed under the
    one line that says what it wrote."""
    def __init__(self):
        self.lines = []

    def say(self, line):
        self.lines.append(line)

    def wrote(self, header):
        print(header)
        for line in self.lines:
            print(line)
        self.lines = []


# ======================================================================================================================
# git: one way to run it, one error policy.
# ======================================================================================================================

class Git:
    """git in one repo. A git that fails (no git, not a repository, dubious ownership) answers None; the first thing
    it said is kept in `error`, which `check` reports once. The renames are asked once per run."""
    def __init__(self, repo):
        self.repo = repo
        self.error = ''
        self._renames = None

    def run(self, *args, quiet=False):
        """git's stdout, or None when it failed (quiet: without keeping what it said)."""
        try:
            r = subprocess.run(['git', '-C', self.repo, *args], capture_output=True, text=True)
        except OSError as e:     # no git binary
            if not quiet:
                self.error = self.error or f'{e.strerror or e}'
            return None
        if r.returncode != 0:
            if not quiet and r.stderr.strip():
                self.error = self.error or ' '.join(r.stderr.strip().split('\n')[0].split())[:200]
            return None
        return r.stdout

    def head(self):
        """The short commit id of HEAD; '' outside a repository or before its first commit."""
        return (self.run('rev-parse', '--short', 'HEAD', quiet=True) or '').strip()

    def changed_files(self, commit):
        """The files changed since `commit`, committed or not (paths relative to the repo); None: git can't say."""
        out = self.run('diff', '--name-only', '--relative', commit, '--', quiet=True)
        return None if out is None else {l.strip() for l in out.splitlines() if l.strip()}

    def renames(self, since):
        """old path -> new path: renames committed since the journey's commit (or in the last 500 commits), then
        staged/uncommitted ones (git diff -M HEAD, git status). Asked once per run."""
        if self._renames is not None:
            return self._renames
        self._renames = {}
        ok = since and (self.run('rev-parse', '--verify', '--quiet', since + '^{commit}') or '').strip()
        rng = [f'{since}..HEAD'] if ok else ['-n', '500']
        out = self.run('log', '-M', '--diff-filter=R', '--name-status', '--format=', '--reverse', *rng) or ''
        out += self.run('diff', '-M', '--name-status', 'HEAD') or ''
        for line in out.splitlines():
            f = line.split('\t')
            if len(f) == 3 and f[0].startswith('R'):
                self._renames[f[1]] = f[2]
        for line in (self.run('status', '--porcelain=v1') or '').splitlines():
            if line[:1] == 'R' and ' -> ' in line:
                a, b = line[3:].split(' -> ', 1)
                self._renames[a.strip('"')] = b.strip('"')
        return self._renames


class Code:
    """The code a journey points at: the repo's files, and where git says they went since the journey's commit."""
    def __init__(self, repo, git, since):
        self.repo, self.git, self.since = repo, git, since

    def path(self, f):
        return os.path.join(self.repo, f)

    def isfile(self, f):
        return os.path.isfile(self.path(f))

    def renamed(self, f):
        """Where file f is now, following git's renames ('f' itself when git says nothing)."""
        names = self.git.renames(self.since)
        seen = {f}
        while f in names:
            f = names[f]
            if f in seen:
                break
            seen.add(f)
        return f

    def renamed_path(self, p):
        """Where a box's `path` (a file or a directory) went, from the same git renames; '' when git does not say."""
        p = p.rstrip('/')
        new = self.renamed(p)
        if new != p:
            return new
        dirs = set()
        for old in self.git.renames(self.since):
            if old.startswith(p + '/'):
                rest, to = old[len(p):], self.renamed(old)
                if not to.endswith(rest):
                    return ''        # files of the directory were renamed, not the directory
                dirs.add(to[:-len(rest)])
        return dirs.pop() if len(dirs) == 1 else ''


# ======================================================================================================================
# The extension's rules. journey-check.mjs, beside this script, is built from the Code Notes extension's format core
# and checks shapes, scenes, marks, podcasts and anchors the way the extension reads them. It runs when node is on
# PATH; without node, the Python rules further down (the same rules, run against it by the extension's tests) do.
# JOURNEY_RULES=python or JOURNEY_RULES=node picks one.
# ======================================================================================================================

FALLBACK = object()      # the helper could not answer: use the Python rules


class NodeRules:
    HELPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'journey-check.mjs')

    def __init__(self):
        self.want = os.environ.get('JOURNEY_RULES', '')
        self.node = shutil.which('node') if self.want != 'python' else None
        self.on = bool(self.node) and os.path.isfile(self.HELPER)
        self.proc = None

    def ask(self, op, **request):
        """The helper's answer to one request (one JSON line each way, one helper per run), or FALLBACK."""
        if self.want == 'node' and not self.on:
            fail('JOURNEY_RULES=node: node is not on PATH or journey-check.mjs is missing')
        if not self.on:
            return FALLBACK
        try:
            if self.proc is None:
                self.proc = subprocess.Popen([self.node, self.HELPER], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                             text=True, encoding='utf-8')
            self.proc.stdin.write(json.dumps({'op': op, **request}) + '\n')
            self.proc.stdin.flush()
            got = json.loads(self.proc.stdout.readline())
        except (OSError, ValueError) as e:
            return self.give_up(str(e) or type(e).__name__)
        return self.give_up(got['error']) if 'error' in got else got['ok']

    def give_up(self, why):
        """The helper failed: the Python rules from here on (JOURNEY_RULES=node: stop)."""
        if self.want == 'node':
            fail(f'journey-check.mjs failed: {why}')
        self.on = False
        return FALLBACK


RULES = NodeRules()      # one helper process per run, started on the first question


# ======================================================================================================================
# The journeys folder: <repo>/journeys (committed with the code), or .code-notes/journeys when only that exists;
# `--dir` overrides. The last good copy of each journey is kept in its .bak/ (git-ignored).
# ======================================================================================================================

def now():
    t = datetime.datetime.now(datetime.timezone.utc)
    return t.strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'


def new_id(used):
    while True:
        i = ''.join(random.choices(string.ascii_lowercase + string.digits, k=6))
        if i not in used:
            return i


def write_atomic(p, text):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(text)
    os.replace(tmp, p)


class Journeys:
    """The journeys of a repo, in one folder: reading, writing and the backups."""
    def __init__(self, repo, dir=None):
        self.repo = repo
        if dir:                  # relative to the repo, or absolute
            self.dir = os.path.join(repo, dir)
        else:
            new, old = os.path.join(repo, 'journeys'), os.path.join(repo, '.code-notes', 'journeys')
            self.dir = old if os.path.isdir(old) and not os.path.isdir(new) else new
        self.bak_failed = False

    def path(self, slug):
        return os.path.join(self.dir, slug + '.json')

    def bak(self, slug, kind=''):
        return os.path.join(self.dir, '.bak', slug + kind + '.json')

    def podcast(self, slug):
        return os.path.join(self.dir, slug + '.podcast.json')

    def slugs(self):
        return sorted(f[:-5] for f in os.listdir(self.dir) if f.endswith('.json')) if os.path.isdir(self.dir) else []

    def others(self, slug):
        """[(slug, journey)] of every other v2 journey in the folder that reads."""
        out = []
        for f in sorted(os.listdir(self.dir)) if os.path.isdir(self.dir) else []:
            if not f.endswith('.json') or f[:-5] == slug:
                continue
            try:
                o = json.load(open(os.path.join(self.dir, f), encoding='utf-8'))
            except (OSError, ValueError):
                continue
            if isinstance(o, dict) and o.get('version') == 2:
                out.append((f[:-5], o))
        return out

    def no_journey(self, slug):
        """An unknown slug: the closest ones and every slug there is."""
        import difflib
        slugs = self.slugs()
        if not slugs:
            fail(f"No journey '{slug}': {self.dir} has none yet (`journey.py new` starts one).")
        near = difflib.get_close_matches(slug, slugs, n=3, cutoff=0.5)
        ask = f" Did you mean {', '.join(near)}?" if near else ''
        fail(f"No journey '{slug}'.{ask}\nJourneys: {', '.join(slugs)}")

    def keep_bak(self, slug, raw):
        """The last good copy, in .bak/ (the extension reads journeys/*.json only, so it never shows it)."""
        b = self.bak(slug)
        try:
            if os.path.exists(b) and open(b, encoding='utf-8').read() == raw:
                return
            write_atomic(b, raw)
            ig = os.path.join(os.path.dirname(b), '.gitignore')
            if not os.path.exists(ig):   # backups never reach a commit, whatever the repo ignores
                write_atomic(ig, '*\n')
        except OSError as e:
            # A read-only checkout lands here too: nothing else changes, but `restore` would offer an older copy.
            if not self.bak_failed:
                print(f'WARNING: no backup of {slug} could be kept in {os.path.dirname(b)} ({e.strerror or e}): '
                      f'`restore` would put back an older copy', file=sys.stderr)
            self.bak_failed = True

    def unreadable(self, slug, why):
        """A journey file that does not parse: one PROBLEM line, exit 1 (never a traceback)."""
        b = self.bak(slug)
        if os.path.exists(b):
            t = datetime.datetime.fromtimestamp(os.path.getmtime(b)).strftime('%Y-%m-%d %H:%M')
            hint = f'`journey.py restore {self.repo} {slug}` puts back the last good copy ({t})'
        else:
            hint = 'no backup of it exists; rewrite it with the commands (reset, new …)'
        print(f'PROBLEM: {self.path(slug)}: {why}; {hint}')
        raise Failed()

    def load(self, slug, v1=False, notes=None):
        """The journey. Hand-edits it can read anyway (an "at": "file:a-b" string) are read the way the commands
        write them; each is added to `notes` (for `check`, which reports them as PROBLEMs)."""
        p = self.path(slug)
        if not os.path.exists(p):
            self.no_journey(slug)
        try:
            raw = open(p, encoding='utf-8').read()
            j = json.loads(raw)
        except json.JSONDecodeError as e:
            self.unreadable(slug, f'invalid JSON at line {e.lineno} column {e.colno} (char {e.pos} of {len(e.doc)}): {e.msg}')
        except UnicodeDecodeError as e:
            self.unreadable(slug, f'not UTF-8 text (byte {e.start})')
        if not isinstance(j, dict) or not isinstance(j.get('version'), int):
            self.unreadable(slug, 'not a journey (a JSON object with a "version")')
        if j.get('version') == 2:
            miss = [k for k in ('title', 'nodes', 'edges', 'steps') if k not in j]
            if miss:
                self.unreadable(slug, 'missing ' + ', '.join(miss))
        if j.get('version') == 2:
            bad, upgrades = journey_shape(j)
            if bad:                  # a hand-edited file gets PROBLEM lines, never a traceback
                for b in bad:
                    print('PROBLEM: ' + b)
                restore = f', or `journey.py restore {self.repo} {slug}` puts back the last good copy'
                print(f'FAILED: {p} was edited by hand into a shape the commands cannot read; fix the lines '
                      f'above' + (restore if os.path.exists(self.bak(slug)) else ''))
                raise Failed()
            self.upgrade(j, upgrades, notes if notes is not None else [])
        self.keep_bak(slug, raw)
        if not v1 and j.get('version') != 2:
            fail(f'{slug} is a v{j.get("version")} journey: run `journey.py migrate {self.repo} {slug}` first')
        return j

    def upgrade(self, j, upgrades, notes):
        """Reads hand-edits the way the commands write them: a box `at` written as "file:start-end" becomes
        {file, start, end, anchor}; a range without an anchor gets one. Each is noted in `notes`."""
        for u in upgrades:
            a = reanchor(self.repo, u['file'], u['start'], u['end'])
            if 'step' in u:
                j['steps'][u['step']]['anchor'] = a
            elif u.get('at'):
                j['nodes'][u['node']]['at'] = {'file': u['file'], 'start': u['start'], 'end': u['end'], 'anchor': a}
            else:
                j['nodes'][u['node']]['at']['anchor'] = a
            notes.append(u['note'])

    def save(self, slug, j):
        # every step has a stable short id (the extension follows a step by it when steps move); never changed here
        used = {s.get('id') for s in j.get('steps', [])}
        for k, s in enumerate(j.get('steps', [])):
            if not s.get('id'):
                j['steps'][k] = {'id': new_id(used), **s}
                used.add(j['steps'][k]['id'])
        raw = json.dumps(j, indent=2, ensure_ascii=False) + '\n'
        write_atomic(self.path(slug), raw)
        self.keep_bak(slug, raw)


def lines_of(repo, rel):
    try:
        return open(os.path.join(repo, rel), encoding='utf-8', errors='replace').read().split('\n')
    except (FileNotFoundError, IsADirectoryError):
        fail(f'{rel}: no such file in {repo}')


# ======================================================================================================================
# A journey's shape: what every command relies on. With node, the extension's own rules
# (cli/journey/shape.ts through journey-check.mjs); without, the Python rules below.
# ======================================================================================================================


def journey_shape(j):
    """The shapes every command relies on: (what cannot be read, the hand-edits that can be read anyway). Each
    upgrade is {node or step: index, file, start, end, at?, note}; `upgrade` applies them."""
    got = RULES.ask('shape', journey=j)
    if got is FALLBACK:
        return shape_problems(j)
    return got['problems'], got['upgrades']


def reanchor(repo, f, a, b):
    """The anchor of lines a-b of f now; an empty one when they are not there."""
    try:
        ls = open(os.path.join(repo, f), encoding='utf-8', errors='replace').read().split('\n')
    except OSError:
        return make_anchor([''], '', '')
    if not 1 <= a <= b <= len(ls):
        return make_anchor([''], '', '')
    return make_anchor(ls[a - 1:b], *around(ls, a - 1, b - 1))


# --- the Python rules for a journey's shape (without node; the helper's are cli/journey/shape.ts of the extension)
ANCHOR_TEXT = ('text', 'before', 'after', 'head', 'tail', 'hash')


STEP_LISTS = (('links', ('phrase', 'file', 'start', 'end')), ('values', ('name', 'value', 'file', 'line')))


def is_str(v):
    return isinstance(v, str)


def anchor_ok(a):
    if not isinstance(a, dict) or not all(is_str(a.get(k, '')) for k in ANCHOR_TEXT):
        return False
    return a.get('v') != 3 or (is_str(a.get('head')) and is_int(a.get('lines')))


def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def shape_problems(j):
    """journey_shape's rules: (problems, upgrades). Reads `j`, never changes it."""
    out, ups = [], []
    for key in ('nodes', 'edges', 'steps'):
        if not isinstance(j.get(key), list):
            out.append(f'"{key}" must be a list')
    if not is_str(j.get('title')):
        out.append('"title" must be a string (meta title "…")')
    for key in ('question', 'summary', 'commit'):
        if key in j and not is_str(j[key]):
            out.append(f'"{key}" must be a string')
    if out:
        return out, ups
    for i, n in enumerate(j['nodes']):
        node_shape(n, i, out, ups)
    for i, e in enumerate(j['edges']):
        edge_shape(e, i, out)
    for k, st in enumerate(j['steps'], 1):
        step_shape(st, k, out, ups)
    return out, ups


def node_shape(n, i, out, ups):
    if not isinstance(n, dict) or not is_str(n.get('id')) or not n.get('id'):
        out.append(f'nodes[{i}]: a box is an object with a string "id"')
        return
    name = f'box {n["id"]}'
    if n.get('kind') not in KINDS:
        out.append(f'{name}: kind {n.get("kind")!r} is not one of {", ".join(KINDS)}')
    if not is_str(n.get('label')):
        out.append(f'{name}: "label" must be a string')
    for key in ('blurb', 'summary', 'path', 'parent'):
        if key in n and not is_str(n[key]):
            out.append(f'{name}: "{key}" must be a string')
    if 'at' not in n:
        return
    at = n['at']
    if is_str(at):
        m = re.fullmatch(r'(.+):(\d+)(?:-(\d+))?', at.strip())
        if not m:
            out.append(f'{name}: "at" is the string {at!r}; it must be {{file, start, end, anchor}}: remove the line, '
                       f'then `set {n["id"]} at <file:start-end>`')
            return
        f, a, b = m.group(1), int(m.group(2)), int(m.group(3) or m.group(2))
        ups.append({'node': i, 'file': f, 'start': a, 'end': b, 'at': True,
                    'note': f'{name}: "at" was hand-written as the string "{at}"; it must be {{file, start, end, anchor}}: '
                            f'run `set {n["id"]} at {f}:{a}-{b}` (never edit the file by hand)'})
    elif not (isinstance(at, dict) and is_str(at.get('file')) and is_int(at.get('start')) and is_int(at.get('end'))):
        out.append(f'{name}: "at" must be {{file, start, end, anchor}} with whole line numbers: remove it, then '
                   f'`set {n["id"]} at <file:start-end>`')
    elif not anchor_ok(at.get('anchor')):
        ups.append({'node': i, 'file': at['file'], 'start': at['start'], 'end': at['end'],
                    'note': f'{name}: "at" has no anchor (hand-written): run `set {n["id"]} at '
                            f'{at["file"]}:{at["start"]}-{at["end"]}`'})


def edge_shape(e, i, out):
    if not isinstance(e, dict) or not all(is_str(e.get(k)) for k in ('from', 'to', 'label')):
        out.append(f'edges[{i}]: an edge is an object with string "from", "to" and "label" (rewrite it with `edge`)')
    elif 'detail' in e and not is_str(e['detail']):
        out.append(f'edge {e["from"]} -> {e["to"]}: "detail" must be a string')


def step_shape(st, k, out, ups):
    name = f'step {k}'
    if not isinstance(st, dict):
        out.append(f'{name}: a step is an object')
        return
    for key in ('title', 'node', 'file'):
        if not is_str(st.get(key)):
            out.append(f'{name}: "{key}" must be a string')
    for key in ('lead', 'details', 'id'):
        if key in st and not is_str(st[key]):
            out.append(f'{name}: "{key}" must be a string')
    r = st.get('range')
    if is_str(r) or not (isinstance(r, dict) and is_int(r.get('start')) and is_int(r.get('end'))):
        out.append(f'{name}: "range" must be {{start, end}} with whole line numbers (and "file" beside it): put the '
                   f'old value back, then `restep {k} range <file> <start> <end>`')
    elif not anchor_ok(st.get('anchor')) and is_str(st.get('file')):
        ups.append({'step': k - 1, 'file': st['file'], 'start': r['start'], 'end': r['end'],
                    'note': f'{name}: no anchor (hand-written range): run `restep {k} range {st["file"]} {r["start"]} {r["end"]}`'})
    for key, need in STEP_LISTS:
        ok = lambda x: isinstance(x, dict) and all((is_int if f in ('start', 'end', 'line') else is_str)(x.get(f)) for f in need)
        if key in st and not (isinstance(st[key], list) and all(ok(x) for x in st[key])):
            out.append(f'{name}: "{key}" must be a list of {{{", ".join(need)}, text}} objects (rewrite them with '
                       f'`{key[:-1]}`, after removing the line)')
    if 'scene' in st and not (isinstance(st['scene'], dict) and isinstance(st['scene'].get('actors'), list)
                              and isinstance(st['scene'].get('beats'), list)):
        out.append(f'{name}: "scene" must be {{actors, wires, beats}} (remove it, then `scene {k}` < the JSON)')
    if 'refs' in st and not (isinstance(st['refs'], list) and all(is_str(x) for x in st['refs'])):
        out.append(f'{name}: "refs" must be a list of strings, each one sentence with a path:line in it (restep {k} refs "…")')


# ======================================================================================================================
# Text: words, sentences, the words that carry meaning.
# ======================================================================================================================

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


def shown(v, n=160):
    """A value for the echo line: one line, quoted, cut when long, with its length."""
    one = ' '.join(str(v).split())
    return f'"{one[:n]}{"…" if len(one) > n else ""}" ({len(str(v))} chars)'


# Words that say nothing about what a title or question is about.
STOP_WORDS = set("""a an the and or but of to in on at by for from with without into onto as is are was were be been
being it its this that these those then than so not no only one each every all any which who what when where how why if
there here can will would may has have had do does did up out over under after before per via also own same just now
more most them they their he she we you i""".split())


def stem(w):
    """A crude stem: -ing, -ed, -es or -s off a word that keeps at least 4 letters."""
    for suf in ('ing', 'ed', 'es', 's'):
        if len(w) > len(suf) + 3 and w.endswith(suf):
            return w[:-len(suf)]
    return w


def key_words(*texts):
    """The stems of the texts' words that carry meaning (letters and digits only)."""
    return {stem(w) for w in re.findall(r'[a-z0-9]+', ' '.join(texts).lower()) if w not in STOP_WORDS and len(w) >= 2}


def content_words(text):
    """The stems of a prose text's words that carry meaning (code spans and URLs left out)."""
    return [stem(w) for w in re.findall(r"[a-z0-9][a-z0-9'-]*", plain(text).lower()) if w not in STOP_WORDS and len(w) > 1]


# ======================================================================================================================
# Near-duplicate journeys. Two journeys that ask the same thing, or walk the same code, are one journey to extend:
# `new`, `meta question|title` and `check` say so (a WARNING, never a refusal).
# ======================================================================================================================

# Asking the same thing: the question and title of both, as key words (stop words dropped, crude stems); shared
# words over all words (Jaccard). At 0.5 half of what either asks is in the other: "How is an order paid?" and "How
# does the shop charge an order?" stay apart, "How is an order placed and paid?" and "How does an order get placed
# and paid?" meet.
SIMILAR = 0.5
# Walking the same code: steps anchored inside the other journey's step ranges. 3 at least, and 70 % of the steps:
# a journey that crosses another one for two steps is a neighbour, not a copy.
SAME_CODE = 0.7
SAME_CODE_MIN = 3


def similar_journeys(journeys, slug, j):
    """WARNING texts naming every other journey that asks nearly the same thing or walks mostly the same code."""
    out = []
    mine = key_words(j.get('question', ''), j.get('title', ''))
    spans = [(s.get('file'), s.get('range', {}).get('start', 0), s.get('range', {}).get('end', 0)) for s in j.get('steps', [])]
    for other, o in journeys.others(slug):
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
        if spans and hit >= SAME_CODE_MIN and hit / len(spans) >= SAME_CODE:
            out.append(f'{hit} of {len(spans)} steps are anchored on the same code as {name}: '
                       f'it tells the same story; extend that journey instead')
    return out


# ======================================================================================================================
# Anchors: where a step or a box is in the code, and finding it again after the code moved.
# ======================================================================================================================


# --- finding a step again after the code moved. With node, the extension's own rules (src/core/anchors, through
# journey-check.mjs: anchor_place, line_at); the Python rules below are the same, and run against the extension's
# relocation cases (test/fixtures/compact-cases.json) in its tests. Lines compare without whitespace, with one quote
# style and no trailing ; or , (`norm`).
def norm(s):
    return re.sub(r'[;,]+$', '', re.sub(r"['`]", '"', re.sub(r'\s+', '', s)))


def blank(s):
    return norm(s) == ''


def weak(s):                     # `}` or `);` says nothing about where code is: not context
    return len(norm(s)) < 3


# --- compact anchors (v3), as in docs/journey-format.md ("In the repo"); written here, found again by anchor_place.
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


def anchor_place(repo, f, a, start0):
    """Where anchor a (v2 or v3) is in file f now: (start0, end0, same_hash), or None when it is not found."""
    got = RULES.ask('place', repo=repo, file=f, anchor=a, hint=start0)
    if got is FALLBACK:
        return place(lines_of(repo, f), as_v3(a), start0)
    return tuple(got) if got else None


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


def line_at(repo, f, line, text):
    """Where a link's, value's or beat's line is in file f now (0-based), found by its text near `line`; -1: gone."""
    got = RULES.ask('line', repo=repo, file=f, line=line, text=text)
    return find_line(lines_of(repo, f), line, text) if got is FALLBACK else got


def find_line(lines, line, text):
    """line_at's rule (src/core/anchors/lineFollow.ts findLine): the written line if it still says `text` (trimmed), else the nearest line within
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


def anchor(repo, rel, start, end, echo=None):
    """The anchor of lines start-end of rel, for a write; its first and last line said to `echo` (none: quiet)."""
    lines = lines_of(repo, rel)
    if not (1 <= start <= end <= len(lines)):
        fail(f'{rel} has {len(lines)} lines: range {start}-{end} is outside it')
    s, e = start - 1, end - 1
    if echo:
        echo.say(f'  {rel} L{start}: {lines[s].strip()[:100]}')
        if end > start:
            echo.say(f'  {rel} L{end}: {lines[e].strip()[:100]}')
    return make_anchor(lines[s:e + 1], *around(lines, s, e))


class State(enum.Enum):
    """Where anchored code is now, as the extension finds it."""
    OK = 'ok'                # fresh, in place
    MOVED = 'moved'          # fresh, elsewhere
    CHANGED = 'changed'      # found by its head and tail, other content
    GONE = 'gone'            # not found (detail: the file git renamed it to)
    NO_FILE = 'nofile'


Located = namedtuple('Located', 'state file start end detail')


def where(code, file, start, end, a):
    """Where anchored code is now, as the extension finds it: in its file, or in the file git renamed it to."""
    files = [file] if code.isfile(file) else []
    new = code.renamed(file)
    if new != file and code.isfile(new):
        files.append(new)
    if not files:
        return Located(State.NO_FILE, file, start, end, '')
    changed = None
    for f in files:
        got = anchor_place(code.repo, f, a, start - 1 if f == file else 0)
        if not got:
            continue
        s0, e0, same = got
        if same:
            here = f == file and (s0 + 1, e0 + 1) == (start, end)
            return Located(State.OK if here else State.MOVED, f, s0 + 1, e0 + 1, '')
        changed = changed or Located(State.CHANGED, f, s0 + 1, e0 + 1, '')
    return changed or Located(State.GONE, file, start, end, (f'renamed to {new}' if new != file else ''))


# ======================================================================================================================
# Ranges. A naive, per-language reading of source lines: whether a step's range starts or ends in the middle of a
# statement (`range_warnings`, a WARNING), and where a declaration starts and ends (`SourceFile`, for `range`).
# Brackets are counted without a parser: strings and comments are stripped first, which is enough for formatted code.
# ======================================================================================================================

CODE_EXT = ('.go', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.py', '.rs', '.java', '.kt', '.c', '.h',
            '.cc', '.cpp', '.cs', '.swift')
TAIL_OPS = ('&&', '||', '+', '-', '*', '/', '%', '=', '|', '&', '^', '\\')
STATEMENT_END_SEARCH = 400   # lines after a range searched for the end of a statement it cuts off
PARAMS_SEARCH = 40           # lines a method's parameter list may span


def code_of(line, py=False):
    """The line without string literals and comments ('' for a blank or comment-only line)."""
    t = line.strip()
    if t.startswith(('*', '/*', '<!--')) or t.startswith('#' if py else '//'):
        return ''
    t = re.sub(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|`[^`]*`', '""', t)
    return re.sub(r'\s#.*$' if py else r'//.*$', '', t).strip()


def bracket_depth(code):
    """Brackets opened minus brackets closed on a line of code."""
    return sum(code.count(x) for x in '([{') - sum(code.count(x) for x in ')]}')


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


def lone_closer(code):
    """A line that only closes brackets (`}`, `});`)."""
    return bool(re.fullmatch(r'[\])}]+[;,]?', code))


def range_warnings(lines, rel, start, end):
    """Problems with where the range start-end (1-based) begins and ends; [] for a file that is not code."""
    if not rel.endswith(CODE_EXT) or not (1 <= start <= end <= len(lines)):
        return []
    py = rel.endswith('.py')
    code = {k: code_of(lines[k - 1], py) for k in range(start, end + 1)}
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
    if lone_closer(first):
        a = nxt(start, 1)
        hint = f'did you mean {a}-{end}?' if a else 'pick the statement itself'
        out.append(f'{rel}:{start}-{end} starts on a lone closing "{first[0]}" (the end of the block above): {hint}')
    if end > start and lone_closer(last) and end in unmatched:
        b = nxt(end, -1)
        hint = f'did you mean {start}-{b}?' if b and not (b == start and lone_closer(first)) else 'pick the statement itself'
        out.append(f'{rel}:{start}-{end} ends on a lone closing "{last[0]}" of a block opened above the range: {hint}')
    if end > start and re.match(r'return\b', first):
        # `return …` first, other code after it: the range starts at the tail of the block above
        depth, r = 0, None
        for k in range(start, end + 1):
            c = code[k]
            if not c:
                continue
            depth += bracket_depth(c)
            if depth <= 0 and not unfinished(c, py):
                r = k                     # the line the return statement ends on
                break
        a = nxt(r, 1) if r else None
        while a and lone_closer(code[a]):
            a = nxt(a, 1)
        if a:
            out.append(f'{rel}:{start}-{end} starts on a bare `{first[:40]}` (the end of the block above; the lines '
                       f'after it are other code): did you mean {a}-{end}?')
    why = unfinished(last, py) if last and not lone_closer(last) else ''
    if why == 'a comma' and not stack and not unmatched:
        why = ''                          # whole elements of a list or literal: balanced, each ends with its comma
    prev = nxt(end, -1) if end > start else None
    if not why and last.endswith('{') and prev and not unfinished(code[prev], py) and not code[prev].endswith('{'):
        why = 'the opening "{" of a new block'     # a head on its own, or one spread over lines, is a fine anchor
    if why:
        opts = [f'{start}-{prev} (without it)'] if prev and last.endswith(('(', '[', '{')) else []
        close = statement_end(lines, end, last, py)
        if close:
            opts.append(f'{start}-{close} (where it ends)')
        out.append(f'{rel}:{start}-{end} ends in the middle of a statement (the last line ends with {why})'
                   + (': did you mean ' + ' or '.join(opts) + '?' if opts else ''))
    return out


def statement_end(lines, end, last, py):
    """The line (1-based) where the statement cut off at line `end` ends: brackets back to level; None if not near."""
    depth = 0
    for k in range(end, min(len(lines), end + STATEMENT_END_SEARCH) + 1):
        c = code_of(lines[k - 1], py)
        depth += bracket_depth(c)
        if k > end and depth <= 0 and c and not unfinished(c, py):
            return k
        if k == end and depth <= 0 and not last.endswith(('(', '[', '{')):
            depth = 0                 # a comma or operator inside an already balanced line: the next full line ends it
    return None


# What `range` takes for a declaration: Go, TS/JS, Python, Rust and C-like heads at the top level, nested functions
# and classes, TS/JS methods and arrow functions assigned to a name.
_MODS = r'(?:(?:public|private|protected|static|async|override|abstract|readonly|get|set)\s+)*'
DECL = re.compile(r'^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?'
                  r'(?:func|function\*?|def|class|type|interface|const|let|var|struct|fn|enum)\b')
NAMED = re.compile(r'^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?'
                   r'(?:func\s+(?:\(([^)]*)\)\s*)?|(?:function\*?|def|class|type|interface|struct|fn|enum|const|let|var)\s+)'
                   r'([A-Za-z_$][\w$]*)')
NESTED = re.compile(r'^\s+(?:export\s+)?(?:async\s+)?(?:function\*?|class)\s+[A-Za-z_$]')
METHOD = re.compile(r'^\s+' + _MODS + r'\*?\s*(#?[A-Za-z_$][\w$]*)\s*(?:<[^(]*>)?\s*\(')
ARROW = re.compile(r'^\s*(?:export\s+)?' + _MODS + r'(?:(?:const|let|var)\s+)?(#?[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*'
                   r'(?:async\s*)?(?:\(|[\w$]+\s*=>).*=>\s*\{\s*$')
NOT_NAMES = {'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'await', 'new', 'throw', 'typeof',
             'super', 'else', 'do', 'try', 'with', 'yield', 'delete', 'void', 'in', 'of'}


class SourceFile:
    """A source file's declarations, for `range`: what each line declares, and where it ends. Ends are found by the
    closing line at the declaration's indentation (formatted code), else by counting brackets (Python: indentation).
    Lines are 0-based here."""
    def __init__(self, lines, py):
        self.lines, self.py = lines, py
        self.ends = {}
        self.decls = [(i, n) for i in range(len(lines)) for n in [self.name_of(i)] if n]   # (line, (name, receiver))

    def indent(self, i):
        return len(self.lines[i]) - len(self.lines[i].lstrip())

    def stripped_line(self, k):
        """Line k without strings and comments, block comments too (unlike `code_of`, its indentation stays)."""
        return re.sub(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|`[^`]*`|/\*.*?\*/|//.*$', '', self.lines[k])

    def method_name(self, i):
        """The name when line i opens a TS/JS method (`private async click(…): T {`), else None."""
        m = METHOD.match(self.lines[i])
        if not m or m.group(1) in NOT_NAMES or self.lines[i].lstrip().startswith(('}', ')', '.', '?', ':')):
            return None
        depth, started = 0, False
        for k in range(i, min(i + PARAMS_SEARCH, len(self.lines))):
            code = self.stripped_line(k)
            for pos, c in enumerate(code):
                if c == '(':
                    depth += 1
                    started = True
                elif c == ')':
                    depth -= 1
                    if started and depth == 0:
                        return m.group(1) if re.match(r'^\s*(?::.*)?\{\s*$', code[pos + 1:]) else None
        return None

    def name_of(self, i):
        """(name, receiver type) when line i declares something `range` may return, else None."""
        l = self.lines[i]
        if self.py:
            m = re.match(r'^\s*(?:async\s+)?(?:def|class)\s+(\w+)', l)
            return (m.group(1), '') if m else None
        if not l.strip() or l.lstrip().startswith(('//', '*', '/*')):
            return None
        m = ARROW.match(l)
        if m and m.group(1) not in NOT_NAMES:
            return (m.group(1), '')
        if DECL.match(l) and (self.indent(i) == 0 or NESTED.match(l)):
            m = NAMED.match(l)
            recv = re.sub(r'^.*?\*?([\w$]+)(?:\[[^\]]*\])?\s*$', r'\1', m.group(1)) if m and m.group(1) else ''
            return (m.group(2), recv) if m else ('', '')
        if self.indent(i) > 0:
            n = self.method_name(i)
            if n:
                return (n, '')
        return None

    def span(self, i):
        """The last line of the declaration on line i."""
        if i not in self.ends:
            self.ends[i] = self.end_by_indent(i) if self.py else self.end_of(i)
        return self.ends[i]

    def end_by_indent(self, i):
        """Python: the last line indented deeper than line i."""
        last = i
        for k in range(i + 1, len(self.lines)):
            if self.lines[k].strip():
                if self.indent(k) <= self.indent(i) and not self.lines[k].lstrip().startswith(')'):
                    break
                last = k
        return last

    def end_of(self, i):
        counted, first = self.end_by_count(i)
        if first and first > 0:
            # The declaration stays open after its first line: in formatted code it ends on the first closing line
            # at the same indentation (a `): T {` that only ends the parameter list is not it). This survives
            # braces inside regex literals and multi-line template strings, which the count does not.
            closing = self.closing_line(i)
            if closing is not None:
                return closing
        return counted

    def end_by_count(self, i):
        """(the line where the brackets opened from line i close again, the depth line i leaves open)."""
        depth, seen, first, tpl = 0, False, None, False
        for k in range(i, len(self.lines)):
            code = self.stripped_line(k)
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
                return k, first
        return len(self.lines) - 1, first

    def closing_line(self, i):
        """The first line at line i's indentation that closes a bracket (and opens none), or None."""
        for k in range(i + 1, len(self.lines)):
            s = self.lines[k].strip()
            if not s:
                continue
            if self.indent(k) < self.indent(i):
                return None
            if self.indent(k) == self.indent(i) and s[0] in '})]' and not self.stripped_line(k).rstrip().endswith(('{', '(', '[')):
                return k
        return None

    def around(self, n):
        """The declarations containing line n, outermost first."""
        return [i for i, _ in self.decls if i <= n <= self.span(i)]

    def receiver(self, i):
        return next((r for j, (_, r) in self.decls if j == i), '')

    def named(self, what):
        """The declarations of `what`: a name, or Owner.name (a method in a class, a Go method of a type)."""
        owner, _, name = what.rpartition('.')
        starts = [i for i, (nm, _) in self.decls if nm == name]
        if owner:
            inside = [(i, self.span(i)) for i, (nm, _) in self.decls if nm == owner]
            starts = [i for i in starts if self.receiver(i) == owner or any(a < i <= b for a, b in inside)]
        return starts

    def owner(self, i):
        """The name of the declaration around declaration i ('' at the top level)."""
        return next((dn for j, (dn, _) in reversed(self.decls)
                     if j < i and self.indent(j) < self.indent(i) and i <= self.span(j)), '')

    def close_names(self, name):
        """Up to 6 declared names that contain `name`, as Owner.name when they are inside something."""
        near = set()
        for i, (nm, _) in self.decls:
            if nm and name.lower() in nm.lower():
                o = self.owner(i)
                near.add(f'{o}.{nm}' if o else nm)
        return sorted(near)[:6]


# ======================================================================================================================
# Refs: one sentence with one path:line in it, saying what the reader will see there.
# ======================================================================================================================


def parse_at(at):
    f, _, r = at.rpartition(':')
    a, _, b = r.partition('-')
    return f, int(a), int(b or a)


def ref_tokens(ref):
    """The path:line tokens inside a ref (a sentence, or an old bare `path:line`), as regex matches."""
    return list(re.finditer(r'(?<![\w/.@-])' + REF, ref))


def ref_token(ref):
    """The ref's first path:line as a string ('' when it has none): what is checked, compared and linked."""
    t = ref_tokens(ref)
    return t[0].group(0) if t else ''


def ref_bare(ref):
    return bool(re.fullmatch(REF, ref.strip()))


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


# ======================================================================================================================
# Style: what a title, a lead, a label says; refused when written over a hard limit, a WARNING otherwise.
# ======================================================================================================================


def question_problem(q):
    """The question is the map header (one bold line) and the sidebar row's tooltip."""
    if len(q.strip()) > MAX_QUESTION:
        return (f'is {len(q.strip())} chars (max {MAX_QUESTION}: one natural question a developer would ask; '
                f'the lists and qualifiers go in the summary)')
    return ''


def title_problem(t, labels):
    if len(t) > MAX_STEP_TITLE:
        return f'is {len(t)} chars (max {MAX_STEP_TITLE})'
    if re.match(r'(?i)^(step|part|phase|stage|hop)\s*\d+\b', t):
        return 'is a heading; write the fact that happens here ("The server only stores a pending record")'
    if re.match(r'(?i)^(what|how|why|where|when|which|about|overview|intro)\b', t):
        return 'names a topic; state the fact instead ("The request carries the spec and the built image tags")'
    if t.strip().lower() in labels or words(t) < 4:
        return 'is a name, not a fact: say what happens (subject + verb, at least 4 words)'
    if t.rstrip().endswith((':', '?')):
        return 'ends with ":" or "?"; state the fact'
    return ''


def journey_title_problem(t):
    """The journey's title is a short topic name for a sidebar row that cannot wrap."""
    t = t.strip()
    if len(t) > MAX_TITLE:
        return f'is {len(t)} chars (max {MAX_TITLE}: a short topic name, subject first, e.g. "Checkout flow")'
    if t.endswith('?') or re.match(r'(?i)^(how|why|what|when)\b', t):
        return 'is a question; the title is a topic name (noun phrase, subject first: "Upgrade in place"); the question stays in `question`'
    return ''


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


def step_limits(s):
    """An over-limit title or lead is refused when it is written, not found later by check."""
    t, w = s.get('title', ''), words(s.get('lead', ''))
    if len(t) > MAX_STEP_TITLE:
        fail(f'title is {len(t)} chars (max {MAX_STEP_TITLE}); nothing was written: "{t}"')
    if w > MAX_LEAD_WORDS:
        fail(f'lead is {w} words (max {MAX_LEAD_WORDS}; move the rest to details); nothing was written')


def lead_repeats_title(title, lead):
    """A lead that says the title again adds nothing to the card. The share of the title's words (stop words
    dropped, crude stems) found again in one sentence of the lead, or in the whole lead; returns that share when one
    sentence carries >= 70 % of them or the lead >= 85 %, else None. Titles under 4 such words are not judged."""
    tw = set(content_words(title))
    if len(tw) < 4:
        return None
    one = max((len(tw & set(content_words(x))) / len(tw) for x in sentences(lead)), default=0)
    whole = len(tw & set(content_words(lead))) / len(tw)
    return max(one, whole) if one >= REPEAT_SENTENCE or whole >= REPEAT_LEAD else None


def label_warning(n):
    """A box label is read at a glance; over 20 chars it wraps or shrinks (a function box is a symbol name)."""
    if n.get('kind') != 'function' and SOFT_LABEL < len(n.get('label', '')) <= MAX_LABEL:
        return (f'{n["id"]}: label "{n["label"]}" is {len(n["label"])} chars; aim for <= {SOFT_LABEL} ("CLI", "Worker"): '
                f'the rest goes in the blurb (set {n["id"]} label "…")')
    return ''


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


# ======================================================================================================================
# Links and values of a step (format: src/core/codeLinkText.ts, src/codeLinks/valueHints.ts): its code links
# (`links`: phrases of the lead/details that open the lines doing that part) and its value hints (`values`:
# what a variable holds in the example run, above its line). Every line is read from the source by the
# commands; the author never types a line's text.
# ======================================================================================================================


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
    """The Issues of one value hint."""
    out = []
    name, val = str(v.get('name', '')), str(v.get('value', ''))
    where = f'step {k}: value {name} at {v.get("file")}:{v.get("line")}'
    if not name.strip() or not val.strip():
        out.append(Issue(PROBLEM, f'{where}: a hint needs a name and a value'))
    if name and name not in str(v.get('text', '')):
        out.append(Issue(REFUSE, f'{where}: the line does not mention "{name}" ("{str(v.get("text", ""))[:70]}"): a hint sits on '
                         f'the line that declares or uses that variable'))
    if len(val) > MAX_VALUE:
        out.append(Issue(REFUSE, f'{where}: the value is {len(val)} chars (max {MAX_VALUE}; the extension cuts it there): '
                         f'"{val}": say less ("[2 items]", "ord_7f3a…")'))
    if len(str(v.get('note', ''))) > SOFT_NOTE:
        out.append(Issue(WARN, f'{where}: the note is {len(v["note"])} chars (aim for <= {SOFT_NOTE}: a few words on what '
                         f'the value IS in this run)'))
    twin = [o for o in others if o is not v and o.get('file') == v.get('file') and o.get('line') == v.get('line')]
    if twin:
        out.append(Issue(PROBLEM, f'{where}: {twin[0].get("name")} already has a hint on that line (one hint per line: the '
                         f'CodeLens row holds one)'))
    if value_far(s, v):
        out.append(Issue(WARN, f'{where} is neither within {VALUE_NEAR} lines of the step\'s range nor within {BEAT_NEAR} '
                         f'lines of a beat or link of this step: the reader never sees it there (rmvalue {k} {name})'))
    return out


def link_issues(k, s, l):
    """The Issues of one code link, without its anchor (checked apart)."""
    out = []
    ph = str(l.get('phrase', ''))
    where = f'step {k}: link "{ph}"'
    r = s.get('range') or {}
    a, b = l.get('start'), l.get('end')
    if is_int(a) and is_int(b) and b < a:
        out.append(Issue(PROBLEM, f'{where}: end {b} is before start {a}'))
    elif is_int(a) and is_int(b):
        if l.get('file') == s.get('file') and (a, b) == (r.get('start'), r.get('end')):
            out.append(Issue(REFUSE, f'{where} points at the step\'s whole own range ({s["file"]}:{a}-{b}): that is already '
                             f'lit; a link opens the few lines that do what the phrase says'))
        if b - a + 1 > SOFT_LINK_LINES:
            out.append(Issue(WARN, f'{where} marks {b - a + 1} lines ({l.get("file")}:{a}-{b}); aim for 1-8, max ~'
                             f'{SOFT_LINK_LINES}: the lines that do what the phrase says'))
    same = [o for o in s.get('links', []) if o is not l and (o.get('file'), o.get('start'), o.get('end')) == (l.get('file'), a, b)]
    if same:
        out.append(Issue(REFUSE, f'{where} points at the same lines as the link "{same[0].get("phrase")}" '
                         f'({l.get("file")}:{a}-{b}): one link per place'))
    if [o.get('phrase') for o in s.get('links', [])].count(ph) > 1:
        out.append(Issue(PROBLEM, f'{where}: two links of this step have this phrase (only the first can be a link)'))
    return out


def say_issues(issues, write):
    """For a write: refuses on a PROBLEM or REFUSE issue (nothing written); returns the warnings to print after the echo."""
    stop = [m for lv, m in issues if lv in (PROBLEM, REFUSE)] if write else []
    if stop:
        print('\n'.join('PROBLEM: ' + m for m in stop[1:]))
        refuse(stop[0])
    return [m for lv, m in issues if lv == WARN]


def extras_line(s):
    """`, 5 links, 3 values, scene 5 beats` for the storyline row."""
    sc = s.get('scene') if isinstance(s.get('scene'), dict) else None
    nm = sum(len(ms) for _, ms, _, _, _ in marks_groups(s) if isinstance(ms, list))
    return (f', {len(s.get("links", []))} links, {len(s.get("values", []))} values'
            + (f', {nm} marks' if nm else '')
            + (f', scene {len(sc.get("beats") or [])} beats' if sc else ''))


def relocate(code, name, h, fkey, lkey, how, span=None):
    """A link's, value's or beat's line (h[fkey]:h[lkey]) found again by its text, the way the extension finds it:
    None in place, an Issue when it can't be found, a Fix when it moved."""
    f, ln, text = h.get(fkey), h.get(lkey), str(h.get('text', ''))
    if not isinstance(f, str) or not is_int(ln):
        return Issue(PROBLEM, f'{name}: needs a file and a line number ({how})')
    if not text.strip():
        return Issue(PROBLEM, f'{name}: no "text" (the line it is on); rewrite it with the command ({how})')
    cur = f
    if not code.isfile(f):
        cur = code.renamed(f)
        if cur == f or not code.isfile(cur):
            asked = ' (git could not be asked about a rename)' if code.git.error else ''
            return Issue(PROBLEM, f'{name}: {f} no longer exists{asked} ({how})')
    i = line_at(code.repo, cur, ln, text)
    if i < 0:
        return Issue(PROBLEM, f'{name}: {f}:{ln} no longer reads "{text[:70]}", and no line within {FIND_NEAR} lines does: '
                              f'the code changed; re-read it and rewrite this ({how})')
    if (cur, i + 1) == (f, ln):
        return None

    def move():
        h[fkey], h[lkey] = cur, i + 1
        if span:
            h[span] = h.get(span, ln) + i + 1 - ln
    return Fix(f'{name} moved to {cur}:{i + 1} (was {f}:{ln}; run check fix)', f'{name}: {f}:{ln} -> {cur}:{i + 1}', move)


def scene_found(code, k, sc):
    """A step's scene: its Issues, then each beat's line found again (Fix or Issue) and what it lights."""
    found = scene_issues(k, sc)
    if any(lv == PROBLEM for lv, _ in found):
        return found
    for i, b in enumerate(sc['beats'], 1):
        c = b.get('code')
        if not isinstance(c, dict):
            continue
        found.append(relocate(code, f'step {k} scene: beat {i} ("{str(b.get("caption", ""))[:40]}")', c, 'file',
                              'line', f'scene {k}: give the beat its line again'))
        why = odd_line(str(c.get('text', '')), str(c.get('file', '')))
        if why:
            found.append(Issue(WARN, f'step {k} scene: beat {i} lights {why} ({c.get("file")}:{c.get("line")}): '
                                     f'light the line that DOES what the caption says'))
    return found


def check_extras(code, j):
    """`check` on every step's links, values, scene and marks: the static rules above, and each stored line found
    again the way the extension finds it. Issues and Fixes (moved: `check fix` applies them), in the order found."""
    found = []
    any_extra = False
    some_links = any(x.get('links') for x in j['steps'])
    for k, s in enumerate(j['steps'], 1):
        links, vals, sc = s.get('links', []), s.get('values', []), s.get('scene')
        any_extra = any_extra or bool(links or vals or sc)
        for l in links:
            found.append(relocate(code, f'step {k}: link "{l.get("phrase")}"', l, 'file', 'start',
                                  f'link {k} "{l.get("phrase")}" <file> <start> <end>', 'end'))
            found.extend(link_issues(k, s, l))
        found.extend(Issue(WARN, w) for w in link_warnings(k, s))      # dead links: refused when written; old files stay valid
        for v in vals:
            found.append(relocate(code, f'step {k}: value {v.get("name")}', v, 'file', 'line',
                                  f'value {k} {v.get("name")} "<value>" <file> <line>'))
            found.extend(value_issues(k, s, v, vals))
        if sc is not None:
            found.extend(scene_found(code, k, sc))
        found.extend(marks_issues(code, k, s))
        if some_links and not links:
            found.append(Issue(WARN, f'step {k}: no code links (aim for 3-6: the phrases of the lead and details that '
                                     f'name what a few lines do; link {k} "<phrase>" <file> <start> <end>)'))
    if not any_extra and j['steps']:
        found.append(Issue(WARN, 'no step has code links, value hints or an animation: add them once the steps are '
                                 'written (link, value, scene: SKILL.md "Links, values, marks, scenes")'))
    return [x for x in found if x]


def as_issues(found):
    """Issues and Fixes as Issues: a Fix not applied is a WARNING."""
    return [Issue(WARN, x.warning) if isinstance(x, Fix) else x for x in found]


# ======================================================================================================================
# Scenes: a step's animation (format: media/journey-scene.js). With node, the extension's rules
# (cli/journey/scene.ts, sizes from the journey schema); without, the Python rules below.
# ======================================================================================================================


# What each actor type reads (anything else is ignored by the engine), what a beat's `set` may change on it, and the
# beat's own keys.
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
BEAT_KEYS = {'focus', 'caption', 'muted', 'set', 'packet', 'click', 'flash', 'code', 'example', 'hold', 'marks'}
SCREENS = ('dialog', 'detail', 'signin')             # and the names of the actor's own `pages`
SCREEN_ALIAS = ('run-dialog', 'run-page', 'login')   # older journeys' names of the three
PANES = ('picture', 'chat', 'desktop')               # desktop: the older name of picture
TONES = ('neutral', 'active', 'good', 'bad')
LOCKS = ('ok', 'warn')
DEFAULT_LABEL = {'app': 'Web app', 'browser': 'Browser', 'terminal': 'Terminal', 'file': 'file', 'chat': 'Chat'}
STARTS_EMPTY = ('terminal', 'chat')                  # nothing is shown until a beat sets `show`
# Widths in pixels, estimated from character counts (media/journey-scene.css; calibrated with the extension's panel
# check, test/journey-scene/check.mjs).
TOP_PX = 280               # the app window's top bar …
BRAND_PX = 7.8             # … its brand (12.5 px bold) …
TAB_PX = 6.8               # … and tabs (12 px)
TAB_GAP = 12
ROW_PX = 300               # a table row …
MONO_13_PX = 7.8           # … its id in 13 px mono …
ROW_ID_MIN_PX = 70         # … at least 70 px wide
PILL_PX = 6.2              # a row's pills: 12 px text …
PILL_GAP = 9               # … 9 px apart
PILL_PAD = 18
PODS_PX = 320              # pods side by side
INNER_PODS_PX = 296
LABEL_14_PX = 7.2          # a pod's 14 px label …
NOTE_12_PX = 6.4           # … over its 12 px note


def scene_issues(k, sc):
    """Issues of step k's scene against what the scene engine (media/journey-scene.js) draws."""
    got = RULES.ask('scene', step=k, scene=sc)
    if got is FALLBACK:
        return scene_rules(k, sc)
    return [Issue(i['level'], i['text']) for i in got]


# --- the Python rules for a scene (without node; the helper's are cli/journey/scene.ts of the extension, which
# reads the sizes from the journey schema)
class Issues(list):
    """Issues said with a common prefix: problem(text), refuse(text), warn(text)."""
    def __init__(self, prefix=''):
        super().__init__()
        self.prefix = prefix

    def problem(self, text):
        self.append(Issue(PROBLEM, self.prefix + text))

    def refuse(self, text):
        self.append(Issue(REFUSE, self.prefix + text))

    def warn(self, text):
        self.append(Issue(WARN, self.prefix + text))


def actor_type(a):
    return TYPE_ALIAS.get(a.get('type'), a.get('type'))


def listed(a, key):
    """A list field of an actor; anything else is none."""
    return a.get(key) if isinstance(a.get(key), list) else []


def scene_rules(k, sc):
    out = Issues(f'step {k} scene: ')
    if not isinstance(sc, dict):
        out.problem('must be an object {actors, wires, beats}')
        return out
    for key in set(sc) - {'actors', 'wires', 'beats'}:
        out.refuse(f'"{key}" is not part of a scene (actors, wires, beats); the engine ignores it')
    actors, beats = sc.get('actors'), sc.get('beats')
    if not isinstance(actors, list) or not actors or not isinstance(beats, list) or not beats:
        out.problem('needs a non-empty "actors" list and a non-empty "beats" list')
        return out
    ids = actor_issues(actors, out)
    pairs = wire_issues(sc.get('wires', []), ids, out)
    beat_issues(k, beats, ids, pairs, out)
    return out


def actor_issues(actors, out):
    """Each actor checked; returns the actors by id."""
    ids = {}
    for i, a in enumerate(actors):
        if not isinstance(a, dict) or not isinstance(a.get('id'), str) or not a.get('id'):
            out.problem(f'actors[{i}] needs a string "id"')
            continue
        aid, t = a['id'], actor_type(a)
        if aid in ids:
            out.problem(f'two actors have the id "{aid}"')
        if aid == 'all':
            out.problem('"all" is not an actor id')
        ids[aid] = a
        if t not in ACTOR_KEYS:
            out.problem(f'actor {aid}: type {t!r} does not exist (types: {", ".join(ACTOR_KEYS)}): the engine skips it')
            continue
        extra = set(a) - COMMON_KEYS - ACTOR_KEYS[t]
        if extra:
            out.refuse(f'actor {aid}: {", ".join(sorted(extra))} {"is" if len(extra) == 1 else "are"} not read by a {t} '
                       f'(it reads {", ".join(sorted(ACTOR_KEYS[t]))}): the engine ignores it')
        if 'col' in a and not (is_int(a['col']) and 0 <= a['col'] <= 3):
            out.problem(f'actor {aid}: "col" is a column number 0-3')
        sub = a.get('sub') or ''
        lab = str(a.get('label') or DEFAULT_LABEL.get(t, aid)) + (f' · {sub}' if sub else '')
        if len(lab) > LABEL_CHARS[t]:
            out.problem(f'actor {aid}: label and sub "{lab}" are {len(lab)} chars; a {t} box holds about {LABEL_CHARS[t]} '
                        f'on its top line: shorten them')
        said = Issues(f'actor {aid}: ')
        ACTOR_RULES[t](a, said)
        out.extend(Issue(lv, out.prefix + m) for lv, m in said)
    if len(actors) > MAX_ACTORS:
        out.refuse(f'{len(actors)} actors (max {MAX_ACTORS}: the parts this step touches; one box per part)')
    return ids


def service_rules(a, out):
    fn = a.get('fn', '')
    if len(str(fn)) > FN_CHARS:
        out.problem(f'fn "{fn}" is {len(str(fn))} chars (max {FN_CHARS}: the name and "()")')
    cs = listed(a, 'checks')
    if len(cs) > MAX_CHECKS:
        out.problem(f'{len(cs)} checks (max {MAX_CHECKS})')
    for c in cs:
        if len(str(c)) > MAX_CHECK:
            out.problem(f'check "{c}" is {len(str(c))} chars (max {MAX_CHECK})')


def table_rules(a, out):
    rows = listed(a, 'rows')
    if len(rows) > MAX_ROWS:
        out.problem(f'{len(rows)} rows (max {MAX_ROWS})')
    for r in rows:
        if not isinstance(r, dict) or not isinstance(r.get('id'), str):
            out.problem('a row is {"id": "…", "chips": ["…"], "old"?: true}')
            continue
        px = row_px(r['id'], r.get('chips') or [])
        if px > ROW_PX:
            out.problem(f'row "{r["id"]}" with chips {r.get("chips")} is about {px} px wide (the row holds {ROW_PX}): '
                        f'a shorter id or fewer, shorter chips')


def cluster_rules(a, out):
    pods = listed(a, 'pods')
    for m in pods_issues(pods, PODS_PX, 32, 12):
        out.problem(m)
    inner = a.get('inner')
    if inner is None:
        return
    if not isinstance(inner, dict):
        out.problem('"inner" is {"label", "sub"?, "ghost"?, "pods"}')
        return
    il = str(inner.get('label') or 'cluster') + (f' · {inner["sub"]}' if inner.get('sub') else '')
    if len(il) > INNER_LABEL_CHARS:
        out.problem(f'inner label and sub "{il}" are {len(il)} chars (about {INNER_LABEL_CHARS} fit)')
    for m in pods_issues(listed(inner, 'pods'), INNER_PODS_PX, 24, 10):
        out.problem(f'inner {m}')
    if len(pods) > 2:
        out.problem(f'{len(pods)} pods above an inner cluster (1 or 2 fit)')


def app_rules(a, out):
    out.extend(Issue(lv, out.prefix + m) for lv, m in app_issues(a))


def browser_rules(a, out):
    for key, n in BROWSER_CHARS.items():
        if len(str(a.get(key, ''))) > n:
            out.problem(f'{key} "{a[key]}" is {len(str(a[key]))} chars (max {n})')
    name, cart = str(a.get('title') or a.get('shop') or 'Shop'), str(a.get('cart') or 'Cart 0')
    if len(name) + len(cart) > SHOP_TOP:
        out.problem(f'title "{name}" and cart "{cart}" share one line: {len(name) + len(cart)} chars (max {SHOP_TOP})')
    for p in listed(a, 'products')[:2]:
        nm = p[0] if isinstance(p, list) and p else p
        if len(str(nm)) > PRODUCT_CHARS:
            out.problem(f'product "{nm}" is {len(str(nm))} chars (max {PRODUCT_CHARS})')


def file_rules(a, out):
    lim = FILE_NUM_CHARS if a.get('from') else FILE_CHARS
    if 'from' in a and not (is_int(a['from']) and a['from'] >= 1):
        out.problem('"from" is the number of the first line (omit it for a folder or a made-up document)')
    for ln in listed(a, 'lines'):
        if len(str(ln)) > lim:
            out.problem(f'line "{ln}" is {len(str(ln))} chars (max {lim}{" with line numbers" if a.get("from") else ""}; '
                        f'a longer one is cut)')


def chat_rules(a, out):
    for m in listed(a, 'messages'):
        if not (isinstance(m, dict) and m.get('from') in ('me', 'them') and isinstance(m.get('text'), str)):
            out.problem('a message is {"from": "me" | "them", "text": "…", "tool"?: true}')
            continue
        lim = CHAT_TOOL_CHARS if m.get('tool') else CHAT_CHARS
        if len(m['text']) > lim:
            out.problem(f'message "{m["text"]}" is {len(m["text"])} chars (max {lim}{" for a tool call" if m.get("tool") else ""}; one line)')


def queue_rules(a, out):
    if 'slots' in a and not (is_int(a['slots']) and 1 <= a['slots']):
        out.problem(f'"slots" is a number of places ({QUEUE_SLOTS} are drawn at most; "cap" says the real size)')
    if len(str(a.get('cap', ''))) > NOTE_CHARS:
        out.problem(f'cap "{a["cap"]}" is {len(str(a["cap"]))} chars (max {NOTE_CHARS})')


def gauge_rules(a, out):
    if not (isinstance(a.get('max'), (int, float)) and a['max'] > 0):
        out.problem('"max" is the limit, a number above 0')


def terminal_rules(a, out):
    for ln in listed(a, 'lines'):
        if len(str(ln)) > MAX_TERM_LINE:
            out.problem(f'line "{ln}" is {len(str(ln))} chars (max {MAX_TERM_LINE}; a longer one is cut): shorten it, '
                        f'keeping what the code prints')


# What each actor type draws, checked (one function per type, as the builders in media/journey-scene.js).
ACTOR_RULES = {'app': app_rules, 'service': service_rules, 'table': table_rules, 'cluster': cluster_rules,
               'browser': browser_rules, 'terminal': terminal_rules, 'file': file_rules, 'chat': chat_rules,
               'queue': queue_rules, 'gauge': gauge_rules}


def wire_issues(wires, ids, out):
    """The wires checked; returns the pairs of actors they join, both ways."""
    pairs = set()
    if not isinstance(wires, list):
        out.problem('"wires" is a list of [fromId, toId] pairs')
        return pairs
    for w in wires:
        if not (isinstance(w, list) and len(w) == 2 and all(isinstance(x, str) and x in ids for x in w)):
            out.problem(f'wire {w}: a wire is [fromId, toId] between two actors of this scene')
            continue
        pairs |= {tuple(w), tuple(w[::-1])}
    return pairs


def beat_issues(k, beats, ids, pairs, out):
    if len(beats) > MAX_BEATS:
        out.problem(f'{len(beats)} beats (max {MAX_BEATS}; aim for {MIN_BEATS}-{SOFT_BEATS}): one thing happening per beat')
    elif len(beats) > SOFT_BEATS:
        out.warn(f'{len(beats)} beats (aim for {MIN_BEATS}-{SOFT_BEATS}): merge two')
    elif len(beats) < MIN_BEATS:
        out.refuse(f'{len(beats)} beats (want {MIN_BEATS}-{SOFT_BEATS}); a step with less to show gets no scene (rmscene {k})')
    types = {actor_type(x) for x in ids.values()}
    is_actor = lambda v: isinstance(v, str) and v in ids
    is_browser = lambda v: is_actor(v) and ids[v].get('type') == 'browser'
    bare, shown = 0, {}              # beats in a row without code; terminal and chat ids -> lines shown so far
    for i, b in enumerate(beats, 1):
        bn = f'beat {i}'
        if not isinstance(b, dict):
            out.problem(f'{bn} is not an object')
            continue
        extra = set(b) - BEAT_KEYS
        if extra:
            out.refuse(f'{bn}: {", ".join(sorted(extra))} {"is" if len(extra) == 1 else "are"} not part of a beat '
                       f'({", ".join(sorted(BEAT_KEYS))})')
        f = b.get('focus')
        if f == 'all':
            out.problem(f'{bn}: focus "all" (a zoomed-out view too small to read): focus the one actor whose line the beat lights')
        elif not is_actor(f):
            out.problem(f'{bn}: focus {f!r} is not an actor of this scene ({", ".join(ids)})')
        cap, mut = str(b.get('caption', '')).strip(), str(b.get('muted', '')).strip()
        if not cap:
            out.problem(f'{bn}: no caption')
        elif len(cap) > SOFT_CAPTION:
            out.warn(f'{bn}: the caption is {len(cap)} chars (aim for < 60, max ~{SOFT_CAPTION}: read in three seconds); '
                     f'move a clause to "muted" or cut it: "{cap}"')
        elif len(cap) + len(mut) > SOFT_CAPTION_ALL:
            out.warn(f'{bn}: caption and muted are {len(cap) + len(mut)} chars together (aim for <= {SOFT_CAPTION_ALL}: '
                     f'read in three seconds)')
        set_issues(bn, b.get('set', {}), ids, shown, out)
        if is_actor(f) and ids[f].get('type') in STARTS_EMPTY and not shown.get(f):
            out.warn(f'{bn}: focus on {ids[f]["type"]} {f} while none of its lines is shown yet (set {{"{f}": {{"show": 1}}}})')
        p = b.get('packet')
        if p is not None:
            if not (isinstance(p, dict) and is_actor(p.get('from')) and is_actor(p.get('to'))):
                out.problem(f'{bn}: a packet is {{from, to, label}} between two actors of this scene')
            elif (p['from'], p['to']) not in pairs:
                out.problem(f'{bn}: packet {p["from"]} -> {p["to"]} has no wire to travel on (add ["{p["from"]}", '
                            f'"{p["to"]}"] to wires): the engine does not show it')
            elif len(str(p.get('label', ''))) > MAX_PACKET:
                out.warn(f'{bn}: packet label "{p["label"]}" is {len(str(p["label"]))} chars (aim for <= {MAX_PACKET})')
        v = b.get('click')
        if v and not types & {'browser', 'app'}:
            out.refuse(f'{bn}: "click" does nothing without a browser or app actor')
        elif v and 'app' not in types and not is_browser(v):
            out.refuse(f'{bn}: click {v!r} must be the id of the browser actor the click happens in')
        v = b.get('flash')
        if v and not is_browser(v):
            out.refuse(f'{bn}: flash {v!r} must be the id of a browser actor (the screenshot flash)')
        c = b.get('code')
        if c is None:
            bare += 1
            if bare == 2:
                out.warn(f'beats {i - 1} and {i} have no code line: never two in a row (a beat without code is for '
                         f'something with no line in this repo; keep those rare)')
        else:
            bare = 0
            if not (isinstance(c, dict) and isinstance(c.get('file'), str) and is_int(c.get('line'))):
                out.problem(f'{bn}: code is {{"file": "<repo path>", "line": <n>}} (the script reads the text)')
    if not any(isinstance(b, dict) and b.get('code') for b in beats):
        out.problem('no beat has a code line: a scene lights the code that does what it shows')


def set_issues(bn, st, ids, shown, out):
    """A beat's `set`: the actors it names, what it changes on each. Records what terminals and chats show."""
    if not isinstance(st, dict):
        out.problem(f'{bn}: "set" is {{actorId: {{…}}}}')
        return
    for aid, ch in st.items():
        a = ids.get(aid)
        if a is None:
            out.problem(f'{bn}: set on {aid!r}, which is not an actor of this scene')
            continue
        t = actor_type(a)
        if not isinstance(ch, dict):
            out.problem(f'{bn}: set.{aid} is an object of what changes')
            continue
        bad = set(ch) - SET_KEYS.get(t, set())
        if bad:
            out.refuse(f'{bn}: set.{aid}: {", ".join(sorted(bad))} does nothing on a {t} (it takes '
                       f'{", ".join(sorted(SET_KEYS.get(t, set())))})')
        for m in (STATE_RULES[t](a, ch) if t in STATE_RULES else []):
            out.refuse(f'{bn}: set.{aid}: {m}')
        if t in STARTS_EMPTY and 'show' in ch:
            shown[aid] = ch['show']


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


SCREEN_FIELDS = (('dialog', {'tab', 'title', 'item', 'lines', 'button'}),
                 ('detail', {'tab', 'title', 'status', 'tone', 'empty', 'cards', 'timeline', 'picture', 'placeholder', 'chat'}),
                 ('signin', {'title', 'notice', 'provider', 'button'}))


def app_issues(a):
    """What in an app actor does not fit the window it draws, or is not what the engine reads."""
    out = Issues()

    def long(what, v, n):
        if len(str(v)) > n:
            out.problem(f'{what} "{v}" is {len(str(v))} chars (max {n})')
    brand = str(a.get('brand') or 'App')
    logo = str(a.get('logo') or brand[:1])
    if len(logo) > 2:
        out.problem(f'logo "{logo}" is 1 or 2 letters')
    tabs = a.get('tabs', [])
    if not isinstance(tabs, list) or len(tabs) > MAX_TABS or not all(isinstance(x, str) for x in tabs):
        out.problem(f'"tabs" is a list of at most {MAX_TABS} short names')
        tabs = []
    for x in tabs:
        long('tab', x, TAB_CHARS)
    if top_bar_px(logo, brand, tabs) > TOP_PX:
        out.problem(f'brand "{brand}" and tabs {tabs} are about {round(top_bar_px(logo, brand, tabs))} px in the top bar '
                    f'({TOP_PX} fit): shorter names or fewer tabs')
    if a.get('screen') and a['screen'] not in screens_of(a):
        out.problem(f'screen {a["screen"]!r} does not exist ({", ".join(screens_of(a))})')
    on_tabs = lambda tab: tab is None or not tabs or tab in tabs
    for key, allowed in SCREEN_FIELDS:
        if key in a and not isinstance(a[key], dict):
            out.problem(f'"{key}" is an object ({", ".join(sorted(allowed))})')
        extra = set(sub_of(a, key)) - allowed
        if extra:
            out.problem(f'{key}: {", ".join(sorted(extra))} is not read (it reads {", ".join(sorted(allowed))})')
        tab = sub_of(a, key).get('tab')
        if not on_tabs(tab):
            out.problem(f'{key} tab {tab!r} is not one of its tabs {tabs}')
    for key, n in OLD_CHARS.items():
        long(key, a.get(key, ''), n)
    dg, dt, sg = sub_of(a, 'dialog'), sub_of(a, 'detail'), sub_of(a, 'signin')
    for key, n in DIALOG_CHARS.items():
        long(f'dialog {key}', dg.get(key, ''), n)
    dialog_lines(dg.get('lines', []), out)
    for key, n in DETAIL_CHARS.items():
        long(f'detail {key}', dt.get(key, ''), n)
    title = str(dt.get('title') or dg.get('item') or a.get('test') or 'Item')
    status = str(dt.get('status') or a.get('status') or 'New')
    if len(title) + len(status) > TITLE_CHIP:
        out.problem(f'detail title "{title}" and status "{status}" share one line: {len(title) + len(status)} chars (max {TITLE_CHIP})')
    if dt.get('tone') not in (None,) + TONES:
        out.problem(f'detail tone {dt["tone"]!r} is one of {", ".join(TONES)}')
    cards = app_list(a, 'cards', 'findings')
    if len(cards) > 2:
        out.warn(f'{len(cards)} cards; the detail page draws the first 2')
    for c in cards:
        if not isinstance(c, dict):
            out.problem('a card is {"sev"?: "low" | "medium" | "high" | "critical", "title": "…"}')
        else:
            long('card', c.get('title', ''), CARD_CHARS)
    for e in app_list(a, 'timeline', 'timeline'):
        long('timeline row', e, TIMELINE_CHARS)
    for m in app_list(a, 'chat', 'chat'):
        if not (isinstance(m, dict) and m.get('from') in ('me', 'them', 'you', 'agent') and isinstance(m.get('text'), str)):
            out.problem('a chat message is {"from": "me" | "them", "text": "…"}')
        else:
            long('chat message', m['text'], APP_CHAT_CHARS)
    for key, n in SIGNIN_CHARS.items():
        long(f'signin {key}', sg.get(key, ''), n)
    st = str(sg.get('title') or f'Sign in to {brand}')
    if len(st) > SIGNIN_CHARS['title']:
        out.problem(f'the sign-in title "{st}" is {len(st)} chars (max {SIGNIN_CHARS["title"]}): a shorter brand or signin.title')
    page_issues(a.get('pages', {}), on_tabs, tabs, long, out)
    return out


def top_bar_px(logo, brand, tabs):
    """The app window's top bar: the logo (20 px, 28 for two letters), a gap, the brand and the tabs."""
    tabs_px = sum(TAB_PX * len(x) for x in tabs) + TAB_GAP * (len(tabs) - 1) if tabs else 0
    return (28 if len(logo) > 1 else 20) + 16 + BRAND_PX * len(brand) + tabs_px


def dialog_lines(lines, out):
    if not isinstance(lines, list) or len(lines) > DIALOG_LINES:
        out.problem(f'dialog "lines" is a list of at most {DIALOG_LINES} [label, value] pairs')
        return
    for ln in lines:
        if not (isinstance(ln, list) and len(ln) == 2):
            out.problem('dialog: a line is ["label", "value"]')
        elif len(str(ln[0])) > LINE_KEY or len(str(ln[1])) > LINE_VALUE:
            out.problem(f'dialog line {ln}: label max {LINE_KEY} chars, value max {LINE_VALUE}')


def page_issues(pages, on_tabs, tabs, long, out):
    if not isinstance(pages, dict):
        out.problem('"pages" is {name: {tab, title, chip?, tone?, banner?, rows: [[label, value]], button?}}')
        return
    for name, pg in pages.items():
        if name in SCREENS or name in SCREEN_ALIAS or not isinstance(pg, dict):
            out.problem(f'page {name!r} must be an object with a name other than {", ".join(SCREENS + tuple(SCREEN_ALIAS))}')
            continue
        for key, lim in PAGE_CHARS.items():
            long(f'page {name} {key}', pg.get(key, ''), lim)
        if not on_tabs(pg.get('tab')):
            out.problem(f'page {name} tab {pg["tab"]!r} is not one of its tabs {tabs}')
        if len(str(pg.get('title') or name)) + len(str(pg.get('chip', ''))) > TITLE_CHIP:
            out.problem(f'page {name}: title and chip share one line (max {TITLE_CHIP} chars together)')
        if pg.get('tone') not in (None,) + TONES:
            out.problem(f'page {name} tone {pg["tone"]!r} is one of {", ".join(TONES)}')
        long(f'page {name} banner', pg.get('banner', ''), PAGE_BANNER)
        rows = pg.get('rows', [])
        if len(rows) > PAGE_ROWS:
            out.problem(f'page {name} has {len(rows)} rows (the page draws {PAGE_ROWS})')
        if len(rows) + bool(pg.get('banner')) + bool(pg.get('button')) > PAGE_ITEMS:
            out.problem(f'page {name}: {len(rows)} rows{", a banner" if pg.get("banner") else ""}'
                        f'{", a button" if pg.get("button") else ""}: {PAGE_ITEMS} of these fit under the title')
        for r in rows:
            if not (isinstance(r, list) and len(r) == 2):
                out.problem(f'page {name}: a row is ["label", "value"]')
            elif len(str(r[0])) > PAGE_KEY or len(str(r[1])) > PAGE_VALUE:
                out.problem(f'page {name} row {r}: label max {PAGE_KEY} chars, value max {PAGE_VALUE}')


def row_px(rid, chips):
    """A table row's width in px: the id, then its pills."""
    pills = sum(PILL_GAP + PILL_PAD + PILL_PX * len(str(c)) for c in chips)
    return round(max(ROW_ID_MIN_PX, MONO_13_PX * len(str(rid))) + pills)


def pods_issues(pods, room, pad, gap):
    """Pods side by side: problems when they do not fit `room` px."""
    out = []
    w = 0
    for p in pods:
        if not isinstance(p, dict) or not isinstance(p.get('label'), str):
            out.append('a pod is {"label", "note"?, "madeNote"?, "ghost"?}')
            continue
        note = max(len(str(p.get('note', ''))), len(str(p.get('madeNote', ''))))
        w += pad + max(LABEL_14_PX * len(p['label']), NOTE_12_PX * note)
    w += gap * max(0, len(pods) - 1)
    if w > room:
        out.append(f'pods {", ".join(str((p or {}).get("label")) for p in pods if isinstance(p, dict))} are about '
                   f'{round(w)} px side by side ({room} fit): fewer pods, or shorter labels and notes')
    return out


# --- a beat's `set`, per actor type: indexes and values that point at nothing the actor has
def is_index(v, m):
    """A list index into m items, or -1 for none."""
    return is_int(v) and -1 <= v < m


def is_count(v, m):
    return is_int(v) and 0 <= v <= m


def count(a, key):
    return len(a.get(key)) if isinstance(a.get(key), list) else 0


class StateRules:
    """The rules a beat's `set` shares across actor types, appending to `out`."""
    def __init__(self, ch, out):
        self.ch, self.out = ch, out

    def index(self, key, m, what):
        if key in self.ch and not is_index(self.ch[key], m):
            self.out.append(f'{key} {self.ch[key]!r} is not one of its {m} {what} (0-{m - 1}, or -1 for none)')

    def count(self, key, m, says):
        if key in self.ch and not is_count(self.ch[key], m):
            self.out.append(f'{key} {self.ch[key]!r}: {says}')

    def indexes(self, key, m, says):
        if any(not is_index(x, m) for x in (self.ch.get(key) or [])):
            self.out.append(f'{key} {self.ch[key]}: {says}')

    def long(self, key, n, says):
        if len(str(self.ch.get(key, ''))) > n:
            self.out.append(f'{key} "{self.ch[key]}" {says}')


def service_state(a, ch):
    out = []
    StateRules(ch, out).count('done', count(a, 'checks'), f'it has {count(a, "checks")} checks')
    return out


def table_state(a, ch):
    out = []
    rows = count(a, 'rows')
    StateRules(ch, out).index('hi', rows, 'rows')
    for r in (ch.get('chips') or {}):
        if not (str(r).isdigit() and int(r) < rows):
            out.append(f'chips for row {r!r}: it has {rows} rows')
        elif row_px(a['rows'][int(r)].get('id', ''), ch['chips'][r] or []) > ROW_PX:
            out.append(f'chips {ch["chips"][r]} make row {r} wider than the box ({ROW_PX} px)')
    return out


def cluster_state(a, ch):
    out = []
    rules = StateRules(ch, out)
    pods = count(a, 'pods')
    rules.index('mark', pods, 'pods')
    for key in ('made', 'gone'):
        rules.indexes(key, pods, f'it has {pods} pods')
    inner = a.get('inner') if isinstance(a.get('inner'), dict) else None
    if inner is None and set(ch) & {'inner', 'innerMade', 'innerMark', 'innerGone'}:
        out.append('inner/innerMade/innerMark/innerGone need an "inner" cluster on the actor')
    elif inner is not None:
        m = len(inner.get('pods') or [])
        rules.index('innerMark', m, 'inner pods')
        for key in ('innerMade', 'innerGone'):
            rules.indexes(key, m, f'the inner cluster has {m} pods')
    return out


def browser_state(a, ch):
    if ch.get('lock') not in (None, '') + LOCKS:
        return [f'lock {ch["lock"]!r} is "ok" (a padlock) or "warn" ("Not secure")']
    return []


def file_state(a, ch):
    out = []
    m = count(a, 'lines')
    StateRules(ch, out).count('show', m, f'it has {m} lines')
    hi = ch.get('hi')
    span = isinstance(hi, list) and len(hi) == 2 and all(is_index(x, m) for x in hi) and hi[0] <= hi[1]
    if hi is not None and not (is_index(hi, m) or span):
        out.append(f'hi {hi!r} is a line index or [first, last] of its {m} lines')
    lim = FILE_NUM_CHARS if a.get('from') else FILE_CHARS
    for i, v in (ch.get('text') or {}).items():
        if not (str(i).isdigit() and int(i) < m):
            out.append(f'text for line {i!r}: it has {m} lines')
        elif len(str(v)) > lim:
            out.append(f'text "{v}" is {len(str(v))} chars (max {lim})')
    return out


def chat_state(a, ch):
    out = []
    rules = StateRules(ch, out)
    m = count(a, 'messages')
    rules.index('hi', m, 'messages')
    rules.count('show', m, f'it has {m} messages')
    return out


def note_state(ch):
    out = []
    StateRules(ch, out).long('note', NOTE_CHARS, f'is {len(str(ch.get("note", "")))} chars (max {NOTE_CHARS}; one line)')
    return out


def queue_state(a, ch):
    out = []
    slots = a.get('slots') or 6
    room = min(QUEUE_SLOTS, slots) if is_int(slots) else QUEUE_SLOTS
    StateRules(ch, out).count('fill', room, f'it draws {room} places')
    return out + note_state(ch)


def gauge_state(a, ch):
    out = note_state(ch)
    for key in ('used', 'want'):
        if key in ch and not (isinstance(ch[key], (int, float)) and ch[key] >= 0):
            out.append(f'{key} {ch[key]!r} is a number')
    return out


def terminal_state(a, ch):
    out = []
    rules = StateRules(ch, out)
    m = count(a, 'lines')
    rules.index('hi', m, 'lines')
    rules.count('show', m, f'it has {m} lines')
    return out


def app_state(a, ch):
    out = []
    rules = StateRules(ch, out)
    if 'screen' in ch and ch['screen'] not in screens_of(a):
        out.append(f'screen {ch["screen"]!r} does not exist ({", ".join(screens_of(a))})')
    if ch.get('pane') not in (None, '') + PANES:
        out.append(f'pane {ch["pane"]!r} is "picture" or "chat" (the detail page; none: cards and timeline)')
    chats, cards, events = len(app_list(a, 'chat', 'chat')), len(app_list(a, 'cards', 'findings')), len(app_list(a, 'timeline', 'timeline'))
    rules.count('chat', chats, f'the actor has {chats} chat messages')
    rules.index('newChat', chats, 'chat messages')
    rules.long('typing', APP_CHAT_CHARS, f'is over {APP_CHAT_CHARS} chars')
    for key in ('picture', 'desktop'):
        rules.long(key, DETAIL_CHARS['picture'], f'is over {DETAIL_CHARS["picture"]} chars')
    most = max([len(p.get('rows') or []) for p in (a.get('pages') or {}).values() if isinstance(p, dict)] or [0])
    rules.count('rows', most, f'its pages have at most {most} rows')
    rules.index('hiRow', most, 'page rows')
    rules.count('findings', cards, f'it has {cards} cards')
    rules.count('cards', cards, f'it has {cards} cards')
    rules.count('events', events, f'it has {events} timeline rows')
    rules.index('newFinding', cards, 'cards')
    rules.index('newCard', cards, 'cards')
    rules.index('newEvent', events, 'timeline rows')
    rules.long('status', DETAIL_CHARS['status'], f'is over {DETAIL_CHARS["status"]} chars')
    if ch.get('tone') not in (None,) + TONES:
        out.append(f'tone {ch["tone"]!r} is one of {", ".join(TONES)}')
    return out


# What a beat's `set` may point at, per actor type.
STATE_RULES = {'app': app_state, 'service': service_state, 'table': table_state, 'cluster': cluster_state,
               'browser': browser_state, 'terminal': terminal_state, 'file': file_state, 'chat': chat_state,
               'queue': queue_state, 'gauge': gauge_state}


# ======================================================================================================================
# Marks: the part of a line a step or beat is about (docs/journey-format.md "Marks"; a podcast segment's
# marks have the same shape plus phrase and at). With node, the extension's src/core/format/marks.ts
# checks them (mark_check); the Python rules below are the same, and its tests run both on the same marks.
# ======================================================================================================================


# shape: what is wrong with its fields; code: (what, moved) against the code; spot: (line, col, end line, end col) lit.
MarkCheck = namedtuple('MarkCheck', 'shape code spot')


def mark_check(m, f, doc, missing):
    """Mark m of file f (its lines `doc`; None: the file isn't there). `missing`: what a match not found lights,
    'lines' (a podcast) or 'drop' (a journey: nothing)."""
    got = RULES.ask('mark', mark=m, file=f, doc=doc, onMissing=missing)
    if got is FALLBACK:
        return mark_check_py(m, f, doc, missing)
    code = got['code']
    return MarkCheck(got['shape'], code and (code['what'], code['moved']), got['spot'] and tuple(got['spot']))


def mark_check_py(m, f, doc, missing):
    if not isinstance(m, dict):
        return MarkCheck('not an object { lines, match? }', None, None)
    shape = mark_shape_problem(m)
    if shape:
        return MarkCheck(shape, None, None)
    return MarkCheck(None, mark_code_problem(doc, f, m, missing), mark_spot(doc, m) if doc else None)


def is_whole_number(x):
    """A number with nothing after the point (JSON's 2 or 2.0), never a bool: the extension's Number.isInteger."""
    return isinstance(x, (int, float)) and not isinstance(x, bool) and float(x).is_integer()


def _js(v):
    """A value in a message, as the extension's JSON.stringify writes it (no spaces, whole floats as integers)."""
    def norm(x):
        if isinstance(x, float) and x.is_integer():
            return int(x)
        if isinstance(x, list):
            return [norm(y) for y in x]
        if isinstance(x, dict):
            return {k: norm(y) for k, y in x.items()}
        return x
    return json.dumps(norm(v), separators=(',', ':'), ensure_ascii=False)


def mark_shape_problem(m):
    """What is wrong with a mark's code fields (lines, file, match, nth), the first found; None: usable."""
    ln = m.get('lines')
    if not (isinstance(ln, list) and len(ln) == 2 and all(is_whole_number(x) and x >= 1 for x in ln) and ln[1] >= ln[0]):
        return f'lines must be [first, last] (1-based, first <= last), got {_js(ln) if "lines" in m else "undefined"}'
    if 'file' in m and (not isinstance(m['file'], str) or not m['file'].strip()):
        return 'file is not a path'
    if 'match' in m and (not isinstance(m['match'], str) or not m['match']):
        return 'match is not a text'
    if 'nth' in m and not (is_whole_number(m['nth']) and m['nth'] >= 1):
        return f'nth must be 1 or more, got {_js(m["nth"])}'
    return None


def mark_code_problem(doc, f, m, missing):
    """What is wrong with mark m against its file's lines `doc` (None: the file isn't there): (message, moved) or
    None when it is in place. moved: the shift it was found at, None when it lights nothing."""
    if doc is None:
        return (f"{f} isn't in the repository; nothing is lit", None)
    a, b = int(m['lines'][0]), int(m['lines'][1])
    where = (f'line {a}' if a == b else f'lines {a}–{b}') + f' of {f}'
    if b > len(doc):
        past = a > len(doc)
        return (f"{where} {('is' if a == b else 'are') if past else 'go'} past its end ({len(doc)} lines){'; nothing is lit' if past else ''}", None)
    if not isinstance(m.get('match'), str):
        return None
    nth = int(m['nth']) if is_whole_number(m.get('nth')) else 1
    moved = mark_moved(doc, [a, b], m['match'], nth)
    if moved == 0:
        return None
    what = f"{_js(m['match'])}{f' (occurrence {nth})' if nth > 1 else ''} isn't in {where}"
    if moved is not None:
        d = abs(moved)
        return (f"{what}; found {d} {'line' if d == 1 else 'lines'} {'up' if moved < 0 else 'down'}, lit there", moved)
    return (f"{what}, nor within {MARK_REFIND} lines: {'the whole lines light' if missing == 'lines' else 'nothing is lit'}", None)


def mark_occurrence(doc, a, b, match, nth):
    """The nth occurrence of `match` in lines a..b (0-based, inclusive; clipped to the document): True when there."""
    a, b = max(0, a), min(len(doc) - 1, b)
    if a > b:
        return False
    text = '\n'.join(doc[a:b + 1])
    i = -len(match)
    for _ in range(nth):
        i = text.find(match, i + len(match))
        if i < 0:
            return False
    return True


def mark_moved(doc, lines, match, nth=1):
    """Where `match` is, against `lines` (1-based [first, last]): 0 in place, else the nearest shift within
    MARK_REFIND lines (up before down), None: not there."""
    a, b = lines[0] - 1, lines[1] - 1
    for d in range(0, MARK_REFIND + 1):
        for s in ((0,) if d == 0 else (-d, d)):
            if mark_occurrence(doc, a + s, b + s, match, nth):
                return s
    return None


def mark_spot(doc, m):
    """Where mark m lights in `doc`: (line, col, end_line, end_col), 0-based, the end exclusive; None: nothing (a
    journey's match not found lights nothing)."""
    a, b = int(m['lines'][0]) - 1, min(int(m['lines'][1]) - 1, len(doc) - 1)
    if a < 0 or a >= len(doc):
        return None
    if not isinstance(m.get('match'), str):
        return (a, len(doc[a]) - len(doc[a].lstrip()) if doc[a].strip() else 0, b, len(doc[b]))
    nth = int(m['nth']) if is_whole_number(m.get('nth')) else 1
    moved = mark_moved(doc, [a + 1, b + 1], m['match'], nth)
    if moved is None:
        return None
    lo, hi = max(0, a + moved), min(len(doc) - 1, b + moved)
    text = '\n'.join(doc[lo:hi + 1])
    i = -len(m['match'])
    for _ in range(nth):
        i = text.find(m['match'], i + len(m['match']))

    def pos(off):
        ln = lo
        while off > len(doc[ln]):
            off -= len(doc[ln]) + 1
            ln += 1
        return ln, off
    (l1, c1), (l2, c2) = pos(i), pos(i + len(m['match']))
    return (l1, c1, l2, c2)


def mark_preview(doc, sp, indent='      '):
    """The lines a mark lights (sp: its spot), each with a ^ line under the characters it lights."""
    if not sp:
        return [f'{indent}(nothing lit)']
    l1, c1, l2, c2 = sp
    out = []
    for ln in range(l1, l2 + 1):
        text = doc[ln].rstrip('\n')
        a = c1 if ln == l1 else len(text) - len(text.lstrip())
        b = c2 if ln == l2 else len(text)
        lead = len(text) - len(text.lstrip())
        shown = text[lead:]
        out.append(f'{indent}L{ln + 1}: {shown[:110]}')
        if b > a and a - lead < 110:
            out.append(f'{indent}{" " * len(f"L{ln + 1}: ")}{" " * (a - lead)}{"^" * max(1, min(b, lead + 110) - a)}')
    return out


def words_of(text):
    """The words a text names a mark by: identifiers split at camelCase and _, and numbers."""
    return re.findall(r'[A-Za-z]+|\d+', re.sub(r'([a-z])([A-Z])', r'\1 \2', text))


def names_match(named, match):
    """The text's words (stemmed) name the match: one of its words (3 letters or more, or a number), or a word
    sharing its first 4 letters or more."""
    ws = {stem(w.lower()) for w in words_of(match) if len(w) >= 3 or w.isdigit()}
    near = lambda w, t: w == t or min(len(w), len(t)) >= 4 and (w.startswith(t) or t.startswith(w))
    return not ws or any(near(w, t) for w in ws for t in named)


def mark_file_lines(code, f):
    """A mark's file's lines now (followed through a git rename when the code has a commit to follow from), and its
    path; (None, f) when it is gone."""
    cur = f
    if not code.isfile(f):
        cur = code.renamed(f) if code.since else f
        if not code.isfile(cur):
            return None, f
    return lines_of(code.repo, cur), cur


def marks_groups(s):
    """A step's marks and its beats': [(where, marks as written, default file, the text that should name them, beat)]."""
    out = []
    if 'marks' in s:
        text = ' '.join(str(s.get(x, '')) for x in ('title', 'lead', 'details'))
        out.append(('', s['marks'], s.get('file'), text, None))
    sc = s.get('scene') if isinstance(s.get('scene'), dict) else None
    for i, b in enumerate((sc or {}).get('beats') or [], 1):
        if isinstance(b, dict) and 'marks' in b:
            c = b.get('code') if isinstance(b.get('code'), dict) else {}
            out.append((f' beat {i}', b['marks'], c.get('file') or s.get('file'), f'{b.get("caption", "")} {b.get("muted", "")}', b))
    return out


def marks_issues(code, k, s):
    """A step's marks and its beats': Issues (a PROBLEM lights nothing or can't be read; a WARNING: too many, not on
    the step's lines, not named by the text, the step's whole range) and a Fix for a match a few lines off."""
    out = []
    for where, ms, own, text, beat in marks_groups(s):
        name = f'step {k}{where}'
        if not isinstance(ms, list):
            out.append(Issue(PROBLEM, f'{name}: marks is not a list of {{ lines, match? }}'))
            continue
        if len(ms) > MAX_MARKS:
            out.append(Issue(WARN, f'{name}: {len(ms)} marks (aim for <= {MAX_MARKS}: only what the text names, so it stands out)'))
        group = MarkGroup(code, s, own, {stem(w.lower()) for w in words_of(text)}, beat,
                          f'mark {k}{"." + where.split()[-1] if where else ""} …')
        for n, m in enumerate(ms, 1):
            out.extend(group.issues(f'{name}: mark {n}', m))
    return out


class MarkGroup(namedtuple('MarkGroup', 'code step own named beat again')):
    """A step's or a beat's marks: their default file, the words its text names, and the command that marks one
    again."""
    def issues(self, label, m):
        return mark_issues(self, label, m)


def mark_issues(g, label, m):
    """One mark of group g: an Issue, a Fix (found a few lines off), or the warnings of a mark that lights."""
    if not isinstance(m, dict):
        return [Issue(PROBLEM, f'{label}: not an object {{ lines, match? }}')]
    f = m.get('file') or g.own
    doc = mark_file_lines(g.code, f)[0] if isinstance(f, str) and f.strip() else None
    got = mark_check(m, f if isinstance(f, str) else '', doc, 'drop')
    if got.shape:
        return [Issue(PROBLEM, f'{label}: {got.shape}')]
    if not isinstance(f, str) or not f:
        return [Issue(PROBLEM, f'{label}: no file (give "file")')]
    if got.code:
        msg, moved = got.code
        if not moved:
            return [Issue(PROBLEM, f'{label}: {msg}; mark the characters as they are now ({g.again})')]
        lines = [m['lines'][0] + moved, m['lines'][1] + moved]
        return [Fix(f'{label}: {msg} (run check fix)', f'{label}: lines moved {moved:+d} to {lines[0]}-{lines[1]}',
                    lambda: m.__setitem__('lines', lines))]
    return mark_warnings(label, g, m, f, doc)


def mark_warnings(label, g, m, f, doc):
    """A mark that lights: where it is against the step, and whether the text names it."""
    out = []
    s, beat = g.step, g.beat
    r = s.get('range') or {}
    a, b = m['lines']
    if beat is None and f == s.get('file') and (b < r.get('start', a) or a > r.get('end', b)):
        out.append(Issue(WARN, f'{label}: {f}:{a}-{b} is outside the step\'s lines ({r.get("start")}-{r.get("end")}): a step marks its own code'))
    if 'match' not in m:
        if f == s.get('file') and beat is None and (a, b) == (r.get('start'), r.get('end')):
            out.append(Issue(WARN, f'{label}: lights the step\'s whole range: mark the part the text names (a "match")'))
    elif not names_match(g.named, m['match']):
        whose = 'caption' if beat is not None else "step's text"
        out.append(Issue(WARN, f'{label}: {_js(m["match"])}: the {whose} names none of it; mark only what the text talks about'))
    elif doc and m['match'].strip() == '\n'.join(x.strip() for x in doc[a - 1:b]).strip():
        out.append(Issue(WARN, f'{label}: {_js(m["match"])} is the whole line: leave "match" out, or mark the part that matters'))
    return out


# ======================================================================================================================
# Podcasts: <slug>.podcast.json next to the journey (docs/podcast-format.md of the Code Notes extension).
# With node, the extension's own validator (src/core/format/podcast/validate.ts) checks it; without, the
# Python rules below, which its tests run on the same cases (test/fixtures/podcast/cases.json).
# ======================================================================================================================


POD_CUES = ('map', 'open', 'beat')


def _pnum(v):
    """A finite number (never a bool), else None."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return v if v == v and v not in (float('inf'), float('-inf')) else None


def _clock(t):
    s = max(0, int(t // 1)) if t == t else 0
    h, m, r = s // 3600, (s % 3600) // 60, s % 60
    return (f'{h}:{m:02d}' if h else f'{m}') + f':{r:02d}'


def _clock_ms(t):
    tenths = round(t * 10) / 10
    whole = int(tenths // 1)
    frac = round((tenths - whole) * 10)
    return f'{_clock(whole)}.{frac}' if frac else _clock(whole)


def podcast_audio_problem(audio):
    """`audio` as written, when it can't be used: a URL, an absolute path, a path out of the podcast's folder."""
    a = audio.replace('\\', '/')
    drive = re.match(r'^[a-z]:/', a, re.I)
    if re.match(r'^[a-z][a-z0-9+.-]*:', a, re.I) and not drive:
        return f'audio must be a file in the journeys folder, not a URL (got {audio})'
    if a.startswith('/') or drive:
        return f'audio must be in the journeys folder, as a path relative to the podcast file (got {audio})'
    depth = 0
    for part in a.split('/'):
        if part == '..':
            depth -= 1
        elif part and part != '.':
            depth += 1
        if depth < 0:
            return f'audio must be in the journeys folder (got {audio})'
    return None


def _sentences_problem(v, start, end):
    """What is wrong with a segment's `sentences` (None: usable): not a non-empty list of {start, text}, starts out of
    order, or a start outside the segment (start to end; end None: from start on)."""
    if not isinstance(v, list) or not v:
        return 'sentences is empty' if isinstance(v, list) else 'sentences is not a list of { start, text }'
    prev = None
    for k, t in enumerate(v, 1):
        if not isinstance(t, dict) or not isinstance(t.get('text'), str) or not t['text'].strip():
            return f'sentences: item {k} is not {{ start, text }} with a text'
        at = _pnum(t.get('start'))
        if at is None:
            return f'sentences: item {k} has no start time in seconds'
        if prev is not None and at < prev - POD_SLACK:
            return f'sentences: item {k} starts at {_clock_ms(at)}, before item {k - 1} ({_clock_ms(prev)})'
        if at < start - POD_SLACK or (end is not None and at > end + POD_SLACK):
            seg = (f'outside the segment ({_clock_ms(start)}–{_clock_ms(end)})' if end is not None
                   else f'before the segment starts ({_clock_ms(start)})')
            return f'sentences: item {k} starts at {_clock_ms(at)}, {seg}'
        prev = at
    return None


def _r2(t):
    """Seconds rounded to hundredths, as the extension writes them (2.8, 3, 0.48)."""
    r = math.floor(t * 100 + 0.5) / 100
    return str(int(r)) if float(r).is_integer() else repr(r)


PodMarkProblem = namedtuple('PodMarkProblem', 'k text drop')   # k: the mark's index (None: the list); drop: ignored


class PhraseCursor:
    """Where the marks' phrases were found so far in a segment's text: each is looked for after the one before; the
    same phrase as the mark before is the same words (two places lit at once)."""
    def __init__(self, text):
        self.text, self.after, self.phrase, self.pos = text, 0, None, -1

    def find(self, phrase):
        p = self.pos if phrase == self.phrase else self.text.find(phrase, self.after)
        if p >= 0:
            self.after = p + len(phrase)
        self.phrase, self.pos = phrase, p
        return p


def _marks_problems(v, text, start, end, on_map):
    """What is wrong with a segment's `marks`: PodMarkProblems. As the extension's marksProblems."""
    if not isinstance(v, list):
        return [PodMarkProblem(None, 'marks is not a list of { phrase, at, lines }; ignored', True)]
    out, prev_at, cursor = [], None, PhraseCursor(text)
    length = max(0, end - start)
    for k, m in enumerate(v):
        bad = mark_problem_at(m, start, end, length, on_map)
        if bad:
            out.append(PodMarkProblem(k, f'mark {k + 1}: {bad}; ignored', True))
            continue
        at, ph = _pnum(m.get('at')), m['phrase']
        if prev_at is not None and at < prev_at - MARK_SLACK:
            out.append(PodMarkProblem(k, f'mark {k + 1} lights at {_r2(at)} s, before mark {k} ({_r2(prev_at)} s): marks light in the order they are said', False))
        searched_from = cursor.after
        if cursor.find(ph) < 0:
            out.append(PodMarkProblem(k, f'mark {k + 1}: the phrase {_js(ph)} isn\'t in the text' + (' after the phrase before it' if searched_from else ''), False))
        prev_at = at
    return out


def mark_problem_at(m, start, end, length, on_map):
    """Why a podcast mark is ignored (its shape, phrase, time, file); None: it is used."""
    if not isinstance(m, dict):
        return 'not an object { phrase, at, lines }'
    ph = m.get('phrase')
    if not isinstance(ph, str) or not ph.strip():
        return 'no phrase'
    at = _pnum(m.get('at'))
    if at is None:
        return 'no "at" (seconds from the segment\'s start)' if 'at' not in m else f'at {_js(m.get("at"))} is not a time in seconds'
    if at < -MARK_SLACK or at > length + MARK_SLACK:
        return f'at {_clock_ms(start + at)} ({_r2(at)} s) is outside the segment ({_clock_ms(start)}–{_clock_ms(end)})'
    shape = mark_shape_problem(m)
    if shape:
        return shape
    if 'file' not in m and on_map:
        return 'a mark in a segment on the map ("at": null) needs its own "file"'
    return None


def _mark_own_file(x, steps_by_id):
    """The file a segment shows (a mark's default): its beat's code file, else its step's; '' when not known."""
    at = x.get('at')
    if not isinstance(at, dict) or not isinstance(at.get('step'), str):
        return ''
    st = steps_by_id.get(at['step'])
    if not st:
        return ''
    b, bf = at.get('beat'), None
    if x.get('cue') != 'map' and is_whole_number(b) and b >= 1:
        files = st.get('beatFiles') or []
        bf = files[int(b) - 1] if int(b) - 1 < len(files) else None
    return bf or st.get('file') or ''


def _pod_bad_beat(x, beats_by_id):
    """Segment x names a beat its step doesn't have (or one that isn't a number): the step only is shown. As
    validate.ts hasBadBeat."""
    at = x.get('at')
    if not isinstance(at, dict) or not isinstance(at.get('step'), str) or 'beat' not in at or x.get('cue') == 'map':
        return False
    if at['step'] not in beats_by_id:
        return False
    b = at['beat']
    return not (is_whole_number(b) and 1 <= b <= beats_by_id[at['step']])


def _mark_code_problems(x, k_drop, steps_by_id, files, docs, bad_beat=False):
    """The marks of segment x against the code: [(n, message)]. As validate.ts markCodeProblems (a segment with a
    bad beat: only the marks naming their own file)."""
    out = []
    own = _mark_own_file(x, steps_by_id)
    for n, m in enumerate(x['marks']):
        if n in k_drop:
            continue
        if bad_beat and not isinstance(m.get('file'), str):
            continue
        f = m['file'] if isinstance(m.get('file'), str) else own
        if not f:
            continue
        if f not in docs:
            t = files(f)
            docs[f] = re.split(r'\r?\n', t) if isinstance(t, str) else t
        lines = docs[f]
        if lines is ...:
            continue
        got = mark_code_problem(lines, f, m, 'lines')
        if got:
            out.append((n, f'mark {n + 1}: {got[0]}'))
    return out


def podcast_findings(raw, journey=None, audio=None, audio_duration=None, changed=None, files=None, repo=None):
    """Every problem of a podcast file: dicts with level (error | warning | info), code, message, segment (or None).
    journey: {id, steps: [{id, beats, file, beatFiles}]}; audio: {exists, size} when looked at; audio_duration: the
    audio's seconds; changed: the journey's steps (numbers) whose code changed since the podcast's journey.commit.
    The marks' files are read from `repo`, or taken from `files` (path -> text; None: not there; left out: not read)."""
    got = RULES.ask('podcast', raw=raw, journey=journey, audio=audio, audioDuration=audio_duration, changed=changed,
                    files=files, repo=repo)
    if got is not FALLBACK:
        return got
    read = (lambda f: _repo_text(repo, f)) if repo is not None else files
    return podcast_problems(raw, journey, audio, audio_duration, changed, read)


# --- the Python rules for a podcast (without node; the helper runs the extension's own validator)
Segment = namedtuple('Segment', 'x i start end')      # a segment as written, its index, its start and end (None: none)


def segment_name(x, i):
    return x['id'] if isinstance(x.get('id'), str) and x['id'] else f'#{i + 1}'


class PodcastCheck:
    """One podcast file checked: the errors (it can't be played) and the rest, in file order."""
    def __init__(self):
        self.errors, self.out = [], []

    def error(self, code, msg):
        self.errors.append({'level': 'error', 'code': code, 'message': msg, 'segment': None})

    def warn(self, code, msg, seg=None, prefix=True):
        self.out.append({'level': 'warning', 'code': code, 'message': (f'segment {seg}: ' if seg and prefix else '') + msg, 'segment': seg})


def podcast_problems(raw, journey=None, audio=None, audio_duration=None, changed=None, files=None):
    """podcast_findings' rules. files: a repository file's text by path (None: not there; ...: not read), a callable
    or a dict."""
    c = PodcastCheck()
    try:
        d = json.loads(raw)
    except ValueError as e:
        c.error('json', 'the file is empty' if not raw.strip() else f'not valid JSON: line {e.lineno}, column {e.colno}: {e.msg}')
        return c.errors
    if not isinstance(d, dict):
        c.error('object', 'not a podcast: the file is not a JSON object')
        return c.errors
    if _pnum(d.get('version')) != 1:
        c.error('version', 'no "version" (this player reads version 1)' if 'version' not in d else
                f'version {json.dumps(d.get("version"))}: this player reads version 1')
        return c.errors
    audio_problems(c, d, audio)
    written = written_segments(c, d)
    j = d.get('journey') if isinstance(d.get('journey'), dict) else {}
    jid = j.get('id') if isinstance(j.get('id'), str) else ''
    if jid and journey and jid != journey['id']:
        c.warn('journey', f'written for journey "{jid}", but it is next to "{journey["id"]}": it plays with the journey next to it')
    duration = _pnum(d.get('duration'))
    if 'duration' in d and not (duration is not None and duration > 0):
        c.warn('duration', f'"duration" {json.dumps(d.get("duration"))} is not a length in seconds; ignored')
    srt = sorted(time_problems(c, written, duration), key=lambda t: (t.start, t.i))
    overlap_problems(c, srt)
    sentence_problems(c, srt, duration)
    mark_drops = segment_mark_problems(c, srt, duration)
    if journey:
        order_problems(c, srt, journey)
        link_problems(c, srt, journey)
        if files is not None:
            marks_against_code(c, srt, journey, files if callable(files) else (lambda f: files.get(f, ...)), mark_drops)
    commit = j.get('commit') if isinstance(j.get('commit'), str) else ''
    if commit and changed:         # worth knowing, nothing wrong with the file
        c.out.append({'level': 'info', 'code': 'recorded-for', 'segment': None,
                      'message': f'Code changed since recording: {"step" if len(changed) == 1 else "steps"} '
                                 f'{", ".join(str(n) for n in changed)}'})
    if audio_duration and audio_duration > 0:
        audio_length_problems(c, written, duration, audio_duration)
    if written and not any(_pnum(x.get('start')) is not None and _pnum(x.get('start')) >= 0 for x, _ in written):
        c.error('segments', 'no segment has a start time: nothing to play')
    return c.errors + c.out


def audio_problems(c, d, audio):
    a = d['audio'].strip() if isinstance(d.get('audio'), str) else ''
    if not a:
        c.error('audio', 'no "audio": the audio file, relative to this file' if 'audio' not in d else '"audio" is not a file name')
        return
    where = podcast_audio_problem(a)
    if where:
        c.error('audio-outside', where)
    elif audio is not None and not audio.get('exists'):
        c.error('audio-missing', f"the audio file {a} isn't there")
    elif audio is not None and audio.get('size') == 0:
        c.error('audio-empty', f'the audio file {a} is empty')


def written_segments(c, d):
    """The segments that are objects, with their index in the file."""
    segs = d.get('segments')
    if 'segments' not in d:
        c.error('segments', 'no "segments": the parts of the episode')
    elif not isinstance(segs, list):
        what = {str: 'a string', bool: 'a boolean', int: 'a number', float: 'a number'}.get(type(segs), 'an object')
        c.error('segments', f'"segments" is not a list (it is {what})')
    elif not segs:
        c.error('segments', '"segments" is empty: the episode has no parts')
    written = []
    for i, x in enumerate(segs if isinstance(segs, list) else []):
        if isinstance(x, dict):
            written.append((x, i))
        else:
            c.warn('segment', f'segment #{i + 1} is not an object; skipped')
    return written


def time_problems(c, written, duration):
    """Start, end, order in the file, past the duration. Returns the segments with a start time."""
    ids, prev, timed = {}, None, []
    for x, i in written:
        n = segment_name(x, i)
        if isinstance(x.get('id'), str) and x['id']:
            if x['id'] in ids:
                c.warn('id', f'the id "{x["id"]}" is used twice ({_pod_place(*ids[x["id"]])} and {_pod_place(i, x.get("start"))})', n)
            else:
                ids[x['id']] = (i, x.get('start'))
        if 'cue' in x and x['cue'] not in POD_CUES:
            c.warn('cue', f'cue {json.dumps(x["cue"])} is not map, open or beat; ignored', n)
        start = _pnum(x.get('start'))
        if start is None or start < 0:
            c.warn('start', ('no start time' if 'start' not in x else f'start {json.dumps(x.get("start"))} is not a time in seconds') + '; skipped', n)
            continue
        end = _pnum(x.get('end'))
        if 'end' in x and end is None:
            c.warn('end', f'end {json.dumps(x.get("end"))} is not a time in seconds; it ends where the next one starts', n)
        if end is not None and end < start - POD_SLACK:
            c.warn('end-before-start', f'ends at {_clock_ms(end)}, before it starts ({_clock_ms(start)})', n)
            end = None
        if prev and start < prev[1] - POD_SLACK:
            c.warn('order', f'starts at {_clock_ms(start)}, before segment {prev[0]} above it ({_clock_ms(prev[1])}): '
                            f'segments play in time order, not in file order', n)
        if duration is not None and duration > 0 and (end if end is not None else start) > duration + POD_SLACK:
            what = f'ends at {_clock_ms(end)}' if end is not None else f'starts at {_clock_ms(start)}'
            c.warn('past-duration', f'{what}, after the episode\'s "duration" ({_clock_ms(duration)})', n)
        prev = (n, start)
        timed.append(Segment(x, i, start, end))
    return timed


def overlap_problems(c, srt):
    for a, b in zip(srt, srt[1:]):
        if a.end is not None and b.start < a.end - POD_SLACK:
            c.warn('overlap', f'starts at {_clock_ms(b.start)}, before segment {segment_name(a.x, a.i)} ends ({_clock_ms(a.end)}): '
                              f'the later one wins from its start', segment_name(b.x, b.i))


def played_end(srt, k, duration):
    """Where segment k ends as the player times it: its end, else the next start, else the duration (None: none)."""
    nxt = srt[k + 1].start if k + 1 < len(srt) else None
    return next((e for e in (_pnum(srt[k].x.get('end')), nxt, duration) if e is not None), None)


def sentence_problems(c, srt, duration):
    for k, seg in enumerate(srt):
        if 'sentences' in seg.x:
            end = played_end(srt, k, duration)
            bad = _sentences_problem(seg.x['sentences'], seg.start, None if end is None else max(end, seg.start))
            if bad:
                c.warn('sentences', f'{bad}; the caption is estimated from the text instead', segment_name(seg.x, seg.i))


def segment_mark_problems(c, srt, duration):
    """The marks' shape, time and phrase. Returns, by segment index, the marks left out."""
    drops = {}
    for k, seg in enumerate(srt):
        if 'marks' not in seg.x:
            continue
        end = played_end(srt, k, duration)
        end = max(seg.start if end is None else end, seg.start)
        text = seg.x['text'] if isinstance(seg.x.get('text'), str) else ''
        found = _marks_problems(seg.x['marks'], text, seg.start, end, 'at' in seg.x and seg.x['at'] is None)
        drops[seg.i] = {p.k for p in found if p.drop}
        for p in found:
            c.warn('mark', p.text, segment_name(seg.x, seg.i))
    return drops


def step_of(x):
    """The step id a segment shows, None when it shows none."""
    at = x.get('at')
    return at.get('step') if isinstance(at, dict) and isinstance(at.get('step'), str) else None


def order_problems(c, srt, journey):
    """Steps first narrated in another order than the journey's: reordered since it was recorded."""
    index = {s['id']: k for k, s in enumerate(journey['steps'])}
    firsts = []
    for seg in srt:
        st = step_of(seg.x)
        if st is None or st not in index or any(f[0] == st for f in firsts):
            continue
        firsts.append((st, index[st], seg))
    late = [k for k in range(1, len(firsts)) if firsts[k][1] < firsts[k - 1][1]]
    if late:
        f, b = firsts[late[0]], firsts[late[0] - 1]
        more = f' ({len(late)} steps out of order)' if len(late) > 1 else ''
        c.warn('narration-order', f'narrates step {f[1] + 1} ("{f[0]}") after step {b[1] + 1} ("{b[0]}"): the journey\'s '
                                  f'steps were reordered since it was recorded; re-record it, or put the steps back{more}',
               segment_name(f[2].x, f[2].i))


def link_problems(c, srt, journey):
    """Where each segment is shown. A step the journey doesn't have is said once, with its segments and when."""
    beats = {s['id']: s['beats'] for s in journey['steps']}
    number = {s['id']: k + 1 for k, s in enumerate(journey['steps'])}
    missing = {}
    for seg in srt:
        st = step_of(seg.x)
        if st is not None and st not in beats:
            missing.setdefault(st, []).append(seg)
    for seg in srt:
        n, at = segment_name(seg.x, seg.i), seg.x.get('at', ...)
        if at is None:
            continue
        if not isinstance(at, dict) or not isinstance(at.get('step'), str):
            c.warn('at', '"at" is ' + ('missing' if at is ... else 'not null or { step, beat }') + '; it keeps the view before it', n)
        elif at['step'] not in beats:
            if missing[at['step']][0].i == seg.i:
                c.warn('step', missing_step(at['step'], missing[at['step']]), n, prefix=False)
        elif 'beat' in at and seg.x.get('cue') != 'map':
            b, sn = at['beat'], number[at['step']]
            if isinstance(b, str):
                c.warn('beat', f'Step {sn}: beat must be a number, got the string {json.dumps(b)}; showing the whole step', n, prefix=False)
            elif _pod_bad_beat(seg.x, beats):
                c.warn('beat', f'Step {sn}: no beat {json.dumps(b)} (it has {beats[at["step"]] or "none"}); showing the whole step', n, prefix=False)


def missing_step(step, segs):
    names = [segment_name(s.x, s.i) for s in segs]
    frm = _pnum(segs[0].x.get('start')) or 0
    last = segs[-1].x
    to = next((t for t in (_pnum(last.get('end')), _pnum(last.get('start'))) if t is not None), frm)
    which = f'segment {names[0]}' if len(names) == 1 else f'segments {names[0]}–{names[-1]}'
    keep = 'it keeps the view before it' if len(names) == 1 else 'they keep the view before them'
    return f'step "{step}" isn\'t in the journey ({which}, {_clock_ms(frm)}–{_clock_ms(to)}): {keep}'


def marks_against_code(c, srt, journey, read, mark_drops):
    """The marks against the code: the file, the lines, the match."""
    by_id = {st['id']: st for st in journey['steps']}
    beats = {s['id']: s['beats'] for s in journey['steps']}
    docs = {}
    for seg in srt:
        if isinstance(seg.x.get('marks'), list):
            # A beat the step doesn't have is said once: its marks are not checked against the step's file.
            bad_beat = _pod_bad_beat(seg.x, beats)
            for _, msg in _mark_code_problems(seg.x, mark_drops.get(seg.i, set()), by_id, read, docs, bad_beat):
                c.warn('mark', msg, segment_name(seg.x, seg.i))


def audio_length_problems(c, written, duration, length):
    """The episode against the audio's real length."""
    starts = [(x, _pnum(x.get('start'))) for x, _ in written]
    ends = [e for e in (_pnum(x.get('end')) if _pnum(x.get('end')) is not None else s for x, s in starts) if e is not None]
    episode = max([duration or 0, 0] + ends)
    slack = max(POD_DUR_SLACK, length * 0.01)
    past = [x for x, s in starts if (s if s is not None else -1) >= length]
    if episode > length + max(2, slack) and past:
        c.warn('audio-short', f'The audio is {_clock(length)} long but the episode is {_clock(episode)}: the file looks cut off '
                              f'({len(past)} {"part starts" if len(past) == 1 else "parts start"} after its end)')
        return
    if duration is not None and abs(duration - length) > slack:
        c.warn('duration', f'"duration" says {_clock_ms(duration)} but the audio is {_clock_ms(length)} long')
    for x, i in written:
        e = _pnum(x.get('end'))
        if e is not None and e > length + slack:
            c.warn('past-audio', f"ends at {_clock_ms(e)}, after the audio's end ({_clock_ms(length)})", segment_name(x, i))


def _pod_place(i, start):
    """Where a segment is, in a message: its start time, else its place in the file."""
    t = _pnum(start)
    return _clock_ms(t) if t is not None and t >= 0 else f'#{i + 1}'


def podcast_changed_steps(git, commit, j):
    """The journey's steps (numbers) whose file changed since `commit` (committed or not); None: git can't say."""
    if not re.match(r'^[0-9a-f]{4,40}$', commit or '', re.I):
        return None
    files = git.changed_files(commit)
    if files is None:
        return None
    return [k + 1 for k, s in enumerate(j.get('steps', [])) if s.get('file') in files]


def audio_seconds(path):
    """The audio file's length in seconds: a .wav by its header, anything else with ffprobe when it is installed
    (None: unknown, and `podcast` says how to give it)."""
    if path.lower().endswith('.wav'):
        import wave
        try:
            with wave.open(path) as w:
                return w.getnframes() / float(w.getframerate())
        except (wave.Error, EOFError, OSError, ZeroDivisionError):
            return None
    try:
        r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
                           capture_output=True, text=True, timeout=30)
        return float(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip() else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def beat_file(b):
    """The file a beat's code line is in; None when it has none."""
    c = b.get('code') if isinstance(b, dict) else None
    return c.get('file') if isinstance(c, dict) and isinstance(c.get('file'), str) else None


def journey_shape_of(j, slug):
    """What the podcast check needs of the journey: its id, and each step's id, beats and files."""
    def beats(s):
        sc = s.get('scene') or {}
        return sc.get('beats') or []
    return {'id': j.get('id') or slug, 'steps': [{'id': s.get('id'), 'beats': len(beats(s)), 'file': s.get('file'),
                                                  'beatFiles': [beat_file(b) for b in beats(s)]} for s in j.get('steps', [])]}


def podcast_report(ctx, slug, j, seconds=None):
    """(problems, warnings, summary) for <slug>.podcast.json next to the journey; None when there is none."""
    pf = ctx.journeys.podcast(slug)
    if not os.path.exists(pf):
        return None
    try:
        raw = open(pf, encoding='utf-8').read()
    except (OSError, UnicodeDecodeError) as e:
        return [f'{pf}: can\'t be read ({e})'], [], ''
    try:
        d = json.loads(raw)
    except ValueError:
        d = None
    d = d if isinstance(d, dict) else {}
    audio, length = None, None
    name = d.get('audio')
    if isinstance(name, str) and name.strip() and not podcast_audio_problem(name.strip()):
        ap = os.path.normpath(os.path.join(os.path.dirname(pf), name.strip()))
        audio = {'exists': os.path.isfile(ap), 'size': os.path.getsize(ap) if os.path.isfile(ap) else 0}
        length = float(seconds) if seconds else (audio_seconds(ap) if audio['exists'] else None)
    commit = d['journey'].get('commit') if isinstance(d.get('journey'), dict) else None
    changed = podcast_changed_steps(ctx.git, commit, j) if isinstance(commit, str) else None
    found = podcast_findings(raw, journey_shape_of(j, slug), audio, length, changed, repo=ctx.repo)
    problems = [f'podcast: {p["message"]}' for p in found if p['level'] == 'error']
    warnings = [f'podcast: {p["message"]}' for p in found if p['level'] == 'warning']
    summary = '' if length else ' (audio length unknown: pass it as <audio seconds>, or install ffprobe, to check the times against it)'
    # Worth knowing, not a problem (recorded for an older commit): in the summary line.
    summary += ''.join(f'; {p["message"]}' for p in found if p['level'] == 'info')
    return problems, warnings, summary


def _repo_text(repo, f):
    """A repository file's text (None: not there or not readable as text)."""
    root = os.path.abspath(repo)
    p = os.path.normpath(os.path.join(root, f))
    if not p.startswith(root + os.sep):
        return None
    try:
        with open(p, encoding='utf-8') as fh:
            return fh.read()
    except (OSError, UnicodeDecodeError):
        return None


# ======================================================================================================================
# Check: the whole journey against the rules and the code, as `check` reports it.
# ======================================================================================================================


class Report:
    """What `check` found: problems, warnings, and the fixes it made (with fix) in the order found."""
    def __init__(self, fix):
        self.fix = fix
        self.problems, self.warnings, self.fixed = [], [], []

    def problem(self, text):
        self.problems.append(text)

    def warn(self, text):
        if text:
            self.warnings.append(text)

    def add(self, found):
        """Issues (a PROBLEM, else a WARNING) and Fixes (applied with fix, else a WARNING)."""
        for x in found:
            if isinstance(x, Fix):
                if self.fix:
                    x.apply()
                    self.fixed.append(x.text)
                else:
                    self.warnings.append(x.warning)
            elif x.level == PROBLEM:
                self.problems.append(x.text)
            else:
                self.warnings.append(x.text)


class JourneyMap:
    """The boxes and edges of a journey as a graph: what is inside what, who reaches whom."""
    def __init__(self, repo, j):
        self.repo, self.j = repo, j
        self.ids = {n['id']: n for n in j['nodes']}
        self.kids = {}
        for n in j['nodes']:
            self.kids.setdefault(n.get('parent', ''), []).append(n)
        self.edges = j['edges']
        self.direct = {(e['from'], e['to']) for e in self.edges}
        both = [(a, b) for e in self.edges if e['from'] in self.ids and e['to'] in self.ids
                for a in self.up(e['from']) for b in self.up(e['to'])]
        self.lifted = set(both)

    def up(self, nid):
        """The box and the boxes around it."""
        out = []
        while nid in self.ids:
            out.append(nid)
            nid = self.ids[nid].get('parent', '')
        return out

    def touched(self, nid):
        """An edge touches this box or something inside it."""
        if any(nid in (e['from'], e['to']) for e in self.edges):
            return True
        return any(self.touched(c['id']) for c in self.kids.get(nid, []))

    def callers(self, nid):
        """Every box the path came through to get here (edges followed backwards)."""
        out, todo = set(), [nid]
        while todo:
            x = todo.pop()
            for e in self.edges:
                if e['to'] == x and e['from'] not in out and e['from'] != nid:
                    out.add(e['from'])
                    todo.append(e['from'])
        return out

    def joined(self, x, y):
        ux, uy = self.up(x), self.up(y)
        return any(((p, q) in self.lifted or (q, p) in self.lifted) for p in ux for q in uy if p not in uy and q not in ux)

    def linked(self, a, b):
        """An edge joins the two boxes at some level (either way); or the path returns to a box it came through (a
        caller) and that box has the edge to b; or both have an edge with one same box (a store, a queue)."""
        if self.joined(a, b) or b in self.callers(a) or any(self.joined(x, b) for x in self.callers(a) if x in self.ids and x != b):
            return True
        both_ways = self.direct | {(t, f) for f, t in self.direct}
        return any((a, x) in both_ways and (b, x) in both_ways for x in self.ids if x not in (a, b))

    def names(self, nid):
        """The identifiers a call of this box would use: its label and what its first line declares."""
        n = self.ids[nid]
        head = as_v3(n['at']['anchor']).get('head', '').split('\n')[0] if 'at' in n else ''
        m = re.search(r'\bfunc\s+(?:\([^)]*\)\s*)?(\w+)|\bfunction\s+(\w+)|\bdef\s+(\w+)|\b(?:const|let|var)\s+(\w+)'
                      r'|^\s*(?:export\s+)?(?:async\s+)?(\w+)\s*\(', head)
        out = {g for g in (m.groups() if m else ()) if g}
        out |= {w for w in re.findall(r'[A-Za-z_]\w{3,}', n['label']) if re.search(r'[a-z][A-Z]|_', w) or ' ' not in n['label']}
        return out

    def mentions(self, x, y):
        """The code of box x names box y."""
        text = '\n'.join(code_at(self.repo, self.ids[x].get('at')))
        return any(re.search(r'\b' + re.escape(w) + r'\b', text) for w in self.names(y))

    def hop_hint(self, a, b):
        """How to join two boxes the path jumps between. A call is only suggested when the code of one names the
        other; when they can only meet through a stored record, the hint is a store box, never an arrow between them."""
        ids = self.ids
        for x, y in ((a, b), (b, a)):
            st = [s for s in ids.values() if s['kind'] == 'store' and (x, s['id']) in self.direct]
            if st:             # one side already writes or reads a store box
                return (f'"{ids[x]["label"]}" already has an edge to the store box "{st[0]["label"]}": if "{ids[y]["label"]}" '
                        f'meets it there, edge {y} {st[0]["id"]} "polls … / reads …" async (not an arrow between the two)')
        if 'at' in ids[a] and 'at' in ids[b] and (self.mentions(a, b) or self.mentions(b, a)):
            x, y = (a, b) if self.mentions(a, b) else (b, a)
            return f'"{ids[x]["label"]}" names "{ids[y]["label"]}" in its code: add the hop (edge {x} {y} "…")'
        par = next((p for p in self.up(a)[1:] + self.up(b)[1:] if ids[p]['kind'] in PARENT_KINDS['store']), '<system or module>')
        return (f'if they only meet through a record, queue or table of the app (one writes it, the other polls or reads '
                f'it), add a store box both have an edge to: node <id> store "<the record>" {par} --blurb "…"; '
                f'edge {a} <id> "inserts …"; edge {b} <id> "polls every … s" async. Draw an edge between the two only if '
                f'one really reaches the other (a call, an HTTP request, a watch), labelled with how')


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


def follow(code, r, name, loc, a, how):
    """Where anchored code is now: loc is a box's `at` (file/start/end) or a step; a its anchor. Moved: fixed with
    fix, else a WARNING; changed, gone or no file: a PROBLEM. Returns where it is now (file, start, end)."""
    rng = loc.get('range', loc)
    st, f, s0, e0, more = where(code, loc['file'], rng['start'], rng['end'], a)
    old = f'{loc["file"]}:{rng["start"]}-{rng["end"]}'
    k = name.split()[-1]
    if st is State.MOVED:
        if r.fix:
            loc['file'] = f
            rng['start'], rng['end'] = s0, e0
            if 'anchor' in loc:      # its hash is the same; the line count and the lines around it may not be
                loc['anchor'] = anchor(code.repo, f, s0, e0)
            r.fixed.append(f'{name}: {old} -> {f}:{s0}-{e0}')
        else:
            r.warn(f'{name} moved to {f}:{s0}-{e0} (was {old}; run check --fix)')
    elif st is State.NO_FILE:
        if code.git.error:
            r.problem(f'{name}: {old} no longer exists; git could not be asked about a rename (see the WARNING): {how}')
        else:
            r.problem(f'{name}: {old} no longer exists (and git shows no rename): {how}')
    elif st in (State.CHANGED, State.GONE):
        # changed code may have made the step false; moving the anchor alone would bless it
        verb, seen, diff = what_changed(code.repo, st, loc, a, f, s0, e0, old, more)
        if 'range' in loc:
            r.problem(f'{name} "{loc.get("title", "")}": its code {verb} ({seen}). Re-read the code and re-verify the '
                      f'title and the lead: if they are still true, {how}; if not, correct them first '
                      f'(restep {k} title|lead|details "…") and then re-anchor; if the code is gone, rmstep {k}{diff}')
        else:
            r.problem(f'{name}: its code {verb} ({seen}). Re-read the function, check the steps on this box still say '
                      f'what it does, then {how}{diff}')
    return f, s0, e0


def what_changed(repo, st, loc, a, f, s0, e0, old, more):
    """(verb, where it is now, the diff lines) for code that changed or is gone."""
    if st is State.CHANGED:
        return 'changed', f'now at {f}:{s0}-{e0}, was {old}', old_diff(a, lines_of(repo, f)[s0 - 1:e0])
    cur = more.replace('renamed to ', '') if more else loc['file']
    near = nearest(repo, cur, a)
    if near:
        lines = near[2][:12] + ([f'  … {len(near[2]) - 12} more changed lines'] if len(near[2]) > 12 else [])
        return 'changed', f'now about {cur}:{near[0]}-{near[1]}, was {old}', ''.join('\n      ' + d[:140] for d in lines)
    head = as_v3(a).get('head', '').split('\n')[0].strip()[:80]
    seen = (f'was {old}' + (f', file {more}' if more else '') + f'; its first lines ("{head}" …) and '
            f'its last ones are not found together in the file any more')
    return 'is gone', seen, ''


def check_header(journeys, slug, j, r):
    """The journey's title, question and summary, and the journeys like it."""
    tp = journey_title_problem(j['title'])
    if tp:
        r.problem(f'title "{j["title"]}" {tp} (meta title "…")')
    if not j.get('question', '').strip():
        r.problem('no question (meta question "…")')
    elif question_problem(j['question']):
        r.problem(f'question {question_problem(j["question"])} (meta question "…")')
    r.warnings.extend(similar_journeys(journeys, slug, j))
    sm = sentences(j.get('summary', ''))
    if not sm:
        r.problem('no summary')
    else:
        if len(sm) > MAX_SUMMARY_SENTENCES:
            r.problem(f'summary has {len(sm)} sentences (max {MAX_SUMMARY_SENTENCES}, plain words; the rest belongs in the steps)')
        if '`' in re.split(SENT, j['summary'].strip())[0]:
            r.problem('summary: code (backticks) in the first sentence; say it in plain words')


def check_node(code, j, g, n, r):
    """One box: its parent, label, blurb, path and the code it is anchored on."""
    want = PARENT_KINDS[n['kind']]
    par = g.ids.get(n.get('parent', ''))
    if (par['kind'] if par else None) not in want:
        r.problem(f'{n["id"]}: a {n["kind"]} node has parent {par["kind"] if par else "none"}, expected {" or ".join(w or "none" for w in want)}')
    if n['kind'] == 'function' and 'at' not in n:
        r.problem(f'{n["id"]}: a function node needs file:start-end')
    if len(n['label']) > MAX_LABEL:
        r.problem(f'{n["id"]}: label is {len(n["label"])} chars (max {MAX_LABEL}; paths go in `set {n["id"]} path`)')
    r.warn(label_warning(n))
    r.warn(node_text_warning(n))
    if n['kind'] != 'function' and not n.get('blurb'):
        r.problem(f'{n["id"]}: no blurb (set {n["id"]} blurb "<= {MAX_BLURB} chars")')
    if len(n.get('blurb', '')) > MAX_BLURB:
        r.problem(f'{n["id"]}: blurb is {len(n["blurb"])} chars (max {MAX_BLURB})')
    if n.get('path') and not os.path.exists(code.path(n['path'])):
        to = code.renamed_path(n['path'])          # a box path follows a git rename like an anchor
        if to and os.path.exists(code.path(to)):
            if r.fix:
                r.fixed.append(f'{n["id"]} path: {n["path"]} -> {to}')
                n['path'] = to
            else:
                r.warn(f'{n["id"]}: path {n["path"]} moved to {to} (run check --fix)')
        elif code.git.error:
            r.problem(f'{n["id"]}: path {n["path"]} does not exist; git could not be asked about a rename (see the WARNING) '
                      f'(set {n["id"]} path <dir or file>)')
        else:
            r.problem(f'{n["id"]}: path {n["path"]} does not exist (set {n["id"]} path <dir or file>)')
    if 'at' in n:
        follow(code, r, f'box {n["id"]}', n['at'], n['at']['anchor'], f'set {n["id"]} at file:start-end')


def check_edges(g, r):
    seen = set()
    for e in g.edges:
        name = f'edge {e["from"]} -> {e["to"]}'
        for x in (e['from'], e['to']):
            if x not in g.ids:
                r.problem(f'{name}: node {x} not defined')
        if g.ids.get(e['from'], {}).get('kind') == 'store':
            r.problem(f'{name}: "{g.ids[e["from"]]["label"]}" is a store box and a store never acts; draw the edge from the box '
                      f'that reads or polls it (rmedge {e["from"]} {e["to"]}; edge {e["to"]} {e["from"]} "polls …" async)')
        if (e['from'], e['to']) in seen:
            r.problem(f'{name}: twice (one edge per pair; put both hops in the label/detail)')
        seen.add((e['from'], e['to']))
        if len(e['label']) > MAX_EDGE_LABEL:
            r.problem(f'{name}: label is {len(e["label"])} chars (max {MAX_EDGE_LABEL}; the sentence goes in detail)')
        if e['label'].strip().endswith('?'):
            r.problem(f'{name}: label "{e["label"]}" is a question; say what flows or who acts ("reads the status", "writes the receipt")')
        if re.match(r'(?i)^(calls?|uses?|invokes?)\b', e['label'].strip()):
            r.problem(f'{name}: label "{e["label"]}" says nothing; say what for or how ("renders the plan", "start run", "polls every 2 s")')
        r.warn(edge_text_warning(e))


def check_map(code, j, g, r):
    """The boxes and edges. Returns the boxes without a step (id -> what to do)."""
    for n in j['nodes']:
        check_node(code, j, g, n, r)
    for p, ks in g.kids.items():
        if len(ks) > MAX_CHILDREN:
            r.problem(f'{p or "top level"}: {len(ks)} children (max {MAX_CHILDREN}: group them)')
    check_edges(g, r)
    stray = dict(unvisited(j))
    unused = set()             # a box with no step and no edge is one problem, not two
    if len(j['nodes']) > 1:
        for n in j['nodes']:
            if g.touched(n['id']):
                continue
            if n['id'] in stray:
                unused.add(n['id'])
                r.problem(f'{n["id"]}: "{n["label"]}" is unused (no step, no edge): rmnode {n["id"]}')
            else:
                r.problem(f'{n["id"]}: no edge touches this box; connect it (edge) or drop it')
    return {nid: what for nid, what in stray.items() if nid not in unused}


def check_steps(code, j, g, stray, r, steps):
    """The storyline: its length, its path through the map, each step. Returns the lines its refs and links point
    at, for the report."""
    least, most = steps
    if not least <= len(j['steps']) <= most:
        r.problem(f'{len(j["steps"])} steps (want {least}-{most}: merge or split)')
    for nid, what in stray.items():
        r.problem(f'{nid}: {what}')
    for k in range(1, len(j['steps'])):
        a, b = j['steps'][k - 1]['node'], j['steps'][k]['node']
        if a != b and a in g.ids and b in g.ids and not g.linked(a, b):
            r.problem(f'steps {k} -> {k + 1}: the path jumps from "{g.ids[a]["label"]}" to "{g.ids[b]["label"]}" but no edge '
                      f'joins those boxes (at any level), not even from a box the path came through: {g.hop_hint(a, b)}')
    seen_ids = set()
    for k, s in enumerate(j['steps'], 1):
        if not s.get('id') or s['id'] in seen_ids:
            r.problem(f'step {k}: {"duplicate" if s.get("id") else "no"} id (any write command, e.g. `meta`, gives every step one)')
        seen_ids.add(s.get('id'))
    labels = {n['label'].lower() for n in j['nodes']}
    links, placed = [], {}
    for k, s in enumerate(j['steps'], 1):
        sf, ss, se = check_step(code, g, labels, k, s, links, r)
        placed.setdefault((sf, ss, se), []).append(k)
    for (sf, ss, se), ks in placed.items():      # two steps showing the very same lines
        if len(ks) > 1:
            r.warn(f'steps {" and ".join(map(str, ks))} are anchored on the same lines ({sf}:{ss}-{se}): each '
                   f'step shows the lines its own title is about (restep N range <file> <start> <end>)')
    return links


def check_step(code, g, labels, k, s, links, r):
    """One step: its box, title, lead, refs and the code it is anchored on. Returns where that code is now."""
    name = f'step {k}'
    kind = g.ids.get(s['node'], {}).get('kind')
    if kind not in STEP_KINDS:
        r.problem(f'{name}: on a {kind} box; steps go on a function, external or store box (add the function box, then '
                  f'stepnode {k} <id>)')
    tp = title_problem(s['title'], labels)
    if tp:
        r.problem(f'{name}: title "{s["title"]}" {tp}')
    lead = s.get('lead', '')
    if not lead:
        r.problem(f'{name}: no lead')
    elif words(lead) > MAX_LEAD_WORDS:
        r.problem(f'{name}: lead is {words(lead)} words (max {MAX_LEAD_WORDS}; move the rest to details)')
    if lead:
        r.warn(repeat_warning(k, s))
        r.warn(lead_warning(k, s))
    r.warn(span_warning(k, s))
    r.warnings.extend(style_warnings(k, s))
    r.warn(near_ref_warning(k, s))
    r.warnings.extend(ref_warnings(k, s))
    sf, ss, se = follow(code, r, name, s, s['anchor'], f'restep {k} range <file> <start> <end>')
    if code.isfile(sf):
        for w in range_warnings(lines_of(code.repo, sf), sf, ss, se):
            r.warn(f'{name}: {w} (restep {k} range <file> <start> <end>)')
    at = g.ids.get(s['node'], {}).get('at')
    if at:
        if r.fix:
            af, aa, ab = at['file'], at['start'], at['end']
        else:
            now = where(code, at['file'], at['start'], at['end'], at['anchor'])
            af, aa, ab = now.file, now.start, now.end
        if af == sf and (se < aa or ss > ab):
            r.problem(f'{name}: anchored at {sf}:{ss}-{se}, outside its box "{g.ids[s["node"]]["label"]}" '
                      f'({aa}-{ab} in the same file): move the step (restep {k} node|range) or fix the box (set {s["node"]} at)')
    refs = s.get('refs', [])
    if len(refs) > MAX_REFS:
        r.problem(f'{name}: {len(refs)} refs (max {MAX_REFS}: keep the lines a reader should open)')
    for ref in refs:
        tok = ref_token(ref)
        if not tok:
            r.problem(f'{name}: ref "{ref}" has no full path:line (or path:line-line) in it: a ref is one sentence with '
                      f'the repo-relative path:line inside (restep {k} refs -)')
            continue
        prob, got = check_ref(code.repo, tok)
        if prob:
            r.problem(f'{name}: ref {tok}: {prob}')
        links.append((k, 'ref', tok, got, '' if ref_bare(ref) else ref))
    text = lead + '\n' + s.get('details', '')
    for m in re.finditer(LINK, text):
        if m.group(0) in [ref_token(x) for x in refs]:
            continue
        prob, got = check_ref(code.repo, m.group(0))
        if prob:
            r.problem(f'{name}: link {m.group(0)}: {prob}')
        links.append((k, 'link', m.group(0), got, ''))
    if re.search(r'(?i)\bsteps? \d+\b', text):
        r.problem(f'{name}: the text says "step N"; numbers change when steps move: name the step instead')
    if re.search(r'(?<![\w/.]):\d+(?:-\d+)?\b', plain(text)):
        r.problem(f'{name}: a bare ":NNN" reference; write the full path:line so it is a link and gets checked')
    return sf, ss, se


def print_check(j, g, flag, links, r):
    """The outline, the storyline and the lines the steps point at (as `flag` asks), then what check found."""
    def show(parent, depth):
        for n in g.kids.get(parent, []):
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
            print(f'  {k:2}. {s["title"]}   [{s["id"]} on {s["node"]}, {words(s.get("lead", ""))}w, {len(s.get("refs", []))} refs'
                  f'{extras_line(s)}]')
    if flag in ('', 'refs', 'fix'):
        print_links(j, links)
    for f in r.fixed:
        print('FIXED: ' + f)
    for w in r.warnings:
        print('WARNING: ' + w)
    for p in r.problems:
        print('PROBLEM: ' + p)
    if quiet:
        plural = lambda n, w: f'{n} {w}{"" if n == 1 else "s"}'
        warn = f', {plural(len(r.warnings), "warning")}' if r.warnings else ''
        print(f'{"FAILED" if r.problems else "ok"}: {plural(len(j["steps"]), "step")}, {plural(len(r.problems), "problem")}{warn}')


def print_links(j, links):
    """Each step's header, then the lines its refs and links point at."""
    last = 0
    for k, kind, ref, got, sentence in links:
        if k != last:
            st = j['steps'][k - 1]
            print(f'step {k} [{st["node"]}] {st["title"]}   @ {st["file"]}:{st["range"]["start"]}-{st["range"]["end"]}')
            last = k
        if sentence:         # the sentence the reader sees, then the line it must describe
            print(f'  ref  "{sentence}"')
        for i, (ln, txt) in enumerate(got):
            print(f'  {kind:4} {ref}: {txt}' if i == 0 else f'       … L{ln}: {txt}')


# ======================================================================================================================
# The commands. Each is declared once, with @command: its name, the line `journey.py` lists, its usage block (for
# `help` and the manual) and its arguments after <repo>; argparse reads them from that declaration. A command gets the
# run's context and its arguments by name, prints what it did, and returns its exit code (None: 0).
# ======================================================================================================================

Command = namedtuple('Command', 'name summary usage args options section fn')
COMMANDS = {}            # name -> Command, in the manual's order


def command(name, summary, usage, args='', options=(), section=None):
    """Declares a command. `usage`: its lines in the manual (the ones starting with `journey.py` are its usage lines
    in an error). `args`: its arguments after <repo>; `x?` may be left out ('' then), `x*` takes the rest. `options`:
    its --options. `section`: a heading the manual puts before it."""
    def declare(fn):
        COMMANDS[name] = Command(name, summary, usage.strip('\n'), tuple(args.split()), tuple(options), section, fn)
        return fn
    return declare


@contextmanager
def step_edit(ctx, slug, n):
    """`with step_edit(ctx, slug, n) as (j, k, s)`: journey j, its step k (1-based) and the step itself; saved when the
    block ends without failing."""
    j = ctx.journeys.load(slug)
    k = step_at(j, n) + 1
    yield j, k, j['steps'][k - 1]
    ctx.journeys.save(slug, j)


def upsert(items, item, same):
    """Puts `item` in place of the first item `same(old)` holds for, else at the end; the replaced index or None."""
    old = next((i for i, x in enumerate(items) if same(x)), None)
    if old is None:
        items.append(item)
    else:
        items[old] = item
    return old


def warn_all(*warnings):
    for w in warnings:
        if w:
            print('WARNING: ' + w)


def step_at(j, n):
    if not str(n).isdigit() or not 1 <= int(n) <= len(j['steps']):
        fail(f'step {n}: there are {len(j["steps"])} steps')
    return int(n) - 1


def node_line(n):
    """`node api [system] "API" — blurb  in parent  path api  @ file:a-b`: a box in one line."""
    parts = [f'node {n["id"]} [{n["kind"]}] "{n["label"]}"']
    if n.get('blurb'):
        parts.append(f' — {n["blurb"]}')
    if n.get('parent'):
        parts.append(f'  in {n["parent"]}')
    if n.get('path'):
        parts.append(f'  path {n["path"]}')
    if 'at' in n:
        parts.append(f'  @ {n["at"]["file"]}:{n["at"]["start"]}-{n["at"]["end"]}')
    return ''.join(parts)


def edge_line(e):
    """`edge a -> b: label  (async) — detail`: an arrow in one line."""
    parts = [f'edge {e["from"]} -> {e["to"]}: {e["label"]}']
    if e.get('async'):
        parts.append('  (async)')
    if e.get('detail'):
        parts.append(f' — {e["detail"]}')
    return ''.join(parts)


# --- the journey and its map

@command('new', 'starts a journey', f'''
  journey.py new   <repo> <slug> "<question>" "<title>"      < summary     (<= 2 plain sentences, no code in the first)
                   question: one natural question, <= {MAX_QUESTION} chars (it is the map header and the row's tooltip)
                   title: a topic name <= {MAX_TITLE} chars, subject first, not a question ("Checkout flow")
                   --model <name>: the model writing it (default: $JOURNEY_MODEL), kept in the journey
''', 'slug question title', options=('--model',))
def cmd_new(ctx, slug, question, title, model=None):
    if os.path.exists(ctx.journeys.path(slug)):
        fail(f'journey {slug} exists')
    if journey_title_problem(title):
        fail(f'title "{title}" {journey_title_problem(title)}; nothing was written')
    if question_problem(question):
        fail(f'question {question_problem(question)}; nothing was written: "{question}"')
    commit = ctx.git.head()
    j = {'version': 2, 'id': slug, 'question': question, 'title': title,
         'summary': ctx.body(f'the summary of journey {slug} (<= 2 plain sentences)')}
    if model:
        j['model'] = model
    j.update({'commit': commit, 'createdAt': now(), 'nodes': [], 'edges': [], 'steps': []})
    ctx.journeys.save(slug, j)
    print(ctx.journeys.path(slug))
    print(f'new journey {slug}: title = {shown(j["title"])}; question = {shown(j["question"])}; '
          f'summary = {shown(j["summary"])}')
    warn_all(*similar_journeys(ctx.journeys, slug, j))


@command('node', 'adds a box to the map', f'''
  journey.py node  <repo> <slug> <id> <system|module|external|store|function> "<label>" [parent] [file:start-end]
                   [--blurb "<= {MAX_BLURB} chars, shown in the box"] [--path src/x]              < summary (tooltip)
                   store: the app's OWN record, queue or table that two parts meet through (never third-party:
                   that is external); a side box in a system or module; it may hold no step and never acts
''', 'slug nid kind label parent? at?', options=('--blurb', '--path'))
def cmd_node(ctx, slug, nid, kind, label, parent='', at='', blurb=None, path=None):
    echo = Echo()
    j = ctx.journeys.load(slug)
    if parent and not at and re.search(r':\d+(-\d+)?$', parent):      # `node id function "x" file:1-2` has no parent
        fail('a function node needs a parent before its file:start-end')
    if kind not in KINDS:
        fail(f'kind is one of {", ".join(KINDS)}')
    if any(n['id'] == nid for n in j['nodes']):
        fail(f'node {nid} exists')
    if parent and not any(p['id'] == parent for p in j['nodes']):
        fail(f'parent {parent} not defined yet (define parents first)')
    pk = next((p['kind'] for p in j['nodes'] if p['id'] == parent), None)
    if kind == 'store' and pk not in PARENT_KINDS['store']:
        refuse(f'a store box sits in a system or a module (parent {parent or "none"} is {pk or "the top level"})')
    if pk == 'store':
        refuse(f'{parent} is a store box: it has no children (put the function that reads or writes it in its module, '
               f'with an edge to {parent})')
    label_limit(label)
    blurb_limit(blurb or '')
    child_limit(j, parent, nid)
    opt = {k: v for k, v in (('blurb', blurb), ('path', path)) if v is not None}
    n = {'id': nid, 'kind': kind, 'label': label, **opt,
         'summary': ctx.body(f'the summary of node {nid} (one sentence, the tooltip: what "{label}" is in this journey)')}
    if parent:
        n['parent'] = parent
    if at:
        f, a, b = parse_at(at)
        n['at'] = {'file': f, 'start': a, 'end': b, 'anchor': anchor(ctx.repo, f, a, b, echo)}
    j['nodes'].append(n)
    ctx.journeys.save(slug, j)
    echo.wrote(node_line(n))
    warn_all(label_warning(n), node_text_warning(n))


def make_edge(a, b, label, flag='', detail=''):
    if flag not in ('', 'async', 'sync'):
        fail('after the label: async or sync, then optionally the detail')
    if len(label) > MAX_EDGE_LABEL:
        refuse(f'edge label is {len(label)} chars (max {MAX_EDGE_LABEL}; the sentence goes in the detail): "{label}"')
    return {'from': a, 'to': b, 'label': label, **({'async': True} if flag == 'async' else {}),
            **({'detail': detail} if detail else {})}


def find_edge(j, a, b):
    for i, e in enumerate(j['edges']):
        if e['from'] == a and e['to'] == b:
            return i
    fail(f'no edge {a} -> {b}')


@command('edge', 'adds an arrow between two boxes', f'''
  journey.py edge  <repo> <slug> <from> <to> "<label>" [async|sync] ["<detail>"]
                   from = the side that ACTS (caller, poller, watcher): a poll is poller -> polled, "polls …"
                   label <= {MAX_EDGE_LABEL} chars, says HOW or WHAT FOR in words ("start run", "polls every 2 s"), never "calls"
''', 'slug a b label flag? detail?')
def cmd_edge(ctx, slug, a, b, label, flag='', detail=''):
    j = ctx.journeys.load(slug)
    ids = {n['id'] for n in j['nodes']}
    for x in (a, b):
        if x not in ids:
            fail(f'node {x} not defined')
    if any(e['from'] == a and e['to'] == b for e in j['edges']):
        fail(f'edge {a} -> {b} exists: one edge per pair (setedge to change it)')
    if any(n['id'] == a and n['kind'] == 'store' for n in j['nodes']):
        refuse(f'{a} is a store box and a store never acts: draw the edge from the box that reads, writes or polls it '
               f'(edge {b} {a} "polls …" async)')
    j['edges'].append(make_edge(a, b, label, flag, detail))
    ctx.journeys.save(slug, j)
    print(edge_line(j['edges'][-1]))
    warn_all(edge_text_warning(j['edges'][-1]))


# --- the storyline

def need_node(j, node):
    if not any(x['id'] == node for x in j['nodes']):
        fail(f'node {node} not defined')


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


def say_same_lines(j, s, echo):
    twins = same_lines(j, s)
    if twins:
        echo.say(f'WARNING: step{"s" if len(twins) > 1 else ""} {", ".join(map(str, twins))} '
                 f'{"are" if len(twins) > 1 else "is"} anchored on the same lines ({s["file"]}:{s["range"]["start"]}-'
                 f'{s["range"]["end"]}): each step shows the lines its own title is about (restep N range <file> <start> <end>)')


def set_range(repo, s, rel, a, b, echo):
    a, b = int(a), int(b)
    s['file'], s['range'], s['anchor'] = rel, {'start': a, 'end': b}, anchor(repo, rel, a, b, echo)
    for w in range_warnings(lines_of(repo, rel), rel, a, b):
        echo.say(f'WARNING: {w}')


def echo_step(k, s, echo):
    """The step's line, what it is anchored on, then its warnings."""
    w = words(s.get('lead', ''))
    echo.wrote(f'step {k} [{s["id"]}] {s["title"]}  ({len(s["title"])} chars; lead {w} words; '
               f'{len(s.get("refs", []))} refs{"; details" if s.get("details") else ""})')
    warn_all(repeat_warning(k, s), lead_warning(k, s), span_warning(k, s), *style_warnings(k, s), near_ref_warning(k, s),
             *ref_warnings(k, s), *link_warnings(k, s))


@command('step', 'adds a step to the storyline', f'''
  journey.py step  <repo> <slug> <node> <file> <start> <end> "<title>" [after N]   < text
                   <node>: a function, external or store box (a system or module box is refused: add the
                   function box first). title: a fact, <= {MAX_STEP_TITLE} chars. <start> <end>: the lines that matter (the call,
                   the branch), <= {SOFT_RANGE_LINES} lines (WARNING above that; the whole function is the box). text on stdin:
                       first paragraph  = lead: ONE sentence, <= {SOFT_LEAD_WORDS} plain words (WARNING above that; {MAX_LEAD_WORDS} is refused)
                       later paragraphs = details (optional markdown, folded in the UI)
                       last lines       = refs (optional, <= {MAX_REFS}): a line `refs:` and under it ONE SENTENCE PER LINE,
                                          each saying what the reader will see there, with exactly one
                                          path:line (or path:a-b) in it, <= {MAX_REF_WORDS} words:
                                              refs:
                                              The 30 s retry delay is set in worker/src/queue.ts:42.
                                          (old form, still read: `refs: path:line path:line` = bare refs; check warns)
''', 'slug node rel start end title after_kw? after?')
def cmd_step(ctx, slug, node, rel, start, end, title, after_kw='', after=''):
    echo = Echo()
    j = ctx.journeys.load(slug)
    need_step_box(ctx.repo, slug, j, node, rel, start)
    pos = len(j['steps'])
    if after_kw:
        if after_kw != 'after' or not after.isdigit() or int(after) > len(j['steps']):
            fail(f'insert with: after N (0..{len(j["steps"])})')
        pos = int(after)
    lead, details, refs = parse_step_text(ctx.body(f'the text of step "{title}" (lead, blank line, details, refs: …)'))
    s = {'id': new_id({x.get('id') for x in j['steps']}), 'title': title, 'node': node}
    set_range(ctx.repo, s, rel, start, end, echo)
    say_same_lines(j, s, echo)
    s['lead'] = lead
    if details:
        s['details'] = details
    s['refs'] = refs or []
    step_limits(s)
    j['steps'].insert(pos, s)
    ctx.journeys.save(slug, j)
    echo_step(pos + 1, s, echo)


@command('range', "prints a function's file:start-end", '''
  journey.py range <repo> <file> <symbol-or-line>     prints file:start-end of that function/type (for node/step)
                   symbol: a function, type, or method (`click`, `Session.click`, Go `envs.List`). line: the
                   innermost function/method around it (outer ones listed as "inside …"); a line outside any
                   function is refused (exit 1), never answered with a range that does not contain it
''', 'rel what')
def cmd_range(ctx, rel, what):
    """Prints file:start-end of a function/type: by name (`name`, `Class.method`), or the innermost one around a
    line. Never prints a range that does not contain the requested line."""
    lines = lines_of(ctx.repo, rel)
    src = SourceFile(lines, rel.endswith('.py'))

    def show(i, outer=()):
        e = src.span(i)
        print(f'{rel}:{i + 1}-{e + 1}')
        print(f'  L{i + 1}: {lines[i].strip()[:100]}')
        print(f'  L{e + 1}: {lines[e].strip()[:100]}')
        for o in outer:
            print(f'  inside {rel}:{o + 1}-{src.span(o) + 1}  {lines[o].strip()[:70]}')

    if what.isdigit():
        n = int(what) - 1
        if n < 0 or n >= len(lines):
            fail(f'{rel}: no line {what} (the file has {len(lines)} lines)')
        around = src.around(n)
        if not around:
            prev = [i for i, _ in src.decls if i <= n]
            hint = (f'; the declaration above it is {rel}:{prev[-1] + 1}-{src.span(prev[-1]) + 1}, which ends before it'
                    if prev else '')
            fail(f'{rel}:{what}: no function or type contains this line{hint}. Nothing printed: read the file and '
                 f'pass the lines yourself.')
        show(around[-1], reversed(around[:-1]))
        return
    starts = src.named(what)
    if not starts:
        near = src.close_names(what.rpartition('.')[2])
        fail(f'{rel}: no definition of {what} found' + (f' (close: {", ".join(near)})' if near else '')
             + ' (try Class.method or a line number)')
    for i in starts:
        show(i)


@command('check', 'validates a journey', '''
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
''', 'slug flag?', options=('--fix',))
def cmd_check(ctx, slug, flag='', fix=False):
    if fix:
        if flag:
            raise UsageError('check', '1 argument(s) too many')
        flag = 'fix'
    if flag not in ('', 'quiet', 'story', 'refs', 'fix'):
        fail('check <repo> <slug> [quiet|story|refs|fix]   quiet: PROBLEM/WARNING lines + a one-line summary; story: storyline only; '
             'refs: ref lines only; fix: repoint steps/boxes whose code moved')
    hand_edits = []
    j = ctx.journeys.load(slug, notes=hand_edits)
    r = Report(flag == 'fix')
    code = ctx.code(j.get('commit', ''))
    g = JourneyMap(ctx.repo, j)
    check_header(ctx.journeys, slug, j, r)
    stray = check_map(code, j, g, r)
    links = check_steps(code, j, g, stray, r, ctx.steps)
    r.add(check_extras(code, j))
    pod = podcast_report(ctx, slug, j)       # its podcast, when it has one (`journey.py podcast` for the details)
    if pod:
        r.problems.extend(pod[0])
        r.warnings.extend(pod[1])
    r.problems.extend(hand_edits)
    if ctx.git.error and any('git could not be asked about a rename' in p for p in r.problems):      # said once, as what it is
        r.warnings.insert(0, f'git failed ({ctx.git.error}), so renames cannot be followed and `check fix` cannot repoint moved '
                             f'files: run check as the owner of the repo, or `git config --global --add safe.directory '
                             f'{os.path.abspath(ctx.repo)}`, then check again')
    if r.fixed:
        ctx.journeys.save(slug, j)
    print_check(j, g, flag, links, r)
    return 1 if r.problems else 0


@command('migrate', 'converts an old (v1) journey', '''
  journey.py migrate <repo> <slug>         v1 (one note per step) -> v2; deletes the step notes after writing
''', 'slug')
def cmd_migrate(ctx, slug):
    """v1 -> v2: each step's note is folded into the journey (file/range/anchor from the note; body -> lead, details,
    refs). The notes are deleted only after the v2 file is on disk. Refuses when a note is missing."""
    j = ctx.journeys.load(slug, v1=True)
    if j.get('version') == 2:
        fail(f'{slug} is already v2')
    d = os.path.join(ctx.repo, '.code-notes')
    notes = []
    for k, s in enumerate(j['steps'], 1):
        p = os.path.join(d, s['note'] + '.json')
        if not os.path.exists(p):
            fail(f'step {k}: note {s["note"]} is missing; nothing was changed (restore it or remove the step from the v1 file)')
        notes.append((p, json.load(open(p, encoding='utf-8'))))
    used, steps = set(), []
    for s, (p, note) in zip(j['steps'], notes):
        steps.append(migrated_step(s, note, used))
    out = {'version': 2}
    for key in ('id', 'question', 'title', 'summary', 'model', 'commit', 'createdAt', 'nodes', 'edges'):
        if key in j:
            out[key] = j[key]
    out['steps'] = steps
    ctx.journeys.save(slug, out)
    if json.load(open(ctx.journeys.path(slug), encoding='utf-8')).get('version') != 2:
        fail('the v2 file did not read back; the step notes were kept')
    for p, _ in notes:
        os.remove(p)
    print(f'{slug}: v2 written, {len(steps)} step notes folded in and deleted. Now rewrite leads/details/refs (check).')


def migrated_step(s, note, used):
    """A v1 step and its note as a v2 step (an id not in `used`, which it joins)."""
    text = note['messages'][0]['body']
    text = re.sub(r'^\*\*\d+\. .*?\*\*\s*', '', text, count=1, flags=re.S).strip()   # the repeated title
    m = re.search(r'(?<=[.!?])\s+(?=[A-Z`*(\["])', text)                            # first sentence = lead
    lead, details = (text[:m.start()], text[m.end():]) if m else (text, '')
    refs = []
    for r in re.finditer(LINK, text):
        if r.group(0) not in refs:
            refs.append(r.group(0))
    st = {'id': new_id(used), 'title': s['title'], 'node': s['node'], 'file': note['file'], 'range': note['range'],
          'anchor': note['anchor'], 'lead': ' '.join(lead.split())}
    used.add(st['id'])
    if details.strip():
        st['details'] = details.strip()
    st['refs'] = refs[:MAX_REFS]
    return st


@command('migrate-anchors', 'rewrites old anchors in the compact form', '''
  journey.py migrate-anchors <repo> <slug>|--all   rewrites full-text (v2) anchors as compact v3 anchors, from the
                   text they stored (so `check` still tells whether the code moved or changed since)
''', 'slug?', options=('--all',))
def cmd_migrate_anchors(ctx, slug='', all=False):
    """Full-text (v2) anchors -> compact v3, from the text they stored: no file is read, so `check` afterwards still
    says whether the code moved or changed since the anchor was written."""
    if all or slug == 'all':
        slugs = ctx.journeys.slugs()
        if not slugs:
            fail(f'no journeys in {ctx.journeys.dir}')
    elif slug:
        slugs = [slug]
    else:
        raise UsageError('migrate-anchors', 'missing <slug>')
    for sl in slugs:
        p = ctx.journeys.path(sl)
        if not os.path.exists(p):
            ctx.journeys.no_journey(sl)
        size = os.path.getsize(p)
        j = ctx.journeys.load(sl)
        holders = [s for s in j['steps']] + [n['at'] for n in j['nodes'] if 'at' in n]
        todo = [h for h in holders if h['anchor'].get('v') != 3]
        for h in todo:
            h['anchor'] = as_v3(h['anchor'])
        if todo:
            ctx.journeys.save(sl, j)
        print(f'{sl}: {len(todo)} of {len(holders)} anchors rewritten as v3, {size} -> {os.path.getsize(p)} bytes')


# --- links, values, scenes and marks of a step

@command('link', 'links a phrase of a step to the lines doing it', '''
  journey.py link  <repo> <slug> N "<phrase>" <file> <start> [<end>]
                   the phrase (exact words of the lead or details, outside backticks and Markdown links) becomes a
                   link to the 1-8 lines that do what it says; the same phrase again replaces it
''', 'slug n phrase rel start end?',
         section="Links, values, marks, scenes (once the steps are written; N = the step's number; the script reads every line's text):")
def cmd_link(ctx, slug, n, phrase, rel, start, end=''):
    with step_edit(ctx, slug, n) as (j, k, s):
        phrase = phrase.strip()
        if not phrase:
            refuse('the phrase is empty: give the words of the lead or details that become the link')
        text = source_line(ctx.repo, rel, start, f'link "{phrase}"')
        a = int(start)
        if end and not end.isdigit():
            refuse(f'link "{phrase}": end "{end}" is not a line number')
        b = int(end or start)
        ls = lines_of(ctx.repo, rel)
        if not a <= b <= len(ls):
            refuse(f'link "{phrase}": {rel}:{a}-{b} is not a range in the file ({len(ls)} lines)')
        links = list(s.get('links', []))
        new = {'phrase': phrase, 'file': rel, 'start': a, 'end': b, 'text': text}
        old = upsert(links, new, lambda l: l.get('phrase') == phrase)
        trial = {**s, 'links': links}
        if links.index(new) not in placed_links(trial):
            refuse(f'link "{phrase}": the phrase {why_unplaced(s, new)}')
        warns = say_issues(link_issues(k, trial, new), True)
        s['links'] = links
    print(f'step {k} link "{phrase}" -> {rel}:{a}-{b}{" (replaced)" if old is not None else ""}  ({len(links)} links)')
    print(f'  {rel} L{a}: {text[:100]}')
    if b > a:
        print(f'  {rel} L{b}: {ls[b - 1].strip()[:100]}')
    warn_all(*warns)


@command('value', 'adds a value hint above a line', f'''
  journey.py value <repo> <slug> N <name> "<value>" <file> <line> ["<note>"]
                   a faint hint above that line: `name = value  · note`. The line mentions <name>; value <= {MAX_VALUE}
                   chars, one line ("-" reads stdin); note = a few words on what it IS in this run. The same name
                   on the same line again replaces it
''', 'slug n name value rel line note?')
def cmd_value(ctx, slug, n, name, value, rel, line, note=''):
    with step_edit(ctx, slug, n) as (j, k, s):
        name, value, note = name.strip(), ' '.join(ctx.value_of(value).split()), ' '.join(note.split())
        text = source_line(ctx.repo, rel, line, f'value {name}')
        v = {'name': name, 'value': value, **({'note': note} if note else {}), 'file': rel, 'line': int(line), 'text': text}
        vals = list(s.get('values', []))
        old = upsert(vals, v, lambda o: (o.get('name'), o.get('file'), o.get('line')) == (name, rel, int(line)))
        warns = say_issues(value_issues(k, s, v, vals), True)
        s['values'] = vals
    print(f'step {k} value {name} = {shown(value, 60)}{f"  · {note}" if note else ""}  @ {rel}:{line}'
          f'{" (replaced)" if old is not None else ""}')
    print(f'  {rel} L{line}: {text[:100]}')
    warn_all(*warns)


@command('scene', "sets a step's animation", '''
  journey.py scene <repo> <slug> N   < scene JSON  {"actors": [...], "wires": [[a, b]], "beats": [...]}
                   replaces the step's animation; a beat's code is {"file", "line"} (the script adds "text").
                   Actors and what a beat's "set" changes: `journey.py help scene`
''', 'slug n')
def cmd_scene(ctx, slug, n):
    with step_edit(ctx, slug, n) as (j, k, s):
        raw = ctx.body(f'the scene of step {k} (JSON: {{"actors": […], "wires": […], "beats": […]}})')
        try:
            sc = json.loads(raw)
        except json.JSONDecodeError as e:
            refuse(f'the scene is not valid JSON (line {e.lineno} column {e.colno}: {e.msg})')
        issues = scene_issues(k, sc)
        if not any(lv == PROBLEM for lv, _ in issues):
            issues += beat_lines(ctx.repo, k, sc['beats'])
        warns = say_issues(issues, True)
        s['scene'] = {'actors': sc['actors'], 'wires': sc.get('wires', []), 'beats': sc['beats']}
    coded = sum(1 for b in sc['beats'] if b.get('code'))
    print(f'step {k} scene: {len(sc["actors"])} actors ({", ".join(a["id"] for a in sc["actors"])}), '
          f'{len(sc["beats"])} beats ({coded} with code)')
    for i, b in enumerate(sc['beats'], 1):
        c = b.get('code')
        print(f'  beat {i} [{b["focus"]}] {b["caption"]}' + (f'\n      {c["file"]} L{c["line"]}: {c["text"][:90]}' if c else '  (no code)'))
    warn_all(*warns)


def beat_lines(repo, k, beats):
    """Reads each beat's line into its code (a given text must agree); the warnings about the lines they light."""
    out = []
    for i, b in enumerate(beats, 1):
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
            out.append(Issue(WARN, f'step {k} scene: beat {i} lights {why} ({c["file"]}:{c["line"]}): light the line '
                                   f'that DOES what the caption says (the call, the assignment, the check)'))
    return out


@command('mark', 'highlights the part of a line a step or beat is about', f'''
  journey.py mark  <repo> <slug> N|N.B <file> <line>[-<end>] ["<match>"] [<nth>]
                   highlights ONLY "<match>" (exact characters, its nth occurrence) within those lines while step N
                   (or beat B of step N) is open; no match: the whole lines. Use it when the text names one call,
                   argument, condition or field; <= {MAX_MARKS} per step or beat. The same lines and match again replace it.
                   In a scene's JSON a beat may carry "marks" itself: [{{"lines": [a, b], "match": "…"}}]
''', 'slug target rel lines match? nth?')
def cmd_mark(ctx, slug, target, rel, lines, match='', nth=''):
    """Adds a mark to step N (or beat N.B): `lines` a or a-b, `match` the characters within them (none: whole lines)."""
    j = ctx.journeys.load(slug)
    k, s, beat, beat_label = parse_mark_target(j, target)
    ml = re.match(r'^(\d+)(?:-(\d+))?$', lines)
    if not ml:
        refuse(f'lines {lines!r}: give a line or a range (12 or 12-14)')
    a, b = int(ml.group(1)), int(ml.group(2) or ml.group(1))
    if b < a:
        refuse(f'lines {a}-{b}: the end is before the start')
    if nth and not nth.isdigit():
        refuse(f'nth {nth!r} is not a number (1 = the first occurrence)')
    holder = beat if beat is not None else s
    own = ((beat.get('code') or {}).get('file') if beat is not None else None) or s.get('file')
    m = {'lines': [a, b], **({'match': match} if match else {}), **({'nth': int(nth)} if nth and int(nth) > 1 else {})}
    if rel != own:
        m = {'file': rel, **m}
    code = ctx.code(None)
    doc, _ = mark_file_lines(code, rel)
    check = mark_check(m, rel, doc, 'drop')
    if check.code:
        why, moved = check.code
        if moved is None:
            refuse(f'mark: {why}')
        away = f'{abs(moved)} line{"" if abs(moved) == 1 else "s"} {"up" if moved < 0 else "down"}'
        refuse(f'mark: {_js(match)} isn\'t on {rel}:{a}-{b} (it is {away}): give the lines it is on')
    ms = list(holder.get('marks', []))
    same = upsert(ms, m, lambda o: isinstance(o, dict) and o.get('lines') == m['lines'] and o.get('match') == m.get('match')
                  and o.get('file', own) == rel)
    holder['marks'] = ms
    where = f'step {k}{beat_label}'
    issues = [x for x in as_issues(marks_issues(code, k, s)) if f'{where}: ' in x[1]]
    if any(lv == PROBLEM for lv, _ in issues):
        refuse(next(t for lv, t in issues if lv == PROBLEM))
    ctx.journeys.save(slug, j)
    replaced = ' (replaced)' if same is not None else ''
    range_text = f'{rel}:{a}' + (f'-{b}' if b > a else '')
    match_text = f' {_js(match)}' if match else ' (whole lines)'
    count = f'{len(ms)} mark{"" if len(ms) == 1 else "s"}'
    print(f'{where} mark {ms.index(m) + 1}{replaced}: {range_text}{match_text}  ({count})')
    print('\n'.join(mark_preview(doc, check.spot, '  ')))
    warn_all(*(t for lv, t in issues))


@command('marks', "previews a journey's marks", '''
  journey.py marks <repo> <slug> [N]  prints every mark with ^^^ under the characters it lights, and its problems
''', 'slug n?')
def cmd_marks(ctx, slug, n=''):
    """Prints every mark (of step n) with the characters it lights, and what check says about them."""
    j = ctx.journeys.load(slug)
    code = ctx.code(None)
    ks = [step_at(j, n) + 1] if n else range(1, len(j['steps']) + 1)
    total, issues = 0, []
    for k in ks:
        s = j['steps'][k - 1]
        groups = marks_groups(s)
        if not groups:
            if n:
                print(f'step {k} has no marks')
            continue
        r = s.get('range') or {}
        print(f'step {k} {s.get("title", "")}   @ {s.get("file")}:{r.get("start")}-{r.get("end")}')
        for where, ms, own, text, beat in groups:
            if beat is not None:
                print(f'  {where.strip()}: {str(beat.get("caption", ""))[:90]}')
            for i, m in enumerate(ms if isinstance(ms, list) else [], 1):
                f = m.get('file') or own if isinstance(m, dict) else ''
                doc = mark_file_lines(code, f)[0] if isinstance(f, str) and f.strip() else None
                check = mark_check(m, f if isinstance(f, str) else '', doc, 'drop')
                if check.shape:
                    continue
                total += 1
                a, b = m['lines'][0], m['lines'][1]
                head = f'    mark {i}: {f}:{a}' + (f'-{b}' if b > a else '')
                print(head + (f' {_js(m["match"])}' if 'match' in m else ' (whole lines)') + (f' #{m["nth"]}' if 'nth' in m else ''))
                print('\n'.join(mark_preview(doc, check.spot)) if doc else '      (file not found)')
        issues += as_issues(marks_issues(code, k, s))
    for lv, t in issues:
        print(('PROBLEM: ' if lv == PROBLEM else 'WARNING: ') + t)
    np = sum(1 for lv, _ in issues if lv == PROBLEM)
    plural = lambda n, w: f'{n} {w}{"" if n == 1 else "s"}'
    print(f'{plural(total, "mark")}, {plural(np, "problem")}, {plural(len(issues) - np, "warning")}')
    return 1 if np else 0


@command('rmlink', 'removes a code link', '''
  journey.py rmlink <repo> <slug> N "<phrase>"
''', 'slug n phrase')
def cmd_rmlink(ctx, slug, n, phrase):
    with step_edit(ctx, slug, n) as (j, k, s):
        links = s.get('links', [])
        gone = next((l for l in links if l.get('phrase') == phrase.strip()), None)
        if gone is None:
            fail(f'step {k} has no link "{phrase}" (its links: {", ".join(repr(l.get("phrase")) for l in links) or "none"})')
        s['links'] = [l for l in links if l is not gone]
        if not s['links']:
            s.pop('links')
    print(f'removed step {k} link "{gone["phrase"]}" -> {gone["file"]}:{gone["start"]}-{gone["end"]}')


@command('rmvalue', 'removes a value hint', '''
  journey.py rmvalue <repo> <slug> N <name> [<line>]
''', 'slug n name line?')
def cmd_rmvalue(ctx, slug, n, name, line=''):
    with step_edit(ctx, slug, n) as (j, k, s):
        hits = [v for v in s.get('values', []) if v.get('name') == name and (not line or str(v.get('line')) == line)]
        if not hits:
            have = ', '.join(f'{v.get("name")} @ {v.get("line")}' for v in s.get('values', [])) or 'none'
            fail(f'step {k} has no value hint {name}{f" on line {line}" if line else ""} (its hints: {have})')
        if len(hits) > 1:
            fail(f'step {k} has {len(hits)} hints {name} (lines {", ".join(str(v["line"]) for v in hits)}): '
                 f'rmvalue {k} {name} <line>')
        s['values'] = [v for v in s['values'] if v is not hits[0]]
        if not s['values']:
            s.pop('values')
    print(f'removed step {k} value {name} @ {hits[0]["file"]}:{hits[0]["line"]}')


@command('rmscene', "removes a step's animation", '''
  journey.py rmscene <repo> <slug> N
''', 'slug n')
def cmd_rmscene(ctx, slug, n):
    with step_edit(ctx, slug, n) as (j, k, s):
        if 'scene' not in s:
            fail(f'step {k} has no scene')
        sc = s.pop('scene')
    print(f'removed step {k} scene ({len(sc.get("beats", []))} beats)')


@command('rmmark', 'removes a mark', '''
  journey.py rmmark <repo> <slug> N|N.B <i>|all
''', 'slug target which')
def cmd_rmmark(ctx, slug, target, which):
    """Removes mark `which` (1-based, or "all") of step N (or beat N.B)."""
    j = ctx.journeys.load(slug)
    k, s, beat, beat_label = parse_mark_target(j, target)
    holder = beat if beat is not None else s
    ms = holder.get('marks', [])
    where = f'step {k}{beat_label}'
    if which == 'all':
        gone = len(ms)
        holder.pop('marks', None)
    else:
        if not which.isdigit() or not 1 <= int(which) <= len(ms):
            fail(f'{where} has {len(ms)} marks; give 1-{len(ms)} or "all"')
        gone = 1
        holder['marks'] = [m for i, m in enumerate(ms, 1) if i != int(which)]
        if not holder['marks']:
            holder.pop('marks')
    ctx.journeys.save(slug, j)
    print(f'removed {gone} mark{"s" if gone != 1 else ""} of {where}')


def parse_mark_target(j, target):
    """`N` (step N) or `N.B` (beat B of step N): (k, step, beat dict or None, ' beat B' or '')."""
    mt = re.match(r'^(\d+)(?:\.(\d+))?$', str(target))
    if not mt:
        refuse(f'{target!r}: give the step as N, or a beat as N.B (beat B of step N)')
    k = step_at(j, mt.group(1)) + 1
    s = j['steps'][k - 1]
    if not mt.group(2):
        return k, s, None, ''
    beats = ((s.get('scene') or {}).get('beats') or []) if isinstance(s.get('scene'), dict) else []
    bi = int(mt.group(2))
    if not 1 <= bi <= len(beats):
        refuse(f'step {k} has {len(beats)} beats; there is no beat {bi}')
    return k, s, beats[bi - 1], f' beat {mt.group(2)}'


# --- fixing things

def restep_title(ctx, slug, j, s, args, echo):
    s['title'] = ctx.value_of(args[0])


def restep_lead(ctx, slug, j, s, args, echo):
    s['lead'] = ' '.join(ctx.value_of(args[0]).split())


def restep_details(ctx, slug, j, s, args, echo):
    v = ctx.value_of(args[0]) if args[0] else ''
    if v:
        s['details'] = v
    else:
        s.pop('details', None)


def restep_refs(ctx, slug, j, s, args, echo):
    s['refs'] = parse_refs(ctx.value_of(args[0]) if args[0] else '')


def restep_node(ctx, slug, j, s, args, echo):
    """Puts the step on another box; returns the boxes that had no step before (to name the ones it leaves empty)."""
    need_step_box(ctx.repo, slug, j, args[0], s['file'], s['range']['start'])
    left = {x for x, _ in unvisited(j)}
    s['node'] = args[0]
    return left


def restep_range(ctx, slug, j, s, args, echo):
    set_range(ctx.repo, s, *args, echo)
    say_same_lines(j, s, echo)


def said(field):
    """The changed field's value as `restep` says it."""
    return lambda s: shown(s.get(field, ''))


# `restep N <field> …`: what each field takes, how it is set, and how its new value is said (None: the step's own
# line says it).
StepField = namedtuple('StepField', 'args set show')
STEP_FIELDS = {
    'title': StepField(1, restep_title, None),
    'lead': StepField(1, restep_lead, said('lead')),
    'details': StepField(1, restep_details, said('details')),
    'refs': StepField(1, restep_refs, lambda s: ' | '.join(s.get('refs', [])) or '(none)'),
    'node': StepField(1, restep_node, lambda s: s['node']),
    'range': StepField(3, restep_range, lambda s: f'{s["file"]}:{s["range"]["start"]}-{s["range"]["end"]}'),
}


@command('restep', 'changes a step', '''
  journey.py restep  <repo> <slug> N [<file> <start> <end>] ["<title>"]  < text    (empty stdin keeps the text)
  journey.py restep  <repo> <slug> N <title|lead|details|refs|node> <value>          one field ("-" reads stdin;
                                                                    refs: one sentence per line ("-" = stdin), or
                                                                    several in one argument separated by " | ";
                                                                    "" clears details/refs)
  journey.py restep  <repo> <slug> N range <file> <start> <end>
''', 'slug n rest*', section='Fixing things:')
def cmd_restep(ctx, slug, n, rest):
    if rest and rest[0] in STEP_FIELDS:
        return restep_field(ctx, slug, n, rest[0], rest[1:])
    return restep_text(ctx, slug, n, rest)


def restep_field(ctx, slug, n, field, args):
    """`restep N <field> <value>` (range: <file> <start> <end>): one field of the step."""
    echo = Echo()
    j = ctx.journeys.load(slug)
    s = j['steps'][step_at(j, n)]
    f = STEP_FIELDS[field]
    if len(args) != f.args:
        fail('restep N range <file> <start> <end>' if field == 'range' else f'restep N {field} <value>   ("-" reads stdin)')
    left = f.set(ctx, slug, j, s, args, echo)
    step_limits(s)
    ctx.journeys.save(slug, j)
    if f.show:
        print(f'step {int(n)} {field} = {f.show(s)}')
    echo_step(int(n), s, echo)
    if left is not None:
        say_left_empty(j, left)


def restep_text(ctx, slug, n, rest):
    """`restep N [<file> <start> <end>] ["<title>"] < text`: the step's range, title and text (lead, details, refs)."""
    echo = Echo()
    j = ctx.journeys.load(slug)
    s = j['steps'][step_at(j, n)]
    if len(rest) >= 3:
        restep_range(ctx, slug, j, s, rest[:3], echo)
        rest = rest[3:]
    if rest:
        s['title'] = rest[0]
    text = ctx.stdin_text()
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
    ctx.journeys.save(slug, j)
    echo_step(int(n), s, echo)


@command('rmstep', 'removes a step', '''
  journey.py rmstep  <repo> <slug> N                later steps renumber (number = position); names the boxes it
                                                    leaves without a step (rmnode them, or add a step)
''', 'slug n')
def cmd_rmstep(ctx, slug, n):
    j = ctx.journeys.load(slug)
    before = {x for x, _ in unvisited(j)}
    s = j['steps'].pop(step_at(j, n))
    ctx.journeys.save(slug, j)
    print(f'removed step {int(n)} [{s.get("id", "")}]: {s["title"]}  ({len(j["steps"])} steps left)')
    say_left_empty(j, before)


@command('mvstep', 'moves a step', '''
  journey.py mvstep  <repo> <slug> N after M        moves step N behind step M (0 = first); the step keeps its id
''', 'slug n after_kw after')
def cmd_mvstep(ctx, slug, n, after_kw, after):
    """Moves a step (it keeps its id, text and anchor): `mvstep N after M`, M = 0 puts it first."""
    j = ctx.journeys.load(slug)
    i = step_at(j, n)
    if after_kw != 'after' or not after.isdigit() or int(after) > len(j['steps']) or int(after) == int(n):
        fail(f'move with: mvstep N after M (M = 0..{len(j["steps"])}, not N itself)')
    s = j['steps'].pop(i)
    pos = int(after) - (1 if int(after) > i else 0)
    j['steps'].insert(pos, s)
    ctx.journeys.save(slug, j)
    print(f'step {n} is now step {pos + 1}: {s["title"]}')


@command('stepnode', 'puts a step on another box', '''
  journey.py stepnode <repo> <slug> N <node>        puts step N on another box
''', 'slug n node')
def cmd_stepnode(ctx, slug, n, node):
    j = ctx.journeys.load(slug)
    s = j['steps'][step_at(j, n)]
    need_step_box(ctx.repo, slug, j, node, s['file'], s['range']['start'])
    before = {x for x, _ in unvisited(j)}
    was = s['node']
    s['node'] = node
    ctx.journeys.save(slug, j)
    print(f'step {int(n)} [{s["id"]}] node = {node} (was {was}): {s["title"]}')
    say_left_empty(j, before)


def say_left_empty(j, before):
    """After a step left a box: names every box that has no step now and had one before."""
    for nid, what in unvisited(j):
        if nid not in before:
            print(f'WARNING: {nid}: {what}')


@command('meta', "changes the journey's own fields", '''
  journey.py meta    <repo> <slug> <title|question|summary|model> <value>           ("-" reads stdin)
  journey.py meta    <repo> <slug> start <true|false>     the journey to open first ("Start here" in the list)
''', 'slug field value')
def cmd_meta(ctx, slug, field, value):
    j = ctx.journeys.load(slug)
    if field == 'start':             # the one journey a newcomer should open first: the list marks it "Start here"
        on = ctx.value_of(value).strip().lower()
        if on not in ('true', 'false'):
            fail('start is true or false')
        if on == 'true':
            j['start'] = True
        else:
            j.pop('start', None)
        ctx.journeys.save(slug, j)
        print(f'start = {on}')
        return
    if field not in ('title', 'question', 'summary', 'model'):
        fail('field is title, question, summary, model or start')
    j[field] = ctx.value_of(value)
    if field == 'title' and journey_title_problem(j[field]):
        fail(f'title "{j[field]}" {journey_title_problem(j[field])}; nothing was written')
    if field == 'question' and question_problem(j[field]):
        fail(f'question {question_problem(j[field])}; nothing was written: "{j[field]}"')
    ctx.journeys.save(slug, j)
    print(f'{field} = {shown(j[field])}')
    if field in ('title', 'question'):
        warn_all(*similar_journeys(ctx.journeys, slug, j))


def set_label(ctx, j, n, v, echo):
    label_limit(v)
    n['label'] = v


def set_blurb(ctx, j, n, v, echo):
    blurb_limit(v)
    n['blurb'] = v


def set_as_is(field):
    def set_field(ctx, j, n, v, echo):
        n[field] = v
    return set_field


def set_kind(ctx, j, n, v, echo):
    nid = n['id']
    if v not in KINDS:
        fail(f'kind is one of {", ".join(KINDS)}')
    if v not in STEP_KINDS and any(s['node'] == nid for s in j['steps']):
        refuse(f'{nid} holds steps; steps go on a function, external or store box (move them first: stepnode)')
    if v == 'store' and any(x.get('parent') == nid for x in j['nodes']):
        refuse(f'{nid} has children; a store box has none (move them first: set <node> parent)')
    if v == 'store' and any(e['from'] == nid for e in j['edges']):
        refuse(f'{nid} is the `from` of an edge; a store never acts: turn the edge round first (rmedge, then edge '
               f'<reader or writer> {nid} "polls …" async)')
    n['kind'] = v


def set_parent(ctx, j, n, v, echo):
    if v and not any(p['id'] == v for p in j['nodes']):
        fail(f'no node {v}')
    if v != n.get('parent', ''):
        child_limit(j, v, n['id'])
    if v:
        n['parent'] = v
    else:
        n.pop('parent', None)


def set_at(ctx, j, n, v, echo):
    f, a, b = parse_at(v)
    n['at'] = {'file': f, 'start': a, 'end': b, 'anchor': anchor(ctx.repo, f, a, b, echo)}


def said_text(n, field):
    return shown(n[field])


def said_name(n, field):
    return n.get(field) or '(none: top level)'


def said_at(n, field):
    return f'{n["at"]["file"]}:{n["at"]["start"]}-{n["at"]["end"]}'


# `set <node> <field> <value>`: how each field is set, how its new value is said, and the warnings it may earn.
NodeField = namedtuple('NodeField', 'set show warnings')
NODE_FIELDS = {
    'label': NodeField(set_label, said_text, (lambda n: label_warning(n), lambda n: node_text_warning(n))),
    'blurb': NodeField(set_blurb, said_text, (lambda n: node_text_warning(n),)),
    'path': NodeField(set_as_is('path'), said_name, ()),
    'summary': NodeField(set_as_is('summary'), said_text, ()),
    'kind': NodeField(set_kind, said_name, ()),
    'at': NodeField(set_at, said_at, ()),
    'parent': NodeField(set_parent, said_name, ()),
}


@command('set', 'changes a box', f'''
  journey.py set     <repo> <slug> <node> <{"|".join(NODE_FIELDS)}> <value>   ("-" reads stdin)
''', 'slug nid field value')
def cmd_set(ctx, slug, nid, field, value):
    echo = Echo()
    j = ctx.journeys.load(slug)
    n = next((x for x in j['nodes'] if x['id'] == nid), None) or fail(f'no node {nid}')
    value = ctx.value_of(value)
    if field not in NODE_FIELDS:
        names = list(NODE_FIELDS)
        fail(f'field is {", ".join(names[:-1])} or {names[-1]}')
    f = NODE_FIELDS[field]
    f.set(ctx, j, n, value, echo)
    ctx.journeys.save(slug, j)
    echo.wrote(f'{nid}.{field} = {f.show(n, field)}')
    warn_all(*(w(n) for w in f.warnings))


@command('rmnode', 'removes a box and its arrows', '''
  journey.py rmnode  <repo> <slug> <node>           (and its edges; refuses while steps or children use it)
''', 'slug nid')
def cmd_rmnode(ctx, slug, nid):
    j = ctx.journeys.load(slug)
    if any(s['node'] == nid for s in j['steps']) or any(n.get('parent') == nid for n in j['nodes']):
        fail(f'{nid} still has steps or children')
    gone = next((n for n in j['nodes'] if n['id'] == nid), None) or fail(f'no node {nid}')
    j['nodes'] = [n for n in j['nodes'] if n['id'] != nid]
    print('removed ' + node_line(gone))
    for e in j['edges']:
        if nid in (e['from'], e['to']):
            print(f'removed edge {e["from"]} -> {e["to"]}: {e["label"]}')
    j['edges'] = [e for e in j['edges'] if nid not in (e['from'], e['to'])]
    ctx.journeys.save(slug, j)


@command('rmedge', 'removes an arrow', '''
  journey.py rmedge  <repo> <slug> <from> <to>
''', 'slug a b')
def cmd_rmedge(ctx, slug, a, b):
    j = ctx.journeys.load(slug)
    e = j['edges'].pop(find_edge(j, a, b))
    ctx.journeys.save(slug, j)
    print('removed ' + edge_line(e))


@command('setedge', 'changes an arrow', '''
  journey.py setedge <repo> <slug> <from> <to> "<label>" [async|sync] ["<detail>"]   (what you omit is kept)
''', 'slug a b label flag? detail?')
def cmd_setedge(ctx, slug, a, b, label, flag='', detail=''):
    j = ctx.journeys.load(slug)
    i = find_edge(j, a, b)
    old = j['edges'][i]
    if not flag:                                   # label only: async and detail stay as they were
        flag, detail = ('async' if old.get('async') else 'sync'), old.get('detail', '')
    elif not detail:
        detail = old.get('detail', '')
    j['edges'][i] = make_edge(a, b, label, flag, detail)
    ctx.journeys.save(slug, j)
    print(edge_line(j['edges'][i]))
    warn_all(edge_text_warning(j['edges'][i]))


@command('reset', 'deletes a journey', '''
  journey.py reset   <repo> <slug>                  deletes the journey file (nothing else)
''', 'slug')
def cmd_reset(ctx, slug):
    p = ctx.journeys.path(slug)
    if not os.path.exists(p):
        ctx.journeys.no_journey(slug)
    os.remove(p)
    print(f'deleted {p}')


@command('restore', 'puts back the last good copy', '''
  journey.py restore <repo> <slug>                  puts back the last good copy (journeys/.bak/<slug>.json,
                                                    kept on every write and every load of a valid file)
''', 'slug')
def cmd_restore(ctx, slug):
    """Puts back .bak/<slug>.json. A current file that differs is kept as .bak/<slug>.replaced.json."""
    b, p = ctx.journeys.bak(slug), ctx.journeys.path(slug)
    if not os.path.exists(b):
        fail(f'no backup of {slug} ({b} does not exist)')
    raw = open(b, encoding='utf-8').read()
    try:
        json.loads(raw)
    except json.JSONDecodeError as e:
        fail(f'the backup {b} does not parse either ({e.msg} at line {e.lineno} column {e.colno}); nothing was changed')
    cur = open(p, encoding='utf-8', errors='replace').read() if os.path.exists(p) else None
    if cur == raw:
        print(f'{p} already is the last good copy; nothing to restore')
        return
    if cur is not None:
        write_atomic(ctx.journeys.bak(slug, '.replaced'), cur)
        print(f'kept the current file as {ctx.journeys.bak(slug, ".replaced")}')
    write_atomic(p, raw)
    t = datetime.datetime.fromtimestamp(os.path.getmtime(b)).strftime('%Y-%m-%d %H:%M')
    print(f'restored {p} from the copy of {t}; run `journey.py check {ctx.repo} {slug}`')


@command('podcast', "checks the journey's podcast file", '''
  journey.py podcast <repo> <slug> [<audio seconds>]   checks the journey's podcast, <slug>.podcast.json next to it
                   (format: docs/podcast-format.md in the Code Notes repository), the way the extension does: PROBLEM =
                   the extension won't play it (invalid JSON, version, no segments, audio missing or outside the
                   journeys folder); WARNING = it plays, but a part is not what the file says (a step or beat the
                   journey doesn't have, overlapping or out-of-order times, an end before its start or past the
                   audio, written for another journey). The audio's length: <audio seconds>, else read from a .wav,
                   else from ffprobe when it is installed. `check` runs it too when the podcast file exists.
''', 'slug seconds?')
def cmd_podcast(ctx, slug, seconds=''):
    if seconds:
        try:
            float(seconds)
        except ValueError:
            fail(f'podcast: <audio seconds> must be a number (got {seconds!r})')
    j = ctx.journeys.load(slug)
    r = podcast_report(ctx, slug, j, seconds or None)
    if r is None:
        print(f'PROBLEM: no podcast for {slug}: {ctx.journeys.podcast(slug)} does not exist')
        return 1
    problems, warnings, note = r
    for w in warnings:
        print('WARNING: ' + w)
    for p in problems:
        print('PROBLEM: ' + p)
    plural = lambda n, w: f'{n} {w}{"" if n == 1 else "s"}'
    print(f'{"FAILED" if problems else "ok"}: podcast of {slug}, {plural(len(problems), "problem")}, '
          f'{plural(len(warnings), "warning")}{note}')
    return 1 if problems else 0


# ======================================================================================================================
# The manual and the command line. `journey.py help` and the usage lines of an error are made from the commands'
# declarations (@command) and the rules below; argparse reads the command line from the same declarations.
# ======================================================================================================================

INTRO = f'''journey.py — writes a code journey (format v2): an answer to "how does X work?" as a small map (nodes, edges)
plus an ordered storyline of steps, all in ONE file: <repo>/journeys/<slug>.json (committed, reviewed in PRs like
code). Rules: ../SKILL.md. The folder: <repo>/journeys/, or <repo>/.code-notes/journeys/ when only that exists;
`--dir <folder>` (anywhere on the command line; relative to <repo>) overrides. Last good copies go in its .bak/
(git-ignored). `--steps A-B` (anywhere) changes the step count `check` wants ({MIN_STEPS}-{MAX_STEPS}), e.g. for a short tour of a change.'''

RULES_HEADER = 'Rules (`journey.py help <command>` shows the ones for that command):'
# The rules every command keeps, and the commands each one is about (`help <command>` shows that command's).
Rule = namedtuple('Rule', 'commands text')
RULE_BOOK = (
    Rule(('step', 'migrate'), '''\
- Every step has a stable short "id" (made by `step`/`migrate`, kept by every other command): the extension follows
  a step by it when steps move.'''),
    Rule(('edge', 'step'), '''\
- Every write command prints one line saying what it wrote (`question = "…" (54 chars)`, `server.label = "…"`,
  `edge a -> b: …`, `step 3 [id] …`), and under it the first/last line it anchored on.'''),
    Rule(('check', 'restep', 'set'), '''\
- Anchors are compact (v3; docs/journey-format.md of the extension, "In the repo"), for steps and box `at`:
  {v: 3, head: first <= 3 non-blank lines, tail: last <= 2, lines: N, hash: sha1 of the normalized text (each
  non-blank line through `norm`, joined with "\\n") first 12 hex, before/after: the nearest non-blank line around it}.
  `check` finds the code again from head and tail: same hash = fresh (elsewhere: moved, a WARNING, `fix` repoints
  it); another hash = CHANGED (a PROBLEM showing where it is now: re-verify, then `restep N range` / `set <node> at`);
  head or tail not found = GONE (PROBLEM). Full-text (v2) anchors are still read.'''),
    Rule(('new', 'node', 'edge', 'step', 'restep', 'meta', 'set', 'setedge'), f'''\
- Limits are enforced when you write (exit 1, nothing is written): `new`/`meta` refuse a question > {MAX_QUESTION} chars and a
  title > {MAX_TITLE}, `step`/`restep` an over-long title or lead, `node`/`set` a label > {MAX_LABEL} chars, a blurb > {MAX_BLURB} and an {MAX_CHILDREN + 1}th
  child of one box, `edge`/`setedge` a label > {MAX_EDGE_LABEL}.'''),
    Rule(('new', 'check', 'meta'), '''\
- `check` (and `new`, `meta question|title`) print a WARNING when another journey in the repo has a very similar
  question or title, or walks mostly the same code: extend that one.'''),
    Rule(('step', 'check', 'restep'), '''\
- `step`/`restep`/`check` print a WARNING when the range starts or ends on a lone closing brace, stops in the middle
  of a statement, or starts on a bare `return …` with other code after it (fix it with `restep N range`), and when
  two steps are anchored on identical lines.'''),
    Rule(('step', 'check', 'restep'), '''\
- `step`/`restep`/`check` print a WARNING when a title holds several facts (two or more of ", " "; " ": " " and "
  " then "; a list "A, B and C" and a leading "If …," do not count) and when the lead or details carry a path:line
  (prose names the symbol; path:line goes in refs).'''),
    Rule(('node', 'check', 'set'), f'''\
- `node`/`set`/`check` print a WARNING when a system/module/external/store label is over {SOFT_LABEL} chars ({MAX_LABEL} stays the hard
  limit).'''),
    Rule(('step', 'check', 'restep'), f'''\
- `step`/`restep`/`check` print a WARNING when a lead is more than one sentence or more than {SOFT_LEAD_WORDS} words (the rest goes
  in details), when a step marks more than {SOFT_RANGE_LINES} lines, and when a lead repeats its title (one sentence of the lead
  carries >= {round(REPEAT_SENTENCE * 100)} % of the title's words, or the whole lead >= {round(REPEAT_LEAD * 100)} %): the lead should say what the title does not.'''),
    Rule(('step', 'check', 'restep'), f'''\
- A ref is ONE sentence saying what the reader will see there, with the path:line inside it ("The 30 s retry delay
  is set in worker/src/queue.ts:42."): the extension shows the sentence and links the basename. `check`
  verifies the one path:line (file exists, lines in range, prints the line); `step`/`restep`/`check` print a WARNING
  for a bare ref without a sentence, for more than one path:line in a ref, for a ref over {MAX_REF_WORDS} words, and for a ref
  that points inside the step's own range or within {NEAR_REF} lines of it (that code is already on screen; a ref points
  somewhere else: another function or file).'''),
    Rule(('node', 'edge', 'check', 'set', 'setedge'), '''\
- `node`/`set`/`edge`/`setedge`/`check` print a WARNING when a label or blurb holds code syntax (a URL template or
  path, an HTTP verb, a protocol name, CLI placeholders, "->"): say it in words ("start run").'''),
    Rule(('check', 'restep', 'link'), f'''\
- `link` refuses a phrase that is not a free part of the lead/details (missing, only in backticks or a Markdown link,
  overlapping another link's phrase), a range equal to the step's own range, a second link on the same lines and a
  blank or missing line (`check`: WARNING for all but a missing line); WARNING over {SOFT_LINK_LINES} lines. `restep`/`check` print
  a WARNING naming a link whose phrase the text no longer has (a dead link).'''),
    Rule(('check', 'value'), f'''\
- `value` refuses a line that does not mention the name and a value over {MAX_VALUE} chars (`check`: WARNING), and a second
  hint on one line (`check`: PROBLEM); WARNING when the line is neither within {VALUE_NEAR} lines of the step's range nor
  within {BEAT_NEAR} of a beat or link of it.'''),
    Rule(('check', 'scene'), f'''\
- `scene` refuses (`check`: PROBLEM) an unknown actor type, a duplicate id, a wire, packet, focus or set naming no
  actor, focus "all", a packet with no wire, no beat with code, more than {MAX_BEATS} beats, more than {MAX_CHECKS} checks or any over {MAX_CHECK}
  chars, more than {MAX_ROWS} table rows, a terminal line over {MAX_TERM_LINE} chars (file {FILE_CHARS}, chat {CHAT_CHARS}), an app screen or pane that does
  not exist, and text longer than its box holds (the message says the limit); it refuses (`check`: WARNING) more than {MAX_ACTORS} actors, fewer than {MIN_BEATS} beats, keys the engine ignores and set
  indexes past what the actor has. WARNING: {SOFT_BEATS + 1} beats, a caption over {SOFT_CAPTION} chars (or with muted over {SOFT_CAPTION_ALL}), two code-less
  beats in a row, a beat lighting a signature, a comment or a lone brace.'''),
    Rule(('check', 'mark', 'marks'), f'''\
- `mark` refuses (`check`: PROBLEM) a match that isn't on its lines (nor within {MARK_REFIND} lines: the extension then lights
  nothing), an nth past the occurrences, lines past the end of the file. WARNING (`mark`/`check`/`marks`): more than
  {MAX_MARKS} marks on a step or beat, a step mark outside the step's lines, a match the step's text (a beat: its caption)
  names none of the words of, a match that is the whole line, a whole-line mark on the step's whole range; a match
  found a few lines off (`check fix` moves its lines).'''),
    Rule(('check',), f'''\
- `check` finds every link, value and beat line again by its stored text the way the extension does (same trimmed
  line, nearest within {FIND_NEAR} lines): moved = WARNING (`check fix` repoints it, apart from the step's range); not found
  = PROBLEM. A journey with none of them gets one WARNING; a step without links, when others have some, too.'''),
)

# The limits a writer meets, for `journey.py help limits` (and SKILL.md's Limits table, which a test keeps the same).
LIMITS = (
    ('Steps in a journey', f'{MIN_STEPS}-{MAX_STEPS} (`--steps A-B` for a short tour); `check`: PROBLEM'),
    ('Question', f'<= {MAX_QUESTION} chars, one natural question; refused'),
    ('Journey title', f'<= {MAX_TITLE} chars, a topic name; refused'),
    ('Summary', f'<= {MAX_SUMMARY_SENTENCES} plain sentences; `check`: PROBLEM'),
    ('Step title', f'<= {MAX_STEP_TITLE} chars; refused'),
    ('Lead', f'one sentence, <= {SOFT_LEAD_WORDS} words (WARNING); {MAX_LEAD_WORDS} refused'),
    ('Lines a step marks', f'<= {SOFT_RANGE_LINES} (WARNING)'),
    ('Refs of a step', f'<= {MAX_REFS} (`check`: PROBLEM), each <= {MAX_REF_WORDS} words (WARNING), not within {NEAR_REF} '
                       f'lines of the step (WARNING)'),
    ('Box label', f'<= {SOFT_LABEL} chars (WARNING; not for a function box), {MAX_LABEL} refused'),
    ('Box blurb', f'<= {MAX_BLURB} chars; refused'),
    ('Boxes in one box', f'<= {MAX_CHILDREN}; refused'),
    ('Edge label', f'<= {MAX_EDGE_LABEL} chars; refused'),
    ('Link', f'1-8 lines, WARNING over {SOFT_LINK_LINES}'),
    ('Value', f'<= {MAX_VALUE} chars (refused), its note <= {SOFT_NOTE} (WARNING); within {VALUE_NEAR} lines of the step '
              f'or {BEAT_NEAR} of a beat or link (WARNING)'),
    ('Scene', f'{MIN_BEATS}-{MAX_BEATS} beats ({MAX_BEATS}: WARNING), <= {MAX_ACTORS} actors; a caption <= {SOFT_CAPTION} '
              f'chars, with `muted` <= {SOFT_CAPTION_ALL} (WARNING)'),
    ('Marks', f'<= {MAX_MARKS} per step or beat (WARNING)'),
)


def limits_table():
    rows = ['| What | Limit |', '|---|---|'] + [f'| {what} | {limit} |' for what, limit in LIMITS]
    return '\n'.join(rows)


def scene_fields():
    """What each scene actor draws and reads, with its sizes: `journey.py help scene` (SKILL.md says when to use which)."""
    def chars(d):
        return ', '.join(f'{k} <= {v}' for k, v in d.items())
    actors = (
        ('service', 'code at work', f'fn "name()" <= {FN_CHARS}; checks <= {MAX_CHECKS}, each <= {MAX_CHECK} chars',
         'done: ticks'),
        ('table', 'a database collection, nothing else', f'rows <= {MAX_ROWS}: {{id, chips: [..], old?}} (old = there before)',
         'show new rows, hi row (-1 none), chips {i: [..]}'),
        ('file', 'a file, folder listing or document',
         f'lines <= {FILE_CHARS} chars ({FILE_NUM_CHARS} with from: the first line\'s number), 8 in view',
         'show n (all if unset), hi i or [a, b], text {i: "now"}'),
        ('cluster', 'a namespace, its pods', f'pods: {{label, note?, madeNote?, goneNote?, ghost?}}; inner (a cluster '
         f'inside it): {{label <= {INNER_LABEL_CHARS}, sub, ghost?, pods}}',
         'made [i], gone [i], mark i, inner true, innerMade, innerGone, innerMark'),
        ('terminal', 'a command and its output', f'lines <= {MAX_TERM_LINE} chars, "$ " = a command',
         'show lines so far (first beat sets it), hi i'),
        ('chat', 'a person and a model, an agent and its tools',
         f'messages {{from: me|them, text <= {CHAT_CHARS}, tool? <= {CHAT_TOOL_CHARS}}}, 4 in view',
         'show n (first beat sets it), hi i'),
        ('queue', 'a bus, channel or work queue', f'slots (<= {QUEUE_SLOTS} drawn), cap "256 events per subscriber"',
         f'fill n, drop true, note <= {NOTE_CHARS}'),
        ('gauge', 'a limit and how much is taken', 'max, unit, used', f'used, want (red when it does not fit), note <= {NOTE_CHARS}'),
        ('app', 'a web app\'s window, drawn dark: dialog (a list page with a dialog over it), detail, signin, or a page '
         'of pages',
         f'brand (default "App"), logo 1-2 letters, tabs <= {MAX_TABS} (each <= {TAB_CHARS}; brand and tabs share the top '
         f'bar), screen; dialog {{tab, {chars(DIALOG_CHARS)}, lines <= {DIALOG_LINES} [label <= {LINE_KEY}, value <= '
         f'{LINE_VALUE}]}}; detail {{tab, {chars(DETAIL_CHARS)} (title + status <= {TITLE_CHIP}), tone '
         f'{"|".join(TONES)}, cards {{sev, title <= {CARD_CHARS}}}, timeline (rows <= {TIMELINE_CHARS}), chat {{from: '
         f'me|them, text <= {APP_CHAT_CHARS}}}}}; signin {{{chars(SIGNIN_CHARS)}}}; pages {{name: {{tab, title <= '
         f'{PAGE_CHARS["title"]}, chip? <= {PAGE_CHARS["chip"]}, tone?, banner? <= {PAGE_BANNER}, rows <= {PAGE_ROWS} '
         f'[label <= {PAGE_KEY}, value <= {PAGE_VALUE}], button? <= {PAGE_CHARS["button"]}}}}} (rows + banner + button '
         f'<= {PAGE_ITEMS})',
         'screen, status, tone, cards n, events n, newCard, newEvent, pane picture|chat, picture, chat n, newChat, typing, '
         'rows, hiRow, banner, busy, notice, redirecting; beat click: true (presses the shown screen\'s button)'),
        ('browser', 'a web page (a small shop)',
         f'{chars(BROWSER_CHARS)} (title + cart <= {SHOP_TOP}), products 2, each <= {PRODUCT_CHARS}, lock {"|".join(LOCKS)}',
         'click, mark, lock; beat click/flash: its id'),
    )
    out = ['Actors (each: id, col 0-3 left to right, the same col stacks; label, sub; a label fits '
           + ', '.join(f'{t} {n}' for t, n in LABEL_CHARS.items()) + ' chars):']
    for t, draws, fields, sets in actors:
        out += [f'  {t}: {draws}', f'      fields: {fields}', f'      a beat\'s set: {sets}']
    out += ['A beat: focus, caption, muted?, set?, packet? {from, to, label} (needs a wire), code {file, line} (the '
            'script adds the text), marks? [{lines: [a, b], match?, nth?, file?}] (file: the beat\'s code file unless given).',
            'Older journeys\' names still read: actor type console (app), screens ' + ', '.join(SCREEN_ALIAS)
            + ', pane desktop.']
    return '\n'.join(out)


# Help topics that are not commands.
TOPICS = {'limits': limits_table}
# What `help <command>` adds after the command's rules.
MORE = {'scene': scene_fields}


def short_help():
    w = max(len(c) for c in COMMANDS)
    lines = ['journey.py: writes a code journey, <repo>/journeys/<slug>.json (rules: ../SKILL.md).', '']
    lines += [f'  {c.name.ljust(w)}  {c.summary}' for c in COMMANDS.values()]
    lines += ['', 'journey.py help <command>: its arguments and rules. journey.py help all: everything. '
                  'journey.py help limits: the limits.',
              '--dir <folder> (anywhere) reads and writes journeys there instead of <repo>/journeys/.']
    return '\n'.join(lines)


def manual():
    """`journey.py help all`: what it is, every command, every rule."""
    lines = [INTRO, '']
    for c in COMMANDS.values():
        if c.section:
            lines += ['', c.section]
        lines += c.usage.split('\n')
    lines += ['', RULES_HEADER] + [r.text for r in RULE_BOOK]
    return '\n'.join(lines)


def command_help(name):
    """The command's usage block, the rules about it, and its reference (scene: the actors)."""
    out = [COMMANDS[name].usage]
    hits = [r.text for r in RULE_BOOK if name in r.commands]
    if hits:
        out += ['', 'Rules:'] + hits
    if name in MORE:
        out += ['', MORE[name]()]
    return '\n'.join(out)


def usage_lines(name):
    return [l.strip() for l in COMMANDS[name].usage.split('\n') if l.startswith('  journey.py ')]


class Parser(argparse.ArgumentParser):
    """argparse for one command, its errors said the way journey.py says them (`<command>: <why>`, its usage, exit 2)."""
    def __init__(self, name):
        super().__init__(prog=f'journey.py {name}', add_help=False, allow_abbrev=False)
        self.name = name

    def error(self, message):
        m = re.match(r'the following arguments are required: (.*)$', message)
        if m:
            message = 'missing ' + ' '.join(f'<{a}>' for a in m.group(1).split(', '))
        m = re.match(r'unrecognized arguments: (.*)$', message)
        if m:
            message = f'{len(m.group(1).split())} argument(s) too many'
        raise UsageError(self.name, re.sub(r'^argument \w+: ', '', message))


FLAGS = ('--fix', '--all')       # options without a value
# Options whose default is read from the environment: the extension runs the agent that writes a journey with
# JOURNEY_MODEL set, as it cannot add --model to the agent's own commands.
ENV_DEFAULTS = {'--model': 'JOURNEY_MODEL'}


def repo_dir(v):
    if not os.path.isdir(v):
        raise argparse.ArgumentTypeError(f'missing <repo>: {v!r} is not a directory (the repo comes first)')
    return v


def parser_for(c):
    p = Parser(c.name)
    p.add_argument('repo', type=repo_dir)
    for a in c.args:
        name = a.rstrip('?*')
        if a.endswith('?'):
            p.add_argument(name, nargs='?', default='')
        elif a.endswith('*'):
            p.add_argument(name, nargs='*')
        else:
            p.add_argument(name)
    for o in c.options:
        if o in FLAGS:
            p.add_argument(o, action='store_true')
        else:
            p.add_argument(o, default=os.environ.get(ENV_DEFAULTS[o]) if o in ENV_DEFAULTS else None)
    p.add_argument('--dir')
    p.add_argument('--steps')
    return p


def step_count(v):
    """--steps A-B: the step count `check` wants."""
    m = re.match(r'^(\d+)-(\d+)$', v)
    if not m or int(m.group(1)) < 1 or int(m.group(1)) > int(m.group(2)):
        raise UsageError('check', f'--steps {v}: write it as A-B (e.g. 2-3)')
    return int(m.group(1)), int(m.group(2))


def run(argv):
    """Runs one command line; returns the exit code."""
    top = argparse.ArgumentParser(prog='journey.py', add_help=False, allow_abbrev=False)
    top.add_argument('--dir')
    top.add_argument('--steps')
    top.add_argument('command', nargs='?')
    top.add_argument('rest', nargs=argparse.REMAINDER)
    first = top.parse_known_args(argv)[0]
    name = first.command
    if name in (None, 'help', '-h', '--help'):
        what = first.rest[0] if name == 'help' and first.rest else ''
        if what == 'all':
            print(manual())
        elif what in COMMANDS:
            print(command_help(what))
        elif what in TOPICS:
            print(TOPICS[what]())
        elif what:
            print(f'unknown command {what!r}\n\n{short_help()}', file=sys.stderr)
            return 2
        else:
            print(short_help())
        return 0 if argv else 2
    if name not in COMMANDS:
        print(f'unknown command {name!r} (journey.py alone lists them)', file=sys.stderr)
        return 2
    c = COMMANDS[name]
    ns = parser_for(c).parse_intermixed_args(first.rest)
    steps = ns.steps or first.steps
    ctx = Ctx(ns.repo, ns.dir or first.dir, step_count(steps) if steps else (MIN_STEPS, MAX_STEPS))
    given = {a.rstrip('?*'): getattr(ns, a.rstrip('?*')) for a in c.args}
    given.update({o.lstrip('-'): getattr(ns, o.lstrip('-')) for o in c.options})
    return c.fn(ctx, **given) or 0


def main(argv=None):
    try:
        code = run(sys.argv[1:] if argv is None else argv)
    except UsageError as e:
        print(e.text, file=sys.stderr)
        for l in usage_lines(e.command):
            print(f'usage: {l}', file=sys.stderr)
        code = e.code
    except Failed as e:
        if e.text:
            print(e.text, file=sys.stderr)
        code = e.code
    sys.stdout.flush()
    sys.exit(code)


if __name__ == '__main__':
    main()
