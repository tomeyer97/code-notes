// Reading and writing a JSON file the extension does not own the shape of (a journey an agent wrote, a request a script
// left): read as `unknown` for the caller to narrow; written whole, never half (a watcher may read it any time).
import * as fs from 'fs'
import * as path from 'path'
import { report } from './run'

/** The file's JSON; undefined when it is missing (said nowhere) or not JSON (logged). */
export async function readJsonFile(file: string): Promise<unknown> {
  let text: string
  try { text = await fs.promises.readFile(file, 'utf8') } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') report(e, { what: `read ${file}` })
    return undefined
  }
  try { return JSON.parse(text) } catch (e) {
    report(e, { what: `read ${file}` })
    return undefined
  }
}

/** `v` as JSON with two spaces, through a temporary file renamed over `file`. */
export async function writeJsonFile(file: string, v: unknown): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`)
  await fs.promises.writeFile(tmp, JSON.stringify(v, null, 2) + '\n')
  await fs.promises.rename(tmp, file)
}
