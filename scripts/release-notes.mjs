// The release notes of one version: its section of CHANGELOG.md, from its `## <version>` heading to the next `## `.
// Run by the release workflow: node scripts/release-notes.mjs <version> [CHANGELOG.md] > notes.md
// Exits 1 when the changelog has no section for the version (a release needs one).
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** The lines under `## <version>` (e.g. "## 0.26.0" or "## 0.26.0 (2026-11-02)"), or undefined when there is none. */
export function releaseNotes(changelog, version) {
  const lines = changelog.split('\n')
  const start = lines.findIndex((l) => l.startsWith(`## ${version}`) && !/^[\w.-]/.test(l.slice(3 + version.length)))
  if (start < 0) return undefined
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').replace(/^\n+/, '').replace(/\n*$/, '\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [version, file = 'CHANGELOG.md'] = process.argv.slice(2)
  if (!version) { console.error('usage: node scripts/release-notes.mjs <version> [CHANGELOG.md]'); process.exit(2) }
  const notes = releaseNotes(fs.readFileSync(file, 'utf8'), version)
  if (notes === undefined) { console.error(`${file} has no section for ${version} (a "## ${version}" line)`); process.exit(1) }
  process.stdout.write(notes)
}
