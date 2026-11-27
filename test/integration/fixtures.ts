// Builders for the files the integration tests write: journeys (format v2), notes, the request file, the skill's
// stand-in, and each suite's workspace (the check's git repository too). Each takes the fields its test is about and
// fills in the rest, so a call shows only what matters (the defaults-plus-overrides style of
// test/checkModel.test.ts). The podcast's files and step scenes have their builders in main/podcast/fixtures.ts. No
// VS Code API here: run.ts uses it too.
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'

/** The repository's root (this file is compiled to out/test/integration/). */
export const REPO_ROOT = path.resolve(__dirname, '../../..')
/** A file under test/fixtures/. */
export const fixturePath = (rel: string) => path.join(REPO_ROOT, 'test', 'fixtures', rel)

export interface StepFixture {
  id: string
  title: string
  node: string
  file: string
  range: { start: number; end: number }
  lead: string
  refs: string[]
  [more: string]: unknown
}

/** A journey step on `file` lines `start`-`end`: id `<file's name>-<start>`, title "Line <start>", lead "Here.". */
export function step(file: string, start: number, end = start, over: Partial<StepFixture> = {}): StepFixture {
  return { id: `${path.basename(file).replace(/\W/g, '')}-${start}`, title: `Line ${start}`, node: 'f', file, range: { start, end }, lead: 'Here.', refs: [], ...over }
}

export interface NodeFixture { id: string; kind: string; label: string; summary?: string; parent?: string; [more: string]: unknown }

/** A function box per node the steps name (labelled by its id), unless `nodes` says otherwise. */
const nodesOf = (steps: StepFixture[]): NodeFixture[] => [...new Set(steps.map((s) => s.node))].map((id) => ({ id, kind: 'function', label: id }))

/** A journey file's content: version 2, `id`, the steps; question, title and summary made up unless given. */
export function journey(id: string, steps: StepFixture[], over: { question?: string; title?: string; summary?: string; nodes?: NodeFixture[]; edges?: object[]; [more: string]: unknown } = {}) {
  return { version: 2, id, question: `How does ${id} work?`, title: id, summary: '', nodes: nodesOf(steps), edges: [], ...over, steps }
}

/** Writes a journey to `<dir>/<id>.json` (or `name`.json); returns the path. */
export function writeJourney(dir: string, j: { id: string }, name = j.id): string {
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, `${name}.json`)
  fs.writeFileSync(p, JSON.stringify(j, null, 2))
  return p
}

/** A note file's content: open, on `file` line `line`, one agent message `body`. */
export function agentNote(file: string, line: number | undefined, body: string, over: object = {}) {
  return { file, ...(line === undefined ? {} : { range: { start: line, end: line } }), status: 'open', messages: [{ author: 'claude', role: 'agent', body }], ...over }
}

/** Writes a note to `<notesDir>/<id>.json`; returns the path. */
export function writeNote(notesDir: string, id: string, note: object): string {
  const p = path.join(notesDir, `${id}.json`)
  fs.writeFileSync(p, JSON.stringify(note, null, 2))
  return p
}

/** A source file of `lines` (a trailing newline added). */
export function writeLines(file: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.join('\n') + '\n')
}

// ---------- the request file (.code-notes/.request.json, answered in .result.json: src/write/requests.ts) ----------

export const requestFile = (notesDir: string) => path.join(notesDir, '.request.json')
export const resultFile = (notesDir: string) => path.join(notesDir, '.result.json')

/** Writes a request, as a script would: `request` stamped with `at` (now by default). */
export function writeRequest(notesDir: string, request: object, at = new Date()): void {
  fs.writeFileSync(requestFile(notesDir), JSON.stringify({ at: at.toISOString(), ...request }))
}

/** What the script reads back: the result file, or undefined while it is missing or half-written. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readResult(notesDir: string): any {
  try { return JSON.parse(fs.readFileSync(resultFile(notesDir), 'utf8')) } catch { return undefined }
}

// ---------- the code-journey skill ----------

/** The repository's own copy of the code-journey skill, its script a stand-in; returns its folder (<ws>/.claude/skills/code-journey). */
export function writeSkillStandIn(ws: string): string {
  const skill = path.join(ws, '.claude', 'skills', 'code-journey')
  fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(skill, 'scripts', 'journey.py'), '# stand-in\n')
  return skill
}

// ---------- each suite's workspace ----------

/** A new temp folder named `prefix…`. */
const tempDir = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix))

/** The main suite's workspace: src/app.ts and nothing else (the tests write the rest). */
export function makeMainWorkspace(): string {
  const ws = tempDir('code-notes-ws-')
  writeLines(path.join(ws, 'src', 'app.ts'), ['import { readToken, use } from "./lib"', 'export function main() {', '  const token = readToken()', '  use(token)', '  return 0', '}'])
  return ws
}

/** The Restricted Mode suite's workspace: a source file, a folder setting naming another claude, the skill's stand-in. */
export function makeUntrustedWorkspace(): string {
  const ws = tempDir('code-notes-untrusted-')
  writeLines(path.join(ws, 'src', 'app.ts'), ['export function main() {', '  return 0', '}'])
  fs.mkdirSync(path.join(ws, '.vscode'))
  fs.writeFileSync(path.join(ws, '.vscode', 'settings.json'), JSON.stringify({ 'codeNotes.claude.path': path.join(ws, 'evil.sh') }))
  writeSkillStandIn(ws)
  return ws
}

// ---------- the check's git repository ----------

/** The branch the check suite asks about (its change: order limits), and the branch its tour tests make. */
export const CHECK_BRANCH = 'feat/limits'
export const CHECK_TOUR_BRANCH = 'feat/tour'
/** Who made the fixture repository's commits (and is the git user while the suite runs). */
export const CHECK_AUTHOR = { name: 'Ada', email: 'ada@example.com' }

/**
 * The check suite's workspace: examples/shop committed on main by CHECK_AUTHOR, then CHECK_BRANCH with the change
 * (api/limits.js), the test's own .vscode/ excluded from git, and a bare remote to push to. Returns the workspace.
 */
export function makeCheckRepo(): string {
  const ws = tempDir('code-notes-check-')
  fs.cpSync(path.join(REPO_ROOT, 'examples', 'shop'), ws, { recursive: true })
  const { name, email } = CHECK_AUTHOR
  const env = { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email }
  const g = (...a: string[]) => execFileSync('git', a, { cwd: ws, env })
  g('init', '-q', '-b', 'main')
  g('config', 'user.name', name)
  g('config', 'user.email', email)
  g('add', '-A')
  g('commit', '-qm', 'shop')
  g('checkout', '-qb', CHECK_BRANCH)
  fs.copyFileSync(fixturePath('check/limits.js'), path.join(ws, 'api', 'limits.js'))
  g('add', '-A')
  g('commit', '-qm', 'limits')
  fs.appendFileSync(path.join(ws, '.git', 'info', 'exclude'), '.vscode/\n')
  const remote = tempDir('code-notes-check-remote-')
  execFileSync('git', ['init', '-q', '--bare'], { cwd: remote })
  g('remote', 'add', 'origin', remote)
  return ws
}
