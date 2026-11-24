// The understanding CLI: cli/understanding.mjs, one file bundled from cli/understanding/ (committed; CI recipes
// download it by URL).
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const r = spawnSync(process.execPath, [path.join(root, 'cli/bundle.mjs')], { cwd: root, stdio: 'inherit' })
process.exit(r.status ?? 1)
