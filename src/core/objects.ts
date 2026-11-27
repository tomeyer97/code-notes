// Small helpers for plain objects. Pure.

/**
 * A copy of `o` without its undefined fields, in the same key order (instead of `...(x ? { x } : {})` chains). `o`
 * itself is left as it is.
 */
export function definedOnly<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}
