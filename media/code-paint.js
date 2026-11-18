// A few lines of code, coloured: the beat's code under a step's animation (journey-scene.js). Colours that read as
// code in any theme (the panel can't have the editor's own): comments, strings, numbers, keywords and called names, by
// one pattern for every language, a line at a time (a block comment's inner lines stay plain). Needs common.js.
// API: window.CodePaint = { paintCode(into, text, hash), showCode(codeEl, c) }
;(function () {
  const { el, baseName } = window.common

  const KEYWORDS = new Set([
    'func', 'function', 'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'default', 'break', 'continue', 'go',
    'defer', 'var', 'const', 'let', 'type', 'struct', 'interface', 'import', 'export', 'from', 'package', 'class',
    'extends', 'new', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'range', 'map', 'chan', 'select', 'def', 'in',
    'of', 'not', 'and', 'or', 'is', 'None', 'True', 'False', 'true', 'false', 'nil', 'null', 'undefined', 'this', 'self',
  ])
  /** One token per match, by the group it fills. */
  const TOKEN = new RegExp([
    /(\/\/.*$|\/\*.*?(?:\*\/|$))/.source, // 1: a // or /* comment
    /(#.*$)/.source, // 2: a # comment (where # starts one)
    /("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`[^`]*`?)/.source, // 3: a string
    /(\b\d[\w.]*)/.source, // 4: a number
    /([A-Za-z_$][\w$]*)/.source, // 5: a name
  ].join('|'), 'g')
  /** Files where # starts a comment. */
  const HASH_COMMENTS = /\.(py|sh|ya?ml|toml|rb)$|Dockerfile|Makefile/
  /** The indentation the lines share is cut, up to this many characters. */
  const MAX_CUT = 99

  /** The token class (scn-tk-<class>) of match `m` in `text`: c (comment), s, n, k (keyword), f (a called name), or
   *  '' (left plain). */
  function tokenClass(m, text, hash) {
    if (m[1]) return 'c'
    if (m[2]) return hash ? 'c' : ''
    if (m[3]) return 's'
    if (m[4]) return 'n'
    if (KEYWORDS.has(m[5])) return 'k'
    return text[TOKEN.lastIndex] === '(' ? 'f' : ''
  }

  /** `text` (one line) into `into`, coloured. `hash`: # starts a comment in this file. */
  function paintCode(into, text, hash) {
    TOKEN.lastIndex = 0
    let at = 0, m
    while ((m = TOKEN.exec(text))) {
      const cls = tokenClass(m, text, hash)
      // A # that is no comment here: only the sign is skipped, the rest is read on.
      if (m[2] && !hash) { TOKEN.lastIndex = m.index + 1; continue }
      if (!cls) continue
      if (m.index > at) into.append(text.slice(at, m.index))
      into.append(el('span', `scn-tk-${cls}`, m[0]))
      at = TOKEN.lastIndex
    }
    if (at < text.length) into.append(text.slice(at))
  }

  /** The beat's line and a few around it (`c`: { file, line, from, lines }) into `codeEl`; none: hidden. */
  function showCode(codeEl, c) {
    codeEl.textContent = ''
    codeEl.hidden = !c || !c.lines || !c.lines.length
    if (codeEl.hidden) return
    const head = el('div', 'scn-code-file', `${baseName(c.file)}:${c.line}`)
    head.title = c.file
    codeEl.append(head)
    // Without the indentation they share: the part that matters stays in view.
    const hash = HASH_COMMENTS.test(String(c.file))
    const ls = c.lines.map((t) => String(t).replace(/\t/g, '  '))
    const indents = ls.filter((t) => t.trim()).map((t) => t.length - t.trimStart().length)
    const cut = Math.min(...indents, MAX_CUT)
    ls.forEach((t, k) => {
      const row = el('div', `scn-code-line${c.from + k === c.line ? ' on' : ''}`)
      const tx = el('span', 'scn-code-t')
      paintCode(tx, t.trim() ? t.slice(cut) : '', hash)
      row.append(el('span', 'scn-code-n', String(c.from + k)), tx)
      codeEl.append(row)
    })
  }

  window.CodePaint = { paintCode, showCode }
})()
