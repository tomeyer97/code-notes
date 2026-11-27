// A feature's ports: what its activate was given (and made), shared by the feature's own modules. Set once by the
// feature's activate; read before that, it throws (a module that reads it at import time is a bug, not an undefined).

export interface PortsSlot<T> {
  set(value: T): void
  get(): T
  /** Set yet (code that may run before its feature started, e.g. a disposable at shutdown). */
  readonly ready: boolean
}

export function portsSlot<T>(feature: string): PortsSlot<T> {
  let value: T | undefined
  return {
    set: (v) => { value = v },
    get: () => {
      if (value === undefined) throw new Error(`Code Notes: ${feature} used before it was activated`)
      return value
    },
    get ready() { return value !== undefined },
  }
}
