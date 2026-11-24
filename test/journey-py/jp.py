"""journey.py loaded as a module for the tests, and helpers to run it and to make repositories."""
import importlib.util, os, shutil, subprocess, sys, tempfile

sys.dont_write_bytecode = True      # no __pycache__ beside the skill's script (it ships as is)
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRIPT = os.path.join(ROOT, 'skills', 'code-journey', 'scripts', 'journey.py')
SKILL = os.path.join(ROOT, 'skills', 'code-journey', 'SKILL.md')

_spec = importlib.util.spec_from_file_location('journey', SCRIPT)
journey = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(journey)

GIT_ENV = {'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@t',
           'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1'}


def run(*args, input='', env=None, cwd=None):
    """journey.py with these arguments: (exit code, stdout, stderr)."""
    r = subprocess.run([sys.executable, SCRIPT, *args], input=input, capture_output=True, text=True, cwd=cwd,
                       env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', **(env or {})})
    return r.returncode, r.stdout, r.stderr


def folder(test, files, git=True):
    """A temporary repository holding `files` ({path: text}), committed when `git`; removed after the test."""
    d = tempfile.mkdtemp()
    test.addCleanup(shutil.rmtree, d, True)
    for rel, text in files.items():
        p = os.path.join(d, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'w', encoding='utf-8') as f:
            f.write(text)
    if git:
        git_in(d, 'init', '-q')
        git_in(d, 'add', '-A')
        git_in(d, 'commit', '-q', '-m', 'base')
    return d


def git_in(d, *args):
    subprocess.run(['git', '-C', d, *args], check=True, capture_output=True, env={**os.environ, **GIT_ENV})
