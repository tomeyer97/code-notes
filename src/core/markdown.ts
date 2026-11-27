// Markdown as plain text: the marks of one line taken out, for previews (a row, a picker, a toast). Pure; each rule is
// tested on its own (test/markdown.test.ts).

/** Links and images as their text: "[text](url)" -> "text". */
export const stripLinks = (s: string) => s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')

/** A heading's #s or a quote's > in front of the line. */
export const stripLineMark = (s: string) => s.replace(/^\s*(#+|>)\s*/, '')

/** Bold, strike-through and code marks: "**a**", "__a__", "~~a~~", "`a`" -> "a". */
const stripPairedMarks = (s: string) => s.replace(/\*\*|__|~~|`/g, '')

/**
 * A single * or _ around words: "*this*" -> "this". Only when it opens after a non-word (or the start) and closes
 * before one: snake_case and 2*3*4 keep theirs.
 */
const SINGLE_EMPHASIS = /(^|[^\w*])[*_](?=\S)(.+?)(?<=\S)[*_](?![\w*])/g

/** Bold, strike-through and code marks, then a single * or _ around words. */
export const stripEmphasis = (s: string) => stripPairedMarks(s).replace(SINGLE_EMPHASIS, '$1$2')

/** One line of markdown as plain text (white space as it was). */
export const markdownAsText = (line: string) => stripEmphasis(stripLineMark(stripLinks(line)))
