// journey.py's rules, asked through test/cli/journey_rules.py: with node (journey-check.mjs, the extension's own
// rules) or without (journey.py's Python copy of them).
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const JPY = path.join(here, '../../skills/code-journey/scripts/journey.py')

/** The answers to `requests` ({op, …} each), by the rules of `mode`: 'node' or 'python'. */
export function rules(requests, mode) {
  // No __pycache__ beside the skill's script (it ships as is).
  const env = { ...process.env, JOURNEY_RULES: mode, PYTHONDONTWRITEBYTECODE: '1' }
  return JSON.parse(execFileSync('python3', [path.join(here, 'journey_rules.py'), JPY], { input: JSON.stringify(requests), encoding: 'utf8', env }))
}

/** The answers of both, as { node, python }. */
export const both = (requests) => ({ node: rules(requests, 'node'), python: rules(requests, 'python') })
