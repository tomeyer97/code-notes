// What Claude may do while it writes or refreshes a journey. No vscode API here (unit-tested with claude.ts's
// claudeArgs in test/writing.test.ts).
import type { AgentRunOptions } from '../platform/agent/agent'

export interface JourneyRunSpec {
  repo: string
  prompt: string
  /** The code-journey skill's folder; `bundled`: the extension's own copy (not installed as a skill). */
  skill: string
  bundled: boolean
  model?: string
  /** The model as the UI names it: journey.py stamps it on the journey (JOURNEY_MODEL). */
  modelLabel: string
  resume?: string
  /** The skill's cache folder, when there is one. */
  cache?: string
}

/** Read-only tools, Bash only for the skill's own scripts; the cache and the bundled skill's folder readable. */
export function journeyRunOptions(s: JourneyRunSpec): AgentRunOptions {
  return {
    cwd: s.repo, prompt: s.prompt, model: s.model, resume: s.resume,
    extraTools: ['Skill', `Bash(${s.skill}/scripts/*)`],
    addDirs: [...(s.cache ? [s.cache] : []), ...(s.bundled ? [s.skill] : [])],
    env: { JOURNEY_MODEL: s.modelLabel },
  }
}
