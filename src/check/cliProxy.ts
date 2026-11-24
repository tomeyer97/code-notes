// What crosses between the extension host and the CLI's worker thread (cliThread.ts ⇄ cliWorker.ts): the messages,
// and the typed proxy's shape (each worker function, returning a promise).

/** A call: `fn(...args)` of the worker's API. */
export interface WorkerRequest { id: number; fn: string; args: unknown[] }
/** Its answer: the value, or the error's message. */
export type WorkerReply = { id: number; ok: true; v: unknown } | { id: number; ok: false; err: string }

/** `api`'s functions as called from the other thread: the same parameters, the result as a promise. */
export type Remote<Api> = {
  [K in keyof Api]: Api[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never
}

/** An error's message (or the thrown value), its first line only when `firstOnly`. */
export function errorText(e: unknown, firstOnly = false): string {
  const text = String((e as Error)?.message ?? e)
  return firstOnly ? text.split('\n')[0] : text
}
