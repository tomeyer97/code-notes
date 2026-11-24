# Code notes

Notes **Ann Example** left on the code in this folder, one JSON file per note. The VS Code extension "Code Notes" shows
them as comment threads and lists them in its sidebar. Agents answer and resolve them by editing these files; the
extension picks changes up live and shows new messages to Ann Example as unread.

## Format

The JSON Schema of a note file: https://github.com/tomeyer97/code-notes/blob/main/src/core/format/schema/note.schema.json

```json
{
  "version": 1,
  "id": "20261111-153012-ab12",
  "file": "src/main.ts",
  "range": { "start": 33, "end": 40 },
  "anchor": { "text": "  const token = readToken()", "before": "export function main() {", "after": "  use(token)" },
  "status": "open",
  "stale": false,
  "createdAt": "2026-11-11T15:30:12.000Z",
  "messages": [
    { "author": "Ann Example", "role": "human", "body": "Why is the token never removed?", "at": "2026-11-11T15:30:12.000Z" }
  ]
}
```

| Field | Meaning |
|---|---|
| file name | The note's identity: `<id>.json`. Keep it when you edit a note. |
| `version` | The note format's version: `1`. A file without it is read as version 1. |
| `file` | The code file, relative to the folder that contains `.code-notes/` (e.g. `src/main.ts`). Files outside that folder are refused. |
| `range` | Lines in `file`, 1-based, inclusive. |
| `anchor` | The lines the note is about (`text`), the lines around them, and the git `branch`/`commit` it was written on. The extension uses them to follow the code. |
| `session` | Optional: a name that groups notes (e.g. `Review: render.go`). The sidebar groups by session; a session can be hidden, resolved or deleted as a whole. |
| `selection` | Optional, when the note is about part of a line: `{ "text": "readToken", "startCol": 8, "endCol": 17 }` (0-based columns on the first line of `range`). A plain string is accepted as the text. |
| `status` | `open` or `resolved`. |
| `stale` | `true`: the code at `range` changed since the note was written; `anchor.text` is what it was about. |
| `messages` | The conversation, oldest first. `role` is `human` (Ann Example) or `agent`. |
| `severity` | Optional, for review findings: `high`, `medium`, `low` or `nit`. The sidebar shows an icon and lists the most severe first. |
| `target` | Optional: `"file"` for a note on a whole file, `"folder"` for a folder (`file` is then the folder, e.g. `src/api`). No `range` or `anchor`. |
| `journey` | Set on a question asked from a journey step: `{ "id": "<journey id>", "step": "<step id>", "n": <its number then> }`. The step is `step` in `<notes folder>/journeys/<id>.json` (find it by id: numbers change). |
| `events` | Status changes, oldest first: `{ "type": "resolved" \| "reopened", "by": "<name>", "role": "agent", "at": "<ISO 8601>" }`. |

A note on a whole file or folder:

```json
{ "file": "src/api", "target": "folder", "status": "open", "messages": [{ "author": "claude", "role": "agent", "body": "This folder mixes HTTP and storage code." }] }
```

## For agents

- **Which notes need an answer:** `status` is `open` and the last message has `"role": "human"`.
- **Answer:** append `{ "author": "<your name>", "role": "agent", "body": "<markdown>", "at": "<ISO 8601 now>" }`
  to `messages`. Keep every other field as it is.
- **Read the code** at `file` / `range` first. If `stale` is true, the code changed: `anchor.text` is what the note was about.
- **Resolve** (only when asked): set `"status": "resolved"` and append `{ "type": "resolved", "by": "<your name>", "role": "agent", "at": "<now>" }`
  to `events`, in the same write as your last message if you add one. A reply on a resolved note reopens it.
- **Create a note** for Ann Example: write `<id>.json` (id `YYYYMMDD-HHMMSS-xxxx`: the current time and 4 random
  letters, so many notes written in one second don't collide) with `file`, `range`, `"status": "open"` and one message
  with `"role": "agent"`. Leave `anchor` out: the extension fills it from the code at `range`.
- **A question from a journey step** (`journey` is set): answer about that step (its code is at the step's
  `file`/`range` in the journey file). A note starting "This step is out of date" asks you to fix the step itself
  (the code-journey skill's `journey.py`), then reply saying what you changed and resolve the note.
- **A review** (several findings): one note per finding, all with the same `session` (e.g. `"Security review"`)
  and a `severity`. The first line of the message is the note's title in the list: make it a one-sentence summary.
- **Suggest a fix:** a fenced block with the language `suggestion` holds the replacement for the note's lines
  (all of `range`, whole lines). Ann Example gets an Apply button; nothing changes until they press it.
  ````
  ```suggestion
    const token = readToken()
    defer clear(token)
  ```
  ````
- **Link code** as `path:line` or `[text](path#L12)`: the thread turns them into links.
- **You changed the code a note points at** (moved or rewrote it): update `file` and `range` to where the code is now
  and set `anchor` to `{}`; the extension refills it from the new lines and clears `stale`. Leave other notes alone:
  the extension follows code that moved by itself.
- **Never delete note files**: resolve them. Ann Example deletes notes.
- Write complete, valid JSON (no comments): write `<id>.json.tmp`, then rename it to `<id>.json`.
