# The bridge: driving Code Notes from another program

A program on the same computer — a *controller*, such as a desktop assistant or a script — can drive the Code Notes
extension in every open VS Code window: show lines with an explanation beside them, play a journey from a step, add a
note, and read where the reader is. The extension dials the controller over a WebSocket; the controller only has to
listen. (The code: `src/bridge/`, `src/core/bridge/`, the messages in `src/protocol/bridge.ts`.)

## Being found

While it runs, the controller writes a discovery file and removes it when it exits:

```json
{"url": "ws://127.0.0.1:47321/v1/bridge", "token": "a long random string", "name": "Desk"}
```

| field | |
|---|---|
| `url` | where to dial: `ws://` on a loopback address (`127.x.x.x`, `localhost`, `[::1]`) or, inside WSL, on the Windows host's (below); any other is ignored |
| `urls` | optional: more addresses of the same kinds, dialled in order after `url` (either one alone is enough) |
| `token` | a secret the extension sends back in its hello, so the controller knows the caller read this file |
| `name` | shown as the author of the controller's explanations and notes (default `Controller`) |

The extension dials the addresses in turn until one answers, and keeps that one: after a drop it dials it first, then
the others. An address that hasn't answered within 3 seconds gives way to the next. List every address the
controller may be reached on when it can't know which one the extension sees, as with WSL below.

Where the extension looks, in order (the first usable file wins):

1. `~/.code-notes/bridge.json` in the home of the machine the extension runs on.
2. Inside WSL, also the Windows user's `%USERPROFILE%\.code-notes\bridge.json` (found once per window with
   `cmd.exe /c echo %USERPROFILE%` and `wslpath`), so a controller on Windows drives a WSL window.
3. The setting `codeNotes.bridge.discovery`, when set, replaces both: only that path is read.

Write the file with mode `0600`, and write it whole (a temporary file renamed over it): the extension reads it every
2 seconds and follows it. A new `url` or `token` makes it hang up and dial the new one; a file that is gone or can't
be used makes it hang up. With no file, the extension does nothing and says nothing. `codeNotes.bridge.enabled: false`
turns the bridge off.

From WSL, a controller on Windows is reached on `127.0.0.1` when WSL's **mirrored networking** is on
(`networkingMode=mirrored` in `%USERPROFILE%\.wslconfig`). With WSL's default networking, WSL sees Windows on its
default gateway instead (`ip route show default` inside WSL; on Windows, the address of the `vEthernet (WSL)`
adapter): list it too, `"urls": ["ws://172.20.48.1:47321/v1/bridge"]`, and listen on it. Inside WSL, that address is
the only one besides loopback the extension dials: the token never leaves the computer.

## The connection

Every message is one JSON text frame. When a connection opens, the extension's first message is its hello:

```json
{"type": "hello", "protocol": 1, "token": "a long random string", "client": "code-notes", "version": "0.27.1",
 "window": {"folders": [{"name": "shop", "path": "/home/sam/shop", "uri": "file:///home/sam/shop"}],
            "remoteName": "wsl", "wslDistro": "Ubuntu"}}
```

Close the connection when the token is wrong. Each VS Code window dials on its own: one connection per window, told
apart by its `window`. `path` is a path on the machine the extension runs on (inside WSL: a Linux path);
`remoteName` is VS Code's (`wsl`, `ssh-remote`, … or `null` locally); `wslDistro` is `null` outside WSL. When the
window's folders change, the extension sends `{"type": "window", "window": {…}}`.

When the connection drops or none of the addresses can be reached, the extension dials again after 1 s, then 2, 4, 8,
16 and at most every 30 s, until the file changes or goes; a connection that opens starts the waits over at 1 s.

## Requests

The controller sends requests; the extension answers each one once, with the same `id`:

```json
{"type": "request", "id": "7", "method": "reveal", "params": {"file": "src/cart.ts", "start": 12, "end": 20}}
{"type": "response", "id": "7", "ok": true, "result": {"start": 12, "end": 20}}
{"type": "response", "id": "8", "ok": false, "error": "file not found: src/cart.tsx"}
```

A frame that is not a request with an `id` is ignored. An unknown `method` is answered `ok: false`. Lines are 1-based
and inclusive; `end` defaults to `start`. A `file` is an absolute path, or a path relative to one of the window's
folders (the first that has it). The extension sends no file contents or note bodies unless a request asks for them.

### `reveal`

`{file, start, end, text?}`: opens the file and lights the lines (with **← Back** above them, as a code link from a
chat does). With `text`, the explanation shows beside them as a hint: its first line, cut short, after the first
line lit, and the whole text (Markdown; links and HTML are not run) in a hover on the lines, under the controller's
`name`. The hint is not a note: nothing is saved. It goes when the reader edits the file, moves the caret out of the
lines, presses Esc, or when the next `reveal` arrives (one without `text` only removes it). Result: `{start, end}`,
the lines lit (`end` stops at the file's last line).

### `journey.play`

`{id, step?, folder?}`: walks the journey `id` from `step` (its number, or its step id; default 1), with its map open
when there is room. `folder` (a path or URI) picks between journeys with the same id in two folders. Result:
`{id, title, step, steps}`.

### `note.add`

`{file, start, end, body, session}`: a note on the lines, `body` its first message, the controller's `name` its
author, grouped under `session` in the Notes view. It is anchored on the code at those lines as a note an agent writes
into `.code-notes/` is. Result: `{id, file}` (the note's id and its workspace-relative file). Files outside the open
folders, and Code Notes' own files, are refused.

### `context.get`

`{selectionText?}`: where the reader is. Result:

```json
{"file": {"relative": "src/cart.ts", "absolute": "/home/sam/shop/src/cart.ts", "folder": "/home/sam/shop"},
 "languageId": "typescript", "visible": {"start": 1, "end": 48},
 "selection": {"start": {"line": 12, "column": 1}, "end": {"line": 14, "column": 9}}}
```

`relative` and `folder` are `null` for a file outside the open folders; `file` is `null` (and nothing else is sent)
when no file editor is active. Columns are 1-based. The selected text is sent only with `"selectionText": true`, as
`selection.text`.
