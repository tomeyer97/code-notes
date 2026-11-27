// The version of every file format, in one table (the policy is VERSIONS.md). A file's `version` is its schema's
// version (schema/*.schema.json); an anchor's kind is told by the anchor's own `v`, not by the file's version.

export const VERSIONS = {
  /** A journey (`<slug>.json`): v1 (steps as notes) is refused with a reason; it needs migrating. */
  journey: 2,
  /** A podcast (`<slug>.podcast.json`). */
  podcast: 1,
  /** A note (`.code-notes/*.json`): a file without `version` is version 1; the extension writes it. */
  note: 1,
  /** An understanding check (`understanding/<branch>.json`). */
  check: 1,
} as const

export type Format = keyof typeof VERSIONS
