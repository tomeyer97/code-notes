// "A push just happened", from what VS Code's Git view says of the branch each time it reads the repository: pushed
// (an upstream, nothing ahead of it) now, and not pushed when last seen. No vscode here: unit-tested
// (test/checkPushSeen.test.ts).

/** What the Git view says of HEAD (the fields read here). */
export interface HeadSeen { name?: string; commit?: string; upstream?: unknown; ahead?: number }

/** What one look at HEAD found: a line for the log, and whether this look saw `branch` get pushed. */
export interface PushLook { branch: string; line: string; pushedNow: boolean }

/** Per branch: pushed when last seen. */
export class PushWatch {
  private readonly was = new Map<string, boolean>()

  /** One look at HEAD (undefined: no branch checked out). A branch first seen already pushed (a checkout) is no push. */
  look(h: HeadSeen | undefined): PushLook | undefined {
    if (!h?.name) return undefined
    const pushed = !!h.upstream && h.ahead === 0
    const before = this.was.get(h.name)
    this.was.set(h.name, pushed)
    const line = `${h.name} ${pushed ? 'pushed' : 'unpushed'}${before === undefined ? ' (new)' : ''}`
    return { branch: h.name, line, pushedNow: pushed && before === false }
  }
}
