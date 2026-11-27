"""journey.py's rules on test requests: one JSON list of requests on stdin, one JSON list of answers on stdout.
JOURNEY_RULES=node runs them through journey-check.mjs (the extension's rules), JOURNEY_RULES=python through
journey.py's own; test/cli/journeyRules.mjs compares the two."""
import importlib.util, json, os, sys, tempfile

spec = importlib.util.spec_from_file_location('journey', sys.argv[1])
jp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jp)


def in_file(lines):
    """A repository holding these lines as `f.txt`, for the rules that read files."""
    d = tempfile.mkdtemp()
    with open(os.path.join(d, 'f.txt'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))
    return d


def anchor_of(c):
    """The anchor of a relocation case (test/fixtures/compact-cases.json), made from the code it was written on."""
    was = c.get('was') or c['now']
    s, e = c['range']
    a = jp.make_anchor(was[s:e + 1], *jp.around(was, s, e))
    if c.get('hash') == 'none':
        a['hash'] = ''
    elif c.get('hash') == 'every-line':
        a['hash'] = jp.text_hash(was[s:e + 1], True)
    return a


def answer(r):
    op = r['op']
    if op == 'shape':
        problems, upgrades = jp.journey_shape(r['journey'])
        return {'problems': problems, 'upgrades': upgrades}
    if op == 'scene':
        return [list(i) for i in jp.scene_issues(r['step'], r['scene'])]
    if op == 'mark':
        got = jp.mark_check(r['mark'], r['file'], r.get('doc'), r.get('onMissing', 'drop'))
        return {'shape': got.shape, 'code': list(got.code) if got.code else None, 'spot': list(got.spot) if got.spot else None}
    if op == 'podcast':
        return jp.podcast_findings(r['raw'], r.get('journey'), r.get('audio'), r.get('audioDuration'), r.get('changed'), r.get('files'))
    if op == 'place':
        got = jp.anchor_place(in_file(r['now']), 'f.txt', anchor_of(r), r['hint'])
        return list(got) if got else None
    if op == 'line':
        return jp.line_at(in_file(r['lines']), 'f.txt', r['line'], r['text'])
    if op == 'limits':
        return {k: getattr(jp, k) for k in r['names']}
    raise ValueError(f'unknown op {op}')


print(json.dumps([answer(r) for r in json.load(sys.stdin)], default=sorted))
