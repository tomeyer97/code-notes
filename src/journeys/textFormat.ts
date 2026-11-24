// How a journey's text is written out: the paths step text names, markdown for VS Code's renderer, and a value hint's
// value on one row (escaping it is core/escape.ts). No imports, no vscode API (unit-tested in test/textFormat.test.ts,
// with a table of the references that link and those that don't). What a journey file holds is journeyModel.ts; a
// step card's text is put together in tour/stepText.ts.

/** A file's name (`orders.go`): an extension of 1-6 letters (`song.mp3` and `Makefile` don't link: see the test). */
export const FILE_NAME = /[\w.-]+\.[a-zA-Z]{1,6}/.source
/** One folder before it (`api/`): the pieces of every path in step text. */
export const DIR = /[\w.-]+\//.source
/** A path with at least one folder: `api/orders.go`. */
export const PATH = `(?:${DIR})+${FILE_NAME}`

/** Not right after a word character, a slash or `[`, and not a markdown link's target (after `](`). */
const NOT_IN_LINK = /(?<![\w/[])(?<!\]\()/.source
/** `:12`, `:12-14` or `:12–14` (`line`: the first line), or `#L12` (`hashLine`). */
const LINE_SUFFIX = /(?::(?<line>\d+)(?:[-–]\d+)?|#L(?<hashLine>\d+))/.source

/**
 * Every `path/to/file.ext:line` (also `:a-b` and `#Ln`) in step text, in or out of backticks and parentheses, but
 * not one that already is a markdown link's text or target. Groups: `path`, then `line` or `hashLine` (also numbered
 * 1, 2, 3 in that order, as tour/stepText.ts reads them).
 */
export const REF_IN_TEXT = new RegExp(`${NOT_IN_LINK}\`?(?<path>${PATH})${LINE_SUFFIX}\`?`, 'g')

/** REF_IN_TEXT's named groups. */
interface RefGroups { path: string; line?: string; hashLine?: string }

/** Replaces each reference in `t` with what `link` makes of it (its text without backticks, the file, the first line). */
export function linkPaths(t: string, link: (text: string, file: string, line: number) => string): string {
  return t.replace(REF_IN_TEXT, (...args: unknown[]) => {
    const g = args[args.length - 1] as RefGroups
    const text = (args[0] as string).replace(/`/g, '')
    return link(text, g.path, Number(g.line ?? g.hashLine) || 1)
  })
}

/** A value hint's value, cut to about `max` characters so the note after it stays on screen. */
export function capValue(v: string, max = 40): string {
  return v.length <= max ? v : `${v.slice(0, max - 1).trimEnd()}…`
}
