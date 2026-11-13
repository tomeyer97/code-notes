// Links in an agent's answer: `path:line` references and relative Markdown links open the file, also inside
// "(…)" and lists; absolute paths are shown repo-relative (never the home folder). No vscode API here (unit-tested).

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

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
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt, url) => keep(`[image: ${alt || url}](${url})`))
    .replace(/\[([^\]]+)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g, (m, text: string, target: string) => {
      if (/^[a-z][\w+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('~') || !target) return keep(m)
      const t = /^(.*?)(?:#L(\d+)(?:-L?\d+)?|:(\d+)(?:-\d+)?)?$/.exec(target)!
      return keep(link(text, t[1].replace(/^\.\//, ''), t[2] ?? t[3]))
    })
    // A bare reference, also right after "(" or in a list; `~/…` (outside the repo) is left as text.
    .replace(/(?<![\w/~.\-\u0000])`?((?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z]{1,6})(?::(\d+)(?:-\d+)?|#L(\d+))`?/g, (m, file, l1, l2) => keep(link(m, file, l1 ?? l2)))
  return seg.replace(/\u0000(\d+)\u0000/g, (_m, i) => kept[Number(i)])
}
