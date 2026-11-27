#!/usr/bin/env node
// The code-journey skill's checks (journey.py check, scene, mark, marks, podcast) on the Code Notes extension's own
// rules for journeys, scenes, marks, podcasts and anchors. journey.py runs it when node is on PATH; without node it
// uses its own copy of the rules. One file, Node >= 18, no dependencies.
//
// Generated from cli/journey/*.ts by scripts/build/journey-check.mjs (npm run build): edit those, not this file.

// cli/journey/index.ts
import readline from "node:readline";

// cli/journey/anchors.ts
import fs from "node:fs";
import path from "node:path";

// src/core/anchors/compact.ts
import { createHash } from "crypto";

// src/core/anchors/lines.ts
var norm = (s) => s.replace(/\s+/g, "").replace(/['`]/g, '"').replace(/[;,]+$/, "");
var blank = (s) => norm(s) === "";
var WEAK_LENGTH = 3;
var weak = (s) => norm(s).length < WEAK_LENGTH;
var lineIs = (lines, k, want) => !!want && k >= 0 && k < lines.length && norm(lines[k]) === want;

// src/core/anchors/kinds.ts
var isCompact = (a) => !!a && a.v === 3;
var str = (v) => typeof v === "string" ? v : "";
function readAnchor(v) {
  if (!v || typeof v !== "object") return void 0;
  if (v.v === 3) return readCompact(v);
  return typeof v.text === "string" ? { text: v.text, before: str(v.before), after: str(v.after) } : void 0;
}
function readCompact(v) {
  if (typeof v.head !== "string" || !v.head.trim()) return void 0;
  const lines = Number.isInteger(v.lines) && v.lines > 0 ? v.lines : v.head.split("\n").length;
  return {
    v: 3,
    head: v.head,
    tail: str(v.tail) || v.head.split("\n").pop(),
    lines,
    hash: str(v.hash),
    before: str(v.before),
    after: str(v.after)
  };
}

// src/core/anchors/compact.ts
var HEAD_LINES = 3;
var TAIL_LINES = 2;
var MIN_LEN_RATIO = 0.5;
var MAX_LEN_RATIO = 1.5;
var MAX_LEN_SLACK = 5;
var HASH_HEX = 12;
var sha = (s) => createHash("sha1").update(s, "utf8").digest("hex").slice(0, HASH_HEX);
function blockHash(block) {
  return sha(block.map(norm).filter(Boolean).join("\n"));
}
function blockHashAll(block) {
  return sha(block.map(norm).join("\n"));
}
function compactOf(lines, start, end) {
  const block = lines.slice(start, end + 1);
  const solid = block.filter((l) => !blank(l));
  if (!solid.length) return void 0;
  const b = nonBlank(lines, start - 1, -1);
  const a = nonBlank(lines, end + 1, 1);
  return {
    v: 3,
    head: solid.slice(0, HEAD_LINES).join("\n"),
    tail: solid.slice(-TAIL_LINES).join("\n"),
    lines: block.length,
    hash: blockHash(block),
    before: b >= 0 ? lines[b] : "",
    after: a < lines.length ? lines[a] : ""
  };
}
function toCompact(a) {
  if (isCompact(a)) return a;
  const text = a.text.split("\n");
  const solid = (s) => s.split("\n").filter((l) => !blank(l));
  const c = compactOf(text, 0, text.length - 1);
  if (!c) return void 0;
  return { ...c, before: solid(a.before).pop() ?? "", after: solid(a.after)[0] ?? "" };
}
function forward(lines, i, want) {
  let k = i;
  for (let w = 0; w < want.length; w++) {
    while (k < lines.length && blank(lines[k])) k++;
    if (k >= lines.length || norm(lines[k]) !== want[w]) return void 0;
    if (w < want.length - 1) k++;
  }
  return k;
}
function backward(lines, e, want, floor) {
  let k = e;
  for (let w = want.length - 1; w >= 0; w--) {
    while (k >= floor && blank(lines[k])) k--;
    if (k < floor || norm(lines[k]) !== want[w]) return false;
    k--;
  }
  return true;
}
function nonBlank(lines, i, step) {
  let k = i;
  while (k >= 0 && k < lines.length && blank(lines[k])) k += step;
  return k;
}
function lengthWindow(storedLen) {
  return { minLen: Math.max(1, Math.ceil(storedLen * MIN_LEN_RATIO)), maxLen: Math.floor(storedLen * MAX_LEN_RATIO + MAX_LEN_SLACK) };
}
function candidateEnds(lines, start, headEnd, tail, storedLen, minLen, maxLen) {
  const out = [];
  const first = Math.max(headEnd, start + minLen - 1);
  const last = Math.min(lines.length - 1, start + maxLen - 1);
  for (let e = first; e <= last; e++) {
    if (norm(lines[e]) !== tail[tail.length - 1] || !backward(lines, e, tail, start)) continue;
    const afterLine = nonBlank(lines, e + 1, 1);
    const stored = start + storedLen - 1;
    const storedFits = stored > e && stored < lines.length && lines.slice(e + 1, stored + 1).every(blank);
    out.push({ end: e, afterLine });
    if (storedFits) out.push({ end: stored, afterLine });
  }
  return out;
}
function rankCandidates(x, y) {
  return Number(y.hash) - Number(x.hash) || x.dLen - y.dLen || y.ctx - x.ctx || x.dist - y.dist;
}
function findCompact(lines, a, hint) {
  const head = a.head.split("\n").map(norm).filter(Boolean);
  const tail = a.tail.split("\n").map(norm).filter(Boolean);
  if (!head.length) return { state: "gone" };
  if (!tail.length) tail.push(...head.slice(-TAIL_LINES));
  const storedLen = Math.max(1, a.lines);
  const { minLen, maxLen } = lengthWindow(storedLen);
  const before = weak(a.before) ? "" : norm(a.before);
  const after = weak(a.after) ? "" : norm(a.after);
  const cands = [];
  for (let start = 0; start < lines.length; start++) {
    if (norm(lines[start]) !== head[0]) continue;
    const headEnd = forward(lines, start, head);
    if (headEnd === void 0) continue;
    const ctxBefore = lineIs(lines, nonBlank(lines, start - 1, -1), before) ? 1 : 0;
    for (const { end, afterLine } of candidateEnds(lines, start, headEnd, tail, storedLen, minLen, maxLen)) {
      const block = lines.slice(start, end + 1);
      const hash = !a.hash || blockHash(block) === a.hash || blockHashAll(block) === a.hash;
      const ctx = ctxBefore + (lineIs(lines, afterLine, after) ? 1 : 0);
      cands.push({ start, end, hash, dLen: Math.abs(end - start + 1 - storedLen), ctx, dist: Math.abs(start - hint) });
    }
  }
  if (!cands.length) return { state: "gone" };
  cands.sort(rankCandidates);
  const c = cands[0];
  return { state: c.hash ? "fresh" : "changed", loc: { start: c.start, end: c.end } };
}

// src/core/anchors/lineFollow.ts
var SAME_TEXT_RADIUS = 400;
function findLine(lines, line, text) {
  const want = text.trim();
  if (!want) return -1;
  if (lines[line]?.trim() === want) return line;
  for (let d = 1; d <= SAME_TEXT_RADIUS; d++) {
    if (lines[line - d]?.trim() === want) return line - d;
    if (lines[line + d]?.trim() === want) return line + d;
  }
  return -1;
}

// cli/journey/anchors.ts
function fileLines(repo, file) {
  try {
    return fs.readFileSync(path.join(repo, file), "utf8").split("\n");
  } catch {
    return void 0;
  }
}
function place(lines, a, hint) {
  const read = readAnchor(a);
  const c = read && toCompact(read);
  if (!c) {
    const w = a ?? {};
    const n = typeof w.lines === "number" ? w.lines : typeof w.text === "string" ? w.text.split("\n").length : 1;
    const stillBlank = hint >= 0 && hint + n <= lines.length && lines.slice(hint, hint + n).every(blank);
    return stillBlank ? [hint, hint + n - 1, true] : null;
  }
  const got = findCompact(lines, c, hint);
  return got.state === "gone" ? null : [got.loc.start, got.loc.end, got.state === "fresh"];
}
var lineOf = (lines, line, text) => findLine(lines, line - 1, text ?? "");

// src/core/format/marks.ts
function markShapeProblem(m) {
  const l = m.lines;
  const lines = Array.isArray(l) && l.length === 2 && l.every((x) => Number.isInteger(x) && x >= 1) && l[1] >= l[0];
  if (!lines) {
    return { what: `lines must be [first, last] (1-based, first <= last), got ${JSON.stringify(l)}`, sub: l === void 0 ? [] : ["lines"] };
  }
  if (m.file !== void 0 && (typeof m.file !== "string" || !m.file.trim())) {
    return { what: "file is not a path", sub: ["file"] };
  }
  if (m.match !== void 0 && (typeof m.match !== "string" || !m.match)) {
    return { what: "match is not a text", sub: ["match"] };
  }
  if (m.nth !== void 0 && !(Number.isInteger(m.nth) && m.nth >= 1)) {
    return { what: `nth must be 1 or more, got ${JSON.stringify(m.nth)}`, sub: ["nth"] };
  }
  return void 0;
}
function codeMarkOf(m) {
  const l = m.lines;
  return {
    lines: [l[0], l[1]],
    ...typeof m.file === "string" ? { file: m.file } : {},
    ...typeof m.match === "string" ? { match: m.match } : {},
    ...typeof m.nth === "number" ? { nth: m.nth } : {}
  };
}
var MARK_REFIND_LINES = 20;
function occurrence(doc, a, b, match, nth) {
  a = Math.max(0, a);
  b = Math.min(doc.length - 1, b);
  if (a > b) return void 0;
  const text = doc.slice(a, b + 1).join("\n");
  let i = -match.length;
  for (let n = 0; n < nth; n++) {
    i = text.indexOf(match, i + match.length);
    if (i < 0) return void 0;
  }
  const pos = (off) => {
    let line = a;
    while (off > doc[line].length) {
      off -= doc[line].length + 1;
      line++;
    }
    return { line, col: off };
  };
  const s = pos(i), e = pos(i + match.length);
  return { line: s.line, col: s.col, endLine: e.line, endCol: e.col };
}
function findMark(doc, m) {
  const a = m.lines[0] - 1, b = Math.min(m.lines[1] - 1, doc.length - 1);
  if (a >= doc.length || a < 0) return void 0;
  if (m.match) {
    for (let d = 0; d <= MARK_REFIND_LINES; d++) {
      for (const s of d ? [-d, d] : [0]) {
        const spot = occurrence(doc, a + s, b + s, m.match, m.nth ?? 1);
        if (spot) return { spot, moved: s, found: true };
      }
    }
  }
  const indent = doc[a].length - doc[a].trimStart().length;
  return { spot: { line: a, col: doc[a].trim() ? indent : 0, endLine: b, endCol: doc[b].length }, moved: 0, found: !m.match };
}
function findMarkProblem({ doc, mark: m }) {
  if (doc === null) return { kind: "no-file", sub: m.file !== void 0 ? "file" : "lines" };
  if (m.lines[1] > doc.length) return { kind: "past-end", fileLines: doc.length, sub: "lines" };
  if (m.match === void 0) return void 0;
  const f = findMark(doc, m);
  if (!f || f.moved === 0 && f.found) return void 0;
  return f.found ? { kind: "moved", moved: f.moved, sub: "match" } : { kind: "not-found", sub: "match" };
}
function markProblemText(p, { file, mark: m, onMissing }) {
  const [a, b] = m.lines;
  const where = `${a === b ? `line ${a}` : `lines ${a}–${b}`} of ${file}`;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  if (p.kind === "no-file") return `${file} isn't in the repository; nothing is lit`;
  if (p.kind === "past-end") {
    if (a <= p.fileLines) return `${where} go past its end (${p.fileLines} lines)`;
    return `${where} ${a === b ? "is" : "are"} past its end (${p.fileLines} lines); nothing is lit`;
  }
  const occurrence2 = m.nth !== void 0 && m.nth > 1 ? ` (occurrence ${m.nth})` : "";
  const missing = `${JSON.stringify(m.match)}${occurrence2} isn't in ${where}`;
  if (p.kind === "moved") return `${missing}; found ${plural(Math.abs(p.moved), "line", "lines")} ${p.moved < 0 ? "up" : "down"}, lit there`;
  return `${missing}, nor within ${MARK_REFIND_LINES} lines: ${onMissing === "lines" ? "the whole lines light" : "nothing is lit"}`;
}
function markCodeProblem(m) {
  const p = findMarkProblem(m);
  if (!p) return void 0;
  return { what: markProblemText(p, m), sub: p.sub, ...p.kind === "moved" ? { moved: p.moved } : {} };
}

// cli/journey/py.ts
var len = (s) => [...s].length;
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === "object") return Object.keys(v).length > 0;
  return !!v;
}
var or = (a, b) => truthy(a) ? a : b;
function quote(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === q) out += "\\" + q;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "	") out += "\\t";
    else if (c < 32 || c === 127) out += "\\x" + c.toString(16).padStart(2, "0");
    else out += ch;
  }
  return q + out + q;
}
function repr(v) {
  if (v === void 0 || v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") return quote(v);
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return "[" + v.map(repr).join(", ") + "]";
  return "{" + Object.entries(v).map(([k, x]) => `${quote(k)}: ${repr(x)}`).join(", ") + "}";
}
var str2 = (v) => typeof v === "string" ? v : repr(v);
var isInt = (v) => typeof v === "number" && Number.isInteger(v);
var isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
var sorted = (xs) => [...xs].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
var isAre = (n) => n === 1 ? "is" : "are";
function pyRound(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : r;
}

// cli/journey/marks.ts
function checkMark(m, file, doc, onMissing) {
  if (!isObj(m)) return { shape: "not an object { lines, match? }", code: null, spot: null };
  const bad = markShapeProblem(m);
  if (bad) return { shape: bad.what, code: null, spot: null };
  const mark = codeMarkOf(m);
  const p = markCodeProblem({ doc, file, mark, onMissing });
  const found = doc && findMark(doc, mark);
  const lit = found && (found.found || mark.match === void 0);
  return {
    shape: null,
    code: p ? { what: p.what, moved: p.moved ?? null } : null,
    spot: lit ? [found.spot.line, found.spot.col, found.spot.endLine, found.spot.endCol] : null
  };
}

// cli/journey/podcast.ts
import fs2 from "node:fs";
import path2 from "node:path";

// src/core/format/versions.ts
var VERSIONS = {
  /** A journey (`<slug>.json`): v1 (steps as notes) is refused with a reason; it needs migrating. */
  journey: 2,
  /** A podcast (`<slug>.podcast.json`). */
  podcast: 1,
  /** A note (`.code-notes/*.json`): a file without `version` is version 1; the extension writes it. */
  note: 1,
  /** An understanding check (`understanding/<branch>.json`). */
  check: 1
};

// src/core/clock.ts
function clock(t) {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(r).padStart(2, "0")}`;
}
function clockMs(t) {
  const tenths = Math.round(t * 10) / 10;
  const whole = Math.floor(tenths);
  const frac = Math.round((tenths - whole) * 10);
  return frac ? `${clock(whole)}.${frac}` : clock(whole);
}

// src/core/json/spans.ts
var JsonSyntax = class extends Error {
  constructor(at, what) {
    super(what);
    this.at = at;
  }
  at;
};
function jsonSyntaxError(raw) {
  try {
    valueSpans(raw);
    return void 0;
  } catch (e) {
    if (!(e instanceof JsonSyntax)) return String(e);
    const { line, col } = lineCol(raw, e.at);
    return `line ${line + 1}, column ${col + 1}: ${e.message}`;
  }
}
function lineCol(raw, offset) {
  let line = 0, last = -1;
  for (let k = 0; k < offset && k < raw.length; k++) if (raw[k] === "\n") {
    line++;
    last = k;
  }
  return { line, col: offset - last - 1 };
}
var WHITESPACE = " 	\n\r";
var SCALAR = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/;
var SCALAR_LOOKAHEAD = 64;
function valueSpans(raw) {
  const reader = new SpanReader(raw);
  reader.value([]);
  reader.end();
  return reader.spans;
}
var SpanReader = class {
  constructor(raw) {
    this.raw = raw;
  }
  raw;
  spans = /* @__PURE__ */ new Map();
  i = 0;
  /** The value at the reader's place, at `path`; `from`: where its span starts (its key, in an object). */
  value(path3, from) {
    this.ws();
    const start = from ?? this.i;
    const c = this.raw[this.i];
    if (c === "{") this.object(path3);
    else if (c === "[") this.array(path3);
    else if (c === '"') this.str();
    else this.scalar();
    this.spans.set(JSON.stringify(path3), { start, end: this.i });
  }
  /** Only whitespace is left. */
  end() {
    this.ws();
    if (this.i < this.raw.length) this.bad();
  }
  object(path3) {
    this.i++;
    this.ws();
    if (this.raw[this.i] === "}") {
      this.i++;
      return;
    }
    do {
      this.ws();
      const keyAt = this.i;
      const key = this.str();
      this.expect(":");
      this.value([...path3, key], keyAt);
    } while (this.listGoesOn("}"));
  }
  array(path3) {
    this.i++;
    this.ws();
    if (this.raw[this.i] === "]") {
      this.i++;
      return;
    }
    let n = 0;
    do
      this.value([...path3, n++]);
    while (this.listGoesOn("]"));
  }
  /** After an item: true on ",", false on `close` (both read), else a syntax error. */
  listGoesOn(close) {
    this.ws();
    const c = this.raw[this.i];
    if (c === "," || c === close) {
      this.i++;
      return c === ",";
    }
    return this.bad(this.atEnd() ? void 0 : `expected "," or "${close}", found ${JSON.stringify(c)}`);
  }
  str() {
    const raw = this.raw;
    if (raw[this.i] !== '"') this.bad();
    const s = this.i;
    this.i++;
    while (this.i < raw.length && raw[this.i] !== '"') {
      if (raw[this.i] === "\n") this.bad("a line break inside a string");
      this.i += raw[this.i] === "\\" ? 2 : 1;
    }
    if (this.atEnd()) this.bad();
    this.i++;
    try {
      return JSON.parse(raw.slice(s, this.i));
    } catch {
      this.i = s;
      return this.bad("a bad escape in a string");
    }
  }
  scalar() {
    const m = SCALAR.exec(this.raw.slice(this.i, this.i + SCALAR_LOOKAHEAD));
    if (!m) this.bad();
    this.i += m[0].length;
  }
  expect(c) {
    this.ws();
    if (this.raw[this.i] !== c) this.bad(this.atEnd() ? void 0 : `expected ${JSON.stringify(c)}, found ${JSON.stringify(this.raw[this.i])}`);
    this.i++;
  }
  ws() {
    while (this.i < this.raw.length && WHITESPACE.includes(this.raw[this.i])) this.i++;
  }
  atEnd() {
    return this.i >= this.raw.length;
  }
  bad(what) {
    throw new JsonSyntax(this.i, what ?? (this.atEnd() ? "the file ends too early (cut off?)" : `unexpected ${JSON.stringify(this.raw[this.i])}`));
  }
};

// src/core/format/podcast/guards.ts
var isObj2 = (v) => !!v && typeof v === "object" && !Array.isArray(v);
var num = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
var TIME_SLACK_S = 0.05;

// src/core/format/podcast/format.ts
var segmentName = (s, i) => typeof s.id === "string" && s.id ? s.id : `#${i + 1}`;
function segProblem(s, i, code, what, sub = []) {
  const name = segmentName(s, i);
  return { level: "warning", code, message: `segment ${name}: ${what}`, path: ["segments", i, ...sub], segment: name };
}
function stepProblem(s, i, n, code, what, sub = []) {
  return { ...segProblem(s, i, code, what, sub), message: `Step ${n}: ${what}` };
}
var beatsItHas = (n) => `it has ${n || "none"}`;
function startOf(s) {
  const t = num(s.start);
  return t !== void 0 && t >= 0 ? t : void 0;
}
function sentenceBound(s, start, next, duration) {
  const end = num(s.end) ?? next ?? num(duration);
  return end === void 0 ? void 0 : Math.max(end, start);
}
var segmentEnd = (s, start, next, duration) => sentenceBound(s, start, next, duration) ?? start;
var notSentences = (v) => ({
  what: Array.isArray(v) ? "sentences is empty" : "sentences is not a list of { start, text }",
  sub: ["sentences"]
});
function sentencesProblem(v, start, end) {
  if (!Array.isArray(v) || !v.length) return notSentences(v);
  let prev;
  for (const [k, t] of v.entries()) {
    const item = `sentences: item ${k + 1}`;
    if (!isObj2(t) || typeof t.text !== "string" || !t.text.trim()) {
      return { what: `${item} is not { start, text } with a text`, sub: ["sentences", k] };
    }
    const at = num(t.start);
    const sub = ["sentences", k, "start"];
    if (at === void 0) return { what: `${item} has no start time in seconds`, sub };
    if (prev !== void 0 && at < prev - TIME_SLACK_S) {
      return { what: `${item} starts at ${clockMs(at)}, before item ${k} (${clockMs(prev)})`, sub };
    }
    if (at < start - TIME_SLACK_S || end !== void 0 && at > end + TIME_SLACK_S) {
      const seg = end !== void 0 ? `outside the segment (${clockMs(start)}–${clockMs(end)})` : `before the segment starts (${clockMs(start)})`;
      return { what: `${item} starts at ${clockMs(at)}, ${seg}`, sub };
    }
    prev = at;
  }
  return void 0;
}

// src/core/format/podcast/journeyShape.ts
var stepIndex = (journey) => new Map(journey.steps.map((s, i) => [s.id, { ...s, n: i + 1 }]));
function stepAt(s, steps) {
  const at = s.at;
  if (!isObj2(at) || typeof at.step !== "string") return void 0;
  const step = steps.get(at.step);
  return step && { step, beat: at.beat };
}
var isBeatNumber = (b) => typeof b === "number" && Number.isInteger(b) && b >= 1;
function segmentFile(s, steps) {
  const at = stepAt(s, steps);
  if (!at) return "";
  const beatFile = s.cue !== "map" && isBeatNumber(at.beat) ? at.step.beatFiles?.[at.beat - 1] : void 0;
  return beatFile ?? at.step.file ?? "";
}
function hasBadBeat(s, steps) {
  const at = stepAt(s, steps);
  if (!at || at.beat === void 0 || s.cue === "map") return false;
  return !(isBeatNumber(at.beat) && at.beat <= at.step.beats);
}

// src/core/format/podcast/timeline.ts
function chaptersOf(segments, duration) {
  const out = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    if (last && last.step === s.step) continue;
    if (last) last.end = s.start;
    out.push({ start: out.length ? s.start : 0, end: duration, step: s.step });
  }
  return out;
}

// src/core/format/podcast/marks.ts
var round2 = (t) => Math.round(t * 100) / 100;
function unusable(m, seg) {
  if (!isObj2(m)) return { what: "not an object { phrase, at, lines }", sub: [] };
  if (typeof m.phrase !== "string" || !m.phrase.trim()) return { what: "no phrase", sub: m.phrase === void 0 ? [] : ["phrase"] };
  const at = num(m.at);
  if (at === void 0) {
    return m.at === void 0 ? { what: `no "at" (seconds from the segment's start)`, sub: [] } : { what: `at ${JSON.stringify(m.at)} is not a time in seconds`, sub: ["at"] };
  }
  const len2 = Math.max(0, seg.end - seg.start);
  if (at < -TIME_SLACK_S || at > len2 + TIME_SLACK_S) {
    const where = `outside the segment (${clockMs(seg.start)}–${clockMs(seg.end)})`;
    return { what: `at ${clockMs(seg.start + at)} (${round2(at)} s) is ${where}`, sub: ["at"] };
  }
  const shape = markShapeProblem(m);
  if (shape) return shape;
  if (m.file === void 0 && seg.onMap) return { what: 'a mark in a segment on the map ("at": null) needs its own "file"', sub: [] };
  return void 0;
}
function marksProblems(v, text, start, end, onMap) {
  if (v === void 0) return [];
  if (!Array.isArray(v)) return [{ what: "marks is not a list of { phrase, at, lines }; ignored", sub: ["marks"], drop: true }];
  const seg = { text, start, end, onMap };
  const out = [];
  let prev;
  let from = 0;
  for (const [k, m] of v.entries()) {
    const bad = unusable(m, seg);
    if (bad) {
      out.push({ k, what: `mark ${k + 1}: ${bad.what}; ignored`, sub: ["marks", k, ...bad.sub], drop: true });
      continue;
    }
    const { phrase, at } = m;
    if (prev && at < prev.at - TIME_SLACK_S) {
      const what = `mark ${k + 1} lights at ${round2(at)} s, before mark ${k} (${round2(prev.at)} s): marks light in the order they are said`;
      out.push({ k, what, sub: ["marks", k, "at"], drop: false });
    }
    const pos = phrase === prev?.phrase ? prev.pos : text.indexOf(phrase, from);
    if (pos < 0) {
      const what = `mark ${k + 1}: the phrase ${JSON.stringify(phrase)} isn't in the text${from ? " after the phrase before it" : ""}`;
      out.push({ k, what, sub: ["marks", k, "phrase"], drop: false });
    } else from = pos + phrase.length;
    prev = { at, phrase, pos };
  }
  return out;
}
function marksOf(v, text, start, end, onMap) {
  if (!Array.isArray(v) || !v.length) return void 0;
  const drop = new Set(marksProblems(v, text, start, end, onMap).filter((p) => p.drop).map((p) => p.k));
  const out = [];
  for (const [k, m] of v.entries()) {
    if (drop.has(k)) continue;
    const x = m;
    out.push({ phrase: x.phrase, at: x.at, ...codeMarkOf(x) });
  }
  out.sort((a, b) => a.at - b.at);
  return out.length ? out : void 0;
}

// src/core/format/podcast/resolve.ts
function timedSegments(written) {
  const out = [];
  for (const x of written) {
    const start = startOf(x.s);
    if (start !== void 0) out.push({ ...x, start });
  }
  return out.sort((a, b) => a.start - b.start || a.i - b.i);
}
var noStart = (s) => `${s.start === void 0 ? "no start time" : `start ${JSON.stringify(s.start)} is not a time in seconds`}; skipped`;
function resolveEpisode(p, journey) {
  const problems = [];
  const indexed = p.segments.map((s, i) => ({ s, i }));
  for (const { s, i } of indexed) {
    if (startOf(s) === void 0) problems.push(segProblem(s, i, "start", noStart(s), ["start"]));
  }
  const timed = timedSegments(indexed);
  const steps = stepIndex(journey);
  let prev = { step: 0 };
  const segments = timed.map((x, k) => {
    const view = viewOf(x, steps, prev, problems);
    prev = view;
    return segmentOf(x, view, timed[k + 1]?.start, p.duration, journey);
  });
  const last = segments[segments.length - 1];
  const duration = Math.max(num(p.duration) ?? 0, last ? last.end : 0);
  return { title: p.title, duration, segments, chapters: chaptersOf(segments, duration), problems };
}
function segmentOf(x, view, next, duration, journey) {
  const { s, i, start } = x;
  const stepId = view.step ? journey.steps[view.step - 1]?.id : void 0;
  const seg = {
    id: typeof s.id === "string" ? s.id : `#${i + 1}`,
    start,
    end: segmentEnd(s, start, next, duration),
    text: typeof s.text === "string" ? s.text : "",
    speaker: typeof s.speaker === "string" ? s.speaker : "",
    ...view,
    ...stepId ? { stepId } : {}
  };
  if (s.sentences !== void 0 && !sentencesProblem(s.sentences, start, sentenceBound(s, start, next, duration))) {
    seg.sentences = s.sentences.map((t) => ({ start: t.start, text: t.text }));
  }
  const marks = marksOf(s.marks, seg.text, seg.start, seg.end, s.at === null);
  if (marks) seg.marks = marks;
  return seg;
}
function viewOf({ s, i }, steps, prev, problems) {
  if (s.at === null) return { step: 0 };
  if (!isObj2(s.at) || typeof s.at.step !== "string") {
    const what = `"at" is ${s.at === void 0 ? "missing" : "not null or { step, beat }"}; it keeps the view before it`;
    problems.push(segProblem(s, i, "at", what, s.at === void 0 ? [] : ["at"]));
    return prev;
  }
  const at = stepAt(s, steps);
  if (!at) {
    problems.push(segProblem(s, i, "step", `no step "${s.at.step}" in the journey; it keeps the view before it`, ["at", "step"]));
    return prev;
  }
  const { n, beats } = at.step;
  const b = at.beat;
  if (b === void 0 || s.cue === "map") return { step: n };
  if (typeof b === "string") {
    problems.push(stepProblem(s, i, n, "beat", `beat must be a number, got the string ${JSON.stringify(b)}; showing the whole step`, ["at", "beat"]));
    return { step: n };
  }
  if (typeof b !== "number" || !Number.isInteger(b) || b < 1 || b > beats) {
    problems.push(stepProblem(s, i, n, "beat", `no beat ${JSON.stringify(b)} (${beatsItHas(beats)}); showing the whole step`, ["at", "beat"]));
    return { step: n };
  }
  return { step: n, beat: b - 1 };
}

// src/core/format/podcast/validate.ts
var problem = (level) => (code, message, path3 = []) => ({ level, code, message, path: path3 });
var error = problem("error");
var warning = problem("warning");
var info = problem("info");
var DURATION_SLACK_S = 1;
var DURATION_SLACK_SHARE = 0.01;
var CUT_OFF_S = 2;
var CUES = /* @__PURE__ */ new Set(["map", "open", "beat"]);
var SAY = {
  noVersion: () => `no "version" (this player reads version ${VERSIONS.podcast})`,
  otherVersion: (v) => `version ${JSON.stringify(v)}: this player reads version ${VERSIONS.podcast}`,
  noAudio: (v) => v === void 0 ? 'no "audio": the audio file, relative to this file' : '"audio" is not a file name',
  audioMissing: (audio) => `the audio file ${audio} isn't there`,
  audioEmpty: (audio) => `the audio file ${audio} is empty`,
  segmentsNotList: (v) => `"segments" is not a list (it is ${typeof v === "object" ? "an object" : `a ${typeof v}`})`,
  notASegment: (i) => `segment #${i + 1} is not an object; skipped`,
  otherJourney: (id, next) => `written for journey "${id}", but it is next to "${next}": it plays with the journey next to it`,
  badDuration: (v) => `"duration" ${JSON.stringify(v)} is not a length in seconds; ignored`,
  duplicateId: (id, first, again) => `the id "${id}" is used twice (${first} and ${again})`,
  badCue: (cue) => `cue ${JSON.stringify(cue)} is not map, open or beat; ignored`,
  badEnd: (end) => `end ${JSON.stringify(end)} is not a time in seconds; it ends where the next one starts`,
  endBeforeStart: (end, start) => `ends at ${clockMs(end)}, before it starts (${clockMs(start)})`,
  outOfOrder: (start, above) => `starts at ${clockMs(start)}, before segment ${above.name} above it (${clockMs(above.start)}): segments play in time order, not in file order`,
  pastDuration: (start, end, duration) => `${end !== void 0 ? `ends at ${clockMs(end)}` : `starts at ${clockMs(start)}`}, after the episode's "duration" (${clockMs(duration)})`,
  overlap: (start, before, end) => `starts at ${clockMs(start)}, before segment ${before} ends (${clockMs(end)}): the later one wins from its start`,
  sentences: (what) => `${what}; the caption is estimated from the text instead`,
  narrationOrder: (late, before, more) => `narrates step ${late.k + 1} ("${late.step}") after step ${before.k + 1} ("${before.step}"): the journey's steps were reordered since it was recorded; re-record it, or put the steps back` + (more > 1 ? ` (${more} steps out of order)` : ""),
  missingStep: (step, names, from, to) => {
    const which = names.length === 1 ? `segment ${names[0]}` : `segments ${names[0]}–${names[names.length - 1]}`;
    const keep = names.length === 1 ? "it keeps the view before it" : "they keep the view before them";
    return `step "${step}" isn't in the journey (${which}, ${clockMs(from)}–${clockMs(to)}): ${keep}`;
  },
  recordedFor: (steps) => `Code changed since recording: ${steps.length === 1 ? "step" : "steps"} ${steps.join(", ")}`,
  cutOff: (audioLen, episodeLen, past) => `The audio is ${clock(audioLen)} long but the episode is ${clock(episodeLen)}: the file looks cut off (${past} ${past === 1 ? "part starts" : "parts start"} after its end)`,
  durationVsAudio: (duration, audioLen) => `"duration" says ${clockMs(duration)} but the audio is ${clockMs(audioLen)} long`,
  pastAudio: (end, audioLen) => `ends at ${clockMs(end)}, after the audio's end (${clockMs(audioLen)})`
};
function audioPathProblem(audio) {
  const a = audio.replace(/\\/g, "/");
  if (/^[a-z][a-z0-9+.-]*:/i.test(a) && !/^[a-z]:\//i.test(a)) return `audio must be a file in the journeys folder, not a URL (got ${audio})`;
  if (a.startsWith("/") || /^[a-z]:\//i.test(a)) return `audio must be in the journeys folder, as a path relative to the podcast file (got ${audio})`;
  let depth = 0;
  for (const part2 of a.split("/")) {
    if (part2 === "..") depth--;
    else if (part2 && part2 !== ".") depth++;
    if (depth < 0) return `audio must be in the journeys folder (got ${audio})`;
  }
  return void 0;
}
function validatePodcast(raw, ctx = {}) {
  return validateRead(readPodcastText(raw), ctx);
}
function readPodcastText(raw) {
  const fatal = (p) => ({ written: [], errors: [p], problems: [] });
  let d;
  try {
    d = JSON.parse(raw);
  } catch (e) {
    if (!raw.trim()) return fatal(error("json", "the file is empty"));
    return fatal(error("json", `not valid JSON: ${jsonSyntaxError(raw) ?? e.message}`));
  }
  if (!isObj2(d)) return fatal(error("object", "not a podcast: the file is not a JSON object"));
  const journey = journeyOf(d.journey);
  if (d.version !== VERSIONS.podcast) {
    const p = d.version === void 0 ? error("version", SAY.noVersion()) : error("version", SAY.otherVersion(d.version), ["version"]);
    return { ...fatal(p), journey };
  }
  const audio = typeof d.audio === "string" ? d.audio.trim() : "";
  const segs = Array.isArray(d.segments) ? d.segments : [];
  const written = [];
  const problems = [];
  for (const [i, s] of segs.entries()) {
    if (isObj2(s)) written.push({ s, i });
    else problems.push(warning("segment", SAY.notASegment(i), ["segments", i]));
  }
  const errors = [...audioNameErrors(d.audio, audio), ...segmentsErrors(d.segments)];
  if (written.length && !written.some((x) => startOf(x.s) !== void 0)) {
    errors.push(error("segments", "no segment has a start time: nothing to play", ["segments"]));
  }
  const podcast = {
    version: VERSIONS.podcast,
    title: typeof d.title === "string" ? d.title : "",
    journey,
    audio,
    duration: num(d.duration),
    // The segments that are objects; `written` keeps their index in the file, so that problems point at it.
    segments: written.map((x) => x.s)
  };
  return { podcast, journey, written, writtenDuration: d.duration, errors, problems };
}
function journeyOf(v) {
  const j = isObj2(v) ? v : {};
  const str3 = (x) => typeof x === "string" ? x : void 0;
  return { id: str3(j.id) ?? "", file: str3(j.file), commit: str3(j.commit) };
}
function audioNameErrors(v, audio) {
  if (audio) return [];
  return [error("audio", SAY.noAudio(v), v === void 0 ? [] : ["audio"])];
}
function segmentsErrors(v) {
  if (v === void 0) return [error("segments", 'no "segments": the parts of the episode')];
  if (!Array.isArray(v)) return [error("segments", SAY.segmentsNotList(v), ["segments"])];
  if (!v.length) return [error("segments", '"segments" is empty: the episode has no parts', ["segments"])];
  return [];
}
function audioFileErrors(audio, ctx) {
  if (!audio) return [];
  const where = audioPathProblem(audio);
  if (where) return [error("audio-outside", where, ["audio"])];
  if (ctx.audio && !ctx.audio.exists) return [error("audio-missing", SAY.audioMissing(audio), ["audio"])];
  if (ctx.audio && ctx.audio.size === 0) return [error("audio-empty", SAY.audioEmpty(audio), ["audio"])];
  return [];
}
var RULES = [
  otherJourney,
  badDuration,
  segmentFieldProblems,
  overlapProblems,
  sentenceProblems,
  markShapeProblems,
  narrationOrder,
  markCodeProblems,
  linkProblems,
  recordedFor,
  audioLengthProblems
];
function validateRead(read, ctx = {}) {
  const { podcast, written } = read;
  if (!podcast) return { problems: [...read.errors], playable: false };
  const errors = [...audioFileErrors(podcast.audio, ctx), ...read.errors];
  const episode = ctx.journey ? episodeOf(podcast, written, ctx.journey) : void 0;
  const checked = { read, podcast, written, timed: timedSegments(written), ctx, episode };
  const problems = [...read.problems, ...RULES.flatMap((rule) => rule(checked))];
  problems.sort((a, b) => order(a.path) - order(b.path));
  const playable = !errors.length;
  return { podcast, episode: playable ? episode : void 0, problems: [...errors, ...problems], playable };
}
var order = (path3) => path3[0] === "segments" && typeof path3[1] === "number" ? path3[1] + 1 : 0;
function episodeOf(podcast, written, journey) {
  const ep = resolveEpisode(podcast, journey);
  const inFile = ep.problems.map((p) => {
    const k = p.path[1];
    return typeof k === "number" ? { ...p, path: ["segments", written[k]?.i ?? k, ...p.path.slice(2)] } : p;
  });
  return { ...ep, problems: missingStepsOnce(inFile.filter((p) => p.code !== "start"), written) };
}
function otherJourney({ podcast, ctx }) {
  const id = podcast.journey.id;
  if (!id || !ctx.journey || id === ctx.journey.id) return [];
  return [warning("journey", SAY.otherJourney(id, ctx.journey.id), ["journey", "id"])];
}
function badDuration({ read }) {
  const d = read.writtenDuration;
  return d !== void 0 && !((num(d) ?? 0) > 0) ? [warning("duration", SAY.badDuration(d), ["duration"])] : [];
}
function usableEnd(s, start) {
  const end = num(s.end);
  return end !== void 0 && end >= start - TIME_SLACK_S ? end : void 0;
}
function segmentFieldProblems({ written, podcast }) {
  const out = [];
  const firstWithId = /* @__PURE__ */ new Map();
  let above;
  const duration = podcast.duration;
  for (const { s, i } of written) {
    if (typeof s.id === "string" && s.id) {
      const first = firstWithId.get(s.id);
      if (first) out.push(segProblem(s, i, "id", SAY.duplicateId(s.id, placeOf(first), placeOf({ i, start: s.start })), ["id"]));
      else firstWithId.set(s.id, { i, start: s.start });
    }
    if (s.cue !== void 0 && !(typeof s.cue === "string" && CUES.has(s.cue))) out.push(segProblem(s, i, "cue", SAY.badCue(s.cue), ["cue"]));
    const start = startOf(s);
    if (start === void 0) {
      out.push(segProblem(s, i, "start", noStart(s), s.start === void 0 ? [] : ["start"]));
      continue;
    }
    const end = usableEnd(s, start);
    if (s.end !== void 0 && num(s.end) === void 0) out.push(segProblem(s, i, "end", SAY.badEnd(s.end), ["end"]));
    if (num(s.end) !== void 0 && end === void 0) out.push(segProblem(s, i, "end-before-start", SAY.endBeforeStart(num(s.end), start), ["end"]));
    if (above && start < above.start - TIME_SLACK_S) out.push(segProblem(s, i, "order", SAY.outOfOrder(start, above), ["start"]));
    if (duration !== void 0 && duration > 0 && (end ?? start) > duration + TIME_SLACK_S) {
      out.push(segProblem(s, i, "past-duration", SAY.pastDuration(start, end, duration), [end !== void 0 ? "end" : "start"]));
    }
    above = { name: segmentName(s, i), start };
  }
  return out;
}
var placeOf = (x) => {
  const start = startOf({ start: x.start });
  return start !== void 0 ? clockMs(start) : `#${x.i + 1}`;
};
function overlapProblems({ timed }) {
  const out = [];
  for (const [k, b] of timed.entries()) {
    const a = timed[k - 1];
    const aEnd = a && usableEnd(a.s, a.start);
    if (aEnd !== void 0 && b.start < aEnd - TIME_SLACK_S) {
      out.push(segProblem(b.s, b.i, "overlap", SAY.overlap(b.start, segmentName(a.s, a.i), aEnd), ["start"]));
    }
  }
  return out;
}
function sentenceProblems({ timed, podcast }) {
  const out = [];
  for (const [k, x] of timed.entries()) {
    if (x.s.sentences === void 0) continue;
    const bad = sentencesProblem(x.s.sentences, x.start, sentenceBound(x.s, x.start, timed[k + 1]?.start, podcast.duration));
    if (bad) out.push(segProblem(x.s, x.i, "sentences", SAY.sentences(bad.what), bad.sub));
  }
  return out;
}
function marksIn(timed, k, duration) {
  const x = timed[k];
  const end = segmentEnd(x.s, x.start, timed[k + 1]?.start, duration);
  const text = typeof x.s.text === "string" ? x.s.text : "";
  return marksProblems(x.s.marks, text, x.start, end, x.s.at === null);
}
function markShapeProblems({ timed, podcast }) {
  const out = [];
  for (const [k, x] of timed.entries()) {
    if (x.s.marks === void 0) continue;
    for (const p of marksIn(timed, k, podcast.duration)) out.push(segProblem(x.s, x.i, "mark", p.what, p.sub));
  }
  return out;
}
function narrationOrder({ timed, ctx }) {
  if (!ctx.journey) return [];
  const index = new Map(ctx.journey.steps.map((s, k) => [s.id, k]));
  const firsts = [];
  for (const { s, i } of timed) {
    const step = isObj2(s.at) && typeof s.at.step === "string" ? s.at.step : void 0;
    const k = step === void 0 ? void 0 : index.get(step);
    if (step === void 0 || k === void 0 || firsts.some((f2) => f2.step === step)) continue;
    firsts.push({ step, k, s, i });
  }
  const late = firsts.filter((f2, n) => n > 0 && f2.k < firsts[n - 1].k);
  if (!late.length) return [];
  const f = late[0];
  const before = firsts[firsts.indexOf(f) - 1];
  return [segProblem(f.s, f.i, "narration-order", SAY.narrationOrder(f, before, late.length), ["at", "step"])];
}
function markCodeProblems({ timed, ctx, podcast }) {
  const { journey, files } = ctx;
  if (!journey || !files) return [];
  const steps = stepIndex(journey);
  const lines = /* @__PURE__ */ new Map();
  const linesOf = (f) => {
    if (!lines.has(f)) {
      const t = files(f);
      lines.set(f, typeof t === "string" ? t.split(/\r?\n/) : t);
    }
    return lines.get(f);
  };
  const out = [];
  for (const [k, x] of timed.entries()) {
    if (!Array.isArray(x.s.marks)) continue;
    const dropped = new Set(marksIn(timed, k, podcast.duration).filter((p) => p.drop).map((p) => p.k));
    const own = segmentFile(x.s, steps);
    const badBeat = hasBadBeat(x.s, steps);
    for (const [n, m] of x.s.marks.entries()) {
      if (dropped.has(n) || badBeat && typeof m.file !== "string") continue;
      const file = typeof m.file === "string" ? m.file : own;
      const doc = file ? linesOf(file) : void 0;
      if (doc === void 0) continue;
      const p = markCodeProblem({ doc, file, mark: codeMarkOf(m), onMissing: "lines" });
      if (p) out.push(segProblem(x.s, x.i, "mark", `mark ${n + 1}: ${p.what}`, ["marks", n, p.sub]));
    }
  }
  return out;
}
function linkProblems({ episode }) {
  return episode?.problems ?? [];
}
function recordedFor({ podcast, ctx }) {
  if (!podcast.journey.commit || !ctx.changed?.length) return [];
  return [info("recorded-for", SAY.recordedFor(ctx.changed), ["journey", "commit"])];
}
function audioLengthProblems({ written, podcast, ctx }) {
  const audioLen = ctx.audioDuration;
  if (audioLen === void 0 || !(audioLen > 0)) return [];
  const duration = podcast.duration;
  const ends = written.map(({ s }) => num(s.end) ?? num(s.start)).filter((x) => x !== void 0);
  const episodeLen = Math.max(duration ?? 0, ...ends, 0);
  const slack = Math.max(DURATION_SLACK_S, audioLen * DURATION_SLACK_SHARE);
  const past = written.filter(({ s }) => (num(s.start) ?? -1) >= audioLen);
  if (episodeLen > audioLen + Math.max(CUT_OFF_S, slack) && past.length) {
    return [warning("audio-short", SAY.cutOff(audioLen, episodeLen, past.length), ["audio"])];
  }
  const out = [];
  if (duration !== void 0 && Math.abs(duration - audioLen) > slack) {
    out.push(warning("duration", SAY.durationVsAudio(duration, audioLen), ["duration"]));
  }
  for (const { s, i } of written) {
    const end = num(s.end);
    if (end !== void 0 && end > audioLen + slack) out.push(segProblem(s, i, "past-audio", SAY.pastAudio(end, audioLen), ["end"]));
  }
  return out;
}
function missingStepsOnce(problems, written) {
  const byIndex = new Map(written.map((x) => [x.i, x]));
  const stepOf = /* @__PURE__ */ new Map();
  const segmentsOf = /* @__PURE__ */ new Map();
  for (const p of problems) {
    const w = p.code === "step" ? byIndex.get(p.path[1]) : void 0;
    const at = w?.s.at;
    if (!w || !isObj2(at) || typeof at.step !== "string") continue;
    stepOf.set(p, at.step);
    segmentsOf.set(at.step, [...segmentsOf.get(at.step) ?? [], w]);
  }
  return problems.flatMap((p) => {
    const step = stepOf.get(p);
    if (step === void 0) return [p];
    const segs = segmentsOf.get(step);
    return segs[0].i === p.path[1] ? [missingStep(step, segs)] : [];
  });
}
function missingStep(step, segs) {
  const names = segs.map((x) => segmentName(x.s, x.i));
  const first = segs[0], last = segs[segs.length - 1];
  const from = num(first.s.start) ?? 0;
  const to = num(last.s.end) ?? num(last.s.start) ?? from;
  return {
    level: "warning",
    code: "step",
    path: ["segments", first.i, "at", "step"],
    segment: names[0],
    segments: names,
    message: SAY.missingStep(step, names, from, to)
  };
}

// cli/journey/podcast.ts
function repoText(repo, file) {
  const root = path2.resolve(repo);
  const p = path2.resolve(root, file);
  if (!p.startsWith(root + path2.sep)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(fs2.readFileSync(p));
  } catch {
    return null;
  }
}
function checkPodcast(r) {
  const { repo, files: given } = r;
  const files = typeof repo === "string" ? (f) => repoText(repo, f) : given ? (f) => f in given ? given[f] : void 0 : void 0;
  const ctx = { journey: r.journey ?? void 0, audio: r.audio ?? void 0, audioDuration: r.audioDuration ?? void 0, changed: r.changed ?? void 0, files };
  return validatePodcast(r.raw, ctx).problems.map((p) => ({ level: p.level, code: p.code, message: p.message, segment: p.segment ?? null }));
}

// cli/journey/issues.ts
function collector(prefix = "") {
  const issues = [];
  const add = (level) => (text) => {
    issues.push({ level, text: prefix + text });
  };
  return { issues, problem: add("problem"), refuse: add("refuse"), warning: add("warning") };
}

// src/core/format/schema/journey.schema.json
var journey_schema_default = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "journey.schema.json",
  title: "Code journey (format v2)",
  description: "A code journey: a layered map of boxes and arrows plus a storyline of steps through the real code (docs/journey-format.md).",
  $comment: "The shape of a journey file: what src/core/format/journeyModel.ts readJourney reads without leaving anything out. The writing rules (wording of titles and leads, label lengths, 6-14 steps, at most 7 boxes on a level, anchors on every step) are journey.py check's and the map's problems, not the format's, and are not here. A step's scene is described as media/journey-scene.js draws it and journey.py scene_issues enforces it: unknown keys in a scene, an actor or a beat, more than 4 actors and fewer than 3 beats are refused there when a scene is written, so they are refused here. Not expressible with these keywords (journey.py check still enforces them): unique ids; parents that exist; edges between existing boxes; range and link ends not before their start; scene ids unique; wires, packets, focus, set and click naming actors of the scene; a beat's set keys allowed for the actor's type (documented in $defs setState.*); label and sub fitting their box; gauge max above 0 (written as minimum 0).",
  type: "object",
  properties: {
    version: { description: "The format version: 2.", const: 2 },
    id: { description: "The journey's id (its file name).", type: "string" },
    question: { description: "The question it answers, one line.", type: "string" },
    title: { description: "A short topic name (a noun phrase, not a question).", type: "string" },
    summary: { description: "Plain words, at most 2 sentences, no code in the first.", type: "string" },
    model: { description: "Who wrote it (the model).", type: "string" },
    commit: { description: "The commit the journey was written at.", type: "string" },
    createdAt: { description: "When it was written (ISO 8601).", type: "string" },
    start: {
      description: 'The journey to start with: marked "Start here" in the Journeys list.',
      type: "boolean"
    },
    nodes: {
      description: "The map's boxes (systems hold modules, modules hold functions).",
      type: "array",
      items: { $ref: "#/$defs/node" },
      minItems: 1
    },
    edges: { description: "The map's arrows.", type: "array", items: { $ref: "#/$defs/edge" } },
    steps: {
      description: "The storyline, in order (step number = position).",
      type: "array",
      items: { $ref: "#/$defs/step" }
    }
  },
  required: ["version", "nodes", "steps"],
  $defs: {
    anchor: {
      description: "Where a range is, to find it again: full text, or compact (its own `v`: 3; not a file version).",
      anyOf: [{ $ref: "#/$defs/anchorText" }, { $ref: "#/$defs/anchorCompact" }]
    },
    anchorText: {
      description: "A full-text anchor (older journeys): the whole block and the lines around it.",
      type: "object",
      properties: {
        text: { description: "The lines of the range, as they were.", type: "string" },
        before: { description: "The text just above the range.", type: "string" },
        after: { description: "The text just below the range.", type: "string" }
      },
      required: ["text", "before", "after"]
    },
    anchorCompact: {
      description: "A compact anchor (`v`: 3): the first and last lines, the length and a hash of the range.",
      type: "object",
      properties: {
        v: { description: "The anchor format: 3.", const: 3 },
        head: {
          description: "The first (up to 3) non-blank lines of the range.",
          type: "string",
          pattern: "\\S"
        },
        tail: { description: "The last (up to 2) non-blank lines of the range.", type: "string" },
        lines: { description: "How many lines the range has.", type: "integer", minimum: 1 },
        hash: {
          description: "sha1 of the normalized non-blank lines of the range, first 12 hex digits.",
          type: "string"
        },
        before: {
          description: "The nearest non-blank line above the range (empty at the top of the file).",
          type: "string"
        },
        after: {
          description: "The nearest non-blank line below the range (empty at the end of the file).",
          type: "string"
        }
      },
      required: ["v", "head", "tail", "lines", "hash", "before", "after"]
    },
    node: {
      description: "A box on the map.",
      type: "object",
      properties: {
        id: { description: "The box's id, unique in the journey.", type: "string", minLength: 1 },
        kind: {
          description: "What the box is: system, module, external (third-party), store (the app's own record, queue or table) or function.",
          enum: ["system", "module", "external", "store", "function"]
        },
        label: { description: "The name shown in the box.", type: "string" },
        blurb: {
          description: "The short text shown in the box (required on every kind but function).",
          type: "string"
        },
        summary: { description: "A longer description (the box's tooltip).", type: "string" },
        path: { description: "Where it lives: a folder or file, relative to the repository.", type: "string" },
        parent: { description: "The id of the box it sits in (a system or a module).", type: "string" },
        lane: { description: "Read but ignored by the map layout.", enum: ["main", "side"] },
        at: {
          description: "The code of a function box: a file and its lines.",
          type: "object",
          properties: {
            file: { description: "The file, relative to the repository.", type: "string" },
            start: { description: "The first line (1-based).", type: "integer", minimum: 1 },
            end: { description: "The last line (1-based, inclusive).", type: "integer", minimum: 1 },
            anchor: { $ref: "#/$defs/anchor", description: "How to find the lines again after the code moved." }
          },
          required: ["file", "start", "end", "anchor"]
        }
      },
      required: ["id"]
    },
    edge: {
      description: "An arrow between two boxes.",
      type: "object",
      properties: {
        from: { description: "The id of the box it starts at (never a store).", type: "string" },
        to: { description: "The id of the box it points at.", type: "string" },
        label: {
          description: 'What flows or who acts, shown on the arrow: not a question, not a bare "calls"/"uses"/"invokes".',
          type: "string"
        },
        detail: { description: "The full sentence (the label's tooltip).", type: "string" },
        async: { description: "The hop is asynchronous (drawn dashed).", type: "boolean" }
      },
      required: ["from", "to"]
    },
    step: {
      description: "A step of the storyline: one fact, anchored on the lines that do it.",
      type: "object",
      properties: {
        id: {
          description: "A short id, unique in the journey, that never changes when steps move.",
          type: "string"
        },
        title: {
          description: "The fact, one line: a sentence of at least 4 words, not a heading, topic or question.",
          type: "string"
        },
        node: {
          description: "The id of the box it happens in (a function, external or store box).",
          type: "string"
        },
        file: { description: "The file, relative to the repository.", type: "string", pattern: "\\S" },
        range: {
          description: "The lines that matter.",
          type: "object",
          properties: {
            start: { description: "The first line (1-based).", type: "integer", minimum: 1 },
            end: { description: "The last line (1-based, inclusive).", type: "integer", minimum: 1 }
          },
          required: ["start"]
        },
        anchor: { $ref: "#/$defs/anchor", description: "How to find the lines again after the code moved." },
        lead: {
          description: 'What happens here and why it matters, at most 40 words; no "step N".',
          type: "string"
        },
        details: { description: 'Markdown with the rest (folded by default); no "step N".', type: "string" },
        refs: {
          description: "Pointers elsewhere (at most 3).",
          type: "array",
          items: {
            description: "A reference: a repo-relative path:line, or a sentence holding one.",
            type: "string"
          },
          maxItems: 3
        },
        links: {
          description: "Code links of the lead and details.",
          type: "array",
          items: { $ref: "#/$defs/link" }
        },
        values: {
          description: "Value hints shown while the step is open.",
          type: "array",
          items: { $ref: "#/$defs/value" }
        },
        marks: {
          $ref: "marks.schema.json#/$defs/marks",
          description: "The parts of the code the step's text names (file default: the step's)."
        },
        scene: { $ref: "#/$defs/scene", description: "The step's animation." }
      },
      required: ["node", "file", "range"]
    },
    link: {
      description: "A code link: words of the lead or details that open these lines.",
      type: "object",
      properties: {
        phrase: {
          description: "The words of the lead or details, exactly as written.",
          type: "string",
          pattern: "\\S"
        },
        file: { description: "The file, relative to the repository.", type: "string" },
        start: { description: "The first line (1-based).", type: "integer", minimum: 1 },
        end: { description: "The last line (1-based, inclusive).", type: "integer", minimum: 1 },
        text: { description: "The trimmed text of the first line (to find it again).", type: "string" }
      },
      required: ["phrase", "file", "start"]
    },
    value: {
      description: "A value hint: what a variable holds in the example run, shown above its line.",
      type: "object",
      properties: {
        name: { description: "The variable.", type: "string", pattern: "\\S" },
        value: { description: "What it holds, on one line.", type: "string" },
        note: { description: "A few words on what the value is.", type: "string" },
        file: { description: "The file, relative to the repository.", type: "string" },
        line: { description: "The line it is on (1-based).", type: "integer", minimum: 1 },
        text: { description: "The trimmed text of that line (to find it again).", type: "string" }
      },
      required: ["name", "value", "file", "line"]
    },
    scene: {
      description: "The step's animation: actors, the wires between them, and the beats.",
      type: "object",
      properties: {
        actors: {
          description: "The boxes on stage (1-4).",
          type: "array",
          items: { $ref: "#/$defs/actor" },
          minItems: 1,
          maxItems: 4
        },
        wires: {
          description: "Lines requests travel on.",
          type: "array",
          items: {
            description: "A wire: [fromId, toId].",
            type: "array",
            prefixItems: [
              { description: "One actor's id.", type: "string" },
              { description: "The other actor's id.", type: "string" }
            ],
            minItems: 2,
            maxItems: 2
          }
        },
        beats: {
          description: "The beats, played in order (3-7).",
          type: "array",
          items: { $ref: "#/$defs/beat" },
          minItems: 3,
          maxItems: 7
        }
      },
      required: ["actors", "beats"],
      additionalProperties: false
    },
    actor: {
      description: "A box on the scene's stage; its type says what it draws and which keys it reads.",
      oneOf: [
        { $ref: "#/$defs/actor.service" },
        { $ref: "#/$defs/actor.table" },
        { $ref: "#/$defs/actor.cluster" },
        { $ref: "#/$defs/actor.app" },
        { $ref: "#/$defs/actor.browser" },
        { $ref: "#/$defs/actor.terminal" },
        { $ref: "#/$defs/actor.file" },
        { $ref: "#/$defs/actor.chat" },
        { $ref: "#/$defs/actor.queue" },
        { $ref: "#/$defs/actor.gauge" }
      ]
    },
    "actor.service": {
      description: "A service actor: a function at work and the checks it ticks off.",
      type: "object",
      properties: {
        id: {
          description: `The actor's id, unique in the scene; beats, wires and packets name it. Not "all".`,
          type: "string",
          pattern: "^(?!all$)[\\s\\S]"
        },
        type: { description: 'The actor type: "service".', const: "service" },
        col: {
          description: "The column it is drawn in, 0-3 (default 0).",
          type: "integer",
          minimum: 0,
          maximum: 3
        },
        label: { description: "The name on the box's top line.", type: "string", maxLength: 38 },
        sub: { description: "A short qualifier shown after the label.", type: "string", maxLength: 34 },
        fn: { description: 'The function at work, e.g. "createOrder()".', type: "string", maxLength: 28 },
        checks: {
          description: "What it does, ticked off one by one (at most 5).",
          type: "array",
          items: { description: "One check.", type: "string", maxLength: 28 },
          maxItems: 5
        }
      },
      required: ["id", "type"],
      additionalProperties: false
    },
    "actor.table": {
      description: "A table actor: a store's rows, shown as beats write them.",
      type: "object",
      properties: {
        id: {
          description: `The actor's id, unique in the scene; beats, wires and packets name it. Not "all".`,
          type: "string",
          pattern: "^(?!all$)[\\s\\S]"
        },
        type: { description: 'The actor type: "table".', const: "table" },
        col: {
          description: "The column it is drawn in, 0-3 (default 0).",
          type: "integer",
          minimum: 0,
          maximum: 3
        },
        label: { description: "The name on the box's top line.", type: "string", maxLength: 46 },
        sub: { description: "A short qualifier shown after the label.", type: "string", maxLength: 42 },
        rows: {
          description: "Its rows (at most 3).",
          type: "array",
          items: {
            description: "A row: its id and status pills.",
            type: "object",
            properties: {
              id: { description: "The row's id.", type: "string" },
              chips: {
                description: "Its status pills.",
                type: "array",
                items: { description: "One pill.", type: "string" }
              },
              old: { description: "There from the start (not written by a beat).", type: "boolean" }
            },
            required: ["id"]
          },
          maxItems: 3
        }
      },
      required: ["id", "type"],
      additionalProperties: false
    },
    "actor.cluster": {
      description: "A cluster actor: a namespace with pods, optionally one cluster inside it.",
      type: "object",
      properties: {
        id: {
          description: `The actor's id, unique in the scene; beats, wires and packets name it. Not "all".`,
          type: "string",
          pattern: "^(?!all$)[\\s\\S]"
        },
        type: { description: 'The actor type: "cluster".', const: "cluster" },
        col: {
          description: "The column it is drawn in, 0-3 (default 0).",
          type: "integer",
          minimum: 0,
          maximum: 3
        },
        label: { description: "The name on the box's top line.", type: "string", maxLength: 46 },
        sub: { description: "A short qualifier shown after the label.", type: "string", maxLength: 42 },
        pods: {
          description: "Its pods.",
          type: "array",
          items: {
            description: "A pod: a label and an optional note under it.",
            type: "object",
            properties: {
              label: { description: "The pod's name.", type: "string" },
              note: { description: "The note under it.", type: "string" },
              madeNote: { description: "The note once a beat makes it (made).", type: "string" },
              goneNote: {
                description: 'The note once a beat removes it (gone; default "gone").',
                type: "string"
              },
              ghost: { description: "Not there until a beat makes it.", type: "boolean" }
            },
            required: ["label"]
          }
        },
        inner: {
          description: "A cluster inside this one (a virtual cluster in a namespace).",
          type: "object",
          properties: {
            label: { description: "Its name.", type: "string", maxLength: 40 },
            sub: { description: "A short qualifier after the name.", type: "string", maxLength: 36 },
            ghost: { description: "Not there until a beat sets inner.", type: "boolean" },
            pods: {
              description: "Its pods.",
              type: "array",
              items: {
                description: "A pod: a label and an optional note under it.",
                type: "object",
                properties: {
                  label: { description: "The pod's name.", type: "string" },
                  note: { description: "The note under it.", type: "string" },
                  madeNote: { description: "The note once a beat makes it (made).", type: "string" },
                  goneNote: {
                    description: 'The note once a beat removes it (gone; default "gone").',
                    type: "string"
                  },
                  ghost: { description: "Not there until a beat makes it.", type: "boolean" }
                },
                required: ["label"]
              }
            }
          }
        }
      },
      required: ["id", "type"],
      additionalProperties: false
    },
    "actor.app": {
      description: "A web app actor: a window with a brand, tabs and screens (dialog, detail, sign-in, own pages).",
      type: "object",
      properties: {
        id: {
          description: `The actor's id, unique in the scene; beats, wires and packets name it. Not "all".`,
          type: "string",
          pattern: "^(?!all$)[\\s\\S]"
        },
        type: {
          description: 'The actor type: "app" ("console" in older journeys).',
          enum: ["app", "console"]
        },
        col: {
          description: "The column it is drawn in, 0-3 (default 0).",
          type: "integer",
          minimum: 0,
          maximum: 3
        },
        label: { description: "The name on the box's top line.", type: "string", maxLength: 42 },
        sub: { description: "A short qualifier shown after the label.", type: "string", maxLength: 38 },
        brand: { description: "The app's name in the top bar.", type: "string", maxLength: 31 },
        logo: { description: "The logo: 1 or 2 letters.", type: "string", maxLength: 2 },
        tabs: {
          description: "The tabs in the top bar (at most 3).",
          type: "array",
          items: { description: "A tab name.", type: "string", maxLength: 10 },
          maxItems: 3
        },
        screen: {
          description: 'The screen shown first: "dialog", "detail", "signin" (or an older name) or one of its pages.',
          type: "string"
        },
        dialog: {
          description: "The dialog screen: a list page with a dialog over it.",
          type: "object",
          properties: {
            tab: { description: "The tab this screen marks.", type: "string" },
            title: { description: "The dialog's title.", type: "string", maxLength: 24 },
            item: { description: "The chosen item.", type: "string", maxLength: 24 },
            lines: {
              description: "Label/value lines (at most 2).",
              type: "array",
              items: {
                description: 'A ["label", "value"] line.',
                type: "array",
                prefixItems: [
                  { description: "The label.", type: "string", maxLength: 12 },
                  { description: "The value.", type: "string", maxLength: 18 }
                ],
                minItems: 2,
                maxItems: 2
              },
              maxItems: 2
            },
            button: { description: "The button's text.", type: "string", maxLength: 18 }
          },
          additionalProperties: false
        },
        detail: {
          description: "The detail screen: a title, a status chip, cards, a timeline and two panes.",
          type: "object",
          properties: {
            tab: { description: "The tab this screen marks.", type: "string" },
            title: { description: "The page title.", type: "string", maxLength: 22 },
            status: { description: "The status chip's text.", type: "string", maxLength: 12 },
            tone: { description: "The status chip's tone.", enum: ["neutral", "active", "good", "bad"] },
            empty: { description: "What it says when there is nothing yet.", type: "string", maxLength: 30 },
            cards: {
              description: "Its cards (the first 2 are drawn).",
              type: "array",
              items: {
                description: "A card: a finding with a severity dot.",
                type: "object",
                properties: {
                  sev: {
                    description: 'Its severity: "low", "medium", "high" or "critical".',
                    type: "string"
                  },
                  title: { description: "What it says.", type: "string", maxLength: 32 }
                }
              }
            },
            timeline: {
              description: "Its timeline rows.",
              type: "array",
              items: { description: "One row.", type: "string", maxLength: 36 }
            },
            picture: { description: "What the live picture pane shows.", type: "string", maxLength: 38 },
            placeholder: { description: "The chat box's placeholder text.", type: "string", maxLength: 32 },
            chat: {
              description: "Chat messages of the detail page.",
              type: "array",
              items: {
                description: "A chat message.",
                type: "object",
                properties: {
                  from: {
                    description: 'Who says it: "me" or "them" ("you" and "agent" are read too).',
                    enum: ["me", "them", "you", "agent"]
                  },
                  text: { description: "What is said, one line.", type: "string", maxLength: 32 }
                },
                required: ["from", "text"]
              }
            }
          },
          additionalProperties: false
        },
        signin: {
          description: "The sign-in screen: a title, a notice and one button.",
          type: "object",
          properties: {
            title: { description: "The title.", type: "string", maxLength: 22 },
            notice: { description: "The notice.", type: "string", maxLength: 40 },
            provider: { description: "The sign-in provider's name.", type: "string", maxLength: 10 },
            button: { description: "The button's text.", type: "string", maxLength: 24 }
          },
          additionalProperties: false
        },
        pages: {
          description: "Its own pages by name: {tab, title, chip?, tone?, banner?, rows: [[label, value]], button?} each.",
          type: "object",
          properties: {}
        },
        test: { description: "Older journeys: the dialog's item.", type: "string", maxLength: 22 },
        env: { description: "Older journeys: the dialog's environment line.", type: "string", maxLength: 18 },
        findings: {
          description: "Older journeys: the detail page's cards.",
          type: "array",
          items: {
            description: "A card: a finding with a severity dot.",
            type: "object",
            properties: {
              sev: {
                description: 'Its severity: "low", "medium", "high" or "critical".',
                type: "string"
              },
              title: { description: "What it says.", type: "string", maxLength: 32 }
            }
          }
        },
        timeline: {
          description: "Older journeys: the detail page's timeline rows.",
          type: "array",
          items: { description: "One row.", type: "string", maxLength: 36 }
        },
        status: { description: "Older journeys: the detail page's status.", type: "string", maxLength: 12 },
        provider: { description: "Older journeys: the sign-in provider.", type: "string", maxLength: 10 },
        chat: {
          description: "Chat messages of the detail page.",
          type: "array",
          items: {
            description: "A chat message.",
            type: "object",
            properties: {
              from: {
                description: 'Who says it: "me" or "them" ("you" and "agent" are read too).',
                enum: ["me", "them", "you", "agent"]
              },
              text: { description: "What is said, one line.", type: "string", maxLength: 32 }
            },
            required: ["from", "text"]
          }
        }
      },
      required: ["id", "type"],
      additionalProperties: false
    },
    "actor.browser": {
      description: "A browser actor: a small shop page with two products, a cart and an address bar.",
      type: "object",
      properties: {
        id: {
          description: `The actor's id, unique in the scene; beats, wires and packets name it. Not "all".`,
          type: "string",
          pattern: "^(?!all$)[\\s\\S]"
        },
        type: { description: 'The actor type: "browser".', const: "browser" },
        col: {
          description: "The column it is drawn in, 0-3 (default 0).",
          type: "integer",
          minimum: 0,
          maximum: 3
        },
        label: { description: "The name on the box's top line.", type: "string", maxLength: 42 },
        sub: { description: "A short qualifier shown after the label.", type: "string", maxLength: 38 },
        url: { description: "The address shown.", type: "string", maxLength: 32 },
        title: { description: "The shop's name.", type: "string", maxLength: 20 },
        shop: { description: "The shop's name (when title is not set).", type: "string", maxLength: 20 },
        products: {
          description: "The products shown (the first 2): a name, or [name, ...].",
          type: "array",
          prefixItems: [
            {
              description: "A product shown: its name, or [name, ...].",
              anyOf: [
                { description: "The product's name.", type: "string", maxLength: 14 },
                {
                  description: "The product: [name, ...].",
                  type: "array",
                  prefixItems: [{ description: "The product's name.", type: "string", maxLength: 14 }]
                }
              ]
            },
            {
              description: "A product shown: its name, or [name, ...].",
              anyOf: [
                { description: "The product's name.", type: "string", maxLength: 14 },
                {
                  description: "The product: [name, ...].",
                  type: "array",
                  prefixItems: [{ description: "The product's name.", type: "string", maxLength: 14 }]
                }
              ]
            }
          ],
          items: { description: "A product not shown: a name, or [name, ...].", type: ["string", "array"] }
        },
        button: { description: "The products' button text.", type: "string", maxLength: 13 },
        cart: { description: "The cart's text.", type: "string", maxLength: 10 },
        markLabel: { description: "The label of the highlight on the cart.", type: "string", maxLength: 18 },
        lock: {
          description: 'Before the address: "ok" (a padlock) or "warn" ("Not secure").',
          type: "string"
        }
      },
      required: ["id", "type"],
      additionalProperties: false
    },
    "actor.terminal": {
      description: "A terminal actor: commands and what they print, shown as beats reveal them.",
      type: "object",
      properties: {
        id: {
          description: `The actor's id, unique in the scene; beats, wires and packets name it. Not "all".`,
          type: "string",
          pattern: "^(?!all$)[\\s\\S]"
        },
        type: { description: 'The actor type: "terminal".', const: "terminal" },
        col: {
          description: "The column it is drawn in, 0-3 (default 0).",
          type: "integer",
          minimum: 0,
          maximum: 3
        },
        label: { description: "The name on the box's top line.", type: "string", maxLength: 42 },
        sub: { description: "A short qualifier shown after the label.", type: "string", maxLength: 38 },
        lines: {
          description: 'Its lines: a command ("$ npm test") or a printed line.',
          type: "array",
          items: { description: "One line.", type: "string", maxLength: 36 }
        }
      },
      required: ["id", "type"],
      additionalProperties: false
    },
    "actor.file": {
      description: "A file (or folder) actor: its lines as they are in it.",
      type: "object",
      properties: {
        id: {
          description: `The actor's id, unique in the scene; beats, wires and packets name it. Not "all".`,
          type: "string",
          pattern: "^(?!all$)[\\s\\S]"
        },
        type: { description: 'The actor type: "file".', const: "file" },
        col: {
          description: "The column it is drawn in, 0-3 (default 0).",
          type: "integer",
          minimum: 0,
          maximum: 3
        },
        label: { description: "The name on the box's top line.", type: "string", maxLength: 42 },
        sub: { description: "A short qualifier shown after the label.", type: "string", maxLength: 38 },
        from: {
          description: "The number of its first line (line numbers are shown then).",
          type: "integer",
          minimum: 1
        },
        lines: {
          description: "Its lines (34 characters each, 30 with line numbers).",
          type: "array",
          items: { description: "One line.", type: "string", maxLength: 34 }
        }
      },
      required: ["id", "type"],
      additionalProperties: false,
      anyOf: [
        {
          description: "With line numbers: lines of at most 30 characters.",
          required: ["from"],
          properties: {
            lines: {
              description: "Its lines.",
              type: "array",
              items: { description: "One line.", type: "string", maxLength: 30 }
            }
          }
        },
        {
          description: "Without line numbers.",
          properties: { from: { description: "Absent.", type: "null" } }
        }
      ]
    },
    "actor.chat": {
      description: "A chat actor: a conversation, one line per message.",
      type: "object",
      properties: {
        id: {
          description: `The actor's id, unique in the scene; beats, wires and packets name it. Not "all".`,
          type: "string",
          pattern: "^(?!all$)[\\s\\S]"
        },
        type: { description: 'The actor type: "chat".', const: "chat" },
        col: {
          description: "The column it is drawn in, 0-3 (default 0).",
          type: "integer",
          minimum: 0,
          maximum: 3
        },
        label: { description: "The name on the box's top line.", type: "string", maxLength: 42 },
        sub: { description: "A short qualifier shown after the label.", type: "string", maxLength: 38 },
        messages: {
          description: "Its messages.",
          type: "array",
          items: {
            description: "A message.",
            type: "object",
            properties: {
              from: { description: "Who says it.", enum: ["me", "them"] },
              text: {
                description: "What is said, one line (38 characters, 32 for a tool call).",
                type: "string",
                maxLength: 38
              },
              tool: { description: "A tool call or its result (set in the code font).", type: "boolean" }
            },
            required: ["from", "text"],
            anyOf: [
              {
                description: "A tool call: at most 32 characters.",
                required: ["tool"],
                properties: {
                  tool: { description: "A tool call.", const: true },
                  text: { description: "What is said.", type: "string", maxLength: 32 }
                }
              },
              {
                description: "A plain message.",
                properties: { tool: { description: "Not a tool call.", const: false } }
              }
            ]
          }
        }
      },
      required: ["id", "type"],
      additionalProperties: false
    },
    "actor.queue": {
      description: "A queue actor: slots taken as items arrive.",
      type: "object",
      properties: {
        id: {
          description: `The actor's id, unique in the scene; beats, wires and packets name it. Not "all".`,
          type: "string",
          pattern: "^(?!all$)[\\s\\S]"
        },
        type: { description: 'The actor type: "queue".', const: "queue" },
        col: {
          description: "The column it is drawn in, 0-3 (default 0).",
          type: "integer",
          minimum: 0,
          maximum: 3
        },
        label: { description: "The name on the box's top line.", type: "string", maxLength: 46 },
        sub: { description: "A short qualifier shown after the label.", type: "string", maxLength: 42 },
        slots: { description: "How many places (at most 8 are drawn).", type: "integer", minimum: 1 },
        cap: { description: 'Its real size in words, e.g. "256 slots".', type: "string", maxLength: 44 }
      },
      required: ["id", "type"],
      additionalProperties: false
    },
    "actor.gauge": {
      description: "A gauge actor: a limit and how much of it is taken.",
      type: "object",
      properties: {
        id: {
          description: `The actor's id, unique in the scene; beats, wires and packets name it. Not "all".`,
          type: "string",
          pattern: "^(?!all$)[\\s\\S]"
        },
        type: { description: 'The actor type: "gauge".', const: "gauge" },
        col: {
          description: "The column it is drawn in, 0-3 (default 0).",
          type: "integer",
          minimum: 0,
          maximum: 3
        },
        label: { description: "The name on the box's top line.", type: "string", maxLength: 46 },
        sub: { description: "A short qualifier shown after the label.", type: "string", maxLength: 42 },
        max: { description: "The limit, a number above 0.", type: "number", minimum: 0 },
        unit: { description: 'The unit, e.g. "GiB".', type: "string" },
        used: { description: "How much is taken at the start.", type: "number" }
      },
      required: ["id", "type", "max"],
      additionalProperties: false
    },
    beat: {
      description: "One beat: the camera on one actor, a caption, and what changes.",
      type: "object",
      properties: {
        focus: {
          description: 'The actor the camera goes to (an actor id; not "all").',
          type: "string",
          pattern: "^(?!all$)[\\s\\S]"
        },
        caption: { description: "What happens, in one short sentence.", type: "string", pattern: "\\S" },
        muted: { description: "More words after the caption, greyed.", type: "string" },
        set: {
          description: "What changes, by actor id: {actorId: {...}} (see $defs setState.*).",
          type: "object",
          properties: {}
        },
        packet: {
          description: "A pill that travels a wire as the beat starts.",
          type: "object",
          properties: {
            from: { description: "The sending actor's id.", type: "string" },
            to: { description: "The receiving actor's id.", type: "string" },
            label: { description: "What travels.", type: "string" }
          },
          required: ["from", "to"]
        },
        click: {
          description: "A click: the browser actor's id, or (with an app actor) true or its id.",
          type: ["string", "boolean"]
        },
        flash: { description: "A screenshot flash on this browser actor (its id).", type: "string" },
        code: {
          description: "The line that does what the beat shows (the extension lights it).",
          type: "object",
          properties: {
            file: { description: "The file, relative to the repository.", type: "string" },
            line: { description: "The line number (1-based).", type: "integer", minimum: 1 },
            text: {
              description: "The trimmed text of that line (to find it again).",
              type: "string",
              pattern: "\\S"
            }
          },
          required: ["file", "line", "text"]
        },
        example: {
          description: "An example of the value in play at that line (written by the author).",
          type: "object",
          properties: {
            label: { description: "What the example is.", type: "string" },
            value: { description: "The example value.", type: "string" },
            lang: { description: "The language to show it in.", type: "string" }
          }
        },
        hold: { description: "How long the beat is held when played (milliseconds).", type: "number" },
        marks: {
          $ref: "marks.schema.json#/$defs/marks",
          description: "Parts of the code lit while the beat is (file default: the beat's code file, else the step's)."
        }
      },
      required: ["focus", "caption"],
      additionalProperties: false
    },
    "setState.service": {
      description: "What a beat changes on a service.",
      type: "object",
      properties: { done: { description: "How many checks are ticked.", type: "integer", minimum: 0 } },
      additionalProperties: false
    },
    "setState.table": {
      description: "What a beat changes on a table.",
      type: "object",
      properties: {
        show: { description: "How many rows are there (after the old ones).", type: "integer", minimum: 0 },
        hi: { description: "The row just written (-1: none).", type: "integer", minimum: -1 },
        chips: { description: "Rows' pills now, by row index.", type: "object", properties: {} }
      },
      additionalProperties: false
    },
    "setState.cluster": {
      description: "What a beat changes on a cluster.",
      type: "object",
      properties: {
        mark: { description: "The pod pointed at (-1: none).", type: "integer", minimum: -1 },
        made: {
          description: "Ghost pods that exist now.",
          type: "array",
          items: { description: "A pod index.", type: "integer", minimum: 0 }
        },
        gone: {
          description: "Pods that are gone now.",
          type: "array",
          items: { description: "A pod index.", type: "integer", minimum: 0 }
        },
        inner: { description: "The inner cluster is there.", type: "boolean" },
        innerMade: {
          description: "Inner ghost pods that exist now.",
          type: "array",
          items: { description: "A pod index.", type: "integer", minimum: 0 }
        },
        innerMark: { description: "The inner pod pointed at (-1: none).", type: "integer", minimum: -1 },
        innerGone: {
          description: "Inner pods that are gone now.",
          type: "array",
          items: { description: "A pod index.", type: "integer", minimum: 0 }
        }
      },
      additionalProperties: false
    },
    "setState.browser": {
      description: "What a beat changes on a browser.",
      type: "object",
      properties: {
        click: { description: "The first product's button is pressed.", type: "boolean" },
        mark: { description: "The highlight on the cart is on.", type: "boolean" },
        lock: { description: 'The padlock: "ok", "warn" or "" (none).', enum: ["ok", "warn", ""] }
      },
      additionalProperties: false
    },
    "setState.terminal": {
      description: "What a beat changes on a terminal.",
      type: "object",
      properties: {
        show: { description: "How many lines are there.", type: "integer", minimum: 0 },
        hi: { description: "The line just printed (-1: none).", type: "integer", minimum: -1 }
      },
      additionalProperties: false
    },
    "setState.file": {
      description: "What a beat changes on a file.",
      type: "object",
      properties: {
        show: { description: "How many lines are there.", type: "integer", minimum: 0 },
        hi: {
          description: "The line (or [first, last]) the beat is about.",
          anyOf: [
            { description: "A line index.", type: "integer", minimum: -1 },
            {
              description: "[first, last] line indexes.",
              type: "array",
              prefixItems: [
                { description: "The first line index.", type: "integer", minimum: -1 },
                { description: "The last line index.", type: "integer", minimum: -1 }
              ],
              minItems: 2,
              maxItems: 2
            }
          ]
        },
        text: {
          description: "Lines that read differently now, by line index.",
          type: "object",
          properties: {}
        }
      },
      additionalProperties: false
    },
    "setState.chat": {
      description: "What a beat changes on a chat.",
      type: "object",
      properties: {
        show: { description: "How many messages are there.", type: "integer", minimum: 0 },
        hi: { description: "The message just said (-1: none).", type: "integer", minimum: -1 }
      },
      additionalProperties: false
    },
    "setState.queue": {
      description: "What a beat changes on a queue.",
      type: "object",
      properties: {
        fill: { description: "How many places are taken.", type: "integer", minimum: 0 },
        drop: { description: "One more arrived and did not fit.", type: "boolean" },
        note: { description: "What it says underneath.", type: "string", maxLength: 44 }
      },
      additionalProperties: false
    },
    "setState.gauge": {
      description: "What a beat changes on a gauge.",
      type: "object",
      properties: {
        used: { description: "How much is taken.", type: "number", minimum: 0 },
        want: { description: "How much is asked for on top.", type: "number", minimum: 0 },
        note: { description: "What it says underneath.", type: "string", maxLength: 44 }
      },
      additionalProperties: false
    },
    "setState.app": {
      description: "What a beat changes on a web app.",
      type: "object",
      properties: {
        screen: { description: "The screen shown.", type: "string" },
        status: { description: "The detail page's status.", type: "string", maxLength: 12 },
        tone: { description: "The status chip's tone.", enum: ["neutral", "active", "good", "bad"] },
        findings: { description: "Older journeys: how many cards are there.", type: "integer", minimum: 0 },
        cards: { description: "How many cards are there.", type: "integer", minimum: 0 },
        events: { description: "How many timeline rows are there.", type: "integer", minimum: 0 },
        newFinding: { description: "Older journeys: the card just added.", type: "integer", minimum: -1 },
        newCard: { description: "The card just added (-1: none).", type: "integer", minimum: -1 },
        newEvent: { description: "The timeline row just added (-1: none).", type: "integer", minimum: -1 },
        ended: { description: "The session ended (the sign-in notice shows).", type: "boolean" },
        notice: { description: "The sign-in notice shows.", type: "boolean" },
        redirecting: { description: "The sign-in button says it is redirecting.", type: "boolean" },
        busy: { description: "The dialog's button is busy.", type: "boolean" },
        pane: {
          description: `The detail page's pane: "picture", "chat" ("desktop" in older journeys) or "" (none).`,
          enum: ["picture", "chat", "desktop", ""]
        },
        desktop: {
          description: "Older journeys: what the picture pane shows.",
          type: "string",
          maxLength: 38
        },
        picture: { description: "What the picture pane shows.", type: "string", maxLength: 38 },
        chat: { description: "How many chat messages are there.", type: "integer", minimum: 0 },
        newChat: { description: "The chat message just added (-1: none).", type: "integer", minimum: -1 },
        typing: { description: "What is being typed in the chat box.", type: "string", maxLength: 32 },
        rows: { description: "How many page rows are there.", type: "integer", minimum: 0 },
        hiRow: { description: "The page row the beat is about (-1: none).", type: "integer", minimum: -1 },
        banner: { description: "The page's banner shows.", type: "boolean" }
      },
      additionalProperties: false
    }
  }
};

// cli/journey/limits.ts
var defs = journey_schema_default.$defs;
function part(def, ...path3) {
  let s = defs[def];
  for (const p of path3) {
    s = p === "[]" ? s.items : typeof p === "number" ? s.prefixItems[p] : s.properties[p];
    if (!s) throw new Error(`journey schema: nothing at ${def} ${path3.join(" ")}`);
  }
  return s;
}
var maxLength = (def, ...path3) => part(def, ...path3).maxLength;
var maxItems = (def, ...path3) => part(def, ...path3).maxItems;
var TYPES = ["app", "service", "table", "cluster", "browser", "terminal", "file", "chat", "queue", "gauge"];
var TYPE_ALIAS = { console: "app" };
var COMMON_KEYS = ["id", "type", "col", "label", "sub"];
var fields = (def) => Object.keys(defs[def].properties);
var ACTOR_KEYS = Object.fromEntries(TYPES.map((t) => [t, fields(`actor.${t}`).filter((k) => !COMMON_KEYS.includes(k))]));
var SET_KEYS = Object.fromEntries(TYPES.map((t) => [t, fields(`setState.${t}`)]));
var SCENE_KEYS = fields("scene");
var BEAT_KEYS = fields("beat");
var MIN_BEATS = part("scene", "beats").minItems;
var MAX_BEATS = maxItems("scene", "beats");
var SOFT_BEATS = 6;
var MAX_ACTORS = maxItems("scene", "actors");
var SOFT_CAPTION = 70;
var SOFT_CAPTION_ALL = 110;
var MAX_PACKET = 24;
var LABEL_CHARS = Object.fromEntries(TYPES.map((t) => [t, maxLength(`actor.${t}`, "label")]));
var DEFAULT_LABEL = { app: "Web app", browser: "Browser", terminal: "Terminal", file: "file", chat: "Chat" };
var STARTS_EMPTY = ["terminal", "chat"];
var FN_CHARS = maxLength("actor.service", "fn");
var MAX_CHECKS = maxItems("actor.service", "checks");
var MAX_CHECK = maxLength("actor.service", "checks", "[]");
var MAX_ROWS = maxItems("actor.table", "rows");
var INNER_LABEL_CHARS = maxLength("actor.cluster", "inner", "label");
var BROWSER_CHARS = ["url", "title", "shop", "button", "cart", "markLabel"].map((k) => [k, maxLength("actor.browser", k)]);
var PRODUCT_CHARS = part("actor.browser", "products", 0).anyOf[0].maxLength;
var SHOP_TOP = 26;
var FILE_CHARS = maxLength("actor.file", "lines", "[]");
var FILE_NUM_CHARS = defs["actor.file"].anyOf[0].properties.lines.items.maxLength;
var CHAT_CHARS = maxLength("actor.chat", "messages", "[]", "text");
var CHAT_TOOL_CHARS = part("actor.chat", "messages", "[]").anyOf[0].properties.text.maxLength;
var NOTE_CHARS = maxLength("actor.queue", "cap");
var QUEUE_SLOTS = 8;
var MAX_TERM_LINE = maxLength("actor.terminal", "lines", "[]");
var SCREENS = ["dialog", "detail", "signin"];
var SCREEN_ALIAS = ["run-dialog", "run-page", "login"];
var PANES = ["picture", "chat", "desktop"];
var TONES = part("actor.app", "detail", "tone").enum;
var LOCKS = ["ok", "warn"];
var MAX_TABS = maxItems("actor.app", "tabs");
var TAB_CHARS = maxLength("actor.app", "tabs", "[]");
var DIALOG_CHARS = ["title", "item", "button"].map((k) => [k, maxLength("actor.app", "dialog", k)]);
var DIALOG_LINES = maxItems("actor.app", "dialog", "lines");
var LINE_KEY = maxLength("actor.app", "dialog", "lines", "[]", 0);
var LINE_VALUE = maxLength("actor.app", "dialog", "lines", "[]", 1);
var DETAIL_CHARS = ["title", "status", "empty", "picture", "placeholder"].map((k) => [k, maxLength("actor.app", "detail", k)]);
var PICTURE_CHARS = maxLength("actor.app", "detail", "picture");
var STATUS_CHARS = maxLength("actor.app", "detail", "status");
var SIGNIN_CHARS = ["title", "notice", "provider", "button"].map((k) => [k, maxLength("actor.app", "signin", k)]);
var SIGNIN_TITLE = maxLength("actor.app", "signin", "title");
var OLD_CHARS = ["test", "env", "provider", "status"].map((k) => [k, maxLength("actor.app", k)]);
var CARD_CHARS = maxLength("actor.app", "detail", "cards", "[]", "title");
var TIMELINE_CHARS = maxLength("actor.app", "detail", "timeline", "[]");
var APP_CHAT_CHARS = maxLength("actor.app", "detail", "chat", "[]", "text");
var APP_CHAT_FROM = part("actor.app", "detail", "chat", "[]", "from").enum;
var TITLE_CHIP = 30;
var PAGE_ROWS = 4;
var PAGE_KEY = 12;
var PAGE_VALUE = 20;
var PAGE_BANNER = 38;
var PAGE_ITEMS = 4;
var PAGE_CHARS = [["title", 22], ["chip", 12], ["tab", TAB_CHARS], ["button", 20]];
var TOP_PX = 280;
var BRAND_PX = 7.8;
var TAB_PX = 6.8;
var TAB_GAP = 12;
var ROW_PX = 300;
var MONO_13_PX = 7.8;
var ROW_ID_MIN_PX = 70;
var PILL_PX = 6.2;
var PILL_GAP = 9;
var PILL_PAD = 18;
var PODS_PX = 320;
var INNER_PODS_PX = 296;
var LABEL_14_PX = 7.2;
var NOTE_12_PX = 6.4;

// cli/journey/scene.ts
var typeOf = (a) => typeof a.type === "string" && a.type in TYPE_ALIAS ? TYPE_ALIAS[a.type] : a.type;
var isType = (t) => TYPES.includes(t);
var list = (a, key) => Array.isArray(a[key]) ? a[key] : [];
var size = (v) => Array.isArray(v) ? v.length : typeof v === "string" ? len(v) : isObj(v) ? Object.keys(v).length : 0;
var get = (o, key, missing = "") => key in o ? o[key] : missing;
var tooLong = (v, n) => len(str2(v)) > n;
function sceneIssues(k, sc) {
  const c = collector(`step ${k} scene: `);
  if (!isObj(sc)) {
    c.problem("must be an object {actors, wires, beats}");
    return c.issues;
  }
  for (const key of Object.keys(sc)) if (!SCENE_KEYS.includes(key)) c.refuse(`"${key}" is not part of a scene (actors, wires, beats); the engine ignores it`);
  const { actors, beats } = sc;
  if (!Array.isArray(actors) || !actors.length || !Array.isArray(beats) || !beats.length) {
    c.problem('needs a non-empty "actors" list and a non-empty "beats" list');
    return c.issues;
  }
  const ids = actorIssues(actors, c);
  const pairs = wireIssues(get(sc, "wires", []), ids, c);
  beatIssues(k, beats, ids, pairs, c);
  return c.issues;
}
function actorIssues(actors, c) {
  const ids = /* @__PURE__ */ new Map();
  actors.forEach((a, i) => {
    if (!isObj(a) || typeof a.id !== "string" || !a.id) {
      c.problem(`actors[${i}] needs a string "id"`);
      return;
    }
    const aid = a.id;
    const t = typeOf(a);
    if (ids.has(aid)) c.problem(`two actors have the id "${aid}"`);
    if (aid === "all") c.problem('"all" is not an actor id');
    ids.set(aid, a);
    if (!isType(t)) {
      c.problem(`actor ${aid}: type ${repr(t)} does not exist (types: ${TYPES.join(", ")}): the engine skips it`);
      return;
    }
    const extra = Object.keys(a).filter((x) => !COMMON_KEYS.includes(x) && !ACTOR_KEYS[t].includes(x));
    if (extra.length) {
      c.refuse(`actor ${aid}: ${sorted(extra).join(", ")} ${isAre(extra.length)} not read by a ${t} (it reads ${sorted(ACTOR_KEYS[t]).join(", ")}): the engine ignores it`);
    }
    if ("col" in a && !(isInt(a.col) && a.col >= 0 && a.col <= 3)) c.problem(`actor ${aid}: "col" is a column number 0-3`);
    const sub = or(a.sub, "");
    const lab = str2(or(a.label, DEFAULT_LABEL[t] ?? aid)) + (truthy(sub) ? ` · ${str2(sub)}` : "");
    if (len(lab) > LABEL_CHARS[t]) {
      c.problem(`actor ${aid}: label and sub "${lab}" are ${len(lab)} chars; a ${t} box holds about ${LABEL_CHARS[t]} on its top line: shorten them`);
    }
    const prefix = `actor ${aid}: `;
    ACTORS[t](a, (m) => c.problem(prefix + m), (m) => c.warning(prefix + m));
  });
  if (actors.length > MAX_ACTORS) c.refuse(`${actors.length} actors (max ${MAX_ACTORS}: the parts this step touches; one box per part)`);
  return ids;
}
var ACTORS = {
  service(a, problem2) {
    const fn = get(a, "fn");
    if (tooLong(fn, FN_CHARS)) problem2(`fn "${str2(fn)}" is ${len(str2(fn))} chars (max ${FN_CHARS}: the name and "()")`);
    const checks = list(a, "checks");
    if (checks.length > MAX_CHECKS) problem2(`${checks.length} checks (max ${MAX_CHECKS})`);
    for (const x of checks) if (tooLong(x, MAX_CHECK)) problem2(`check "${str2(x)}" is ${len(str2(x))} chars (max ${MAX_CHECK})`);
  },
  table(a, problem2) {
    const rows = list(a, "rows");
    if (rows.length > MAX_ROWS) problem2(`${rows.length} rows (max ${MAX_ROWS})`);
    for (const r of rows) {
      if (!isObj(r) || typeof r.id !== "string") {
        problem2('a row is {"id": "…", "chips": ["…"], "old"?: true}');
        continue;
      }
      const px = rowPx(r.id, or(r.chips, []));
      if (px > ROW_PX) problem2(`row "${r.id}" with chips ${str2(r.chips)} is about ${px} px wide (the row holds ${ROW_PX}): a shorter id or fewer, shorter chips`);
    }
  },
  cluster(a, problem2) {
    const pods = list(a, "pods");
    for (const m of podsIssues(pods, PODS_PX, 32, 12)) problem2(m);
    const inner = a.inner;
    if (inner === void 0 || inner === null) return;
    if (!isObj(inner)) {
      problem2('"inner" is {"label", "sub"?, "ghost"?, "pods"}');
      return;
    }
    const il = str2(or(inner.label, "cluster")) + (truthy(inner.sub) ? ` · ${str2(inner.sub)}` : "");
    if (len(il) > INNER_LABEL_CHARS) problem2(`inner label and sub "${il}" are ${len(il)} chars (about ${INNER_LABEL_CHARS} fit)`);
    for (const m of podsIssues(Array.isArray(inner.pods) ? inner.pods : [], INNER_PODS_PX, 24, 10)) problem2(`inner ${m}`);
    if (pods.length > 2) problem2(`${pods.length} pods above an inner cluster (1 or 2 fit)`);
  },
  app(a, problem2, warning2) {
    for (const i of appIssues(a)) (i.level === "warning" ? warning2 : problem2)(i.text);
  },
  browser(a, problem2) {
    for (const [key, n] of BROWSER_CHARS) if (tooLong(get(a, key), n)) problem2(`${key} "${str2(a[key])}" is ${len(str2(a[key]))} chars (max ${n})`);
    const name = str2(or(a.title, or(a.shop, "Shop"))), cart = str2(or(a.cart, "Cart 0"));
    if (len(name) + len(cart) > SHOP_TOP) problem2(`title "${name}" and cart "${cart}" share one line: ${len(name) + len(cart)} chars (max ${SHOP_TOP})`);
    for (const p of list(a, "products").slice(0, 2)) {
      const nm = Array.isArray(p) && p.length ? p[0] : p;
      if (tooLong(nm, PRODUCT_CHARS)) problem2(`product "${str2(nm)}" is ${len(str2(nm))} chars (max ${PRODUCT_CHARS})`);
    }
  },
  file(a, problem2) {
    const numbered = truthy(a.from);
    const lim = numbered ? FILE_NUM_CHARS : FILE_CHARS;
    if ("from" in a && !(isInt(a.from) && a.from >= 1)) problem2('"from" is the number of the first line (omit it for a folder or a made-up document)');
    for (const ln of list(a, "lines")) {
      if (tooLong(ln, lim)) problem2(`line "${str2(ln)}" is ${len(str2(ln))} chars (max ${lim}${numbered ? " with line numbers" : ""}; a longer one is cut)`);
    }
  },
  chat(a, problem2) {
    for (const m of list(a, "messages")) {
      if (!(isObj(m) && ["me", "them"].includes(m.from) && typeof m.text === "string")) {
        problem2('a message is {"from": "me" | "them", "text": "…", "tool"?: true}');
        continue;
      }
      const tool = truthy(m.tool);
      const lim = tool ? CHAT_TOOL_CHARS : CHAT_CHARS;
      if (len(m.text) > lim) problem2(`message "${m.text}" is ${len(m.text)} chars (max ${lim}${tool ? " for a tool call" : ""}; one line)`);
    }
  },
  queue(a, problem2) {
    if ("slots" in a && !(isInt(a.slots) && a.slots >= 1)) problem2(`"slots" is a number of places (${QUEUE_SLOTS} are drawn at most; "cap" says the real size)`);
    if (tooLong(get(a, "cap"), NOTE_CHARS)) problem2(`cap "${str2(a.cap)}" is ${len(str2(a.cap))} chars (max ${NOTE_CHARS})`);
  },
  gauge(a, problem2) {
    if (!(isNumber(a.max) && Number(a.max) > 0)) problem2('"max" is the limit, a number above 0');
  },
  terminal(a, problem2) {
    for (const ln of list(a, "lines")) {
      if (tooLong(ln, MAX_TERM_LINE)) problem2(`line "${str2(ln)}" is ${len(str2(ln))} chars (max ${MAX_TERM_LINE}; a longer one is cut): shorten it, keeping what the code prints`);
    }
  }
};
var isNumber = (v) => typeof v === "number" || typeof v === "boolean";
function wireIssues(wires, ids, c) {
  const pairs = /* @__PURE__ */ new Set();
  if (!Array.isArray(wires)) {
    c.problem('"wires" is a list of [fromId, toId] pairs');
    return pairs;
  }
  for (const w of wires) {
    if (!(Array.isArray(w) && w.length === 2 && w.every((x) => typeof x === "string" && ids.has(x)))) {
      c.problem(`wire ${str2(w)}: a wire is [fromId, toId] between two actors of this scene`);
      continue;
    }
    pairs.add(`${w[0]}
${w[1]}`).add(`${w[1]}
${w[0]}`);
  }
  return pairs;
}
function beatIssues(k, beats, ids, pairs, c) {
  const n = beats.length;
  if (n > MAX_BEATS) c.problem(`${n} beats (max ${MAX_BEATS}; aim for ${MIN_BEATS}-${SOFT_BEATS}): one thing happening per beat`);
  else if (n > SOFT_BEATS) c.warning(`${n} beats (aim for ${MIN_BEATS}-${SOFT_BEATS}): merge two`);
  else if (n < MIN_BEATS) c.refuse(`${n} beats (want ${MIN_BEATS}-${SOFT_BEATS}); a step with less to show gets no scene (rmscene ${k})`);
  const types = new Set([...ids.values()].map(typeOf));
  const isActor = (v) => typeof v === "string" && ids.has(v);
  let bare = 0;
  const shown = /* @__PURE__ */ new Map();
  beats.forEach((b, i0) => {
    const i = i0 + 1;
    const bn = `beat ${i}`;
    if (!isObj(b)) {
      c.problem(`${bn} is not an object`);
      return;
    }
    const extra = Object.keys(b).filter((x) => !BEAT_KEYS.includes(x));
    if (extra.length) c.refuse(`${bn}: ${sorted(extra).join(", ")} ${isAre(extra.length)} not part of a beat (${sorted(BEAT_KEYS).join(", ")})`);
    const f = b.focus;
    if (f === "all") c.problem(`${bn}: focus "all" (a zoomed-out view too small to read): focus the one actor whose line the beat lights`);
    else if (!isActor(f)) c.problem(`${bn}: focus ${repr(f)} is not an actor of this scene (${[...ids.keys()].join(", ")})`);
    const cap = str2(get(b, "caption")).trim(), mut = str2(get(b, "muted")).trim();
    if (!cap) c.problem(`${bn}: no caption`);
    else if (len(cap) > SOFT_CAPTION) c.warning(`${bn}: the caption is ${len(cap)} chars (aim for < 60, max ~${SOFT_CAPTION}: read in three seconds); move a clause to "muted" or cut it: "${cap}"`);
    else if (len(cap) + len(mut) > SOFT_CAPTION_ALL) c.warning(`${bn}: caption and muted are ${len(cap) + len(mut)} chars together (aim for <= ${SOFT_CAPTION_ALL}: read in three seconds)`);
    setIssues(bn, get(b, "set", {}), ids, shown, c);
    if (isActor(f) && STARTS_EMPTY.includes(ids.get(f)?.type) && !truthy(shown.get(f))) {
      c.warning(`${bn}: focus on ${ids.get(f)?.type} ${f} while none of its lines is shown yet (set {"${f}": {"show": 1}})`);
    }
    const p = b.packet;
    if (p !== void 0 && p !== null) {
      if (!(isObj(p) && isActor(p.from) && isActor(p.to))) c.problem(`${bn}: a packet is {from, to, label} between two actors of this scene`);
      else if (!pairs.has(`${p.from}
${p.to}`)) c.problem(`${bn}: packet ${p.from} -> ${p.to} has no wire to travel on (add ["${p.from}", "${p.to}"] to wires): the engine does not show it`);
      else if (tooLong(get(p, "label"), MAX_PACKET)) c.warning(`${bn}: packet label "${str2(p.label)}" is ${len(str2(p.label))} chars (aim for <= ${MAX_PACKET})`);
    }
    const browser = (v) => isActor(v) && ids.get(v)?.type === "browser";
    const click = b.click;
    if (truthy(click) && !types.has("browser") && !types.has("app")) c.refuse(`${bn}: "click" does nothing without a browser or app actor`);
    else if (truthy(click) && !types.has("app") && !browser(click)) c.refuse(`${bn}: click ${repr(click)} must be the id of the browser actor the click happens in`);
    if (truthy(b.flash) && !browser(b.flash)) c.refuse(`${bn}: flash ${repr(b.flash)} must be the id of a browser actor (the screenshot flash)`);
    const code = b.code;
    if (code === void 0 || code === null) {
      bare++;
      if (bare === 2) c.warning(`beats ${i - 1} and ${i} have no code line: never two in a row (a beat without code is for something with no line in this repo; keep those rare)`);
    } else {
      bare = 0;
      if (!(isObj(code) && typeof code.file === "string" && isInt(code.line))) c.problem(`${bn}: code is {"file": "<repo path>", "line": <n>} (the script reads the text)`);
    }
  });
  if (!beats.some((b) => isObj(b) && truthy(b.code))) c.problem("no beat has a code line: a scene lights the code that does what it shows");
}
function setIssues(bn, set, ids, shown, c) {
  if (!isObj(set)) {
    c.problem(`${bn}: "set" is {actorId: {…}}`);
    return;
  }
  for (const [aid, ch] of Object.entries(set)) {
    const a = ids.get(aid);
    if (!a) {
      c.problem(`${bn}: set on ${repr(aid)}, which is not an actor of this scene`);
      continue;
    }
    const t = typeOf(a);
    if (!isObj(ch)) {
      c.problem(`${bn}: set.${aid} is an object of what changes`);
      continue;
    }
    const takes = isType(t) ? SET_KEYS[t] : [];
    const bad = Object.keys(ch).filter((x) => !takes.includes(x));
    if (bad.length) c.refuse(`${bn}: set.${aid}: ${sorted(bad).join(", ")} does nothing on a ${str2(t)} (it takes ${sorted(takes).join(", ")})`);
    if (isType(t)) for (const m of STATES[t](a, ch)) c.refuse(`${bn}: set.${aid}: ${m}`);
    if (STARTS_EMPTY.includes(t) && "show" in ch) shown.set(aid, ch.show);
  }
}
function rowPx(id, chips) {
  const pills = iter(chips).reduce((w, x) => w + PILL_GAP + PILL_PAD + PILL_PX * len(str2(x)), 0);
  return pyRound(Math.max(ROW_ID_MIN_PX, MONO_13_PX * len(str2(id))) + pills);
}
function iter(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [...v];
  if (isObj(v)) return Object.keys(v);
  return [];
}
function podsIssues(pods, room, pad, gap) {
  const out = [];
  let w = 0;
  for (const p of pods) {
    if (!isObj(p) || typeof p.label !== "string") {
      out.push('a pod is {"label", "note"?, "madeNote"?, "ghost"?}');
      continue;
    }
    w += pad + Math.max(LABEL_14_PX * len(p.label), NOTE_12_PX * Math.max(len(str2(get(p, "note"))), len(str2(get(p, "madeNote")))));
  }
  w += gap * Math.max(0, pods.length - 1);
  if (w > room) {
    const names = pods.filter(isObj).map((p) => str2(p.label)).join(", ");
    out.push(`pods ${names} are about ${pyRound(w)} px side by side (${room} fit): fewer pods, or shorter labels and notes`);
  }
  return out;
}
var isIndex = (v, m) => isInt(v) && v >= -1 && v < m;
var isCount = (v, m) => isInt(v) && v >= 0 && v <= m;
var count = (a, key) => Array.isArray(a[key]) ? a[key].length : 0;
function rules(ch, out) {
  return {
    index(key, m, what) {
      if (key in ch && !isIndex(ch[key], m)) out.push(`${key} ${repr(ch[key])} is not one of its ${m} ${what} (0-${m - 1}, or -1 for none)`);
    },
    count(key, m, says) {
      if (key in ch && !isCount(ch[key], m)) out.push(`${key} ${repr(ch[key])}: ${says}`);
    },
    indexes(key, m, says) {
      if (iter(or(ch[key], [])).some((x) => !isIndex(x, m))) out.push(`${key} ${str2(ch[key])}: ${says}`);
    },
    long(key, n, says) {
      if (tooLong(get(ch, key), n)) out.push(`${key} "${str2(ch[key])}" ${says}`);
    }
  };
}
var STATES = {
  service(a, ch) {
    const out = [];
    rules(ch, out).count("done", count(a, "checks"), `it has ${count(a, "checks")} checks`);
    return out;
  },
  table(a, ch) {
    const out = [];
    const rows = count(a, "rows");
    rules(ch, out).index("hi", rows, "rows");
    const chips = or(ch.chips, {});
    for (const r of iter(chips)) {
      const ok = /^\d+$/.test(str2(r)) && Number(r) < rows;
      if (!ok) out.push(`chips for row ${repr(r)}: it has ${rows} rows`);
      else if (isObj(chips) && rowPx(get(a.rows[Number(r)] ?? {}, "id"), or(chips[r], [])) > ROW_PX) {
        out.push(`chips ${str2(chips[r])} make row ${r} wider than the box (${ROW_PX} px)`);
      }
    }
    return out;
  },
  cluster(a, ch) {
    const out = [];
    const r = rules(ch, out);
    const pods = count(a, "pods");
    r.index("mark", pods, "pods");
    for (const key of ["made", "gone"]) r.indexes(key, pods, `it has ${pods} pods`);
    const inner = isObj(a.inner) ? a.inner : void 0;
    if (!inner && ["inner", "innerMade", "innerMark", "innerGone"].some((x) => x in ch)) {
      out.push('inner/innerMade/innerMark/innerGone need an "inner" cluster on the actor');
    } else if (inner) {
      const m = size(or(inner.pods, []));
      r.index("innerMark", m, "inner pods");
      for (const key of ["innerMade", "innerGone"]) r.indexes(key, m, `the inner cluster has ${m} pods`);
    }
    return out;
  },
  browser(_a, ch) {
    return [null, "", ...LOCKS].includes(ch.lock ?? null) ? [] : [`lock ${repr(ch.lock)} is "ok" (a padlock) or "warn" ("Not secure")`];
  },
  file(a, ch) {
    const out = [];
    const m = count(a, "lines");
    rules(ch, out).count("show", m, `it has ${m} lines`);
    const hi = ch.hi;
    const range = Array.isArray(hi) && hi.length === 2 && hi.every((x) => isIndex(x, m)) && hi[0] <= hi[1];
    if (hi !== void 0 && hi !== null && !(isIndex(hi, m) || range)) out.push(`hi ${repr(hi)} is a line index or [first, last] of its ${m} lines`);
    const lim = truthy(a.from) ? FILE_NUM_CHARS : FILE_CHARS;
    const text = or(ch.text, {});
    if (isObj(text)) {
      for (const [i, v] of Object.entries(text)) {
        if (!(/^\d+$/.test(i) && Number(i) < m)) out.push(`text for line ${repr(i)}: it has ${m} lines`);
        else if (tooLong(v, lim)) out.push(`text "${str2(v)}" is ${len(str2(v))} chars (max ${lim})`);
      }
    }
    return out;
  },
  chat(a, ch) {
    const out = [];
    const r = rules(ch, out);
    const m = count(a, "messages");
    r.index("hi", m, "messages");
    r.count("show", m, `it has ${m} messages`);
    return out;
  },
  queue(a, ch) {
    const out = [];
    const slots = or(a.slots, 6);
    const room = isInt(slots) ? Math.min(QUEUE_SLOTS, slots) : QUEUE_SLOTS;
    rules(ch, out).count("fill", room, `it draws ${room} places`);
    return [...out, ...noteIssues(ch)];
  },
  gauge(_a, ch) {
    const out = [];
    for (const key of ["used", "want"]) if (key in ch && !(isNumber(ch[key]) && Number(ch[key]) >= 0)) out.push(`${key} ${repr(ch[key])} is a number`);
    return [...noteIssues(ch), ...out];
  },
  terminal(a, ch) {
    const out = [];
    const r = rules(ch, out);
    const m = count(a, "lines");
    r.index("hi", m, "lines");
    r.count("show", m, `it has ${m} lines`);
    return out;
  },
  app(a, ch) {
    const out = [];
    const r = rules(ch, out);
    if ("screen" in ch && !screensOf(a).includes(ch.screen)) out.push(`screen ${repr(ch.screen)} does not exist (${screensOf(a).join(", ")})`);
    if (![null, "", ...PANES].includes(ch.pane ?? null)) out.push(`pane ${repr(ch.pane)} is "picture" or "chat" (the detail page; none: cards and timeline)`);
    const chats = appList(a, "chat", "chat").length, cards = appList(a, "cards", "findings").length, events = appList(a, "timeline", "timeline").length;
    r.count("chat", chats, `the actor has ${chats} chat messages`);
    r.index("newChat", chats, "chat messages");
    if (tooLong(get(ch, "typing"), APP_CHAT_CHARS)) out.push(`typing "${str2(ch.typing)}" is over ${APP_CHAT_CHARS} chars`);
    for (const key of ["picture", "desktop"]) r.long(key, PICTURE_CHARS, `is over ${PICTURE_CHARS} chars`);
    const pages = or(a.pages, {});
    const most = Math.max(0, ...isObj(pages) ? Object.values(pages).filter(isObj).map((p) => size(or(p.rows, []))) : []);
    r.count("rows", most, `its pages have at most ${most} rows`);
    r.index("hiRow", most, "page rows");
    r.count("findings", cards, `it has ${cards} cards`);
    r.count("cards", cards, `it has ${cards} cards`);
    r.count("events", events, `it has ${events} timeline rows`);
    r.index("newFinding", cards, "cards");
    r.index("newCard", cards, "cards");
    r.index("newEvent", events, "timeline rows");
    r.long("status", STATUS_CHARS, `is over ${STATUS_CHARS} chars`);
    if (![null, ...TONES].includes(ch.tone ?? null)) out.push(`tone ${repr(ch.tone)} is one of ${TONES.join(", ")}`);
    return out;
  }
};
function noteIssues(ch) {
  return tooLong(get(ch, "note"), NOTE_CHARS) ? [`note "${str2(ch.note)}" is ${len(str2(ch.note))} chars (max ${NOTE_CHARS}; one line)`] : [];
}
function screensOf(a) {
  return [...SCREENS, ...SCREEN_ALIAS, ...isObj(a.pages) ? Object.keys(a.pages) : []];
}
var screen = (a, key) => isObj(a[key]) ? a[key] : {};
function appList(a, key, old) {
  const d = screen(a, "detail")[key];
  const v = d !== void 0 && d !== null ? d : a[old];
  return Array.isArray(v) ? v : [];
}
var SCREEN_FIELDS = [
  ["dialog", ["tab", "title", "item", "lines", "button"]],
  ["detail", ["tab", "title", "status", "tone", "empty", "cards", "timeline", "picture", "placeholder", "chat"]],
  ["signin", ["title", "notice", "provider", "button"]]
];
function appIssues(a) {
  const c = collector();
  const long = (what, v, n) => {
    if (tooLong(v, n)) c.problem(`${what} "${str2(v)}" is ${len(str2(v))} chars (max ${n})`);
  };
  const brand = str2(or(a.brand, "App"));
  const logo = str2(or(a.logo, [...brand].slice(0, 1).join("")));
  if (len(logo) > 2) c.problem(`logo "${logo}" is 1 or 2 letters`);
  let tabs = get(a, "tabs", []);
  if (!Array.isArray(tabs) || tabs.length > MAX_TABS || !tabs.every((x) => typeof x === "string")) {
    c.problem(`"tabs" is a list of at most ${MAX_TABS} short names`);
    tabs = [];
  }
  for (const x of tabs) long("tab", x, TAB_CHARS);
  const tabsPx = tabs.length ? tabs.reduce((w, x) => w + TAB_PX * len(x), 0) + TAB_GAP * (tabs.length - 1) : 0;
  const top = (len(logo) > 1 ? 28 : 20) + 16 + BRAND_PX * len(brand) + tabsPx;
  if (top > TOP_PX) c.problem(`brand "${brand}" and tabs ${repr(tabs)} are about ${pyRound(top)} px in the top bar (${TOP_PX} fit): shorter names or fewer tabs`);
  if (truthy(a.screen) && !screensOf(a).includes(a.screen)) c.problem(`screen ${repr(a.screen)} does not exist (${screensOf(a).join(", ")})`);
  const onTabs = (tab) => tab === void 0 || tab === null || !tabs.length || tabs.includes(tab);
  for (const [key, allowed] of SCREEN_FIELDS) {
    if (key in a && !isObj(a[key])) c.problem(`"${key}" is an object (${sorted(allowed).join(", ")})`);
    const extra = Object.keys(screen(a, key)).filter((x) => !allowed.includes(x));
    if (extra.length) c.problem(`${key}: ${sorted(extra).join(", ")} is not read (it reads ${sorted(allowed).join(", ")})`);
    const tab = screen(a, key).tab;
    if (!onTabs(tab)) c.problem(`${key} tab ${repr(tab)} is not one of its tabs ${repr(tabs)}`);
  }
  for (const [key, n] of OLD_CHARS) long(key, get(a, key), n);
  const dg = screen(a, "dialog"), dt = screen(a, "detail"), sg = screen(a, "signin");
  for (const [key, n] of DIALOG_CHARS) long(`dialog ${key}`, get(dg, key), n);
  dialogLines(get(dg, "lines", []), c);
  for (const [key, n] of DETAIL_CHARS) long(`detail ${key}`, get(dt, key), n);
  const title = str2(or(dt.title, or(dg.item, or(a.test, "Item"))));
  const status = str2(or(dt.status, or(a.status, "New")));
  if (len(title) + len(status) > TITLE_CHIP) c.problem(`detail title "${title}" and status "${status}" share one line: ${len(title) + len(status)} chars (max ${TITLE_CHIP})`);
  if (![null, ...TONES].includes(dt.tone ?? null)) c.problem(`detail tone ${repr(dt.tone)} is one of ${TONES.join(", ")}`);
  const cards = appList(a, "cards", "findings");
  if (cards.length > 2) c.warning(`${cards.length} cards; the detail page draws the first 2`);
  for (const x of cards) {
    if (!isObj(x)) c.problem('a card is {"sev"?: "low" | "medium" | "high" | "critical", "title": "…"}');
    else long("card", get(x, "title"), CARD_CHARS);
  }
  for (const e of appList(a, "timeline", "timeline")) long("timeline row", e, TIMELINE_CHARS);
  for (const m of appList(a, "chat", "chat")) {
    if (!(isObj(m) && APP_CHAT_FROM.includes(m.from) && typeof m.text === "string")) c.problem('a chat message is {"from": "me" | "them", "text": "…"}');
    else long("chat message", m.text, APP_CHAT_CHARS);
  }
  for (const [key, n] of SIGNIN_CHARS) long(`signin ${key}`, get(sg, key), n);
  const st = str2(or(sg.title, `Sign in to ${brand}`));
  if (len(st) > SIGNIN_TITLE) c.problem(`the sign-in title "${st}" is ${len(st)} chars (max ${SIGNIN_TITLE}): a shorter brand or signin.title`);
  pageIssues(get(a, "pages", {}), onTabs, tabs, c);
  return c.issues;
}
function dialogLines(lines, c) {
  if (!Array.isArray(lines) || lines.length > DIALOG_LINES) {
    c.problem(`dialog "lines" is a list of at most ${DIALOG_LINES} [label, value] pairs`);
    return;
  }
  for (const ln of lines) {
    if (!(Array.isArray(ln) && ln.length === 2)) c.problem('dialog: a line is ["label", "value"]');
    else if (tooLong(ln[0], LINE_KEY) || tooLong(ln[1], LINE_VALUE)) c.problem(`dialog line ${repr(ln)}: label max ${LINE_KEY} chars, value max ${LINE_VALUE}`);
  }
}
function pageIssues(pages, onTabs, tabs, c) {
  if (!isObj(pages)) {
    c.problem('"pages" is {name: {tab, title, chip?, tone?, banner?, rows: [[label, value]], button?}}');
    return;
  }
  const long = (what, v, n) => {
    if (tooLong(v, n)) c.problem(`${what} "${str2(v)}" is ${len(str2(v))} chars (max ${n})`);
  };
  for (const [name, pg] of Object.entries(pages)) {
    if (SCREENS.includes(name) || SCREEN_ALIAS.includes(name) || !isObj(pg)) {
      c.problem(`page ${repr(name)} must be an object with a name other than ${[...SCREENS, ...SCREEN_ALIAS].join(", ")}`);
      continue;
    }
    for (const [key, lim] of PAGE_CHARS) long(`page ${name} ${key}`, get(pg, key), lim);
    if (!onTabs(pg.tab)) c.problem(`page ${name} tab ${repr(pg.tab)} is not one of its tabs ${repr(tabs)}`);
    if (len(str2(or(pg.title, name))) + len(str2(get(pg, "chip"))) > TITLE_CHIP) c.problem(`page ${name}: title and chip share one line (max ${TITLE_CHIP} chars together)`);
    if (![null, ...TONES].includes(pg.tone ?? null)) c.problem(`page ${name} tone ${repr(pg.tone)} is one of ${TONES.join(", ")}`);
    long(`page ${name} banner`, get(pg, "banner"), PAGE_BANNER);
    const rows = get(pg, "rows", []);
    const n = size(rows);
    if (n > PAGE_ROWS) c.problem(`page ${name} has ${n} rows (the page draws ${PAGE_ROWS})`);
    const banner = truthy(pg.banner), button = truthy(pg.button);
    if (n + Number(banner) + Number(button) > PAGE_ITEMS) {
      c.problem(`page ${name}: ${n} rows${banner ? ", a banner" : ""}${button ? ", a button" : ""}: ${PAGE_ITEMS} of these fit under the title`);
    }
    for (const r of iter(rows)) {
      if (!(Array.isArray(r) && r.length === 2)) c.problem(`page ${name}: a row is ["label", "value"]`);
      else if (tooLong(r[0], PAGE_KEY) || tooLong(r[1], PAGE_VALUE)) c.problem(`page ${name} row ${repr(r)}: label max ${PAGE_KEY} chars, value max ${PAGE_VALUE}`);
    }
  }
}

// cli/journey/shape.ts
var KINDS = ["system", "module", "function", "external", "store"];
var ANCHOR_TEXT = ["text", "before", "after", "head", "tail", "hash"];
var LISTS = [["links", ["phrase", "file", "start", "end"]], ["values", ["name", "value", "file", "line"]]];
var isStr = (v) => typeof v === "string";
function anchorOk(a) {
  if (!isObj(a) || !ANCHOR_TEXT.every((k) => isStr(k in a ? a[k] : ""))) return false;
  return a.v !== 3 || isStr(a.head) && isInt(a.lines);
}
function shapeProblems(j) {
  const problems = [];
  const upgrades = [];
  for (const key of ["nodes", "edges", "steps"]) if (!Array.isArray(j[key])) problems.push(`"${key}" must be a list`);
  if (!isStr(j.title)) problems.push('"title" must be a string (meta title "…")');
  for (const key of ["question", "summary", "commit"]) if (key in j && !isStr(j[key])) problems.push(`"${key}" must be a string`);
  if (problems.length) return { problems, upgrades };
  j.nodes.forEach((n, i) => nodeShape(n, i, problems, upgrades));
  j.edges.forEach((e, i) => edgeShape(e, i, problems));
  j.steps.forEach((s, i) => stepShape(s, i + 1, problems, upgrades));
  return { problems, upgrades };
}
function nodeShape(n, i, problems, upgrades) {
  if (!isObj(n) || !isStr(n.id) || !n.id) {
    problems.push(`nodes[${i}]: a box is an object with a string "id"`);
    return;
  }
  const name = `box ${n.id}`;
  if (!KINDS.includes(n.kind)) problems.push(`${name}: kind ${repr(n.kind)} is not one of ${KINDS.join(", ")}`);
  if (!isStr(n.label)) problems.push(`${name}: "label" must be a string`);
  for (const key of ["blurb", "summary", "path", "parent"]) if (key in n && !isStr(n[key])) problems.push(`${name}: "${key}" must be a string`);
  if (!("at" in n)) return;
  const at = n.at;
  if (isStr(at)) {
    const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(at.trim());
    if (!m) {
      problems.push(`${name}: "at" is the string ${repr(at)}; it must be {file, start, end, anchor}: remove the line, then \`set ${n.id} at <file:start-end>\``);
      return;
    }
    const [f, a, b] = [m[1], Number(m[2]), Number(m[3] ?? m[2])];
    upgrades.push({
      node: i,
      file: f,
      start: a,
      end: b,
      at: true,
      note: `${name}: "at" was hand-written as the string "${at}"; it must be {file, start, end, anchor}: run \`set ${n.id} at ${f}:${a}-${b}\` (never edit the file by hand)`
    });
  } else if (!(isObj(at) && isStr(at.file) && isInt(at.start) && isInt(at.end))) {
    problems.push(`${name}: "at" must be {file, start, end, anchor} with whole line numbers: remove it, then \`set ${n.id} at <file:start-end>\``);
  } else if (!anchorOk(at.anchor)) {
    upgrades.push({
      node: i,
      file: at.file,
      start: at.start,
      end: at.end,
      note: `${name}: "at" has no anchor (hand-written): run \`set ${n.id} at ${at.file}:${at.start}-${at.end}\``
    });
  }
}
function edgeShape(e, i, problems) {
  if (!isObj(e) || !["from", "to", "label"].every((k) => isStr(e[k]))) {
    problems.push(`edges[${i}]: an edge is an object with string "from", "to" and "label" (rewrite it with \`edge\`)`);
  } else if ("detail" in e && !isStr(e.detail)) {
    problems.push(`edge ${e.from} -> ${e.to}: "detail" must be a string`);
  }
}
function stepShape(st, k, problems, upgrades) {
  const name = `step ${k}`;
  if (!isObj(st)) {
    problems.push(`${name}: a step is an object`);
    return;
  }
  for (const key of ["title", "node", "file"]) if (!isStr(st[key])) problems.push(`${name}: "${key}" must be a string`);
  for (const key of ["lead", "details", "id"]) if (key in st && !isStr(st[key])) problems.push(`${name}: "${key}" must be a string`);
  const r = st.range;
  if (isStr(r) || !(isObj(r) && isInt(r.start) && isInt(r.end))) {
    problems.push(`${name}: "range" must be {start, end} with whole line numbers (and "file" beside it): put the old value back, then \`restep ${k} range <file> <start> <end>\``);
  } else if (!anchorOk(st.anchor) && isStr(st.file)) {
    upgrades.push({
      step: k - 1,
      file: st.file,
      start: r.start,
      end: r.end,
      note: `${name}: no anchor (hand-written range): run \`restep ${k} range ${st.file} ${r.start} ${r.end}\``
    });
  }
  for (const [key, need] of LISTS) {
    const ok = (x) => isObj(x) && need.every((f) => (["start", "end", "line"].includes(f) ? isInt : isStr)(x[f]));
    if (key in st && !(Array.isArray(st[key]) && st[key].every(ok))) {
      problems.push(`${name}: "${key}" must be a list of {${need.join(", ")}, text} objects (rewrite them with \`${key.slice(0, -1)}\`, after removing the line)`);
    }
  }
  if ("scene" in st && !(isObj(st.scene) && Array.isArray(st.scene.actors) && Array.isArray(st.scene.beats))) {
    problems.push(`${name}: "scene" must be {actors, wires, beats} (remove it, then \`scene ${k}\` < the JSON)`);
  }
  if ("refs" in st && !(Array.isArray(st.refs) && st.refs.every(isStr))) {
    problems.push(`${name}: "refs" must be a list of strings, each one sentence with a path:line in it (restep ${k} refs "…")`);
  }
}

// cli/journey/index.ts
function answer(r) {
  switch (r.op) {
    case "shape":
      return shapeProblems(r.journey);
    case "scene":
      return sceneIssues(r.step, r.scene);
    case "mark":
      return checkMark(r.mark, r.file, r.doc ?? null, r.onMissing ?? "drop");
    case "podcast":
      return checkPodcast(r);
    case "place": {
      const lines = r.lines ?? fileLines(r.repo, r.file);
      return lines ? place(lines, r.anchor, r.hint) : null;
    }
    case "line": {
      const lines = r.lines ?? fileLines(r.repo, r.file);
      return lines ? lineOf(lines, r.line, r.text) : -1;
    }
    default:
      throw new Error(`unknown request "${r.op}"`);
  }
}
function serve() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let out;
    try {
      out = { ok: answer(JSON.parse(line)) };
    } catch (e) {
      out = { error: e.message };
    }
    process.stdout.write(JSON.stringify(out) + "\n");
  });
}
serve();
export {
  answer
};
