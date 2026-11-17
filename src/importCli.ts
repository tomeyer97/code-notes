// Loads cli/understanding.mjs (an ES module) from the CommonJS build. `new Function` keeps the real `import()`: the
// TypeScript compiler (module commonjs) would turn an `import()` written here into `require()`, which can't load .mjs.
// No vscode here: the worker thread (cliWorker.ts) uses it too.
import { pathToFileURL } from 'url'

const dynamicImport = new Function('u', 'return import(u)') as (u: string) => Promise<unknown>

/** The module at `file` (an absolute path). */
export function importCli<T>(file: string): Promise<T> {
  return dynamicImport(pathToFileURL(file).href) as Promise<T>
}
