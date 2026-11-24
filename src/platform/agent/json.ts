// JSON read from outside (Claude Code's stream, a script's request): an object narrowed before its fields are read.
export type Json = Record<string, unknown>
export const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
