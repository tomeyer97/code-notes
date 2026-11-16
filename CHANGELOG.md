# Changelog

## 0.24.0

- **Understanding check:** **Check my understanding** has Claude Code ask a few questions about your branch's change,
  each a thread on its lines. Answer in the thread; Claude grades it and replies with a short confirmation, a hint, or
  (after a second miss) the explanation, naming the code as clickable links. The **Check** view in the sidebar lists
  the questions; the status bar says where the check stands; **Commit & push** finishes it. Answers are saved in
  `understanding/<branch>.json` for a merge request check that needs no model (`cli/understanding.mjs ci`, GitLab and
  GitHub recipes in the README). The bundled `understanding-check` skill writes the questions.
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
