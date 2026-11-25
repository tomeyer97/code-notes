// The plain phase shown while Claude writes or refreshes a journey ("drawing the map", "writing the steps", …), read
// from its last tool call. journey.py prints no phase of its own, so its command lines are read: test/writing.test.ts
// checks that every journey.py subcommand is placed below. No vscode API here.
import { phaseFromTool, type PhaseTable, type ToolUse } from '../core/agentRun'

/** Claude Code's tools that only read: the phase is "reading the code" until the map is started. */
const READ_TOOLS = ['Read', 'Grep', 'Glob', 'Skill', 'LS']

/** journey.py's subcommands by the phase they start. */
export const PHASES: Record<string, string[]> = {
  'drawing the map': ['new', 'meta', 'node', 'edge', 'set', 'setedge', 'rmnode', 'rmedge'],
  'writing the steps': ['step', 'restep', 'rmstep', 'mvstep', 'stepnode'],
  // What each step gets after it is written: its code links, its value hints, its animation.
  'adding links and animations': ['link', 'value', 'scene', 'rmlink', 'rmvalue', 'rmscene'],
  'checking': ['check', 'podcast'],
}

/** The subcommands that start no phase: `range` only reads; the others don't say what Claude is at. */
export const NO_PHASE = ['range', 'reset', 'restore', 'migrate', 'migrate-anchors', 'mark', 'rmmark', 'marks']

/** `python3 <skill>/scripts/journey.py --dir <stage> check <repo> <slug>` → check. */
const JOURNEY_PY_COMMAND = /journey\.py(?:\s+--dir(?:=|\s+)\S+)?\s+(?<sub>[a-z-]+)/

const JOURNEY_PHASES: PhaseTable = {
  readTools: READ_TOOLS,
  onRead: (prev) => (prev === 'starting' || prev === 'reading the code' ? 'reading the code' : prev),
  onCommand(command, prev) {
    const sub = JOURNEY_PY_COMMAND.exec(command)?.groups?.sub
    if (!sub) return undefined
    if (sub === 'range') return prev === 'starting' ? 'reading the code' : prev
    return Object.keys(PHASES).find((phase) => PHASES[phase].includes(sub))
  },
}

/** What Claude is doing, in plain words, after tool call `tool` (`prev`: the phase so far). */
export const phaseOf = (tool: ToolUse | undefined, prev: string): string => phaseFromTool(tool, prev, JOURNEY_PHASES)
