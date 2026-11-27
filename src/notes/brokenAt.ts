// Where a note file that can't be read is wrong, found from its JSON (not from the words of the reason it was
// refused, which may change): the first field that is not what a note file has. Pure.

import { parseJson } from '../core/format/result'
import { VERSIONS } from '../core/format/versions'

const isInt = (x: unknown): x is number => Number.isInteger(x)

/** The fields of a note file in the order the reader checks them, each with whether its value is one a note has. */
const FIELDS: [string, (v: Record<string, any>) => boolean][] = [
  ['version', (v) => v.version === undefined || v.version === VERSIONS.note],
  ['file', (v) => typeof v.file === 'string' && v.file !== ''],
  ['target', (v) => v.target === undefined || v.target === 'file' || v.target === 'folder'],
  ['range', (v) => !!v.target || (isInt(v.range?.start) && isInt(v.range?.end) && v.range.start >= 1 && v.range.end >= v.range.start)],
  ['status', (v) => v.status === undefined || v.status === 'open' || v.status === 'resolved'],
  ['messages', (v) => Array.isArray(v.messages) && v.messages.length > 0 && v.messages.every((m: any) => typeof m?.body === 'string')],
]

/** Where in `text` (a note file) the cursor goes to fix it: the end when it is not JSON, a wrong field's name, or the
 *  top (0) when no field is to blame. */
export function brokenOffset(text: string): number {
  const json = parseJson(text)
  if (!json.ok) return text.length
  const v = json.value
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 0
  const field = FIELDS.find(([, ok]) => !ok(v as Record<string, any>))?.[0]
  const at = field ? text.indexOf(`"${field}"`) : -1
  return Math.max(at, 0)
}
