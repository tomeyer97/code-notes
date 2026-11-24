# Tests

| Command | What runs |
| --- | --- |
| `npm test` | the TypeScript unit tests (`test/*.test.ts`, compiled to `out/test/`) and the CLI's (`test/cli/*.test.mjs`), golden tests included |
| `npm run test:goldens` | only the golden tests (a few seconds) |
| `npm run lint` | ESLint (`eslint.config.mjs`) and the layer and import-cycle check (`scripts/check-layers.mjs`, rules in `scripts/layers.json`) |
| `npm run test:integration` | the extension in a real VS Code |
| `npm run test:panel`, `test:scenes`, `test:checkpanel`, `test:journeylist` | the webviews in a headless browser, with checks (CI runs these) |
| `npm run test:checktour`, `test:podcast` | screenshot drivers to look at (not in CI) |
| `npm run test:grader` | the grader on real cases (needs a model; not in CI) |

CI (`.github/workflows/ci.yml`) is the one list of what gates a change; the release workflow runs it before it
publishes.

Every unit test runs with `test/hermetic.mjs` loaded first: the CI job's own variables never reach the code under test.

## Golden tests

A golden test pins what pure code returns today, byte for byte: its output is written to a file under
`test/goldens/<area>/` and every run compares against that file. They are a regression net for refactors: any byte
that changes in any output fails the test and shows a diff.

What is pinned:

| File | Area (`test/goldens/…`) | What |
| --- | --- | --- |
| `test/golden-journey.test.ts` | `journey/` | Every fixture journey as `parseJourney` reads it (and the old-format files it refuses), crafted journeys that break the rules (the refusal or the problems), anchors, code links, value hints and marks as read, marks found in code and their problems |
| `test/golden-codelinks.test.ts` | `journey/` | The code links in each step of the shop journey, and their markup |
| `test/golden-steps.test.ts` | `journey/` | Paths in step text (linked, shortened, asides dropped, tags escaped), the shop journey's steps placed in its code after edits |
| `test/golden-tour.test.ts` | `journey/` | Each step card's text (as written, moved, stale, renamed and gone files) |
| `test/golden-list.test.ts` | `journey/` | Search words and scores, the Journeys list model (sorts, searches, chips, the active file) |
| `test/golden-layout.test.ts` | `journey/` | The pure parts of the map's layout (`media/journey-layout.js`) |
| `test/golden-podcast.test.ts` | `podcast/` | The full check of every case in `test/fixtures/podcast/cases.json` (problems, messages, paths, places in the file, the episode), the sample podcast's episode (what the panel is sent), its timing (views, chapters, jumps, calm views, resume) and its marks |
| `test/golden-notes.test.ts` | `notes/` | Real and crafted note files read and written back (the JSON the extension writes), notes that are refused and why, the three-way merge, the agents' README, v2 anchors and v3 compact anchors found again after edits, the stale diff |
| `test/golden-check-agent.test.ts` | `check-model/` | The prompts that write a check and its tour, the phase shown while Claude works, failures in plain words |
| `test/golden-check.test.ts` | `check-model/` | TODO comments |
| `test/golden-check-view.test.ts` | `check-model/` | The Check view's names and the requests its page may send, text at code links, its thread texts |
| `test/cli/golden-understanding.test.mjs` | `check/` | The understanding check end to end on the refunds change of `test/fixtures/grader-cases`: the skill's script output and the check file it writes, every CLI command's output and `status --json`, the Check view (`checkView`, what the view is sent) at each stage, each question's thread, grading replies (and refused ones), the CI job and its merge request comment, broken check files and what `validate` says, drift / conflicts / the default branch, and the CLI's pure helpers |

Not pinned (not pure enough): the messages built inside vscode-dependent classes — the journey panel's `tour` /
`journey` message (`mapState`, `TourInfo`), the step card (`tour/card.ts`), the podcast player's messages
(`podcast/player.ts`, `listenView.ts`) and `media/journey-layout.js`'s `layout()` (it measures the DOM). Their
payloads that are pure are pinned: the parsed journey, the list model, the podcast episode, the Check view. The quiz
is not on `main` yet, so it has no goldens.

### How it works

`test/golden.ts` has one function, `expectGolden(area, name, value)`. A string is written as it is
(`<name>.txt`); anything else as `JSON.stringify(value, null, 2)` in its real key order (the order is part of what is
pinned), with what JSON can't say spelled out: `"[undefined]"`, `{ "[Map]": [...] }`, `{ "[Set]": [...] }`,
`"[NaN]"`. A missing golden fails the test. The CLI's goldens replace what changes from run to run before comparing:
temporary paths (`<refunds>`, `<root>`), ISO times (`<time>`) and commit ids (`<sha1>`, `<sha2>`, … in order of
appearance). The list's goldens run in UTC (its dates are local time). The journey goldens read their fixtures through
`test/goldenJourneys.ts`.

JSON.parse's error messages are V8's own words: the goldens are written with Node 22 (the version CI runs).
`.gitattributes` keeps `test/goldens/` out of line-ending conversion, so a Windows checkout compares the same bytes.

### Updating

When a change to the output is intended:

```sh
UPDATE_GOLDENS=1 npm run test:goldens
git diff test/goldens
```

Review the diff as part of the change: every changed line should be one the change means to make. A refactor should
leave `test/goldens/` untouched. To drop goldens no test writes any more: `rm -rf test/goldens && UPDATE_GOLDENS=1 npm
run test:goldens`, then check that `git status` shows only deletions you expect.

To add one: call `expectGolden('<area>', '<name>', value)` in a golden test (each name once per area), run with
`UPDATE_GOLDENS=1`, and read the new file before committing it.
