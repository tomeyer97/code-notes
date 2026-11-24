"""The run's context: git with one error policy, the journeys folder, its backups, and failing."""
import io, json, os, unittest
from contextlib import redirect_stderr, redirect_stdout
from jp import journey as J, folder, git_in


class GitTest(unittest.TestCase):
    def test_outside_a_repository_git_answers_none_and_keeps_its_first_error(self):
        g = J.Git(folder(self, {'a.txt': 'a'}, git=False))
        self.assertEqual(g.head(), '')
        self.assertEqual(g.error, '')                    # head() is quiet: a journey outside git has no commit
        self.assertIsNone(g.run('log'))
        first = g.error
        self.assertIn('not a git repository', first)
        g.run('status')
        self.assertEqual(g.error, first)
        self.assertEqual(g.renames(''), {})

    def test_renames_are_followed_once_per_run(self):
        d = folder(self, {'src/a.js': 'a\n', 'src/b.js': 'b\n'})
        git_in(d, 'mv', 'src/a.js', 'src/c.js')
        code = J.Code(d, J.Git(d), '')
        self.assertEqual(code.renamed('src/a.js'), 'src/c.js')
        self.assertEqual(code.renamed_path('src/a.js'), 'src/c.js')
        git_in(d, 'mv', 'src/b.js', 'src/d.js')
        self.assertEqual(code.renamed('src/b.js'), 'src/b.js')     # asked once: the second rename is not seen
        self.assertEqual(J.Git(d).changed_files('HEAD'), {'src/c.js', 'src/d.js'})


class JourneysTest(unittest.TestCase):
    def test_the_folder(self):
        d = folder(self, {'.code-notes/journeys/x.json': '{}'}, git=False)
        self.assertEqual(J.Journeys(d).dir, os.path.join(d, '.code-notes', 'journeys'))
        self.assertEqual(J.Journeys(d, 'docs/j').dir, os.path.join(d, 'docs/j'))
        os.makedirs(os.path.join(d, 'journeys'))
        self.assertEqual(J.Journeys(d).dir, os.path.join(d, 'journeys'))

    def test_a_backup_that_cannot_be_kept_is_said_once(self):
        d = folder(self, {'journeys/.bak': 'a file where the backup folder goes'}, git=False)
        js = J.Journeys(d)
        err = io.StringIO()
        with redirect_stderr(err):
            js.save('a', {'version': 2, 'steps': []})
            js.save('a', {'version': 2, 'steps': [], 'title': 'again'})
        self.assertEqual(err.getvalue().count('WARNING: no backup of a could be kept'), 1)
        self.assertTrue(os.path.exists(js.path('a')))       # the journey itself is written

    def test_hand_edits_are_returned_to_the_caller(self):
        d = folder(self, {'a.js': 'one\ntwo\n', 'journeys/x.json': json.dumps(
            {'version': 2, 'title': 'X', 'nodes': [{'id': 'f', 'kind': 'function', 'label': 'f', 'at': 'a.js:1-2'}],
             'edges': [], 'steps': []})}, git=False)
        notes = []
        j = J.Journeys(d).load('x', notes=notes)
        self.assertEqual(j['nodes'][0]['at']['file'], 'a.js')
        self.assertEqual(len(notes), 1)
        self.assertIn('"at" was hand-written as the string "a.js:1-2"', notes[0])
        self.assertEqual(J.Journeys(d).load('x')['nodes'][0]['at']['start'], 1)      # no list: read all the same

    def test_an_unreadable_journey_fails_with_one_problem_line(self):
        d = folder(self, {'journeys/x.json': '{ broken'}, git=False)
        out = io.StringIO()
        with redirect_stdout(out), self.assertRaises(J.Failed) as e:
            J.Journeys(d).load('x')
        self.assertEqual(e.exception.text, '')
        self.assertTrue(out.getvalue().startswith('PROBLEM: '))
        with self.assertRaises(J.Failed) as e:
            J.Journeys(d).load('y')
        self.assertIn("No journey 'y'.", e.exception.text)


class FailingTest(unittest.TestCase):
    def test_refuse_and_fail(self):
        with self.assertRaises(J.Failed) as e:
            J.refuse('label is too long')
        self.assertEqual((e.exception.text, e.exception.code), ('label is too long; nothing was written', 1))
        e = J.UsageError('node', 'missing <slug>')
        self.assertEqual((e.text, e.code), ('node: missing <slug>', 2))


if __name__ == '__main__':
    unittest.main()
