# Changelog

## 0.27.1

### Changed

- **A program's explanation is a hint, not a comment.** When a program on your computer shows you lines with an
  explanation (the bridge), the explanation appears after the first line, in the inlay hints' colours, with the whole
  text in a hover on the lines. It goes away when you edit the file, move the caret out of the lines, press Esc, or
  when the program shows something else. Nothing is saved.
- **The bridge tries every address it is given.** `bridge.json` may list several addresses in `urls`; Code Notes tries
  each in turn and keeps the one that answers. Inside WSL, a program on Windows can list the Windows host's address
  (WSL's default gateway), so it is found without mirrored networking.

## 0.27.0

### Added

- **A bridge for local programs.** A program on your computer (a desktop assistant, a script) can drive Code Notes
  over a WebSocket: light lines with its explanation beside them, play a journey from a step, add a note, and read
  which file, lines and selection you have in front of you. It writes `~/.code-notes/bridge.json` while it runs (in
  WSL, the Windows user's file is found too); Code Notes connects, and reconnects when the program restarts. Settings:
  `codeNotes.bridge.enabled`, `codeNotes.bridge.discovery`. The protocol: [docs/bridge.md](docs/bridge.md).

### Fixed

- **Docs match the extension.** The GitLab recipe for the understanding check uses the `test` stage, so it also runs
  as a project's only job (GitLab creates no pipeline with only `.post` jobs). Skipping the check is described as it
  works: the label plus an approval by someone else. The README lists the two VS Code defaults the extension changes
  and how to undo them, no longer mentions a gutter `+` or a status bar bell, and ships the docs it links;
  development moved to CONTRIBUTING.md.

## 0.26.0

### Added

- **Listen to a journey.** A journey with an audio episode next to it (`<journey>.podcast.json`) gets ▶ Listen on its
  row: the walk follows the voice step by step and beat by beat, with captions, a chapter list and a timeline marked
  by step. Code highlights as the words are said (`marks`), and the editor gives you time to read before it moves
  (`codeNotes.listen.readBeforeMove`, `codeNotes.listen.settleAfterMove`). The audio plays in the new **Listen** view,
  so closing the journey panel doesn't stop it. Keys: Ctrl+' Space, Ctrl+' ← →, Ctrl+' Shift+← →. How it works and
  the file format: [docs/podcast-format.md](docs/podcast-format.md).
- **Podcast checks.** A podcast file that can't be played, or doesn't match its journey, says why in the Problems view
  and on its row; `journey.py podcast` and `journey.py check` run the same checks.
- **Understanding check: a tour of the change.** After the questions, Claude writes a short journey through the
  change, each question placed after the step that shows its answer. **Walk the tour** in the Check view walks it.

### Changed

- **Faster over Remote-SSH and on big repositories.** Notes, journeys and step files are read with Node's fs instead
  of through the window, and the understanding check reads git on a worker thread and only when something it shows
  can have changed.

### Fixed

- The sidebar no longer logs "Failed to resolve tree node"; notes queued for Claude no longer stay "Queued…" when the
  Claude Code CLI isn't found; a note on a file that shrank is placed again.
- Step text: a bare `file#L9` ref links to its line, line labels move with the code, and a step link opens the journey
  of its own folder.
- A reply or an answer sent twice with a quick double Ctrl+Enter is saved once; a quick Next, Next, Next ends on the
  last step asked for.
- With reduced motion, journey scenes don't animate; a question id with a quote no longer stops the Check view
  drawing.

## 0.24.0

- **Understanding check:** **Check my understanding** has Claude Code ask a few questions about your branch's change,
  each a thread on its lines. Answer in the thread; Claude grades it and replies with a short confirmation, a hint, or
  (after a second miss) the explanation, naming the code as clickable links. The **Check** view in the sidebar lists
  the questions; the status bar says where the check stands; **Commit & push** finishes it. Answers are saved in
  `understanding/<branch>.json` for a merge request check that needs no model (`cli/understanding.mjs ci`, GitLab and
  GitHub recipes in [docs/understanding-check.md](docs/understanding-check.md)). The bundled `understanding-check` skill writes the questions.
- **Finding journeys:** journeys have their own **Journeys** view: In this file, Continue, Checks, then All by area,
  with search and sort. The panel's Journeys list gets a search field, chips, the same sections and a preview of the
  selected journey (its map, small, and its steps); a click selects, Enter or **Walk** starts it.

## 0.23.0

First release on the Visual Studio Marketplace.

- **Notes:** comment threads on code that a coding agent answers; unread replies, bulk resolve, suggestions you can
  apply, notes that follow the code when it moves and go stale when it changes.
- **Code Journeys:** an answer to "how does X work?" as a map of the parts involved and a storyline of steps through
  the real code, walked step by step with a card above each step's lines.
- **Step animations:** a step can play as a short animation, beat by beat, each beat lighting the line of code that
  does it; a small view of that code sits under the caption.
- **Code links and value hints:** phrases of a step's text link to the exact lines they describe; faint hints above
  the code show what a variable holds in an example run.
- **Writing journeys:** "Ask a Question About the Code…" has Claude Code write a journey with the bundled
  `code-journey` skill; nothing else needs installing.
