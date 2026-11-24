// Values in messages written the way journey.py writes them (Python's repr() and str()), so an agent reads the same
// words whichever of the two checked the journey (node on PATH or not).

/** Python's len(): code points, not UTF-16 units. */
export const len = (s: string) => [...s].length

/** Python's truth value of a JSON value: empty strings, lists and objects, 0, false and null are false. */
export function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0
  if (v && typeof v === 'object') return Object.keys(v).length > 0
  return !!v
}

/** `a or b`, as Python reads it. */
export const or = <T>(a: unknown, b: T): unknown => (truthy(a) ? a : b)

function quote(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'"
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0) as number
    if (ch === '\\') out += '\\\\'
    else if (ch === q) out += '\\' + q
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (c < 0x20 || c === 0x7f) out += '\\x' + c.toString(16).padStart(2, '0')
    else out += ch
  }
  return q + out + q
}

/** Python's repr() of a JSON value (undefined: None, as dict.get gives it). */
export function repr(v: unknown): string {
  if (v === undefined || v === null) return 'None'
  if (v === true) return 'True'
  if (v === false) return 'False'
  if (typeof v === 'string') return quote(v)
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) return '[' + v.map(repr).join(', ') + ']'
  return '{' + Object.entries(v as Record<string, unknown>).map(([k, x]) => `${quote(k)}: ${repr(x)}`).join(', ') + '}'
}

/** Python's str() of a JSON value: a string as it is, anything else as repr(). */
export const str = (v: unknown): string => (typeof v === 'string' ? v : repr(v))

/** A whole number that is not a boolean (journey.py's is_int: JSON's 2.0 reads as 2 here). */
export const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

/** A number that is not a boolean. */
export const isNum = (v: unknown): v is number => typeof v === 'number'

export const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

/** `x in (…)` for a JSON value against strings or null. */
export const oneOf = (v: unknown, options: readonly (string | null)[]) => (v === undefined ? options.includes(null) : options.includes(v as string))

/** Python's sorted() of strings. */
export const sorted = (xs: Iterable<string>) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

/** "is" or "are", as the messages say how many fields were extra. */
export const isAre = (n: number) => (n === 1 ? 'is' : 'are')

/** Python's round(): halves to the even neighbour. */
export function pyRound(x: number): number {
  const r = Math.round(x)
  return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : r
}
