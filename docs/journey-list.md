# Finding journeys (next after the understanding check)

A workspace will have dozens to hundreds of journeys (plus understanding checks, reviews, later refreshers).
Today the sidebar and the panel's "‹ Journeys" home show one flat list. Goal: find the right journey in a few
seconds, browse without committing to a walk, and tell rows apart at a glance. Keep it quiet: short rows,
muted metadata, details on hover/preview.

## One model, two views

The extension computes the list once — groups, search matches, sort, per-row metadata — and sends it to both
the sidebar tree and the panel. They never disagree.

Per row (derived, nothing for authors to maintain):
- `kind`: journey / check / review (icon)
- `area`: the top folder most of its steps visit (e.g. `api`); ties → the first step's
- `age` from `createdAt`; `stale` when the code under its steps changed since its `commit`
- personal: `new` (never opened), `resume` (left at step n), last walked (workspace state, not in git)
- `here`: one of its steps is in the active editor's file

## Sidebar: own view "Journeys" (separate from Notes)

Groups: **In this file** (follows the active editor; hidden when empty) · **Continue** · **Checks** (open
ones; checks of merged branches hidden) · **All** (grouped by area, or flat when sorted by date/name).
Row: icon by kind, title, description `area · age` (or `step 4/9`, `2/4 ✓`), ⚠ when stale; tooltip =
question + summary + provenance. Title buttons: Search (QuickPick over title, question, summary, file paths,
step titles; matchOnDescription/Detail), Sort (area / newest / recently walked / A–Z). Click walks (as now).

## Panel home

- Search field focused on open; `/` refocuses; filters live over title, question, summary, files, step text;
  matched words highlighted; Enter walks the top hit; Esc clears, then returns to the journey.
- Chips: kind (All · Journeys · Checks · Reviews), areas, "In <file>"; Sort dropdown.
- Without a search: sections Continue · In <file> · New · then by area.
- Row: title; question (one line, ellipsis); muted `area · n steps · age`; marks new / step n/m / stale.
- Row click SELECTS and previews (changes the earlier "click walks" for the panel only); Walk/Resume buttons
  and Enter start it. Wide panel: preview pane on the right = the journey's question, mini map of its
  systems/modules (reuse the map renderer, read-only, no pan), step titles. Narrow: ▸ unfolds step titles
  inside the row.
- Keyboard: ↑↓ move, → preview, Enter walk, Esc back.

## Tests

A fixture workspace with ~40 journeys over several areas (generated JSON is fine) + a few checks. Screenshot
the panel home at 320/600/1000 px and the sidebar; measure overflow/clipping; capture console errors; search
"retry" finds a journey whose title doesn't contain it; "In this file" updates when switching editors.

## As built (0.24.0)

- Model: `src/journeyList.ts` (`buildList`): rows with `area`, `age`, `here`, `meta`, search hits; the panel's
  `sections` and the sidebar's `groups` come from the same call. Search: every word must match (title, question,
  summary, step titles, file paths; title hits weigh most; a light stem lets "retry" find "retries").
- On the panel each row is listed once: Continue, In <file>, Checks and New come first; the area sections hold the
  rest. The sidebar's All holds every journey. Checks are never under All or an area; a passed check shows only
  with the Checks chip.
- `review` is a kind the model knows; nothing produces it yet.
- Tests: `test/journeyList.test.ts`, `test/journey-list/shoot.mjs` (panel home, 320/600/1000 px, dark and light),
  the VS Code suite (`test/integration/check.ts`: In this file follows the editor, search over step titles).

## As built (list fixes after 0.24.0)

- Checks are not in the journey lists (no group, section or chip): a branch's check lives in the Check view. The
  panel's count and the sidebar's All are the same number.
- Search: every word, else any word with one line saying so ("Nothing mentions “payment”; showing “retry”"). The
  sidebar's picker shows the same line as a separator.
- Continue starts past step 1 (opening a journey is not reading it); the walk being walked is first and its row says
  its step. A sidebar click still walks; the panel list previews.
- In this file: ranked (a step in the function under the cursor, from the document symbols; then the most steps
  here; then the largest share), "3 of 7 steps here", 5 rows and "Show n more". The view reveals that group when
  the editor changes, and a walk's row only where it is near the top (In this file, Continue), never deep in All.
- Stale: a "Stale n" chip; the row's ⚠ says which steps; the preview marks them with the last commit to their file
  since the journey's commit ("⚠ changed · a1b2c3d · 3 d ago", or "uncommitted") and "The other n still match the
  code." **Refresh** (preview, the sidebar row's inline button, the command) asks the agent in one step note to update
  only those steps (the same request as Ask on a stale step); asked already, that note opens.
- Staleness is re-checked when a step's file changes on disk (checkout, pull, an agent) and on a branch switch.
  Before, steps were only located at load and while their file was open, so after a branch switch the list showed a
  mix of both branches' stale steps.
- Keyboard: ↓ from the search goes into the rows (roving focus, a focus ring, scrolled into view), ↑ from the first
  row back; Home/End; the chips are one Tab stop with ← →; Ctrl+' J opens Search Journeys.
- "‹ Journeys" from a walk lists over it: the walk keeps its place (card, status item), and its row is selected.
- The panel heading is the short title; the question is under it (at most three lines, whole on hover).
- The preview has no mini map: at that size it showed overlapping boxes and told less than the step list.
