// What "the same line" means for every anchor engine (anchor.ts, compact.ts, staleDiff.ts): compared without
// whitespace, with one quote style and without a trailing `;` or `,`, so reformatting is not a change.

/** A line as compared: no whitespace, one quote style, no trailing `;` or `,`. */
export const norm = (s: string) => s.replace(/\s+/g, '').replace(/['`]/g, '"').replace(/[;,]+$/, '')

/** A line with nothing in it once normalized. */
export const blank = (s: string) => norm(s) === ''

/** Shorter than this once normalized (`}`, `);`), a line says nothing about where code is. */
export const WEAK_LENGTH = 3

/** Lines like `}` or `);` say nothing about where code is: they don't count as context. */
export const weak = (s: string) => norm(s).length < WEAK_LENGTH

/** Line `k` of `lines` exists and is `want` (normalized; '' never matches). */
export const lineIs = (lines: string[], k: number, want: string) => !!want && k >= 0 && k < lines.length && norm(lines[k]) === want
