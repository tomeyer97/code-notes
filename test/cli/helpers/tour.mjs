// The tour of a check: a journey of the change, written with journey.py after the questions (questions.mjs tour) and
// embedded in the check file. journey.py's argument order lives here only: tests name the parts.
import assert from 'node:assert/strict'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { script } from './cli.mjs'

export const JPY = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../skills/code-journey/scripts/journey.py')

/** The agent's part of a tour: `questions.mjs tour`, then journey.py with the --dir it prints. Returns that --dir. */
export function tourStage(d, topUp = false) {
  const out = script(d, 'tour', ...(topUp ? ['--top-up'] : [])).out
  assert.match(out, /^JOURNEY: \S+journey\.py <command> <repo> tour … --dir (\S+)/m)
  return { out, dir: /--dir (\S+)/.exec(out)[1] }
}

/** journey.py `args` in `d`, writing into the tour's `dir`; `input` on stdin. */
export const jpy = (d, dir, args, input = '') => execFileSync('python3', [JPY, ...args, '--dir', dir], { cwd: d, encoding: 'utf8', input })

/** The tour journey: its question and title; `text` is its overview. */
export const tourNew = (d, dir, { question, title }, text) => jpy(d, dir, ['new', d, 'tour', question, title], text)

/** A box of the tour's map: { id, kind, label, parent?, at? ('file:start-end'), blurb? }; `text` is its description. */
export function tourNode(d, dir, { id, kind, label, parent, at, blurb }, text) {
  const args = ['node', d, 'tour', id, kind, label]
  if (parent) args.push(parent)
  if (at) args.push(at)
  if (blurb) args.push('--blurb', blurb)
  return jpy(d, dir, args, text)
}

/** An arrow between two boxes: { from, to, label }. */
export const tourEdge = (d, dir, { from, to, label }) => jpy(d, dir, ['edge', d, 'tour', from, to, label])

/** A step of the storyline: { node, file, start, end, title }; `text` is its details. */
export const tourStep = (d, dir, { node, file, start, end, title }, text) =>
  jpy(d, dir, ['step', d, 'tour', node, file, String(start), String(end), title], text)

/** Six steps through main in src/app.js (the change of repo()). */
export function writeTourSteps(d, dir) {
  tourNew(d, dir, { question: 'How does main load its steps?', title: 'Loading steps' }, 'Main loads each step in turn. Then it returns zero.')
  tourNode(d, dir, { id: 'app', kind: 'system', label: 'App', blurb: 'The program' }, 'The program.')
  tourNode(d, dir, { id: 'f_main', kind: 'function', label: 'main', parent: 'app', at: 'src/app.js:1-73' }, 'Loads the steps.')
  tourNode(d, dir, { id: 'f_end', kind: 'function', label: 'the end of main', parent: 'app', at: 'src/app.js:72-73' }, 'Returns.')
  tourEdge(d, dir, { from: 'f_main', to: 'f_end', label: 'returns zero' })
  for (const k of [1, 2, 3, 4, 5]) {
    tourStep(d, dir, { node: 'f_main', file: 'src/app.js', start: k * 10, end: k * 10 + 1, title: `Main loads step number ${k} here` },
      'Each load call reads one value, in order, before the next one starts.')
  }
  tourStep(d, dir, { node: 'f_end', file: 'src/app.js', start: 72, end: 72, title: 'Main returns zero at the end' },
    'Nothing is returned but zero, whatever the steps loaded.')
}
