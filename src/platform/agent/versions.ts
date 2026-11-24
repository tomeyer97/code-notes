// Version numbers as programs print them: Claude Code's `--version`, a request's `needs`, this extension's own.
// No vscode API here (unit-tested in test/agentProtocol.test.ts).

export interface Version {
  core: [number, number, number]
  /** "quiz" in 0.24.0-quiz: a pre-release, older than 0.24.0 itself. */
  pre?: string
}

/** The first major.minor.patch[-pre] in `text` ("2.1.322 (Claude Code)", "v0.24.0-quiz"), else undefined. */
export function parseVersion(text: string): Version | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(text)
  if (!m) return undefined
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], ...(m[4] ? { pre: m[4] } : {}) }
}

/** Pre-release tags by semver's rule: numeric parts as numbers, others as text, a longer tag after its prefix. */
function comparePre(a: string, b: string): number {
  const x = a.split('.')
  const y = b.split('.')
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const nx = /^\d+$/.test(x[i]) ? Number(x[i]) : undefined
    const ny = /^\d+$/.test(y[i]) ? Number(y[i]) : undefined
    if (nx !== undefined && ny !== undefined) { if (nx !== ny) return nx - ny; continue }
    if (nx !== undefined) return -1
    if (ny !== undefined) return 1
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  }
  return x.length - y.length
}

/** Negative when `a` is older than `b`, positive when newer, 0 when the same (semver order). */
export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i]
  if (a.pre === b.pre) return 0
  if (a.pre === undefined) return 1
  if (b.pre === undefined) return -1
  return comparePre(a.pre, b.pre)
}

/** Version text `a` is older than `b`; text without a version reads as 0.0.0. */
export function olderThan(a: string, b: string): boolean {
  const zero: Version = { core: [0, 0, 0] }
  return compareVersions(parseVersion(a) ?? zero, parseVersion(b) ?? zero) < 0
}
