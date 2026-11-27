// The staging folders Claude writes a journey into (`<notes folder>/.writing/<id>`): the journey shows only once it
// is checked and moved. A folder left behind (a journey that failed its check is kept there to look at, a window
// closed mid-run) is swept a day later. No vscode API here (unit-tested in test/writeStaging.test.ts).
import * as fs from 'fs'
import * as path from 'path'
import { report } from '../platform/run'

/** The staging folders' folder, inside the notes folder. */
export const STAGING = '.writing'

/** A staging folder left this long is swept (ms). */
export const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** A staging folder: `stage`, relative to the repository (journey.py's `--dir`); `dir`, absolute. */
export interface Staging { id: string; stage: string; dir: string; cleanup: () => void }

const remove = (dir: string) => {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) { report(e, { what: `remove staging folder ${dir}` }) }
}

/** A new staging folder in `notesFolder` (relative to `repo`). */
export function stagingFolder(repo: string, notesFolder: string): Staging {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const stage = `${notesFolder}/${STAGING}/${id}`
  const dir = path.join(repo, stage)
  fs.mkdirSync(dir, { recursive: true })
  return { id, stage, dir, cleanup: () => remove(dir) }
}

/** The staging folders under `root` (`<repo>/<notes folder>/.writing`) older than STAGING_MAX_AGE_MS, removed. */
export async function sweepStaging(root: string, now = Date.now()): Promise<string[]> {
  let names: string[]
  try { names = await fs.promises.readdir(root) } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') report(e, { what: `sweep ${root}` })
    return []
  }
  const old: string[] = []
  for (const n of names) {
    const dir = path.join(root, n)
    const st = await fs.promises.stat(dir).catch(() => undefined)
    if (st && now - st.mtimeMs > STAGING_MAX_AGE_MS) old.push(dir)
  }
  old.forEach(remove)
  return old
}
