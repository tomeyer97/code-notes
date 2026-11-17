// What a refresh of the understanding check depends on, cheaply: the paths `git status --porcelain=v2 -z` lists, so
// their size and time can go into the key (git's own line for a modified file doesn't change when it is edited again).
// No vscode and no worker here: unit tests use it as is.

/** The paths of the entries of `git status --porcelain=v2 -z` output (renames: the new path; headers skipped). */
export function statusPaths(out: string): string[] {
  const recs = out.split('\0')
  const paths: string[] = []
  // Fields before the path: "1 XY sub mH mI mW hH hI path", "2 XY sub mH mI mW hH hI Xscore path\0orig",
  // "u XY sub m1 m2 m3 mW h1 h2 h3 path", "? path", "! path".
  const skip: Record<string, number> = { '1': 8, '2': 9, u: 10, '?': 1, '!': 1 }
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i]
    const n = skip[r[0]]
    if (!r || r[1] !== ' ' || n === undefined) continue
    const p = r.split(' ').slice(n).join(' ')
    if (p) paths.push(p)
    if (r[0] === '2') i++ // the original path follows as its own record
  }
  return paths
}

/** The branch `git status --porcelain=v2 --branch` names ("(detached)" when HEAD is detached), or undefined. */
export function statusBranch(out: string): string | undefined {
  for (const r of out.split('\0')) if (r.startsWith('# branch.head ')) return r.slice('# branch.head '.length)
  return undefined
}

/**
 * Runs `job` one at a time. A call while it runs doesn't start another run each: all such calls share ONE next run,
 * which starts when the current one ends (forced when any of them asked for it). Each call's promise settles after a
 * run that started after the call.
 */
export class Coalesced {
  private running: Promise<void> | undefined
  private next: { force: boolean; p: Promise<void> } | undefined
  constructor(private job: (force: boolean) => Promise<void>) {}

  run(force: boolean): Promise<void> {
    if (this.next) { this.next.force ||= force; return this.next.p }
    if (!this.running) return this.start(force)
    const n = { force, p: Promise.resolve() }
    const go = () => { this.next = undefined; return this.start(n.force) }
    n.p = this.running.then(go, go)
    this.next = n
    return n.p
  }

  get busy(): boolean { return !!this.running }

  private start(force: boolean): Promise<void> {
    const p: Promise<void> = Promise.resolve().then(() => this.job(force)).finally(() => { if (this.running === p) this.running = undefined })
    this.running = p
    return p
  }
}
