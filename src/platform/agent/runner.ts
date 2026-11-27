// The one way the features run an agent (answering a note, writing a journey, the check's questions and grades): the
// trust gate, the model for each purpose, finding the program, starting it, and one list of the runs in progress
// that every feature can show and cancel. The features keep only their prompts and what they do with the result.
import * as vscode from 'vscode'
import { cfg } from '../settings'
import { log } from '../host'
import { fireAndForget } from '../run'
import type { AgentRun, AgentRunOptions } from './agent'
import { claudeCode } from './claude'
import { ClaudeCliFinder } from './claudeCli'

/** What a run is for: its model setting and its row in the list of runs. */
export type AgentPurpose = 'note' | 'journey' | 'check'

/** Why a run can't start; the feature says it in its own place (a thread, a notification, a result file). */
export type AgentProblem =
  /** The folder is in Restricted Mode: agents never run there. */
  | { kind: 'untrusted' }
  /** No program to run (not installed, or not where the setting says). */
  | { kind: 'no-cli' }
  /** The model asked for is not one the agent knows. */
  | { kind: 'bad-model'; message: string }

/** A run in the list: what it is for, what it is about, since when; cancel stops it. */
export interface InProgressRun {
  key: string
  purpose: AgentPurpose
  label: string
  started: number
  cancel(): void
}

/** The runs in progress, of every feature. */
export class InProgress implements vscode.Disposable {
  private readonly runs = new Map<string, InProgressRun>()
  private readonly changed = new vscode.EventEmitter<InProgressRun>()
  /** A run joined or left the list. */
  readonly onDidChange = this.changed.event

  /** `run` listed until it is removed (or the returned disposable is disposed). */
  add(run: InProgressRun): vscode.Disposable {
    this.runs.set(run.key, run)
    this.changed.fire(run)
    return { dispose: () => this.remove(run.key) }
  }

  remove(key: string): void {
    const run = this.runs.get(key)
    if (!run || !this.runs.delete(key)) return
    this.changed.fire(run)
  }

  get(key: string): InProgressRun | undefined { return this.runs.get(key) }

  /** The runs for `purpose` (all of them without). */
  list(purpose?: AgentPurpose): InProgressRun[] {
    return [...this.runs.values()].filter((r) => !purpose || r.purpose === purpose)
  }

  dispose(): void { this.changed.dispose() }
}

/** The setting each purpose reads its model from, before codeNotes.claude.model. */
const MODEL_SETTING: Record<AgentPurpose, string | undefined> = {
  note: undefined,
  journey: 'journeys.model',
  check: 'understanding.model',
}

export class AgentRunner implements vscode.Disposable {
  readonly inProgress = new InProgress()
  private readonly finder = new ClaudeCliFinder(undefined, skippedPath)

  /** Agents run tools in the repository (a skill's own scripts among them): only in a trusted folder. */
  trusted(): boolean { return vscode.workspace.isTrusted }

  /** Whether an agent may `what` here; when not, says why (once per call) with a button to the trust editor. */
  allowed(what: string): boolean {
    if (this.trusted()) return true
    log().info(`${what}: not run: this folder is in Restricted Mode (not trusted)`)
    const said = vscode.window.showInformationMessage(`Trust this folder to let Claude ${what}.`, 'Manage Trust').then((b) => {
      if (b) fireAndForget(vscode.commands.executeCommand('workbench.trust.manage'), 'trust: command workbench.trust.manage')
    })
    fireAndForget(said, 'trust: window.showInformationMessage')
    return false
  }

  /** The model for `purpose`: `override` (a request's), the purpose's own setting, Claude's; undefined: its default. */
  model(purpose: AgentPurpose, override?: string): string | undefined {
    const own = MODEL_SETTING[purpose]
    return override || (own && cfg().get<string>(own)) || cfg().get<string>('claude.model') || undefined
  }

  /**
   * The `claude` program (setting codeNotes.claude.path, else the newest install), waiting for a search in progress.
   * In Restricted Mode the setting comes from the user's settings only (package.json: restrictedConfigurations), so a
   * folder's own settings never pick the program run here.
   */
  cli(): Promise<string | undefined> { return this.finder.find(cliSetting()) }

  /** `cli()` as far as it is known now, without waiting (undefined while the first search runs). */
  knownCli(): string | undefined { return this.finder.known(cliSetting()) }

  /** The program to start a run with `model`, or why it can't start. */
  async ready(model: string | undefined): Promise<{ kind: 'ready'; cli: string } | AgentProblem> {
    if (!this.trusted()) return { kind: 'untrusted' }
    const cli = await this.cli()
    if (!cli) return { kind: 'no-cli' }
    const bad = claudeCode(cli).modelProblem(model)
    return bad ? { kind: 'bad-model', message: bad } : { kind: 'ready', cli }
  }

  /** The agent started on `o`, listed in progress as `run` until it ends. */
  start(cli: string, run: Omit<InProgressRun, 'cancel' | 'started'>, o: AgentRunOptions): AgentRun {
    const agentRun = claudeCode(cli).start(o)
    const listed = this.inProgress.add({ ...run, started: Date.now(), cancel: () => agentRun.cancel() })
    agentRun.done.then(() => listed.dispose(), () => listed.dispose())
    return agentRun
  }

  /**
   * The window closes or reloads: note and journey runs stop with it (else a Claude that writes nothing outlives the
   * window, still billed). The check's writer keeps running: a reloaded window finds it again by its pid.
   */
  dispose(): void {
    for (const r of this.inProgress.list()) if (r.purpose !== 'check') r.cancel()
    this.inProgress.dispose()
  }
}

/** Claude: Path names no program: said in the log and the status bar, naming it (the newest install runs instead). */
function skippedPath(setting: string, used: string | undefined): void {
  log().warn(`Claude: Path ${setting} is not a program; ${used ? `running ${used} instead` : 'no other claude found'}`)
  vscode.window.setStatusBarMessage(`$(warning) Claude: Path ${setting} is not a program`, SKIPPED_HINT_MS)
}
const SKIPPED_HINT_MS = 15000

const cliSetting = () => cfg().get<string>('claude.path') || undefined

let runner: AgentRunner | undefined
/** The extension's runner (one per window: the list of runs in progress is shared by every feature). */
export function agentRunner(): AgentRunner {
  runner ??= new AgentRunner()
  return runner
}
