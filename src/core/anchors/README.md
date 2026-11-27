# Anchors: following code through change

Where a note's or a step's code is after the file changed. No vscode API; the understanding CLI bundles the same
files (cli/understanding/anchors.ts), so the extension and CI follow code alike.

| file | what it does |
|---|---|
| `kinds.ts` | The two kinds of anchor (full text; compact, `v: 3`), `readAnchor`, `Loc` |
| `lines.ts` | What "the same line" means: `norm` (no whitespace, one quote style, no trailing `;`/`,`), `blank`, `weak` |
| `anchor.ts` | Full-text anchors (notes): where the note is now, and whether it is stale |
| `compact.ts` | Compact anchors (journeys, check questions): fresh, changed or gone |
| `lineFollow.ts` | Live edits: a range or a line moved by an edit; a line found again by its text |
| `staleDiff.ts` | What a stale note's or step's code became: a diff, or removed |

Both engines run the same named scenarios (test/fixtures/anchor-scenarios.json); the compact engine also runs the
shared cases of test/fixtures/compact-cases.json, in the extension and against the CLI bundle.

## Tunables

| file | name | value | what it decides |
|---|---|---|---|
| lines.ts | `WEAK_LENGTH` | 3 | a shorter normalized line (`}`, `);`) says nothing about where code is |
| anchor.ts | `DISTINCT` | 25 | one line this long is recognisable alone (moves without context) |
| anchor.ts | `SEARCH_WINDOW` | 40 | lines around the old place searched for edited code |
| anchor.ts | `LINE_SLACK` | 3 | how far a block line may be from its place and still count |
| anchor.ts | `CONTEXT_WEIGHT` | 2 | a matching context line counts as this many block lines |
| anchor.ts | `END_SLACK` | 6 | how far the block's last line may have moved |
| compact.ts | `HEAD_LINES`, `TAIL_LINES` | 3, 2 | non-blank lines kept at the start and the end |
| compact.ts | `MIN_LEN_RATIO` | 0.5 | a candidate at least this share of the stored length… |
| compact.ts | `MAX_LEN_RATIO`, `MAX_LEN_SLACK` | 1.5, 5 | …and at most 1.5 × the stored length + 5 lines |
| compact.ts | `HASH_HEX` | 12 | hex digits of the sha1 kept |
| lineFollow.ts | `SAME_TEXT_RADIUS` | 400 | how far a remembered line is looked for by its text |
| staleDiff.ts | `TELLING_LENGTH` | 3 | shorter lines say nothing about which code it was |
| staleDiff.ts | `NEAR_LINES` | 3 | lines around the old place looked at |
| staleDiff.ts | `KEPT_SHARE` | 0.4 | edited, not removed: this share of its lines still near… |
| staleDiff.ts | `CONTEXT_KEPT_SHARE` | 0.75 | …or this share of its context, and one of its own lines |
| staleDiff.ts | `MAX_DIFF_CELLS` | 250 000 | blocks larger than this are not diffed line by line |

A note's anchor keeps 2 lines of context each side (`ANCHOR_CONTEXT_LINES`, core/format/noteModel.ts); a mark's
`match` is looked for 20 lines up and down (`MARK_REFIND_LINES`, core/format/marks.ts).
