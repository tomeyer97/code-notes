// Renames git knows, the way `journey.py check` finds them. No vscode import: unit-tested.
/** old path -> new path, from git (the same sources as `journey.py check`); empty when git or the repo is missing. */
export async function gitRenames(cwd: string, since?: string): Promise<Map<string, string>> {
  const { execFile } = await import('child_process')
  const git = (args: string[]) => new Promise<string>((res) => execFile('git', ['-C', cwd, ...args], { timeout: 5000, maxBuffer: 8 << 20 }, (e, out) => res(e ? '' : String(out))))
  const out = new Map<string, string>()
  const ok = since && /^[0-9a-f]{4,40}$/i.test(since) && (await git(['rev-parse', '--verify', '--quiet', `${since}^{commit}`])).trim()
  const text = (await git(['log', '-M', '--diff-filter=R', '--name-status', '--format=', '--reverse', ...(ok ? [`${since}..HEAD`] : ['-n', '500'])]))
    + (await git(['diff', '-M', '--name-status', 'HEAD']))
  for (const l of text.split('\n')) { const f = l.split('\t'); if (f.length === 3 && f[0].startsWith('R')) out.set(f[1], f[2]) }
  for (const l of (await git(['status', '--porcelain=v1'])).split('\n')) {
    if (l[0] === 'R' && l.includes(' -> ')) { const [a, b] = l.slice(3).split(' -> '); out.set(a.replace(/^"|"$/g, ''), b.replace(/^"|"$/g, '')) }
  }
  return out
}
