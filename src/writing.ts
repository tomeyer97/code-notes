// Writing a journey with Claude: the prompt, the plain phase shown while it works, the clock.
// No vscode API here (unit-tested in test/writing.test.ts).
import type { ToolCall } from './claude'

/** "1:05" */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** "about 2 min" / "under a minute", for the notice when it is done. */
export function minutes(ms: number): string {
  const m = Math.round(ms / 60000)
  return m < 1 ? 'under a minute' : `${m} min`
}

/**
 * What Claude is doing, in plain words, from its last tool call: reading the code, drawing the map, writing the
 * steps, adding links and animations, checking. journey.py's subcommand says which (the commands it runs are `…/journey.py [--dir x] <cmd> …`).
 */
export function phaseOf(tool: ToolCall | undefined, prev: string): string {
  if (!tool) return prev
  if (['Read', 'Grep', 'Glob', 'Skill', 'LS'].includes(tool.name)) return prev === 'starting' || prev === 'reading the code' ? 'reading the code' : prev
  if (tool.name !== 'Bash') return prev
  const cmd = String(tool.input?.command ?? '')
  const m = /journey\.py((?:\s+--dir(?:=|\s+)\S+)?)\s+([a-z-]+)/.exec(cmd)
  if (!m) return prev
  const sub = m[2]
  if (sub === 'range') return prev === 'starting' ? 'reading the code' : prev
  if (['new', 'meta', 'node', 'edge', 'set', 'setedge', 'rmnode', 'rmedge'].includes(sub)) return 'drawing the map'
  if (['step', 'restep', 'rmstep', 'mvstep', 'stepnode'].includes(sub)) return 'writing the steps'
  // What each step gets after it is written: its code links, its value hints, its animation.
  if (['link', 'value', 'scene', 'rmlink', 'rmvalue', 'rmscene'].includes(sub)) return 'adding links and animations'
  if (sub === 'check') return 'checking'
  return prev
}

/**
 * The prompt for `claude -p`. The person's words are a request: the journey gets its own natural question.
 * `stage`: the folder (relative to the repo) journey.py writes into; Code Notes moves the journey into the journeys
 * folder once `check` passes.
 */
export function journeyPrompt(request: string, skill: string, stage: string, journeysFolder: string, bundled = false): string {
  // The copy that ships with the extension is not registered with Claude Code as a skill: its instructions are read as a file.
  const how = bundled ? `Read ${skill}/SKILL.md and follow it exactly (it is the code-journey skill; it is not installed, so do not look for it with the Skill tool) to answer` : 'Use the code-journey skill to answer'
  return `${how}: ${request.replace(/\s+/g, ' ').trim()}\n\n` + journeyRules(skill, stage, journeysFolder)
}

export function journeyRules(skill: string, stage: string, journeysFolder: string): string {
  return [
    'Those are the words of the person asking: a request, not the journey\'s question. Give the journey its own natural question, the one a developer would ask that this journey answers (one line), and a short title.',
    `Write exactly one journey with the skill's journey.py, always with \`--dir ${stage}\` (a staging folder: Code Notes moves the journey into ${journeysFolder}/ once \`check\` passes, so it never shows half-written). Run its scripts by their full path (${skill}/scripts/…), one command per call: no shell variables, no && or pipes.`,
    'If the request is too unclear to pick one flow, write nothing and reply with one short clarifying question instead; the person can answer it.',
    'When done, reply with the storyline.',
  ].join('\n\n')
}

/** a model Claude Code knows (an alias or a claude-* id), else the message to show; nothing runs then. */
export function modelProblem(m: string | undefined): string | undefined {
  if (!m) return undefined
  if (/^(sonnet|opus|haiku|fable)(\[1m\])?$/i.test(m) || /^claude-[a-z0-9][\w.-]*(\[1m\])?$/i.test(m)) return undefined
  return `Unknown model '${m}'. Use sonnet, opus, haiku or fable.`
}
