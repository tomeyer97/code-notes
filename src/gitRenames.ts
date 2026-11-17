// Renames git knows, the way `journey.py check` finds them. No vscode import: unit-tested.

type Git = (args: string[]) => Promise<string>

/** Renames committed since `since` (a commit; unknown or missing: the last 500 commits), plus those staged or not. */
async function committedRenames(git: Git, since: string | undefined): Promise<string> {
  const known = since && /^[0-9a-f]{4,40}$/i.test(since) && (await git(['rev-parse', '--verify', '--quiet', `${since}^{commit}`])).trim()
  const range = known ? [`${since}..HEAD`] : ['-n', '500']
  const log = await git(['log', '-M', '--diff-filter=R', '--name-status', '--format=', '--reverse', ...range])
  return log + (await git(['diff', '-M', '--name-status', 'HEAD']))
}

/** `--name-status` lines `R<score>\tfrom\tto` as from -> to. */
function parseNameStatus(text: string, out: Map<string, string>): void {
  for (const l of text.split('\n')) {
    const f = l.split('\t')
    if (f.length === 3 && f[0].startsWith('R')) out.set(f[1], f[2])
  }
}

/** `status --porcelain=v1` lines `R  "a" -> "b"` (quotes only around odd names) as a -> b. */
function parseStatus(text: string, out: Map<string, string>): void {
  const unquote = (s: string) => s.replace(/^"|"$/g, '')
  for (const l of text.split('\n')) {
    if (l[0] !== 'R' || !l.includes(' -> ')) continue
    const [a, b] = l.slice(3).split(' -> ')
    out.set(unquote(a), unquote(b))
  }
}

/** old path -> new path, from git (the same sources as `journey.py check`); empty when git or the repo is missing. */
export async function gitRenames(cwd: string, since?: string): Promise<Map<string, string>> {
  const { execFile } = await import('child_process')
  const git: Git = (args) => new Promise<string>((res) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 5000, maxBuffer: 8 << 20 }, (e, out) => res(e ? '' : String(out)))
  })
  const out = new Map<string, string>()
  parseNameStatus(await committedRenames(git, since), out)
  parseStatus(await git(['status', '--porcelain=v1']), out)
  return out
}
