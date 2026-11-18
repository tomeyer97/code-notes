// Links in an agent's answer: `path:line` references and relative Markdown links open the file, also inside
// "(…)" and lists; absolute paths are shown repo-relative (never the home folder). No vscode API here (unit-tested in
// test/answerLinks.test.ts).

import { PATH } from './journeyModel'

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A Markdown image: `![chart](img/a.png "title")` (alt, url). */
const IMAGE = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g
/** A Markdown link: `[the parser](src/parse.ts#L12 "title")` (text, target). */
const MD_LINK = /\[([^\]]+)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g
/** A link target with a scheme (`https://…`, `mailto:…`): not a file in the repository. */
const NOT_A_FILE = /^[a-z][\w+.-]*:/i
/** A file link target and its line: `src/a.ts#L12`, `src/a.ts#L12-L20`, `src/a.ts:12`, `src/a.ts:12-20` (path, line). */
const TARGET = /^(.*?)(?:#L(\d+)(?:-L?\d+)?|:(\d+)(?:-\d+)?)?$/
/** Not right after a word character, "/", "~", ".", "-" or a link already made (its \u0000 mark): a bare reference starts here. */
const REF_START = String.raw`(?<![\w/~.\-\u0000])`
/** A reference's line: `:12`, `:12-20` (the first group) or `#L12` (the second). */
const REF_LINE = String.raw`(?::(\d+)(?:-\d+)?|#L(\d+))`
/**
 * A bare reference, also right after "(" or in a list, optionally in backticks: `src/a.ts:12`, `src/a.ts:12-20`,
 * `src/a.ts#L12` (path, line, line). Never inside a longer word or path, nor after `~/` (outside the repo: left as text).
 * The path is journeyModel's PATH, as in step text (REF_IN_TEXT); what may come before it and the line forms differ.
 */
const BARE_REF = new RegExp(`${REF_START}\`?(${PATH})${REF_LINE}\`?`, 'g')

/**
 * One piece of answer text (outside ``` fences) with its file references as links. `link(text, file, line)` makes
 * one link; `root`: the repository's absolute path (its prefix is dropped everywhere); `home`: shown as "~".
 */
export function linkify(seg: string, root: string, home: string, link: (text: string, file: string, line?: string) => string): string {
  const r = root.replace(/\/+$/, '')
  if (r) seg = seg.replace(new RegExp(`(?:file://)?${esc(r)}/`, 'g'), '')
  const h = home.replace(/\/+$/, '')
  if (h) seg = seg.replace(new RegExp(`(?:file://)?${esc(h)}(?=/|\\b)`, 'g'), '~')
  // Links already made are kept whole (a path inside one is never linked again: nested links showed as raw text).
  const kept: string[] = []
  const keep = (x: string) => `\u0000${kept.push(x) - 1}\u0000`
  seg = seg
    .replace(IMAGE, (_m, alt, url) => keep(`[image: ${alt || url}](${url})`))
    .replace(MD_LINK, (m, text: string, target: string) => {
      if (NOT_A_FILE.test(target) || target.startsWith('#') || target.startsWith('~') || !target) return keep(m)
      const t = TARGET.exec(target)!
      return keep(link(text, t[1].replace(/^\.\//, ''), t[2] ?? t[3]))
    })
    .replace(BARE_REF, (m, file, l1, l2) => keep(link(m, file, l1 ?? l2)))
  return seg.replace(/\u0000(\d+)\u0000/g, (_m, i) => kept[Number(i)])
}
