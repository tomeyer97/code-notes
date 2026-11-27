# Requests from scripts and agents

A script, an agent or another tool can ask the VS Code window that has a repository open to show its journeys or to
answer a question. All requests use one envelope (the code: `src/platform/agent/protocol.ts`); three things deliver
it:

- the **request file** `.code-notes/.request.json` in the repository (the way scripts should use);
- the **link** `vscode://<publisher>.code-notes/explain?action=…&q=…[&repo=<path>]` (older scripts);
- the palette command **Ask a Question About the Code…**.

## Request

```json
{"action": "ask", "question": "How is a note saved?", "model": "opus", "at": "2026-11-24T12:00:00Z", "id": "r-1", "needs": "0.24.0"}
```

| field | |
|---|---|
| `action` | `overview` (the Journeys list) or `ask` (a journey that answers `question`) |
| `question` | the question (`q` in a link) |
| `model` | the model a journey written for it uses (request file only; a link's is ignored) |
| `at` | when it was written (ISO time); required in the request file |
| `id` | the caller's id, echoed in the result; without it no result is written |
| `needs` | the oldest Code Notes version that can handle it (semver; a pre-release is older than its release) |

The window that has the repository open handles a request file as soon as it appears, also one that was there before
the window started. Rules, the same for every request file:

- `needs` newer than this extension: the file is left alone for a window with the newer version (no result).
- Otherwise the file is deleted once read. One that is not a JSON object, has no `at`, is older than 2 minutes or
  names an unknown `action` is refused: its result is `error` with the reason as `message`.
- The same action and question within 30 seconds (a link and a file for the same ask) is handled once; the second
  gets the first one's result.
- A link never starts Claude: with no journey that answers it, the Journeys list opens instead.

## Result

`.code-notes/.result.json`, written atomically (a temporary file renamed over it): a flat object of strings.

```json
{"id": "r-1", "outcome": "opened", "title": "Saving a note"}
```

| outcome | with | |
|---|---|---|
| `overview` | | the Journeys list opened |
| `opened` | `title` | the journey that answers it opened |
| `choose` | `text` | several answer it about equally; a pick shows their titles (`text`, ` / ` between them) |
| `confirm` | `model` | none answers it; "Write one with Claude?" is showing |
| `writing` | `model` | Claude is writing one (may come after the caller stopped waiting) |
| `untrusted` | `message` | the folder is in Restricted Mode: Claude never runs there |
| `error` | `message` | the request was refused, or the model is unknown |

A caller can wait a few seconds for the result and print one line. How a question is matched and a journey written:
[journey-format.md](journey-format.md), "The explain request".
