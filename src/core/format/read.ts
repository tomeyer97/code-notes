// Small readers every format parser shares (journeyModel.ts, noteModel.ts): what a field holds when it is the right
// type, and optional fields that are left out when empty.

/** `v` when it is a string, else ''. */
export const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** A plain object (not null, not an array). */
export const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A 1-based line number, or undefined. */
export const line = (x: unknown) => (Number.isInteger(x) && (x as number) >= 1 ? (x as number) : undefined)

/** `{ [k]: v }` when `keep`, else nothing: spread into an object for an optional field. */
export const opt = <K extends string, V>(keep: unknown, k: K, v: V) => (keep ? { [k]: v } as { [P in K]: V } : {})

/** `{ [k]: v }` when `v` is a string (`nonEmpty`: with something in it), kept as it is (a note file's strings are
 *  not trimmed). */
export const optString = <K extends string>(k: K, v: unknown, nonEmpty = false) => opt(typeof v === 'string' && (!nonEmpty || v), k, v as string)

/** `{ [k]: text }` when `v` is a string with something in it, trimmed (a journey's texts are); else nothing. */
export const optTrimmed = <K extends string>(k: K, v: unknown) => opt(str(v).trim(), k, str(v).trim())
