# Layer exceptions

`npm run lint` runs `scripts/check-layers.mjs`, which checks the imports between the layers of `src/`
(`scripts/layers.json`, lowest first):

| layer | folders |
|---|---|
| core | `core/` (pure: no `vscode`) |
| platform | `platform/` (the vscode and Node adapters), `webview/` (a webview page and its channel) |
| features | `notes/`, `threads/`, `journeys/`, `tour/`, `podcast/`, `marks/`, `ask/`, `write/`, `check/`, `codeLinks/` |
| ui | `sidebar/` |
| composition | the files at the root of `src/` (`extension.ts`, …) |

A file may import its own layer and the layers below it; `protocol/` is open to every layer and imports only
`core/` (its exceptions are `protocol.txt`).

Each `<folder>.txt` here lists the imports from that `src/` folder that break the rule today, one
`<from> -> <to>` per line. A new violation fails the lint; so does a listed one that is gone (remove the line when you
fix it). Each file belongs to the work that owns its folder.

The check also measures the largest import cycle (strongly connected component). It may not grow past `maxScc` in
`scripts/layers.json`; when your change shrinks it, write the new size as a `# max-scc: N` line at the top of your
folder's file (the smallest of all of them counts). `maxSccIn` caps the cycles inside one folder the same way.

`node scripts/check-layers.mjs --write` rewrites the lists from the code (review the diff: it lists new violations too).
