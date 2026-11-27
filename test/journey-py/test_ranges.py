"""Ranges: where a declaration starts and ends (`range`), and a step range that cuts a statement (a WARNING), per
language."""
import unittest
from jp import journey as J

PY = '''import os


class Session:
    def __init__(self, x):
        self.x = x

    def click(self, y):
        if y:
            return (
                self.x
                + y
            )
        return 0


async def fetch_all(urls):
    out = []
    return out
'''.split('\n')

GO = '''package envs

type Env struct {
	Name string
}

func (e *Env) List(a int) []string {
	out := []string{}
	return out
}

func Free(x int) int {
	return x + 1
}
'''.split('\n')

TS = '''export class Shop {
  private items: string[] = []

  public async add(item: string): Promise<void> {
    const t = `template { with braces
    and lines }`
    this.items.push(item + t)
  }

  get size(): number {
    return this.items.length
  }
}

export const total = async (a: number, b: number) => {
  const re = /\\{+/g
  return a +
    b
}

function helper(x: number) {
  if (x > 1) {
    return x
  }
  return {
    a: 1,
  }
}
'''.split('\n')


def spans(lines, py, what):
    """`range`'s answer for a name, as 1-based (start, end) pairs."""
    src = J.SourceFile(lines, py)
    return [(i + 1, src.span(i) + 1) for i in src.named(what)]


class DeclarationsTest(unittest.TestCase):
    def test_python_by_indentation(self):
        self.assertEqual(spans(PY, True, 'Session'), [(4, 14)])
        self.assertEqual(spans(PY, True, 'click'), [(8, 14)])
        self.assertEqual(spans(PY, True, 'Session.click'), [(8, 14)])
        self.assertEqual(spans(PY, True, 'fetch_all'), [(17, 19)])

    def test_python_line_inside_a_method(self):
        src = J.SourceFile(PY, True)
        self.assertEqual([i + 1 for i in src.around(10)], [4, 8])     # line 11: in click, in Session

    def test_go_functions_and_methods_by_receiver(self):
        self.assertEqual(spans(GO, False, 'List'), [(7, 10)])
        self.assertEqual(spans(GO, False, 'Env.List'), [(7, 10)])
        self.assertEqual(spans(GO, False, 'Free'), [(12, 14)])
        self.assertEqual(spans(GO, False, 'Env'), [(3, 5)])

    def test_typescript_methods_getters_and_arrows(self):
        self.assertEqual(spans(TS, False, 'Shop'), [(1, 13)])
        self.assertEqual(spans(TS, False, 'Shop.add'), [(4, 8)])     # braces inside a template string are skipped
        self.assertEqual(spans(TS, False, 'size'), [(10, 12)])
        self.assertEqual(spans(TS, False, 'total'), [(15, 19)])      # a regex with a brace does not end it
        self.assertEqual(spans(TS, False, 'helper'), [(21, 28)])

    def test_close_names_for_an_unknown_name(self):
        self.assertEqual(J.SourceFile(TS, False).close_names('ad'), ['Shop.add'])

    def test_stripped_line_keeps_indentation_and_drops_block_comments(self):
        src = J.SourceFile(['    f("a{") /* } */ // {'], False)
        self.assertEqual(src.stripped_line(0), '    f()  ')
        self.assertEqual(J.code_of('    f("a{") // {'), 'f("")')       # the other contract: trimmed, strings kept as ""


class RangeWarningsTest(unittest.TestCase):
    def test_a_range_that_starts_on_a_closing_brace(self):
        lines = ['function a() {', '  x()', '}', 'b()']
        self.assertEqual(J.range_warnings(lines, 'a.js', 3, 4),
                         ['a.js:3-4 starts on a lone closing "}" (the end of the block above): did you mean 4-4?'])

    def test_a_typescript_range_cut_after_an_operator(self):
        got = J.range_warnings(TS, 'shop.ts', 15, 17)
        self.assertEqual(got, ['shop.ts:15-17 ends in the middle of a statement (the last line ends with the operator '
                               '"+"): did you mean 15-18 (where it ends)?'])

    def test_a_python_range_cut_after_a_block_opener(self):
        got = J.range_warnings(PY, 'sample.py', 9, 10)
        self.assertEqual(got, ['sample.py:9-10 ends in the middle of a statement (the last line ends with an open "("): '
                               'did you mean 9-9 (without it) or 9-13 (where it ends)?'])

    def test_a_range_on_a_bare_return_then_other_code(self):
        got = J.range_warnings(TS, 'shop.ts', 23, 25)
        self.assertEqual(got, ['shop.ts:23-25 starts on a bare `return x` (the end of the block above; the lines after '
                               'it are other code): did you mean 25-25?',
                               'shop.ts:23-25 ends in the middle of a statement (the last line ends with the opening '
                               '"{" of a new block): did you mean 23-24 (without it) or 23-27 (where it ends)?'])

    def test_go_and_whole_statements_are_fine(self):
        self.assertEqual(J.range_warnings(GO, 'envs.go', 8, 9), [])
        self.assertEqual(J.range_warnings(['not code ('], 'notes.md', 1, 1), [])

    def test_the_end_of_a_cut_statement_is_searched_a_bounded_number_of_lines(self):
        lines = ['f(a,'] + ['  x,'] * (J.STATEMENT_END_SEARCH + 5) + [')']
        self.assertIsNone(J.statement_end(lines, 1, 'f(a,', False))
        self.assertEqual(J.statement_end(['f(a,', '  b)'], 1, 'f(a,', False), 2)


if __name__ == '__main__':
    unittest.main()
