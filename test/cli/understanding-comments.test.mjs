// Code lines (cli/understanding/comments.ts): comments and blank lines never count, by file type.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cliModule } from './helpers/source.mjs'

const { isCode } = await cliModule('comments')

/** Whether each line of `file` is code, read in order (a block comment spans lines). */
const code = (file, lines) => {
  const st = {}
  return lines.map((l) => isCode(l, file, st))
}

// One row per comment syntax: the file, its lines, and which of them are code.
const CASES = [
  ['a.js', ['  // x', '/* a', ' * b', ' */', 'x()', '/** one */ y()', '', '  '], [false, false, false, false, true, true, false, false]],
  ['a.py', ['# x', 'x = 1  # y', '#include'], [false, true, false]],
  ['a.c', ['#include <x.h>', '// c'], [true, false]],
  ['q.sql', ['-- x', 'select 1'], [false, true]],
  ['a.html', ['<!-- a', 'b -->', '<p>x</p>', '<!-- c --> <b>'], [false, false, true, true]],
  ['Dockerfile', ['# x', 'RUN y'], [false, true]],
  ['data.json', ['// not a comment here', '{}'], [true, true]],
  ['x.unknown', ['# anything', ''], [true, false]],
]

for (const [file, lines, want] of CASES) {
  test(`code lines in ${file}`, () => assert.deepEqual(code(file, lines), want))
}
