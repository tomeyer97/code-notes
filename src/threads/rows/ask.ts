// Claude on a note's thread: what it wrote so far and is doing, with Cancel; a failure with Try again and Dismiss.
import { askErrors, asking, type Asking } from '../../ask/run'
import { Cmd } from '../../platform/commands'
import { THREAD_WORD } from '../context'
import type { Links } from '../links'
import { systemRow, type ThreadContribution, type ThreadRow } from '../rows'

/** Claude's elapsed seconds redraw the row in steps of this many ms (the row shows them when it is redrawn). */
const ELAPSED_STEP_MS = 5000

function answeringRow(id: string, a: Asking): ThreadRow {
  const elapsed = Date.now() - a.started
  const secs = Math.round(elapsed / 1000)
  const activity = a.activity ? `${a.text ? '\n\n' : ''}_${a.activity}_` : ''
  const thinking = !a.text && !a.activity ? '_Thinking…_' : ''
  const comment = systemRow((l) => `${a.text || ''}${activity}${thinking}\n\n${l.to('Cancel', Cmd.cancelClaude, id)}`, 'Claude',
    secs > 2 ? `answering… ${secs}s` : 'answering…')
  return { comment, key: JSON.stringify(['answering', a.text, a.activity, Math.floor(elapsed / ELAPSED_STEP_MS)]) }
}

/** First after the messages: Claude answering. */
export const claudeAnswering: ThreadContribution = {
  facts: (n) => (asking.has(n.data.id) ? { working: true, words: [THREAD_WORD.asking] } : undefined),
  rows: (n) => {
    const a = asking.get(n.data.id)
    return a ? [answeringRow(n.data.id, a)] : []
  },
}

/** Last: Claude couldn't answer (a passing status, not a message; never saved). */
export const claudeFailed: ThreadContribution = {
  facts: (n) => (askErrors.has(n.data.id) ? { failed: true } : undefined),
  rows: (n) => {
    const id = n.data.id
    const err = askErrors.get(id)
    if (!err) return []
    const text = (l: Links) =>
      `⚠ Claude couldn't answer: ${err}\n\n${l.to('Try again', Cmd.askClaude, id)} · ${l.to('Dismiss', Cmd.cancelClaude, id)}`
    return [{ comment: systemRow(text, 'Code Notes') }]
  },
}
