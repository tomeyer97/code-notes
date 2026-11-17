// Refresh journey: Claude updates a journey's stale steps in a copy; the copy replaces it once its check passes.

import * as vscode from 'vscode'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { cfg, journeys, log, mapPanel, showError } from '../app'
import { claudeAllowed } from '../ask'
import { AskResult, findCli } from '../claude'
import { LoadedJourney } from '../journeys'
import { journeyOrder } from '../sidebar/journeyRows'
import { journeysTree } from '../sidebar/journeysTree'
import { staleCount, staleLine } from '../sidebar/listModel'
import { shortQ } from '../text'
import { walk } from '../tour/tour'
import { clock, modelProblem } from '../writing'
import { bundledSkill, journeyModel, journeyPy, journeySkill, modelLabel, runWriter, stagingFolder, Writing, writingChanged, writingNow } from './writer'

/** Journeys being refreshed (key): their Refresh says so. */
export const refreshing = new Set<string>()

/**
 * "Refresh journey": the journey writer (Claude Code with the code-journey skill, as when writing one) updates the
 * stale steps of a copy in a staging folder, changing nothing else; once `journey.py check` passes, the copy replaces
 * the journey file and a notice offers the diff. No note, nothing said in the reader's name. Without the CLI: the
 * prompt on the clipboard.
 */
export async function refreshJourney(arg?: unknown): Promise<LoadedJourney | undefined> {
  const key = typeof arg === 'string' ? arg : arg && typeof arg === 'object' ? ('lj' in arg ? (arg as { lj: LoadedJourney }).lj.key : 'key' in arg && 'j' in arg ? (arg as LoadedJourney).key : undefined) : undefined
  let lj = key ? journeys.list.get(key) : undefined
  if (!lj) {
    const stale = journeyOrder().filter((x) => staleCount(x))
    if (!stale.length) { vscode.window.setStatusBarMessage('$(check) Every journey matches the code', 3000); return undefined }
    // The one in front (the walk, the panel's), else none preselected: Enter never refreshes a journey by chance.
    const near = walk.tourJourney() ?? mapPanel.journey
    const items = stale.map((x) => ({ label: x.j.title, description: staleLine(x).replace(/^⚠ /, ''), key: x.key }))
    const qp = vscode.window.createQuickPick<typeof items[number]>()
    qp.title = 'Refresh which journey?'
    qp.items = items
    const pre = items.find((x) => x.key === near?.key)
    qp.activeItems = pre ? [pre] : []
    const p = await new Promise<typeof items[number] | undefined>((res) => { qp.onDidAccept(() => { res(qp.selectedItems[0] ?? qp.activeItems[0]); qp.hide() }); qp.onDidHide(() => { res(undefined); qp.dispose() }); qp.show() })
    lj = p && journeys.list.get(p.key)
    if (!lj) return undefined
  }
  const stale = lj.at.flatMap((a, i) => (a.stale ? [i + 1] : []))
  if (!stale.length) { vscode.window.setStatusBarMessage('$(check) Every step matches the code', 3000); return undefined }
  if (refreshing.has(lj.key)) { vscode.window.setStatusBarMessage('$(sync~spin) Already refreshing this journey', 3000); return undefined }
  const folder = lj.folder
  const repo = folder.uri.fsPath
  const slug = path.basename(lj.uri.fsPath, '.json')
  const which = stale.map((n) => `${n} (“${lj!.j.steps[n - 1].title}”)`).join(', ')
  const task = `The journey "${slug}" is out of date: step${stale.length === 1 ? '' : 's'} ${which} no longer match${stale.length === 1 ? 'es' : ''} the code. Update only ${stale.length === 1 ? 'that step' : 'those steps'}: \`check … fix\` what only moved; where the code changed, re-read it, \`restep\` the facts that are no longer true, then the range; \`rmstep\` a step whose code is gone for good. Leave the other steps, the map and the journey's question and title as they are.`
  const cli = findCli(cfg().get<string>('claude.path') || undefined)
  if (!cli) {
    await vscode.env.clipboard.writeText(`Use the code-journey skill. ${task}`)
    void vscode.window.showInformationMessage(`Copied a prompt for your agent to refresh “${lj.j.title}”`)
    return undefined
  }
  if (!claudeAllowed('refresh journeys')) return undefined
  const skill = journeySkill(folder)
  if (!skill) { void showError('Code Notes: the code-journey skill isn\'t in this repository (.claude/skills/code-journey) or in ~/.claude/skills.'); return undefined }
  const model = journeyModel()
  const bad = modelProblem(model)
  if (bad) { void showError(`Code Notes: ${bad}`); return undefined }
  const { id, stage, dir: stageDir, cleanup } = stagingFolder(repo)
  const before = fs.readFileSync(lj.uri.fsPath, 'utf8')
  fs.writeFileSync(path.join(stageDir, `${slug}.json`), before)
  const bundled = skill === bundledSkill()
  // What `check` says before: a refresh is judged by what it adds, not by rule breaks the journey already had.
  const problems = (out: string) => new Set(out.split('\n').filter((l) => l.startsWith('PROBLEM')).map((l) => l.replace(/\d+/g, '#')))
  const was = problems((await journeyPy(skill, repo, stage, ['check', repo, slug, 'quiet'])).out)
  const how = bundled ? `Read ${skill}/SKILL.md and follow it exactly (it is the code-journey skill; it is not installed, so do not look for it with the Skill tool).` : 'Use the code-journey skill.'
  const prompt = [how, task,
    `The journey is in a staging folder: run journey.py always with \`--dir ${stage}\` (Code Notes puts it back in place once \`check\` passes). Run its scripts by their full path (${skill}/scripts/…), one command per call: no shell variables, no && or pipes. Edit nothing else.`,
    'When done, reply with one short line per step you changed.'].join('\n\n')
  const title = lj.j.title
  const w: Writing = { id, question: `Refresh: ${title}`, started: Date.now(), phase: 'starting', model: modelLabel(model) }
  writingNow.set(id, w)
  writingChanged.fire()
  refreshing.add(lj.key)
  journeysTree.refresh()
  mapPanel.update()
  log.info(`journey ${lj.j.id}: Claude (${w.model}) refreshes step(s) ${stale.join(', ')}`)
  let res: AskResult
  try {
    res = await runWriter(w, `Refreshing: ${shortQ(title)}`, {
      cli, cwd: repo, prompt, model,
      extraTools: ['Skill', `Bash(${skill}/scripts/*)`], addDirs: bundled ? [skill] : [],
      env: { JOURNEY_MODEL: w.model },
    })
  } finally {
    refreshing.delete(lj.key)
  }
  const staged = path.join(stageDir, `${slug}.json`)
  const after = fs.existsSync(staged) ? fs.readFileSync(staged, 'utf8') : ''
  if (res.cancelled) { cleanup(); journeysTree.refresh(); mapPanel.update(); return undefined }
  if (res.error) { cleanup(); void showError(`Code Notes: Claude couldn't refresh the journey: ${res.error}`); journeysTree.refresh(); return undefined }
  const chk = await journeyPy(skill, repo, stage, ['check', repo, slug, 'quiet'])
  const added = [...problems(chk.out)].filter((p) => !was.has(p))
  if (added.length || !after) {
    log.error(`journey ${slug}: the refreshed copy has new problems (journey.py check); left in ${stage}/:\n${chk.out}`)
    void showError('Code Notes: the refreshed journey broke a rule of its check, so nothing changed.', 'Show Output').then((b) => { if (b) log.show(true) })
    journeysTree.refresh(); mapPanel.update()
    return undefined
  }
  if (after === before) { cleanup(); void vscode.window.showInformationMessage(`“${title}”: Claude changed nothing. ${res.text.trim().split('\n')[0] ?? ''}`.trim()); journeysTree.refresh(); return lj }
  // The journey file was edited meanwhile: keep that, the refresh stays in the staging folder.
  if (fs.readFileSync(lj.uri.fsPath, 'utf8') !== before) { void showError(`Code Notes: “${title}” changed while it was refreshed; the refreshed copy is in ${stage}/.`); return undefined }
  const old = path.join(os.tmpdir(), `code-notes-${id}-${slug}.before.json`)
  fs.writeFileSync(old, before)
  fs.writeFileSync(lj.uri.fsPath, after)
  cleanup()
  const done = await journeys.reload(lj.uri)
  const left = done ? staleCount(done) : 0
  log.info(`journey ${slug}: refreshed in ${clock(Date.now() - w.started)}${left ? `; ${left} step(s) still out of date` : ''}`)
  void vscode.window.showInformationMessage(`Refreshed “${title}”${left ? ` · ${left} step${left === 1 ? '' : 's'} still out of date` : ''}`, 'Show changes').then((b) => {
    if (b) void vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(old), lj!.uri, `${title}: before ↔ refreshed`)
  })
  journeysTree.refresh(); mapPanel.update()
  return done ?? lj
}
