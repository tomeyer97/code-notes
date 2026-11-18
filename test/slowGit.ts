// A `git` that takes its time: a shim on PATH that sleeps, then runs the real git. The unit tests use it to see that
// the CLI's worker never holds up the extension's thread (cliThread.test.ts); the check's integration run to see the
// same inside VS Code (integration/run.ts, check/refresh.ts).
import * as fs from 'fs'
import * as path from 'path'
import { execFileSync } from 'child_process'

/**
 * Writes `<bin>/git`: it sleeps `seconds` (only while the file `onlyWhenExists` exists, relative to where git runs,
 * when given), then runs the real git with the same arguments. Put `bin` first on PATH to use it.
 */
export function writeSlowGit(bin: string, seconds: number, onlyWhenExists?: string): void {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  const wait = onlyWhenExists ? `if [ -e ${onlyWhenExists} ]; then sleep ${seconds}; fi` : `sleep ${seconds}`
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\n${wait}\nexec ${real} "$@"\n`, { mode: 0o755 })
}
