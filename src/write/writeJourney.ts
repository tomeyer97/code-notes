// Writing a journey for a question nobody wrote one for: Claude Code with the code-journey skill writes it into a
// staging folder; it is checked, then moved into the journeys folder.

import * as vscode from 'vscode'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { journeys, log, showError } from '../app'
import { claudeAllowed } from '../ask/trust'
import { AskResult } from '../platform/agent/claude'
import { LoadedJourney } from '../journeys/steps'
import { journeysFolderName } from '../journeys/journeys'
import { shortQ } from '../core/text'
import { relPath } from '../notes/location'
import { walkJourney } from '../tour/commands'
import { walk } from '../tour/instances'
import { clock, journeyPrompt, journeyRules, minutes } from '../core/writing'
import { showClarify } from './clarify'
import { bundledSkill, cliOrClipboard, journeyPy, modelLabel, runJourneySkill, skillAndModel, Staging, stagingFolder } from './claudeRun'
import { startWriting, Writing } from './inProgress'

interface WriteOptions { model?: string; resume?: { session: string; reply: string } }

/** Waiting for a journey just moved in to be read: this many tries, this far apart (ms). */
const LOAD_TRIES = 30
const LOAD_WAIT = 100

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
  if (!claudeAllowed('write journeys')) return undefined
  const ownAgent = `Use the code-journey skill to answer: ${question}`
  const cli = await cliOrClipboard(ownAgent, `Copied a prompt for your agent: "${ownAgent}"`)
  if (!cli) return undefined
  const repo = folder.uri.fsPath
  const ready = skillAndModel(folder, NO_SKILL, o.model)
  if (!ready) return undefined
  const { skill, model } = ready
  const jf = journeysFolderName()
  const staging = stagingFolder(repo)
  const prompt = o.resume
    ? `${o.resume.reply}\n\n${journeyRules(skill, staging.stage, jf)}`
    : journeyPrompt(question, skill, staging.stage, jf, skill === bundledSkill())
  const w: Writing = { id: staging.id, question, started: Date.now(), phase: 'starting', model: modelLabel(model) }
  startWriting(w)
  log.info(`journey: Claude (${w.model}) is writing one for "${question}"${o.resume ? ' (with your answer to its question)' : ''}`)
  // journey.py's cache of the repository, when there is one: readable too.
  const cache = `${process.env.XDG_CACHE_HOME ?? `${os.homedir()}/.cache`}/code-journey`
  const extraDirs = fs.existsSync(cache) ? [cache] : []
  const res = await runJourneySkill(w, `Writing: ${shortQ(question)}`, { cli, repo, prompt, skill, model, resume: o.resume?.session, extraDirs })
  const took = Date.now() - w.started
  if (res.cancelled) {
    log.info('journey: writing cancelled')
    staging.cleanup()
    return undefined
  }
  const files = stagedJourneys(staging.dir)
  if (res.error) {
    staging.cleanup()
    void showError(`Code Notes: Claude couldn't write the journey: ${res.error}`)
    return undefined
  }
  if (!files.length) {
    staging.cleanup()
    return noJourneyWritten(question, res, o)
  }
  if (files.length > 1) log.warn(`journey: Claude wrote ${files.length} journeys (${files.join(', ')}); only ${files[0]} is kept`)
  const written = await checkStaged(skill, repo, staging, files[0], w.model)
  if (!written) return undefined
  const { name, made } = await install(path.join(repo, jf), staging, files[0])
  const title = made?.j.title ?? written.title ?? name
  log.info(`journey: written: "${title}" (${jf}/${name}.json) in ${clock(took)} by ${w.model}`)
  // One notice; the map opens by itself unless you are walking another journey.
  void vscode.window.showInformationMessage(`Journey written: ${title} · ${minutes(took)}`, 'Open').then((b) => { if (b && made) void walkJourney(made) })
  if (made && !walk.touring()) await walkJourney(made)
  return made
}

const NO_SKILL = 'Code Notes: the code-journey skill isn\'t in this repository (.claude/skills/code-journey) or in ~/.claude/skills, so Claude can\'t write a journey here.'

/** The journey files Claude wrote into the staging folder, newest first. */
function stagedJourneys(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs)
  } catch { return [] }
}

/**
 * Claude wrote no journey. One already answers it ("… is already in journeys/<slug>.json"): that one opens. Or Claude
 * asks something first: shown with a reply box (not an error).
 */
async function noJourneyWritten(question: string, res: AskResult, o: WriteOptions): Promise<LoadedJourney | undefined> {
  const all = [...journeys.list.values()]
  const named = [...res.text.matchAll(/([\w./-]*journeys)\/([\w.-]+?)\.json/g)]
    .map((m) => all.find((x) => x.j.id === m[2] && relPath(x.folder, x.uri) === `${m[1].replace(/^\.\//, '')}/${m[2]}.json`) ?? all.find((x) => x.j.id === m[2]))
    .find((x): x is LoadedJourney => !!x)
  if (named) {
    log.info(`journey: Claude says "${named.j.title}" (${relPath(named.folder, named.uri)}) already answers "${question}": opening it`)
    void vscode.window.showInformationMessage(`A journey already answers this: ${named.j.title}`)
    await walkJourney(named)
    return named
  }
  if (res.text.trim() && res.sessionId) {
    log.info(`journey: Claude asks before writing "${question}": ${res.text.trim().replace(/\s+/g, ' ').slice(0, 300)}`)
    await showClarify(question, res.sessionId, res.text.trim(), o.model)
    return undefined
  }
  void showError('Code Notes: Claude finished without writing a journey.')
  return undefined
}

const readJson = (file: string) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return undefined } }
const writeJson = (file: string, v: unknown) => fs.writeFileSync(file, JSON.stringify(v, null, 2) + '\n')

/** The staged journey stamped with who wrote it (journey.py's own command; set directly when that one can't), then
 *  checked. Its content when it passes; undefined (said, and left in the staging folder) when it doesn't. */
async function checkStaged(skill: string, repo: string, staging: Staging, file: string, model: string): Promise<{ title?: string } | undefined> {
  const slug = file.replace(/\.json$/, '')
  const staged = path.join(staging.dir, file)
  await journeyPy(skill, repo, staging.stage, ['meta', repo, slug, 'model', model])
  const j = readJson(staged)
  if (j && j.model !== model) { j.model = model; writeJson(staged, j) }
  const chk = await journeyPy(skill, repo, staging.stage, ['check', repo, slug, 'quiet'])
  if (chk.code === 0 && j) return j
  log.error(`journey: "${slug}" didn't pass journey.py check; left in ${staging.stage}/:\n${chk.out}`)
  void showError('Code Notes: the journey Claude wrote didn\'t pass its check, so it wasn\'t added.', 'Show Output').then((b) => { if (b) log.show(true) })
  return undefined
}

/** Into the journeys folder under a free name, all at once (the list never sees it half-written); then the journey
 *  as read from there. */
async function install(destDir: string, staging: Staging, file: string): Promise<{ name: string; made?: LoadedJourney }> {
  const slug = file.replace(/\.json$/, '')
  const staged = path.join(staging.dir, file)
  fs.mkdirSync(destDir, { recursive: true })
  let name = slug
  for (let k = 2; fs.existsSync(path.join(destDir, `${name}.json`)); k++) name = `${slug}-${k}`
  if (name !== slug) { const j = readJson(staged); j.id = name; writeJson(staged, j) }
  const dest = path.join(destDir, `${name}.json`)
  fs.renameSync(staged, dest)
  staging.cleanup()
  const key = vscode.Uri.file(dest).toString()
  let made: LoadedJourney | undefined
  for (let i = 0; i < LOAD_TRIES && !(made = journeys.list.get(key)); i++) await new Promise((r) => setTimeout(r, LOAD_WAIT))
  if (!made) { await journeys.load(); made = journeys.list.get(key) ?? [...journeys.list.values()].find((x) => x.j.id === name) }
  return { name, made }
}
