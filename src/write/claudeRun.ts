// Claude Code at work on a journey (writing one, or refreshing one): what must be in place before it may run (the
// folder trusted, the CLI, the code-journey skill, the model), a staging folder, journey.py, and the run itself in a
// notification. writeJourney.ts and refreshJourney.ts keep only their prompts and what they do with the result.

import * as vscode from 'vscode'
import { execFile, ExecFileException } from 'child_process'
import * as fs from 'fs'
import { fireAndForget, showError } from '../platform/run'
import { agentRunner } from '../platform/agent/runner'
import { AskResult, modelProblem } from '../platform/agent/claude'
import { skillCacheDir } from '../platform/agent/claudeHome'
import { withRunProgress } from '../platform/agentProgress'
import { findSkill, missingSkill, type SkillLookup } from '../platform/skillDir'
import { extUri } from '../platform/host'
import { modelLabel } from '../core/agentRun'
import { folderName } from '../notes/notesFolder'
import { phaseOf } from './journeyPhases'
import { JourneyJob, journeyRun } from './journeyJobs'
import { Staging, stagingFolder } from './staging'
import { journeyRunOptions } from './runOptions'

export { modelLabel } from '../core/agentRun'

const SKILL = 'code-journey'

/** How long writing a journey takes, about: said before the run is started. */
export const WRITE_ESTIMATE = 'about 3 min'

/** The model a journey is written with (a request's `model`, the settings). */
export const journeyModel = (override?: string) => agentRunner().model('journey', override)

/** Where the code-journey skill is looked for, for the repository at `repo` (platform/skillDir.ts). */
const lookup = (repo: string): SkillLookup => ({ repo, bundled: vscode.Uri.joinPath(extUri(), 'skills').fsPath })

/** A copy of the skill is a folder with its scripts. */
const MARKER = 'scripts'

/** The code-journey skill for `folder` (platform/skillDir.ts says where it is looked for). */
export const journeySkill = (folder: vscode.WorkspaceFolder): string | undefined =>
  findSkill(SKILL, { ...lookup(folder.uri.fsPath), marker: MARKER })?.dir

/** How long journey.py may take (ms), and how much it may print. */
const JOURNEY_PY_TIMEOUT = 120_000
const JOURNEY_PY_MAX_OUTPUT = 8 << 20
/** The Python that runs journey.py: Windows installs it as `python`. */
const PYTHON = process.platform === 'win32' ? 'python' : 'python3'

/** A finished command's exit code: 0, its own, or 1 when it has none (killed, not started). */
const exitCode = (err: ExecFileException | null) => (!err ? 0 : typeof err.code === 'number' ? err.code : 1)

/** journey.py with a staging folder; never throws. */
export function journeyPy(skill: string, repo: string, stage: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const opts = { cwd: repo, timeout: JOURNEY_PY_TIMEOUT, maxBuffer: JOURNEY_PY_MAX_OUTPUT }
    execFile(PYTHON, [`${skill}/scripts/journey.py`, '--dir', stage, ...args], opts, (err, out, errOut) => {
      resolve({ code: exitCode(err), out: `${out ?? ''}${errOut ?? ''}`.trim() })
    })
  })
}

/** Everything a journey run needs, once it may start. */
export interface JourneyRunReady {
  cli: string
  repo: string
  skill: string
  /** The skill is the extension's own copy (its SKILL.md is read as a file). */
  bundled: boolean
  model?: string
  staging: Staging
}

/** Why a journey run can't start: said by `prepareJourneyRun`'s caller (reportNotReady). */
export type NotReady = { ok: false; reason?: string }

/**
 * What a journey run needs in `folder`, in order: a trusted folder (`what` Claude would do, for the trust message), the
 * claude CLI (without it, `ownAgent.prompt` goes on the clipboard, said with `ownAgent.notice`), the skill, a usable
 * model; then a staging folder. `reason` is what to say when there is one.
 */
export async function prepareJourneyRun(
  folder: vscode.WorkspaceFolder,
  o: { what: string; ownAgent: { prompt: string; notice: string }; model?: string },
): Promise<({ ok: true } & JourneyRunReady) | NotReady> {
  if (!agentRunner().allowed(o.what)) return { ok: false }
  const cli = await cliOrClipboard(o.ownAgent.prompt, o.ownAgent.notice)
  if (!cli) return { ok: false }
  const repo = folder.uri.fsPath
  const skill = findSkill(SKILL, { ...lookup(repo), marker: MARKER })
  if (!skill) return { ok: false, reason: `${missingSkill(SKILL, lookup(repo))}, so Claude can't ${o.what} here.` }
  const model = journeyModel(o.model)
  const bad = modelProblem(model)
  if (bad) return { ok: false, reason: bad }
  const staging = stagingFolder(repo, folderName())
  return { ok: true, cli, repo, skill: skill.dir, bundled: skill.bundled, model, staging }
}

/** Says why a journey run didn't start, when there is something to say. */
export function reportNotReady(r: NotReady): undefined {
  if (r.reason) fireAndForget(showError(r.reason), 'claudeRun: showError')
  return undefined
}

/** The claude CLI; without it, `prompt` for your own agent goes on the clipboard (said with `notice`). */
async function cliOrClipboard(prompt: string, notice: string): Promise<string | undefined> {
  const cli = await agentRunner().cli()
  if (cli) return cli
  await vscode.env.clipboard.writeText(prompt)
  fireAndForget(vscode.window.showInformationMessage(notice), 'claudeRun: window.showInformationMessage')
  return undefined
}

/** A new job for `r`: listed (with its row) while Claude runs. */
export function journeyJob(r: JourneyRunReady, kind: JourneyJob['kind'], question: string, journey?: string): JourneyJob {
  return { id: r.staging.id, kind, question, journey, started: Date.now(), phase: 'starting', model: modelLabel(r.model) }
}

/**
 * Claude with the code-journey skill in the repository (what it may do: runOptions.ts), on job `job`, in a
 * notification titled `title`; with `cache`, the skill's cache folder is readable when there is one (claudeHome.ts
 * skillCacheDir, the same rule as a note's skills). Listed in the runner's runs in progress until it ends.
 */
export async function runJourneySkill(
  job: JourneyJob, title: string, r: JourneyRunReady, o: { prompt: string; resume?: string; cache?: boolean },
): Promise<AskResult> {
  const cache = skillCacheDir(SKILL)
  const cached = !!o.cache && (await fs.promises.access(cache).then(() => true, () => false))
  const options = journeyRunOptions({
    repo: r.repo, prompt: o.prompt, skill: r.skill, bundled: r.bundled, model: r.model, modelLabel: job.model,
    resume: o.resume, cache: cached ? cache : undefined,
  })
  // The notification says the phase again as soon as it changes.
  const start = (tick: () => void) => agentRunner().start(r.cli, journeyRun(job), {
    ...options,
    onProgress: (p) => {
      const phase = phaseOf(p.tool, job.phase)
      if (phase === job.phase) return
      job.phase = phase
      tick()
    },
  })
  return withRunProgress(job, title, start)
}
