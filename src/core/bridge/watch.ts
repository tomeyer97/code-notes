// The discovery file followed: read every few seconds, and the target it names (or none) handed on when it changes.
// Polling, not a file watcher: the file may not exist yet, its folder neither, and inside WSL it may be on the Windows
// drive, where Linux file events never come. No vscode, no fs (unit-tested in test/bridgeDiscovery.test.ts).
import { BridgeTarget, parseBridgeFile, sameTarget } from './discovery'
import type { Timers } from './client'

/** How often the file is read again. */
export const POLL_MS = 2_000

export interface WatchDeps {
  /** Where to look, in order (the first usable file wins). */
  paths(): Promise<string[]>
  /** A file's text; undefined when it can't be read (missing). */
  read(path: string): Promise<string | undefined>
  /** Hosts besides loopback the token may go to (inside WSL: the Windows host); none when not given. */
  hosts?(): Promise<readonly string[]>
  /** The target changed (undefined: there is none now). */
  changed(target: BridgeTarget | undefined, path: string | undefined): void
  timers: Timers
  pollMs?: number
}

/** The first usable discovery file among `paths`, with its path. */
export async function findTarget(paths: string[], read: WatchDeps['read'], hosts: readonly string[] = []): Promise<{ target: BridgeTarget; path: string } | undefined> {
  for (const path of paths) {
    const text = await read(path)
    const target = text === undefined ? undefined : parseBridgeFile(text, hosts)
    if (target) return { target, path }
  }
  return undefined
}

export class DiscoveryWatch {
  private current: BridgeTarget | undefined
  private timer: unknown
  private running: Promise<void> = Promise.resolve()
  private stopped = true

  constructor(private readonly deps: WatchDeps) {}

  /** Reads now, then every POLL_MS until stop(). */
  start(): Promise<void> {
    this.stopped = false
    return this.check()
  }

  /** Reads now (a setting changed); one read at a time. */
  check(): Promise<void> {
    this.running = this.running.then(() => this.readOnce())
    return this.running
  }

  /** Stops reading; the next start() hands on what it finds, even the same target (the caller hung up meanwhile). */
  stop(): void {
    this.stopped = true
    this.current = undefined
    if (this.timer !== undefined) this.deps.timers.clear(this.timer)
    this.timer = undefined
  }

  private async readOnce(): Promise<void> {
    if (this.stopped) return
    if (this.timer !== undefined) this.deps.timers.clear(this.timer)
    const found = await this.find().catch(() => undefined)
    if (this.stopped) return
    if (!sameTarget(found?.target, this.current)) {
      this.current = found?.target
      this.deps.changed(found?.target, found?.path)
    }
    this.timer = this.deps.timers.set(() => { this.timer = undefined; this.check().catch(() => undefined) }, this.deps.pollMs ?? POLL_MS)
  }

  private async find() {
    return findTarget(await this.deps.paths(), this.deps.read, (await this.deps.hosts?.()) ?? [])
  }
}
