// npm run lint: ESLint over the extension (src/), the tests (test/), the CLI sources (cli/) and the build scripts
// (scripts/). The webview pages (media/) are not linted yet. The layer and cycle rule is scripts/check-layers.mjs.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/** Node's globals for the .mjs/.js scripts (written out: no extra dependency for them). */
const NODE = Object.fromEntries(['process', 'console', 'Buffer', 'URL', 'URLSearchParams', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'setImmediate', 'queueMicrotask', 'structuredClone', 'fetch', 'AbortController',
  'AbortSignal', 'TextEncoder', 'TextDecoder', 'require', 'module', 'exports', '__dirname', '__filename', 'performance',
].map((g) => [g, 'readonly']))

// From a remote extension host every vscode.workspace.fs call is a round trip through the window: the extension's own
// files go through platform/workspaceFs.ts (Node's fs for file: URIs) instead.
const WORKSPACE_FS = {
  selector: "MemberExpression[property.name='fs']:matches([object.name='workspace'], [object.property.name='workspace'])",
  message: 'Read and write files through platform/workspaceFs.ts, not vscode.workspace.fs.',
}
// The step paths (code links, value hints) read a file's lines through platform/documents.ts, not by opening it as a
// document.
const OPEN_DOCUMENT = {
  selector: "MemberExpression[property.name='openTextDocument']",
  message: 'Code links and value hints read lines without opening a document.',
}

export default tseslint.config(
  { ignores: ['out/**', 'node_modules/**', '.vscode-test/**', 'media/**', 'examples/**', 'skills/**', 'cli/understanding.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The code carries disable comments for rules that are off below; they come back into use as the rules go on.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      // Recommended rules the code does not pass yet, off until the slice owning the code fixes it:
      '@typescript-eslint/no-explicit-any': 'off', // ~56 `any` casts, mostly at the vscode API and in tests
      '@typescript-eslint/no-unused-vars': 'off', // ~15 unused names in the CLI and its tests
      '@typescript-eslint/no-require-imports': 'off', // the CommonJS fixtures (fake claude, fake grader) and a lazy require
      '@typescript-eslint/no-unused-expressions': 'off', // one `c ? f() : g()` statement in the notes filter
      'no-useless-assignment': 'off', // 6 initial values that later code overwrites before reading
      'no-control-regex': 'off', // the answer linkifier marks kept spans with NUL characters on purpose
      'no-irregular-whitespace': 'off', // text.ts's right-to-left character range holds U+FEFF literally
      'no-regex-spaces': 'off', // one regex in a CLI test matches aligned output
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      // Off until the ~186 un-awaited promises are handled (each awaited, or marked `void` with a reason): the
      // platform slice turns it on.
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/platform/workspaceFs.ts'],
    rules: { 'no-restricted-syntax': ['error', WORKSPACE_FS] },
  },
  {
    files: ['src/codeLinks/codeLinks.ts', 'src/codeLinks/valueHints.ts'],
    rules: { 'no-restricted-syntax': ['error', WORKSPACE_FS, OPEN_DOCUMENT] },
  },
  { files: ['**/*.mjs', '**/*.js'], languageOptions: { globals: NODE } },
  {
    // The screenshot drivers and harness pages run code in the browser (page.evaluate, <script>): TypeScript does not
    // check them and no single list of globals fits both sides.
    files: ['test/**/*.mjs', 'test/**/*.js'],
    rules: { 'no-undef': 'off' },
  },
)
