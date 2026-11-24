// Two rules of the extension's file access, kept by ESLint (eslint.config.mjs, npm run lint): no vscode.workspace.fs
// outside platform/workspaceFs.ts (from a remote extension host every call is a round trip through the window), and no
// openTextDocument just to read lines in the step paths (code links, value hints). This checks the rules catch it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'path'
import { ESLint } from 'eslint'

const ROOT = path.join(__dirname, '../..')
// Type information is not needed for these rules (and the made-up files below are in no tsconfig); the rule that needs
// it is off here (npm run lint runs it).
const NO_TYPES = {
  languageOptions: { parserOptions: { projectService: false } },
  rules: { '@typescript-eslint/no-floating-promises': 'off' as const },
}
const eslint = new ESLint({ cwd: ROOT, overrideConfig: NO_TYPES })

/** The no-restricted-syntax messages ESLint reports for `code` as if it were the file `file` (relative to the root). */
async function restricted(code: string, file: string): Promise<string[]> {
  const [r] = await eslint.lintText(code, { filePath: path.join(ROOT, file) })
  return r.messages.filter((m) => m.ruleId === 'no-restricted-syntax').map((m) => `${m.line}: ${m.message}`)
}

const FS = "import * as vscode from 'vscode'\nexport const read = (u: vscode.Uri) => vscode.workspace.fs.readFile(u)\n"
const FS_NAMED = "import { workspace, Uri } from 'vscode'\nexport const read = (u: Uri) => workspace.fs.readFile(u)\n"
const OPEN = "import * as vscode from 'vscode'\nexport const open = (u: vscode.Uri) => vscode.workspace.openTextDocument(u)\n"
const FS_MESSAGE = '2: Read and write files through platform/workspaceFs.ts, not vscode.workspace.fs.'

test('no vscode.workspace.fs outside workspaceFs.ts (src/ and its folders)', async () => {
  assert.deepEqual(await restricted(FS, 'src/notes/anything.ts'), [FS_MESSAGE])
  assert.deepEqual(await restricted(FS_NAMED, 'src/tour/deep/anything.ts'), [FS_MESSAGE])
  assert.deepEqual(await restricted(FS, 'src/extension.ts'), [FS_MESSAGE])
  assert.deepEqual(await restricted(FS, 'src/platform/workspaceFs.ts'), [])
})

test('no vscode.workspace.openTextDocument just to read lines in the step paths (code links, value hints)', async () => {
  for (const f of ['src/codeLinks/codeLinks.ts', 'src/codeLinks/valueHints.ts']) {
    assert.deepEqual(await restricted(OPEN, f), ['2: Code links and value hints read lines without opening a document.'], f)
    assert.deepEqual(await restricted(FS, f), [FS_MESSAGE], f)
  }
})

test('the source as it is passes both rules', async () => {
  const results = await new ESLint({ cwd: ROOT, overrideConfig: NO_TYPES }).lintFiles(['src/**/*.ts'])
  const hits = results.flatMap((r) => r.messages.filter((m) => m.ruleId === 'no-restricted-syntax').map((m) => `${path.relative(ROOT, r.filePath)}:${m.line}`))
  assert.deepEqual(hits, [])
})
