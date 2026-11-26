// Refresh journey: Claude updates a journey's stale steps in a copy; the copy replaces it once its check passes.

import * as vscode from 'vscode'
import { journeys, mapPanel, refreshJourneyList, tour } from './ports'
import * as fs from 'fs'
import * as path from 'path'
import { log } from '../platform/host'
import { fireAndForget, showError } from '../platform/run'
import { AskResult } from '../platform/agent/claude'
import { LoadedJourney } from '../journeys/steps'
import { pickOne } from '../platform/quickPick'
import { staleCount, staleLine, staleSteps } from '../sidebar/listModel'
import { plural, shortQ } from '../core/text'
import { elapsed as clock } from '../core/clock'
import { journeyJob, journeyPy, JourneyRunReady, prepareJourneyRun, reportNotReady, runJourneySkill } from './claudeRun'
import { isRefreshing } from './journeyJobs'
import { refreshPrompt, refreshTask } from './prompts'
import { beforeCopies } from './beforeCopies'
import { problemsIn, stepProblems, stepsOf } from './questions'
import { notify, sayInStatusBar, warn } from './told'

/** Journeys being refreshed (by key): their Refresh says so. */
export const refreshing: Pick<ReadonlySet<string>, 'has'> = { has: isRefreshing }

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
    sayInStatusBar('$(check) Every step matches the code')
    return undefined
  }
  if (isRefreshing(lj.key)) {
    sayInStatusBar('$(sync~spin) Already refreshing this journey')
    return undefined
  }
  const slug = path.basename(lj.uri.fsPath, '.json')
  const task = refreshTask(slug, stale.map((n) => ({ n, title: lj.j.steps[n - 1].title })))
  const ready = await prepareJourneyRun(lj.folder, {
    what: 'refresh journeys',
    ownAgent: {
      prompt: `Use the code-journey skill. ${task}`,
      notice: `Copied a prompt for your agent to refresh “${lj.j.title}”`,
    },
  })
  if (!ready.ok) return reportNotReady(ready)
  const { skill, repo, staging } = ready
  const before = await fs.promises.readFile(lj.uri.fsPath, 'utf8')
  await fs.promises.writeFile(path.join(staging.dir, `${slug}.json`), before)
  // What `check` says before: a refresh is judged by what it adds, not by rule breaks the journey already had.
  const was = problemsIn((await journeyPy(skill, repo, staging.stage, ['check', repo, slug, 'quiet'])).out)
  const job = journeyJob(ready, 'refresh', `Refresh: ${lj.j.title}`, lj.key)
  log().info(`journey ${lj.j.id}: Claude (${job.model}) refreshes step(s) ${stale.join(', ')}`)
  const prompt = refreshPrompt(skill, staging.stage, task, ready.bundled)
  const res = await runJourneySkill(job, `Refreshing: ${shortQ(lj.j.title)}`, ready, { prompt })
  try {
    const outcome = await applyRefresh(lj, { ...ready, slug, before, was, res, stale })
    return said(lj, outcome, { slug, stage: staging.stage, took: Date.now() - job.started })
  } finally {
    refreshJourneyList()
    mapPanel().update()
  }
}

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
  const all = journeys().all()
  const stale = all.filter((x) => staleCount(x))
  if (!stale.length) {
    // No journeys at all is not "all fresh".
    sayInStatusBar(all.length ? '$(check) Every journey matches the code' : NO_JOURNEYS, all.length ? 3000 : 6000)
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

/** Refresh Journey in a folder with no journeys. */
export const NO_JOURNEYS = 'No journeys in this folder yet. Find or Write a Journey… to write one.'

/** `stale`: the steps Claude was asked to rewrite (1-based). */
interface RefreshRun extends JourneyRunReady { slug: string; before: string; was: Set<string>; res: AskResult; stale: number[] }

/** How a refresh ended. The refreshed copy stays in the staging folder when it broke a rule or the file changed. */
type Outcome =
  | { kind: 'cancelled' }
  | { kind: 'error'; error: string }
  | { kind: 'broke-a-rule' }
  | { kind: 'unchanged'; reply: string }
  | { kind: 'edited-meanwhile' }
  /** `failing`: check's lines saying the rewritten steps still point at code that is gone (said, never hidden). */
  | { kind: 'refreshed'; done?: LoadedJourney; diff: vscode.Uri; failing: string[] }

/**
 * After Claude's run: the refreshed copy replaces the journey file when its check adds no problem and the file was
 * not edited meanwhile.
 */
async function applyRefresh(lj: LoadedJourney, r: RefreshRun): Promise<Outcome> {
  const { skill, repo, slug, staging, before, res } = r
  if (res.cancelled || res.error) {
    staging.cleanup()
    return res.error ? { kind: 'error', error: res.error } : { kind: 'cancelled' }
  }
  const after = await fs.promises.readFile(path.join(staging.dir, `${slug}.json`), 'utf8').catch(() => '')
  const chk = await journeyPy(skill, repo, staging.stage, ['check', repo, slug, 'quiet'])
  const added = [...problemsIn(chk.out)].filter((p) => !r.was.has(p))
  if (added.length || !after) {
    const why = `the refreshed copy has new problems (journey.py check); left in ${staging.stage}/`
    log().error(`journey ${slug}: ${why}:\n${chk.out}`)
    return { kind: 'broke-a-rule' }
  }
  if (after === before) {
    staging.cleanup()
    return { kind: 'unchanged', reply: res.text.trim().split('\n')[0] ?? '' }
  }
  // The journey file was edited meanwhile: keep that, the refresh stays in the staging folder.
  if ((await fs.promises.readFile(lj.uri.fsPath, 'utf8')) !== before) return { kind: 'edited-meanwhile' }
  const diff = beforeCopies.keep(staging.id, `${slug}.before.json`, before)
  await fs.promises.writeFile(lj.uri.fsPath, after)
  staging.cleanup()
  return { kind: 'refreshed', done: await journeys().reload(lj.uri), diff, failing: stepProblems(chk.out, r.stale) }
}

/** Each outcome said: an error, a notice, or nothing (cancelled). The journey after it. */
function said(lj: LoadedJourney, o: Outcome, run: { slug: string; stage: string; took: number }): LoadedJourney | undefined {
  const title = lj.j.title
  const info = notify
  const shownBy = 'refreshJourney: window.showInformationMessage'
  switch (o.kind) {
    case 'cancelled':
      return undefined
    case 'error':
      fireAndForget(showError(`Claude couldn't refresh the journey: ${o.error}`), 'refreshJourney: showError')
      return undefined
    case 'broke-a-rule': {
      const shown = showError('the refreshed journey broke a rule of its check, so nothing changed.', 'Show Output')
      fireAndForget(shown.then((b) => { if (b) log().show(true) }), 'refreshJourney: showError')
      return undefined
    }
    case 'unchanged':
      fireAndForget(info(`“${title}”: Claude changed nothing. ${o.reply}`.trim()), shownBy)
      return lj
    case 'edited-meanwhile': {
      const text = `“${title}” changed while it was refreshed; the refreshed copy is in ${run.stage}/.`
      fireAndForget(showError(text), 'refreshJourney: showError')
      return undefined
    }
    case 'refreshed': {
      const left = o.done ? staleCount(o.done) : 0
      log().info(`journey ${run.slug}: refreshed in ${clock(run.took)}${left ? `; ${left} step(s) still out of date` : ''}`)
      const stillStale = left ? ` · ${plural(left, 'step')} still out of date` : ''
      const failing = stepsOf(o.failing)
      if (failing.length) log().warn(`journey ${run.slug}: the refreshed step(s) still fail journey.py check:\n${o.failing.join('\n')}`)
      const shown = (failing.length
        ? warn(`Refreshed “${title}” · ${failing.length > 1 ? 'steps' : 'step'} ${failing.join(', ')} still ${failing.length > 1 ? 'fail' : 'fails'} its check`, 'Show changes', 'Show Output')
        : info(`Refreshed “${title}”${stillStale}`, 'Show changes')).then((b) => {
        if (b === 'Show Output') log().show(true)
        if (b !== 'Show changes') return
        const diff = vscode.commands.executeCommand('vscode.diff', o.diff, lj.uri, `${title}: before ↔ refreshed`)
        fireAndForget(diff, 'refreshJourney: command vscode.diff')
      })
      fireAndForget(shown, shownBy)
      return o.done ?? lj
    }
  }
}
