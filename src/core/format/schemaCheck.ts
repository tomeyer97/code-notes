// A small JSON Schema checker for the format schemas (schema/*.schema.json): only the keywords they use (README.md
// lists them), no dependency. The tests check every fixture and example file against its schema with it.

/** A schema (or a part of one) as written. */
export type Schema = { [keyword: string]: any } | boolean

/** What is wrong at `path` (JSON path segments from the document's root). */
export interface SchemaProblem { path: (string | number)[]; message: string }

/** The keywords this checker knows; a schema using any other is refused (it would be silently ignored). */
export const KEYWORDS = new Set([
  '$schema', '$id', 'title', 'description', '$comment', '$defs', '$ref', 'type', 'enum', 'const', 'properties',
  'required', 'additionalProperties', 'items', 'prefixItems', 'minItems', 'maxItems', 'minLength', 'maxLength',
  'minimum', 'maximum', 'pattern', 'oneOf', 'anyOf',
])

/** The schemas a `$ref` may name by file (`marks.schema.json#/$defs/mark`), by file name. */
export type SchemaFiles = Record<string, Schema>

/** Where a part of a schema was found: the file it is in (for its `#/...` refs). */
interface At { file: string }

const typeOf = (v: unknown): string => {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  return typeof v
}
const isType = (v: unknown, t: string) => typeOf(v) === t || (t === 'number' && typeOf(v) === 'integer')
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** The schema `ref` names, and the file it is in. */
function resolve(ref: string, at: At, files: SchemaFiles): { schema: Schema; at: At } {
  const [file, pointer = ''] = ref.split('#')
  const name = file || at.file
  let s: any = files[name]
  if (s === undefined) throw new Error(`$ref "${ref}": no schema file "${name}"`)
  for (const key of pointer.split('/').filter(Boolean)) {
    s = s?.[key.replace(/~1/g, '/').replace(/~0/g, '~')]
    if (s === undefined) throw new Error(`$ref "${ref}": nothing at "${pointer}" in ${name}`)
  }
  return { schema: s, at: { file: name } }
}

/** What is wrong with `value` against `schema` (the file `file` of `files`); empty: it conforms. */
export function checkSchema(value: unknown, file: string, files: SchemaFiles): SchemaProblem[] {
  const out: SchemaProblem[] = []
  check(value, files[file], { file }, files, [], out)
  return out
}

function check(v: unknown, s: Schema, at: At, files: SchemaFiles, path: (string | number)[], out: SchemaProblem[]): void {
  if (s === true) return
  if (s === false) { out.push({ path, message: 'not allowed here' }); return }
  const bad = (message: string, p = path) => out.push({ path: p, message })
  if (s.$ref) {
    const r = resolve(s.$ref, at, files)
    check(v, r.schema, r.at, files, path, out)
  }
  if (s.type !== undefined) {
    const types: string[] = Array.isArray(s.type) ? s.type : [s.type]
    if (!types.some((t) => isType(v, t))) { bad(`is ${typeOf(v)}, expected ${types.join(' or ')}`); return }
  }
  if (s.const !== undefined && !same(v, s.const)) bad(`is ${JSON.stringify(v)}, expected ${JSON.stringify(s.const)}`)
  if (s.enum && !s.enum.some((e: unknown) => same(v, e))) bad(`is ${JSON.stringify(v)}, expected one of ${s.enum.map((e: unknown) => JSON.stringify(e)).join(', ')}`)
  if (typeof v === 'string') checkString(v, s, bad)
  if (typeof v === 'number') checkNumber(v, s, bad)
  if (Array.isArray(v)) checkArray(v, s, at, files, path, out, bad)
  else if (v && typeof v === 'object') checkObject(v as Record<string, unknown>, s, at, files, path, out, bad)
  if (s.anyOf && !s.anyOf.some((x: Schema) => conforms(v, x, at, files))) bad('matches none of the allowed shapes')
  if (s.oneOf) {
    const n = s.oneOf.filter((x: Schema) => conforms(v, x, at, files)).length
    if (n !== 1) bad(n ? `matches ${n} of the shapes, expected exactly one` : 'matches none of the allowed shapes')
  }
}

const conforms = (v: unknown, s: Schema, at: At, files: SchemaFiles) => {
  const out: SchemaProblem[] = []
  check(v, s, at, files, [], out)
  return !out.length
}

function checkString(v: string, s: Record<string, any>, bad: (m: string) => void): void {
  const n = [...v].length
  if (s.minLength !== undefined && n < s.minLength) bad(`is ${n} characters, at least ${s.minLength}`)
  if (s.maxLength !== undefined && n > s.maxLength) bad(`is ${n} characters, at most ${s.maxLength}`)
  if (s.pattern !== undefined && !new RegExp(s.pattern, 'u').test(v)) bad(`does not match ${s.pattern}`)
}

function checkNumber(v: number, s: Record<string, any>, bad: (m: string) => void): void {
  if (s.minimum !== undefined && v < s.minimum) bad(`is ${v}, at least ${s.minimum}`)
  if (s.maximum !== undefined && v > s.maximum) bad(`is ${v}, at most ${s.maximum}`)
}

function checkArray(
  v: unknown[], s: Record<string, any>, at: At, files: SchemaFiles, path: (string | number)[], out: SchemaProblem[], bad: (m: string) => void,
): void {
  if (s.minItems !== undefined && v.length < s.minItems) bad(`has ${v.length} items, at least ${s.minItems}`)
  if (s.maxItems !== undefined && v.length > s.maxItems) bad(`has ${v.length} items, at most ${s.maxItems}`)
  const prefix: Schema[] = s.prefixItems ?? []
  v.forEach((x, i) => {
    const item = i < prefix.length ? prefix[i] : s.items
    if (item !== undefined) check(x, item, at, files, [...path, i], out)
  })
}

function checkObject(
  v: Record<string, unknown>, s: Record<string, any>, at: At, files: SchemaFiles, path: (string | number)[], out: SchemaProblem[],
  bad: (m: string, p?: (string | number)[]) => void,
): void {
  for (const k of s.required ?? []) if (!(k in v)) bad(`"${k}" is missing`)
  const props: Record<string, Schema> = s.properties ?? {}
  for (const [k, x] of Object.entries(v)) {
    if (k in props) check(x, props[k], at, files, [...path, k], out)
    else if (s.additionalProperties === false) bad('is not a field here', [...path, k])
  }
}

/** Keywords of `schema` (and every schema in it) this checker doesn't know, as JSON paths. */
export function unknownKeywords(schema: Schema, path = ''): string[] {
  if (typeof schema !== 'object' || schema === null) return []
  const out: string[] = []
  for (const [k, v] of Object.entries(schema)) {
    if (!KEYWORDS.has(k)) { out.push(`${path}/${k}`); continue }
    if (k === 'properties' || k === '$defs') for (const [name, sub] of Object.entries(v as object)) out.push(...unknownKeywords(sub, `${path}/${k}/${name}`))
    else if (k === 'items' || k === 'additionalProperties') out.push(...unknownKeywords(v, `${path}/${k}`))
    else if (k === 'prefixItems' || k === 'oneOf' || k === 'anyOf') (v as Schema[]).forEach((sub, i) => out.push(...unknownKeywords(sub, `${path}/${k}/${i}`)))
  }
  return out
}
