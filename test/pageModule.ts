// A page's module (media/*.js) in Node, for unit tests of its pure parts: bundled by esbuild as the page's bundle is
// (scripts/build/pages.mjs), as CommonJS. Its DOM use stays inside functions the tests don't call.
import * as esbuild from 'esbuild'
import * as path from 'path'

const root = path.join(__dirname, '../..')

/** The exports of `file` (a path from the repository root, e.g. media/journey-layout.js). */
export function pageModule<T = Record<string, any>>(file: string): T {
  const r = esbuild.buildSync({
    entryPoints: [path.join(root, file)], bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
    // Libraries come from node_modules as they are.
    packages: 'external',
  })
  const m = { exports: {} as T }
  new Function('module', 'exports', 'require', r.outputFiles[0].text)(m, m.exports, require)
  return m.exports
}
