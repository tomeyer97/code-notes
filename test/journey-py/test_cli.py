"""The command line: one declaration per command gives the dispatch, the list, the help and the usage errors."""
import json, os, re, unittest
from jp import journey as J, run, folder, SKILL

SRC = {'src/app.js': 'function main() {\n  load(1)\n  load(2)\n  return 0\n}\n'}


class RegistryTest(unittest.TestCase):
    def test_every_command_is_declared_once_with_its_usage(self):
        self.assertEqual(len(J.COMMANDS), 29)
        for name, c in J.COMMANDS.items():
            self.assertTrue(c.usage.startswith(f'  journey.py {name} '), name)
            self.assertTrue(J.usage_lines(name), name)
            self.assertTrue(c.fn.__name__.startswith('cmd_'), name)

    def test_the_list_the_manual_and_a_command_s_help_come_from_the_declarations(self):
        code, out, _ = run('help')
        self.assertEqual(code, 0)
        for name, c in J.COMMANDS.items():
            self.assertIn(f'  {name.ljust(15)}  {c.summary}', out)
        _, manual, _ = run('help', 'all')
        for c in J.COMMANDS.values():
            self.assertIn(c.usage, manual)
        for r in J.RULE_BOOK:
            self.assertIn(r.text, manual)
        _, link, _ = run('help', 'link')
        self.assertTrue(link.startswith(J.COMMANDS['link'].usage))
        self.assertEqual([r for r in J.RULE_BOOK if r.text in link], [r for r in J.RULE_BOOK if 'link' in r.commands])

    def test_every_rule_names_commands_that_exist(self):
        for r in J.RULE_BOOK:
            self.assertTrue(set(r.commands) <= set(J.COMMANDS), r.commands)

    def test_help_topics(self):
        code, out, _ = run('help', 'limits')
        self.assertEqual((code, out.strip()), (0, J.limits_table()))
        _, scene, _ = run('help', 'scene')
        self.assertIn(f'  service: code at work\n      fields: fn "name()" <= {J.FN_CHARS}', scene)
        code, _, err = run('help', 'nope')
        self.assertEqual(code, 2)
        self.assertTrue(err.startswith("unknown command 'nope'"))
        self.assertEqual(run()[0], 2)

    def test_ref_and_link_patterns(self):
        self.assertEqual(J.REF, r'((?:[\w.@-]+/)*[\w.@-]+\.[A-Za-z]{1,6}):(\d+)(?:-(\d+))?')
        self.assertEqual(J.LINK, r'(?<![\w/])((?:[\w.@-]+/)+[\w.@-]+\.[A-Za-z]{1,6}):(\d+)(?:-(\d+))?')


class UsageErrorsTest(unittest.TestCase):
    def setUp(self):
        self.repo = folder(self, SRC)

    def test_missing_arguments(self):
        code, _, err = run('new', self.repo, 'x')
        self.assertEqual(code, 2)
        self.assertEqual(err.split('\n')[0], 'new: missing <question> <title>')
        self.assertTrue(err.split('\n')[1].startswith('usage: journey.py new   <repo> <slug>'))

    def test_too_many_arguments(self):
        self.assertEqual(run('reset', self.repo, 'a', 'b', 'c')[2].split('\n')[0], 'reset: 2 argument(s) too many')

    def test_the_repo_comes_first(self):
        err = run('check', 'not-a-dir', 'x')[2]
        self.assertEqual(err.split('\n')[0], "check: missing <repo>: 'not-a-dir' is not a directory (the repo comes first)")

    def test_unknown_command_and_steps(self):
        self.assertEqual(run('nope', self.repo)[2].strip(), "unknown command 'nope' (journey.py alone lists them)")
        code, _, err = run('check', self.repo, 'x', '--steps', '3')
        self.assertEqual((code, err.split('\n')[0]), (2, 'check: --steps 3: write it as A-B (e.g. 2-3)'))

    def test_restep_dispatches_a_field_or_the_text(self):
        self.assertEqual(J.STEP_FIELDS.keys(), {'title', 'lead', 'details', 'refs', 'node', 'range'})


class OptionsTest(unittest.TestCase):
    def write(self, *before, env=None):
        repo = folder(self, SRC)
        code, out, err = run(*before, 'new', repo, 'j', 'How does main load its steps?', 'Loading steps', input='Main loads them.',
                             env=env)
        self.assertEqual(code, 0, err)
        return repo

    def test_dir_anywhere(self):
        repo = self.write('--dir', 'docs/j')
        self.assertTrue(os.path.exists(os.path.join(repo, 'docs/j/j.json')))
        self.assertEqual(run('check', repo, 'j', 'story', '--dir=docs/j')[0], 1)      # found there (and 0 steps)
        self.assertIn("No journey 'j'", run('check', repo, 'j')[2])

    def test_steps_anywhere(self):
        repo = self.write()
        self.assertIn('0 steps (want 6-14', run('check', repo, 'j', 'quiet')[1])
        self.assertIn('0 steps (want 2-3', run('check', '--steps', '2-3', repo, 'j', 'quiet')[1])

    def test_the_model_is_a_flag_or_the_environment(self):
        repo = self.write(env={'JOURNEY_MODEL': 'from-env'})
        self.assertEqual(json.load(open(os.path.join(repo, 'journeys/j.json')))['model'], 'from-env')
        run('new', repo, 'k', 'How does main load each step?', 'Main', '--model', 'given', input='Main loads them.')
        self.assertEqual(json.load(open(os.path.join(repo, 'journeys/k.json')))['model'], 'given')


class SkillTest(unittest.TestCase):
    def test_the_skill_s_limits_table_is_journey_py_s(self):
        skill = open(SKILL, encoding='utf-8').read()
        self.assertTrue(J.limits_table() + '\n' in skill, 'SKILL.md: paste `journey.py help limits` under "## Limits"')

    def test_the_commands_the_skill_names_exist(self):
        skill = open(SKILL, encoding='utf-8').read()
        named = set(re.findall(r'\$J ([a-z-]+)', skill)) - {'help'}
        self.assertTrue(named)
        self.assertEqual(named - set(J.COMMANDS), set())


if __name__ == '__main__':
    unittest.main()
