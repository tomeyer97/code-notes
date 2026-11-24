"""The commands' shared parts: a step edited in place, upserts, the field tables of `set` and `restep`, echo lines."""
import json, os, unittest
from jp import journey as J, run, folder

SRC = {'src/app.js': 'function main() {\n  const order = load(1)\n  save(order)\n  return 0\n}\n'}


def journey_repo(test):
    repo = folder(test, SRC)
    steps = [('new', repo, 'j', 'How does main save an order?', 'Saving orders'),
             ('node', repo, 'j', 'app', 'system', 'App', '--blurb', 'The program'),
             ('node', repo, 'j', 'main', 'function', 'main', 'app', 'src/app.js:1-5'),
             ('step', repo, 'j', 'main', 'src/app.js', '2', '3', 'Main loads the order and saves it')]
    for args in steps:
        code, out, err = run(*args, input='It does it once.')
        test.assertEqual(code, 0, err)
    return repo


class HelpersTest(unittest.TestCase):
    def test_upsert(self):
        xs = [{'k': 1, 'v': 'a'}]
        self.assertIsNone(J.upsert(xs, {'k': 2, 'v': 'b'}, lambda x: x['k'] == 2))
        self.assertEqual(J.upsert(xs, {'k': 1, 'v': 'c'}, lambda x: x['k'] == 1), 0)
        self.assertEqual(xs, [{'k': 1, 'v': 'c'}, {'k': 2, 'v': 'b'}])

    def test_echo_lines(self):
        self.assertEqual(J.node_line({'id': 'a', 'kind': 'function', 'label': 'f', 'parent': 'p',
                                      'at': {'file': 'x.js', 'start': 1, 'end': 2}}),
                         'node a [function] "f"  in p  @ x.js:1-2')
        self.assertEqual(J.edge_line({'from': 'a', 'to': 'b', 'label': 'polls', 'async': True, 'detail': 'every 2 s'}),
                         'edge a -> b: polls  (async) — every 2 s')

    def test_a_refused_step_edit_writes_nothing(self):
        repo = journey_repo(self)
        before = open(os.path.join(repo, 'journeys/j.json')).read()
        ctx = J.Ctx(repo)
        with self.assertRaises(J.Failed):
            with J.step_edit(ctx, 'j', 1) as (j, k, s):
                s['title'] = 'changed'
                J.refuse('no')
        self.assertEqual(open(os.path.join(repo, 'journeys/j.json')).read(), before)


class FieldTablesTest(unittest.TestCase):
    def test_set_says_each_field_its_own_way(self):
        repo = journey_repo(self)
        self.assertEqual(run('set', repo, 'j', 'app', 'label', 'Program')[1].strip(), 'app.label = "Program" (7 chars)')
        self.assertEqual(run('set', repo, 'j', 'app', 'path', 'src')[1].strip(), 'app.path = src')
        got = run('set', repo, 'j', 'main', 'at', 'src/app.js:1-4')[1].split('\n')
        self.assertEqual(got[:2], ['main.at = src/app.js:1-4', '  src/app.js L1: function main() {'])
        code, _, err = run('set', repo, 'j', 'app', 'colour', 'red')
        self.assertEqual((code, err.strip()), (1, 'field is label, blurb, path, summary, kind, at or parent'))

    def test_restep_says_the_changed_field_then_the_step(self):
        repo = journey_repo(self)
        out = run('restep', repo, 'j', '1', 'refs', 'The end is in src/app.js:4.')[1].split('\n')
        self.assertEqual(out[0], 'step 1 refs = The end is in src/app.js:4.')
        self.assertTrue(out[1].startswith('step 1 ['))
        out = run('restep', repo, 'j', '1', 'range', 'src/app.js', '2', '2')[1].split('\n')
        self.assertEqual(out[0], 'step 1 range = src/app.js:2-2')
        self.assertEqual(out[2], '  src/app.js L2: const order = load(1)')
        out = run('restep', repo, 'j', '1', 'title', 'Main loads the order before saving it')[1]
        self.assertTrue(out.startswith('step 1 ['))
        code, _, err = run('restep', repo, 'j', '1', 'range', 'src/app.js', '2')
        self.assertEqual((code, err.strip()), (1, 'restep N range <file> <start> <end>'))

    def test_restep_text(self):
        repo = journey_repo(self)
        code, out, err = run('restep', repo, 'j', '1', 'src/app.js', '2', '2', 'Main loads the order once', input='New lead.')
        self.assertEqual(code, 0, err)
        s = json.load(open(os.path.join(repo, 'journeys/j.json')))['steps'][0]
        self.assertEqual((s['title'], s['lead'], s['range']), ('Main loads the order once', 'New lead.', {'start': 2, 'end': 2}))

    def test_mark_says_what_it_lights(self):
        repo = journey_repo(self)
        out = run('mark', repo, 'j', '1', 'src/app.js', '2', 'load(1)')[1].split('\n')
        self.assertEqual(out[0], 'step 1 mark 1: src/app.js:2 "load(1)"  (1 mark)')


if __name__ == '__main__':
    unittest.main()
