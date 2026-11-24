// How a journey's text is written out: the paths step text names, markdown for VS Code's renderer, and a value hint's
// value on one row (escaping it is core/escape.ts). No imports, no vscode API (unit-tested in test/journeyModel.test.ts).
// What a journey file holds is journeyModel.ts; a step card's text is put together in tour/stepText.ts.

/** A file's name (`orders.go`) and the folders before it (`api/`): the pieces of every path in step text. */
export const FILE_NAME = /[\w.-]+\.[a-zA-Z]{1,6}/.source
export const DIR = /[\w.-]+\//.source
/** A path with at least one folder: `api/orders.go`. */
export const PATH = `(?:${DIR})+${FILE_NAME}`

/** Not right after a word character, a slash or `[`, and not a markdown link's target (after `](`). */
const NOT_IN_LINK = '(?<![\\w/[])(?<!\\]\\()'
/** `:12`, `:12-14` or `:12–14` (group 2: the first line), or `#L12` (group 3). */
const LINE_SUFFIX = '(?::(\\d+)(?:[-–]\\d+)?|#L(\\d+))'
/**
 * Every `path/to/file.ext:line` (also `:a-b` and `#Ln`) in step text, in or out of backticks and parentheses, but
 * not one that already is a markdown link's text or target. Group 1: the path.
 */
export const REF_IN_TEXT = new RegExp(`${NOT_IN_LINK}\`?(${PATH})${LINE_SUFFIX}\`?`, 'g')

/** Replaces each reference in `t` with what `link` makes of it (its text without backticks, the file, the first line). */
export function linkPaths(t: string, link: (text: string, file: string, line: number) => string): string {
  return t.replace(REF_IN_TEXT, (m: string, file: string, l1?: string, l2?: string) => {
    const line = Number(l1 ?? l2) || 1
    return link(m.replace(/`/g, ''), file, line)
  })
}

/** A value hint's value, cut to about `max` characters so the note after it stays on screen. */
export function capValue(v: string, max = 40): string {
  return v.length <= max ? v : `${v.slice(0, max - 1).trimEnd()}…`
}
