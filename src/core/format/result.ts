// What every format parser returns: the value, or why the file was refused (a reason a person can read).

export type Parsed<T> = { ok: true; value: T } | { ok: false; why: string }

export const accepted = <T>(value: T): Parsed<T> => ({ ok: true, value })
export const refused = <T = never>(why: string): Parsed<T> => ({ ok: false, why })

/** The JSON in `raw`, or why it is not JSON. */
export function parseJson(raw: string): Parsed<unknown> {
  try {
    return accepted(JSON.parse(raw))
  } catch (e) {
    return refused(`not valid JSON (${(e as Error).message})`)
  }
}
