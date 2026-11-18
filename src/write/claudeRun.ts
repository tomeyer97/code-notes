// Claude Code at work on a journey (writing one, or refreshing one): the code-journey skill and its journey.py, a
// staging folder, the model, what must be in place before Claude may run, and the run itself, with a notification.

import * as vscode from 'vscode'
import { execFile } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { cfg, extUri, showError } from '../app'
import { Ask, AskOptions, AskResult, findCli } from '../claude'
import { folderName } from '../store'
import { clock, modelProblem, phaseOf } from '../writing'
import { Writing, writingChanged, writingNow } from './inProgress'

/** The model a journey is written with (a request's `model`, the settings), and how it is named. */
export const journeyModel = (override?: string) => override || cfg().get<string>('journeys.model') || cfg().get<string>('claude.model') || undefined
export const modelLabel = (m?: string) => m || 'Claude Code default'

/**
 * The code-journey skill: the repository's own copy (a team can pin and adapt it), else the home folder's, else the one
 * that ships with the extension (so writing a journey works with nothing installed).
 */
export function journeySkill(folder: vscode.WorkspaceFolder): string | undefined {
  const home = os.homedir()
  return [`${folder.uri.fsPath}/.claude/skills/code-journey`, `${home}/.claude/skills/code-journey`, bundledSkill()].find((d) => fs.existsSync(`${d}/scripts`))
}
/** The copy inside the extension: Claude Code does not know it as a skill, so the prompt names its SKILL.md instead. */
export const bundledSkill = () => `${extUri.fsPath}/skills/code-journey`

/** How long journey.py may take (ms), and how much it may print. */
const JOURNEY_PY_TIMEOUT = 120_000
const JOURNEY_PY_MAX_OUTPUT = 8 << 20

/** journey.py with a staging folder; never throws. */
export function journeyPy(skill: string, repo: string, stage: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('python3', [`${skill}/scripts/journey.py`, '--dir', stage, ...args], { cwd: repo, timeout: JOURNEY_PY_TIMEOUT, maxBuffer: JOURNEY_PY_MAX_OUTPUT }, (err, out, errOut) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
      resolve({ code, out: `${out ?? ''}${errOut ?? ''}`.trim() })
    })
  })
}

/** A staging folder in the notes folder (`stage`, relative to the repository; `dir`, absolute) Claude writes into. */
export interface Staging { id: string; stage: string; dir: string; cleanup: () => void }
export function stagingFolder(repo: string): Staging {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const stage = `${folderName()}/.writing/${id}`
  const dir = path.join(repo, stage)
  fs.mkdirSync(dir, { recursive: true })
  return { id, stage, dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* gone */ } } }
}

/**
 * Claude at work on a journey (`w`, listed in writingNow by the caller), in a notification titled `title`: the elapsed
 * time and a plain phase (not the tool's name); Cancel stops it. `w` leaves the list when it is done.
 */
export async function runWriter(w: Writing, title: string, o: Omit<AskOptions, 'onProgress'>): Promise<AskResult> {
  try {
    return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
      const tick = () => { progress.report({ message: `${clock(Date.now() - w.started)} · ${w.phase}` }); writingChanged.fire() }
      const ask = new Ask({
        ...o,
        onProgress: (p) => {
          const phase = phaseOf(p.tool, w.phase)
          if (phase !== w.phase) { w.phase = phase; tick() }
        },
      })
      w.ask = ask
      tick()
      const timer = setInterval(tick, 1000)
      token.onCancellationRequested(() => ask.cancel())
      try { return await ask.done } finally { clearInterval(timer) }
    })
  } finally {
    writingNow.delete(w.id)
    writingChanged.fire()
  }
}

/**
 * The claude CLI; without it, `prompt` for your own agent goes on the clipboard (said with `notice`) and undefined
 * is returned.
 */
export async function cliOrClipboard(prompt: string, notice: string): Promise<string | undefined> {
  const cli = findCli(cfg().get<string>('claude.path') || undefined)
  if (cli) return cli
  await vscode.env.clipboard.writeText(prompt)
  void vscode.window.showInformationMessage(notice)
  return undefined
}

/**
 * The code-journey skill and the model a journey is written with (`model`: a request's, else the settings'); undefined
 * when either can't be used, said (`noSkill`: what is said when the skill is missing).
 */
export function skillAndModel(folder: vscode.WorkspaceFolder, noSkill: string, model?: string): { skill: string; model?: string } | undefined {
  const skill = journeySkill(folder)
  if (!skill) {
    void showError(noSkill)
    return undefined
  }
  const m = journeyModel(model)
  const bad = modelProblem(m)
  if (bad) {
    void showError(`Code Notes: ${bad}`)
    return undefined
  }
  return { skill, model: m }
}

/** Claude with the code-journey skill in `repo`: read-only tools, Bash only for the skill's own scripts; the skill's
 *  folder readable when it is the bundled copy, and `extraDirs`. */
export function runJourneySkill(
  w: Writing, title: string,
  o: { cli: string; repo: string; prompt: string; skill: string; model?: string; resume?: string; extraDirs?: string[] },
): Promise<AskResult> {
  const bundled = o.skill === bundledSkill()
  return runWriter(w, title, {
    cli: o.cli, cwd: o.repo, prompt: o.prompt, model: o.model, resume: o.resume,
    extraTools: ['Skill', `Bash(${o.skill}/scripts/*)`], addDirs: [...(o.extraDirs ?? []), ...(bundled ? [o.skill] : [])],
    env: { JOURNEY_MODEL: w.model },
  })
}
