# Contributing

```sh
npm ci
npm run build               # the extension, the CLI bundle and the pages (scripts/build.mjs)
npm run lint                # ESLint, and the layers of src/ and their import cycles (scripts/check-layers.mjs)
npm test                    # unit tests, golden tests included (test/README.md)
npm run test:goldens        # only the golden tests; UPDATE_GOLDENS=1 rewrites them
npm run test:integration    # the extension in a real VS Code (needs a display, or xvfb)
npm run package             # code-notes-<version>.vsix
```

Open the folder in VS Code and press F5 ("Code Notes (dev)") for a window that reloads itself when the code changes.

Releases: see [CHANGELOG.md](CHANGELOG.md). Pushing a tag `v<version>` publishes that version.
