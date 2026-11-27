// Writing a journey for a question nobody wrote one for: Claude Code with the code-journey skill writes it into a
// staging folder; it is checked, then moved into the journeys folder.

import * as vscode from 'vscode'
import { journeys, tour } from './ports'
import * as fs from 'fs'
import * as path from 'path'
import { log } from '../platform/host'
import { fireAndForget, showError } from '../platform/run'
import { AskResult } from '../platform/agent/claude'
import { isObject } from '../platform/agent/json'
import { readJsonFile, writeJsonFile } from '../platform/jsonFile'
import { relPath } from '../platform/documents'
import { LoadedJourney } from '../journeys/steps'
import { journeysFolderName } from '../journeys/journeys'
import { shortQ } from '../core/text'
import { elapsed as clock, minutes } from '../core/clock'
import { showClarify } from './clarify'
import { journeyJob, journeyPy, JourneyRunReady, prepareJourneyRun, reportNotReady, runJourneySkill } from './claudeRun'
import { answeredBy, journeyPrompt, journeyRules } from './prompts'
import { clarified } from './questions'

interface WriteOptions { model?: string; resume?: { session: string; reply: string } }

/**
 * A journey for a question nobody wrote one for. With the `claude` CLI: Claude Code headless with the
 * code-journey skill (read-only tools, Bash only for the skill's own scripts), only in a trusted folder.
 * It writes into a staging folder; the journey moves into the journeys folder once `journey.py check` passes,
 * stamped with the model, and is announced. Claude may answer with a question instead: shown with a
 * reply box that goes on in the same session. Without the CLI: a ready prompt on the clipboard.
 */
export async function writeJourney(question: string, o: WriteOptions = {}): Promise<LoadedJourney | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) return undefined
  const ownAgent = `Use the code-journey skill to answer: ${question}`
  const ready = await prepareJourneyRun(folder, {
    what: 'write journeys', model: o.model,
    ownAgent: { prompt: ownAgent, notice: `Copied a prompt for your agent: "${ownAgent}"` },
  })
  if (!ready.ok) return reportNotReady(ready)
  const jf = journeysFolderName()
  const prompt = o.resume
    ? `${o.resume.reply}\n\n${journeyRules(ready.skill, ready.staging.stage, jf)}`
    : journeyPrompt(question, ready.skill, ready.staging.stage, jf, ready.bundled)
  // Listed by the question as your answer made it, so the job you answered is the one you see going on.
  const asked = o.resume ? clarified(question, o.resume.reply) : question
  const job = journeyJob(ready, 'write', asked)
  log().info(`journey: Claude (${job.model}) is writing one for "${asked}"`)
  const res = await runJourneySkill(job, `Writing: ${shortQ(asked)}`, ready, {
    prompt, resume: o.resume?.session, cache: true,
  })
  const took = Date.now() - job.started
  const files = await stagedJourneys(ready.staging.dir)
  if (res.cancelled || res.error || !files.length) {
    ready.staging.cleanup()
    if (res.cancelled) log().info('journey: writing cancelled')
    else if (res.error) fireAndForget(showError(`Claude couldn't write the journey: ${res.error}`), 'writeJourney: showError')
    else return noJourneyWritten(question, res, o)
    return undefined
  }
  if (files.length > 1) {
    log().warn(`journey: Claude wrote ${files.length} journeys (${files.join(', ')}); only ${files[0]} is kept`)
  }
  const written = await checkStaged(ready, files[0], job.model)
  if (!written) return undefined
  const { name, made } = await install(path.join(ready.repo, jf), ready, files[0])
  const title = made?.j.title ?? written.title ?? name
  log().info(`journey: written: "${title}" (${jf}/${name}.json) in ${clock(took)} by ${job.model}`)
  announce(title, took, made)
  if (made && !tour().touring()) await tour().walkJourney(made)
  return made
}

/** One notice; Open walks the journey (the map opens by itself unless you are walking another journey). */
function announce(title: string, took: number, made: LoadedJourney | undefined): void {
  const said = vscode.window.showInformationMessage(`Journey written: ${title} · ${minutes(took)}`, 'Open').then((b) => {
    if (b && made) fireAndForget(tour().walkJourney(made), 'writeJourney: walkJourney')
  })
  fireAndForget(said, 'writeJourney: window.showInformationMessage')
}

/** The journey files Claude wrote into the staging folder, newest first. */
async function stagedJourneys(dir: string): Promise<string[]> {
  const names = (await fs.promises.readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json'))
  const at = await Promise.all(names.map((f) => fs.promises.stat(path.join(dir, f)).then((s) => s.mtimeMs, () => 0)))
  return names.map((f, i) => ({ f, at: at[i] })).sort((a, b) => b.at - a.at).map((x) => x.f)
}

/**
 * Claude wrote no journey. One already answers it (its reply's ANSWERED_BY line, else a journeys/<slug>.json it
 * names): that one opens. Or Claude asks something first: shown with a reply box (not an error).
 */
async function noJourneyWritten(question: string, res: AskResult, o: WriteOptions): Promise<LoadedJourney | undefined> {
  const named = journeyNamed(res.text)
  if (named) {
    const where = relPath(named.folder, named.uri)
    log().info(`journey: Claude says "${named.j.title}" (${where}) already answers "${question}": opening it`)
    const said = vscode.window.showInformationMessage(`A journey already answers this: ${named.j.title}`)
    fireAndForget(said, 'writeJourney: window.showInformationMessage')
    await tour().walkJourney(named)
    return named
  }
  if (res.text.trim() && res.sessionId) {
    log().info(`journey: Claude asks before writing "${question}": ${res.text.trim().replace(/\s+/g, ' ').slice(0, 300)}`)
    await showClarify(question, res.sessionId, res.text.trim(), o.model)
    return undefined
  }
  fireAndForget(showError('Claude finished without writing a journey.'), 'writeJourney: showError')
  return undefined
}

/** A journey file named in prose ("… is already in journeys/<slug>.json"), for a reply without an ANSWERED_BY line. */
const NAMED_IN_PROSE = /([\w./-]*journeys)\/([\w.-]+?)\.json/g

/** The listed journey Claude's reply says answers the question: by its path, else by its id. */
function journeyNamed(reply: string): LoadedJourney | undefined {
  const all = [...journeys().list.values()]
  const file = answeredBy(reply)
  const files = file ? [file] : [...reply.matchAll(NAMED_IN_PROSE)].map((m) => `${m[1].replace(/^\.\//, '')}/${m[2]}.json`)
  for (const f of files) {
    const id = path.basename(f, '.json')
    const found = all.find((x) => x.j.id === id && relPath(x.folder, x.uri) === f) ?? all.find((x) => x.j.id === id)
    if (found) return found
  }
  return undefined
}

/** The staged journey stamped with who wrote it (journey.py's own command; set directly when that one can't), then
 *  checked. Its content when it passes; undefined (said, and left in the staging folder) when it doesn't. */
async function checkStaged(r: JourneyRunReady, file: string, model: string): Promise<{ title?: string } | undefined> {
  const slug = file.replace(/\.json$/, '')
  const staged = path.join(r.staging.dir, file)
  await journeyPy(r.skill, r.repo, r.staging.stage, ['meta', r.repo, slug, 'model', model])
  const j = await readJsonFile(staged)
  if (isObject(j) && j.model !== model) await writeJsonFile(staged, { ...j, model })
  const chk = await journeyPy(r.skill, r.repo, r.staging.stage, ['check', r.repo, slug, 'quiet'])
  if (chk.code === 0 && isObject(j)) return { title: typeof j.title === 'string' ? j.title : undefined }
  log().error(`journey: "${slug}" didn't pass journey.py check; left in ${r.staging.stage}/:\n${chk.out}`)
  const said = showError('the journey Claude wrote didn\'t pass its check, so it wasn\'t added.', 'Show Output')
    .then((b) => { if (b) log().show(true) })
  fireAndForget(said, 'writeJourney: showError')
  return undefined
}

const there = (file: string) => fs.promises.access(file).then(() => true, () => false)

/** Into the journeys folder under a free name, all at once (the list never sees it half-written); then the journey
 *  as read from there. */
async function install(destDir: string, r: JourneyRunReady, file: string): Promise<{ name: string; made?: LoadedJourney }> {
  const slug = file.replace(/\.json$/, '')
  const staged = path.join(r.staging.dir, file)
  await fs.promises.mkdir(destDir, { recursive: true })
  const name = await freeName(destDir, slug)
  if (name !== slug) {
    const j = await readJsonFile(staged)
    if (isObject(j)) await writeJsonFile(staged, { ...j, id: name })
  }
  const dest = path.join(destDir, `${name}.json`)
  const key = vscode.Uri.file(dest).toString()
  // Listening before the move: the file watcher's read of it is the one to wait for.
  const listed = listedSoon(key)
  await fs.promises.rename(staged, dest)
  r.staging.cleanup()
  // Read here only when the watcher is late (reading it first would race the watcher's own events for the file).
  const made = (await listed)
    ?? (await journeys().reload(vscode.Uri.file(dest)))
    ?? journeys().all().find((x) => x.j.id === name)
  return { name, made }
}

/** `slug`, or `slug-2`, `slug-3`… : the first name no journey file in `dir` has. */
async function freeName(dir: string, slug: string): Promise<string> {
  let name = slug
  for (let k = 2; await there(path.join(dir, `${name}.json`)); k++) name = `${slug}-${k}`
  return name
}

/** How long a journey just moved in may take to be listed by the file watcher (ms). */
const LISTED_WITHIN_MS = 3000

/** The journey `key` once the journeys list has it (it changes as the watcher reads files); undefined after the wait. */
function listedSoon(key: string): Promise<LoadedJourney | undefined> {
  return new Promise((resolve) => {
    const done = (lj: LoadedJourney | undefined) => {
      clearTimeout(timer)
      sub.dispose()
      resolve(lj)
    }
    const sub = journeys().onDidChange(() => {
      const lj = journeys().list.get(key)
      if (lj) done(lj)
    })
    const timer = setTimeout(() => done(journeys().list.get(key)), LISTED_WITHIN_MS)
  })
}
