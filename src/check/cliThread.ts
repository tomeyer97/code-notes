// Calls into the understanding CLI that run git, made on a worker thread (cliWorker.ts), so the extension host never
// waits for git: a big repository's `git diff` takes a second or more, and every extension sharing the host (over
// Remote-SSH: the editor too) would wait with it. No vscode here: unit tests use it as is.
import { Worker } from 'worker_threads'
import * as path from 'path'
import { READ_ONLY_GIT } from '../platform/git'
import { fireAndForget } from '../platform/run'

/** A call that takes longer than this is given up (a git that hangs): the worker is stopped, the next call starts a new one. */
const TIMEOUT_MS = 120_000

export class CliThread {
  private worker: Worker | undefined
  private seq = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()

  /**
   * `cli`: the CLI file's path. `env`: the worker's environment (its git commands'), with READ_ONLY_GIT: reading the
   * status writes nothing another watcher sees.
   */
  constructor(private cli: string, private env: NodeJS.ProcessEnv = process.env) {}

  /** `fn(...args)` of the CLI (or of the worker's own functions), on the worker; its value, or its error. */
  call<T>(fn: string, ...args: unknown[]): Promise<T> {
    const w = (this.worker ??= this.start())
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.stop(w, new Error(`${fn}: no answer in ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      w.postMessage({ id, fn, args })
    })
  }

  private start(): Worker {
    const w = new Worker(path.join(__dirname, 'cliWorker.js'), { workerData: { cli: this.cli }, env: { ...this.env, ...READ_ONLY_GIT } })
    // Never what keeps a process alive (the unit tests, a host shutting down).
    w.unref()
    w.on('message', (m: { id: number; ok: boolean; v?: unknown; err?: string }) => {
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      clearTimeout(p.timer)
      if (m.ok) p.resolve(m.v); else p.reject(new Error(m.err))
    })
    w.on('error', (e) => this.stop(w, e))
    w.on('exit', () => this.stop(w, new Error('the CLI worker stopped')))
    return w
  }

  /** The worker is gone or given up: every call still waiting fails; the next call starts a new worker. */
  private stop(w: Worker, e: Error): void {
    if (this.worker !== w) return
    this.worker = undefined
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e) }
    this.pending.clear()
    fireAndForget(w.terminate(), 'cliThread: w.terminate')
  }

  dispose(): void { if (this.worker) this.stop(this.worker, new Error('disposed')) }
}
