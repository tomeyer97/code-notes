// Where things are in a JSON text: the span of the value at a path, the place invalid JSON stops being JSON, and an
// offset as line and column. Nothing format-specific: a validator says what is wrong (with a path), this says where,
// so an editor can underline it. Pure.

/** A range of the text (offsets). */
export interface Span { start: number; end: number }

/**
 * Where the value at `path` is in the JSON text (the deepest part of the path that is there; the whole text when
 * none is). For invalid JSON, the place the parser stopped.
 */
export function locate(raw: string, path: (string | number)[]): Span {
  let spans: Map<string, Span>
  try { spans = valueSpans(raw) } catch (e) {
    const at = e instanceof JsonSyntax ? e.at : 0
    return { start: at, end: Math.min(raw.length, at + 1) }
  }
  for (let n = path.length; n >= 0; n--) {
    const s = spans.get(JSON.stringify(path.slice(0, n)))
    if (s) return s
  }
  return { start: 0, end: 0 }
}

/** Where invalid JSON stops being JSON, and what was there. */
export class JsonSyntax extends Error {
  constructor(readonly at: number, what: string) { super(what) }
}

/** Invalid JSON said for an author: "line 3, column 12: unexpected "}"" (the engine's own message names no place). */
export function jsonSyntaxError(raw: string): string | undefined {
  try { valueSpans(raw); return undefined } catch (e) {
    if (!(e instanceof JsonSyntax)) return String(e)
    const { line, col } = lineCol(raw, e.at)
    return `line ${line + 1}, column ${col + 1}: ${e.message}`
  }
}

/** Line and column (0-based) of an offset. */
export function lineCol(raw: string, offset: number): { line: number; col: number } {
  let line = 0, last = -1
  for (let k = 0; k < offset && k < raw.length; k++) if (raw[k] === '\n') { line++; last = k }
  return { line, col: offset - last - 1 }
}

const WHITESPACE = ' \t\n\r'
/** A JSON literal or number at the start of the text. */
const SCALAR = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/
/** The longest scalar SCALAR has to look at (a number with many digits is still found). */
const SCALAR_LOOKAHEAD = 64

/**
 * Every value's span in the JSON text, by its path (JSON of the keys and indexes); a key's value spans from the key.
 * Strict: anything that isn't JSON throws a JsonSyntax with its place.
 */
function valueSpans(raw: string): Map<string, Span> {
  const reader = new SpanReader(raw)
  reader.value([])
  reader.end()
  return reader.spans
}

/** A recursive-descent reader over the text that records each value's span as it passes it. */
class SpanReader {
  readonly spans = new Map<string, Span>()
  private i = 0
  constructor(private readonly raw: string) {}

  /** The value at the reader's place, at `path`; `from`: where its span starts (its key, in an object). */
  value(path: (string | number)[], from?: number): void {
    this.ws()
    const start = from ?? this.i
    const c = this.raw[this.i]
    if (c === '{') this.object(path)
    else if (c === '[') this.array(path)
    else if (c === '"') this.str()
    else this.scalar()
    this.spans.set(JSON.stringify(path), { start, end: this.i })
  }

  /** Only whitespace is left. */
  end(): void {
    this.ws()
    if (this.i < this.raw.length) this.bad()
  }

  private object(path: (string | number)[]): void {
    this.i++
    this.ws()
    if (this.raw[this.i] === '}') { this.i++; return }
    do {
      this.ws()
      const keyAt = this.i
      const key = this.str()
      this.expect(':')
      this.value([...path, key], keyAt)
    } while (this.listGoesOn('}'))
  }

  private array(path: (string | number)[]): void {
    this.i++
    this.ws()
    if (this.raw[this.i] === ']') { this.i++; return }
    let n = 0
    do this.value([...path, n++])
    while (this.listGoesOn(']'))
  }

  /** After an item: true on ",", false on `close` (both read), else a syntax error. */
  private listGoesOn(close: string): boolean {
    this.ws()
    const c = this.raw[this.i]
    if (c === ',' || c === close) { this.i++; return c === ',' }
    return this.bad(this.atEnd() ? undefined : `expected "," or "${close}", found ${JSON.stringify(c)}`)
  }

  private str(): string {
    const raw = this.raw
    if (raw[this.i] !== '"') this.bad()
    const s = this.i
    this.i++
    while (this.i < raw.length && raw[this.i] !== '"') {
      if (raw[this.i] === '\n') this.bad('a line break inside a string')
      this.i += raw[this.i] === '\\' ? 2 : 1
    }
    if (this.atEnd()) this.bad()
    this.i++
    try { return JSON.parse(raw.slice(s, this.i)) as string } catch { this.i = s; return this.bad('a bad escape in a string') }
  }

  private scalar(): void {
    const m = SCALAR.exec(this.raw.slice(this.i, this.i + SCALAR_LOOKAHEAD))
    if (!m) this.bad()
    this.i += m![0].length
  }

  private expect(c: string): void {
    this.ws()
    if (this.raw[this.i] !== c) this.bad(this.atEnd() ? undefined : `expected ${JSON.stringify(c)}, found ${JSON.stringify(this.raw[this.i])}`)
    this.i++
  }

  private ws(): void { while (this.i < this.raw.length && WHITESPACE.includes(this.raw[this.i])) this.i++ }

  private atEnd(): boolean { return this.i >= this.raw.length }

  private bad(what?: string): never {
    throw new JsonSyntax(this.i, what ?? (this.atEnd() ? 'the file ends too early (cut off?)' : `unexpected ${JSON.stringify(this.raw[this.i])}`))
  }
}
