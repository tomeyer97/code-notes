// Refresh journey: Claude updates a journey's stale steps in a copy; the copy replaces it once its check passes.

import * as vscode from 'vscode'
import { journeys, mapPanel, refreshJourneyList, tour } from './ports'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { log } from '../platform/host'
import { showError } from '../platform/run'
import { agentRunner } from '../platform/agent/runner'
import { AskResult } from '../platform/agent/claude'
import { LoadedJourney } from '../journeys/steps'
import { pickOne } from '../platform/quickPick'
import { staleCount, staleLine, staleSteps } from '../sidebar/listModel'
import { plural, shortQ } from '../core/text'
import { clock } from '../core/writing'
import { bundledSkill, cliOrClipboard, journeyPy, modelLabel, runJourneySkill, skillAndModel, Staging, stagingFolder } from './claudeRun'
import { startWriting, Writing } from './inProgress'
import { fireAndForget } from '../platform/run'

/** Journeys being refreshed (key): their Refresh says so. */
export const refreshing = new Set<string>()

/**
 * "Refresh journey": the journey writer (Claude Code with the code-journey skill, as when writing one) updates the
 * stale steps of a copy in a staging folder, changing nothing else; once `journey.py check` passes, the copy replaces
 * the journey file and a notice offers the diff. No note, nothing said in the reader's name. Without the CLI: the
 * prompt on the clipboard.
 */
export async function refreshJourney(arg?: unknown): Promise<LoadedJourney | undefined> {
  const key = journeyKeyOf(arg)
  const lj = (key ? journeys().list.get(key) : undefined) ?? (await pickStaleJourney())
  if (!lj) return undefined
  const stale = staleSteps(lj)
  if (!stale.length) {
    vscode.window.setStatusBarMessage('$(check) Every step matches the code', 3000)
    return undefined
  }
  if (refreshing.has(lj.key)) {
    vscode.window.setStatusBarMessage('$(sync~spin) Already refreshing this journey', 3000)
    return undefined
  }
  const repo = lj.folder.uri.fsPath
  const slug = path.basename(lj.uri.fsPath, '.json')
  const task = refreshTask(lj, slug, stale)
  const cli = await cliOrClipboard(`Use the code-journey skill. ${task}`, `Copied a prompt for your agent to refresh “${lj.j.title}”`)
  if (!cli) return undefined
  if (!agentRunner().allowed('refresh journeys')) return undefined
  const ready = skillAndModel(lj.folder, NO_SKILL)
  if (!ready) return undefined
  const { skill, model } = ready
  const staging = stagingFolder(repo)
  const before = fs.readFileSync(lj.uri.fsPath, 'utf8')
  fs.writeFileSync(path.join(staging.dir, `${slug}.json`), before)
  // What `check` says before: a refresh is judged by what it adds, not by rule breaks the journey already had.
  const was = problemsIn((await journeyPy(skill, repo, staging.stage, ['check', repo, slug, 'quiet'])).out)
  const prompt = refreshPrompt(skill, staging.stage, task)
  const w: Writing = { id: staging.id, question: `Refresh: ${lj.j.title}`, started: Date.now(), phase: 'starting', model: modelLabel(model) }
  startWriting(w)
  refreshing.add(lj.key)
  refreshJourneyList()
  mapPanel().update()
  log().info(`journey ${lj.j.id}: Claude (${w.model}) refreshes step(s) ${stale.join(', ')}`)
  let res: AskResult
  try {
    res = await runJourneySkill(w, `Refreshing: ${shortQ(lj.j.title)}`, { cli, repo, prompt, skill, model })
  } finally {
    refreshing.delete(lj.key)
  }
  return applyRefresh(lj, { skill, repo, slug, staging, before, was, res, started: w.started })
}

const NO_SKILL = 'the code-journey skill isn\'t in this repository (.claude/skills/code-journey) or in ~/.claude/skills.'

/** The journey a command argument names: a key, a sidebar row ({ lj }), or a journey itself. */
function journeyKeyOf(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg
  if (!arg || typeof arg !== 'object') return undefined
  if ('lj' in arg) return (arg as { lj: LoadedJourney }).lj.key
  return 'key' in arg && 'j' in arg ? (arg as LoadedJourney).key : undefined
}

/** Which stale journey to refresh: the one in front (the walk, the panel's) preselected, else none (Enter never
 *  refreshes a journey by chance). Undefined: none is stale (said), or Esc. */
async function pickStaleJourney(): Promise<LoadedJourney | undefined> {
  const stale = journeys().all().filter((x) => staleCount(x))
  if (!stale.length) {
    vscode.window.setStatusBarMessage('$(check) Every journey matches the code', 3000)
    return undefined
  }
  const near = tour().tourJourney() ?? mapPanel().journey
  const items = stale.map((x) => ({ label: x.j.title, description: staleLine(x).replace(/^⚠ /, ''), key: x.key }))
  const qp = vscode.window.createQuickPick<typeof items[number]>()
  qp.title = 'Refresh which journey?'
  qp.items = items
  const pre = items.find((x) => x.key === near?.key)
  qp.activeItems = pre ? [pre] : []
  const p = await pickOne(qp, { orActive: true })
  return p && journeys().list.get(p.key)
}

/** What Claude is asked to do: the stale steps (by number and title), and how to update only those. */
function refreshTask(lj: LoadedJourney, slug: string, stale: number[]): string {
  const one = stale.length === 1
  const which = stale.map((n) => `${n} (“${lj.j.steps[n - 1].title}”)`).join(', ')
  return `The journey "${slug}" is out of date: step${one ? '' : 's'} ${which} no longer match${one ? 'es' : ''} the code. ` +
    `Update only ${one ? 'that step' : 'those steps'}: \`check … fix\` what only moved; where the code changed, re-read it, ` +
    '`restep` the facts that are no longer true, then the range; `rmstep` a step whose code is gone for good. ' +
    'Leave the other steps, the map and the journey\'s question and title as they are.'
}

/** The prompt: the skill (by name, or the bundled copy's SKILL.md), the task, the staging folder, the reply wanted. */
function refreshPrompt(skill: string, stage: string, task: string): string {
  const how = skill === bundledSkill()
    ? `Read ${skill}/SKILL.md and follow it exactly (it is the code-journey skill; it is not installed, so do not look for it with the Skill tool).`
    : 'Use the code-journey skill.'
  return [how, task,
    `The journey is in a staging folder: run journey.py always with \`--dir ${stage}\` (Code Notes puts it back in place once \`check\` passes). Run its scripts by their full path (${skill}/scripts/…), one command per call: no shell variables, no && or pipes. Edit nothing else.`,
    'When done, reply with one short line per step you changed.'].join('\n\n')
}

/** journey.py check's PROBLEM lines, numbers masked (a moved line is not a new problem). */
function problemsIn(out: string): Set<string> {
  return new Set(out.split('\n').filter((l) => l.startsWith('PROBLEM')).map((l) => l.replace(/\d+/g, '#')))
}

interface RefreshRun { skill: string; repo: string; slug: string; staging: Staging; before: string; was: Set<string>; res: AskResult; started: number }

/**
 * After Claude's run: the refreshed copy replaces the journey file when its check adds no problem and the file was
 * not edited meanwhile; else it is said, and the copy stays in the staging folder.
 */
async function applyRefresh(lj: LoadedJourney, r: RefreshRun): Promise<LoadedJourney | undefined> {
  const { skill, repo, slug, staging, before, res } = r
  const title = lj.j.title
  const lists = () => {
    refreshJourneyList()
    mapPanel().update()
  }
  const staged = path.join(staging.dir, `${slug}.json`)
  const after = fs.existsSync(staged) ? fs.readFileSync(staged, 'utf8') : ''
  if (res.cancelled) {
    staging.cleanup()
    lists()
    return undefined
  }
  if (res.error) {
    staging.cleanup()
    fireAndForget(showError(`Claude couldn't refresh the journey: ${res.error}`), 'refreshJourney: showError')
    refreshJourneyList()
    return undefined
  }
  const chk = await journeyPy(skill, repo, staging.stage, ['check', repo, slug, 'quiet'])
  const added = [...problemsIn(chk.out)].filter((p) => !r.was.has(p))
  if (added.length || !after) {
    log().error(`journey ${slug}: the refreshed copy has new problems (journey.py check); left in ${staging.stage}/:\n${chk.out}`)
    fireAndForget(showError('the refreshed journey broke a rule of its check, so nothing changed.', 'Show Output').then((b) => { if (b) log().show(true) }), 'refreshJourney: showError')
    lists()
    return undefined
  }
  if (after === before) {
    staging.cleanup()
    fireAndForget(vscode.window.showInformationMessage(`“${title}”: Claude changed nothing. ${res.text.trim().split('\n')[0] ?? ''}`.trim()), 'refreshJourney: window.showInformationMessage')
    refreshJourneyList()
    return lj
  }
  // The journey file was edited meanwhile: keep that, the refresh stays in the staging folder.
  if (fs.readFileSync(lj.uri.fsPath, 'utf8') !== before) {
    fireAndForget(showError(`“${title}” changed while it was refreshed; the refreshed copy is in ${staging.stage}/.`), 'refreshJourney: showError')
    return undefined
  }
  const old = path.join(os.tmpdir(), `code-notes-${staging.id}-${slug}.before.json`)
  fs.writeFileSync(old, before)
  fs.writeFileSync(lj.uri.fsPath, after)
  staging.cleanup()
  const done = await journeys().reload(lj.uri)
  const left = done ? staleCount(done) : 0
  log().info(`journey ${slug}: refreshed in ${clock(Date.now() - r.started)}${left ? `; ${left} step(s) still out of date` : ''}`)
  const stillStale = left ? ` · ${plural(left, 'step')} still out of date` : ''
  fireAndForget(vscode.window.showInformationMessage(`Refreshed “${title}”${stillStale}`, 'Show changes').then((b) => {
    if (b) fireAndForget(vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(old), lj.uri, `${title}: before ↔ refreshed`), 'refreshJourney: command vscode.diff')
  }), 'refreshJourney: window.showInformationMessage')
  lists()
  return done ?? lj
}
