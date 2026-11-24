// Multi-line text written as it reads (a diff, a file): a template literal, indented with the test.

/**
 * A tagged template without its first newline and its common indentation, so a diff in a test looks like a diff.
 * Lines keep what they have past the common indentation (a diff's context lines start with one space).
 */
export function dedent(strings, ...values) {
  const text = String.raw({ raw: strings }, ...values).replace(/^\n/, '').replace(/\n[ \t]*$/, '\n')
  const indent = Math.min(...text.split('\n').filter((l) => l.trim()).map((l) => /^ */.exec(l)[0].length))
  return text.split('\n').map((l) => l.slice(indent)).join('\n')
}
