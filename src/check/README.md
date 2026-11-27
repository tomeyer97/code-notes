# src/check: the understanding check in VS Code

Claude writes a few questions about the branch's change (skills/understanding-check). They show as note threads on
their lines and as rows in the Check view (in the Code Notes sidebar). An answer in a thread is graded by Claude
(read-only) and the reply lands in the same thread. The file `understanding/<branch>.json` is the source of truth;
the threads are a view of it, kept in sync both ways. Where the check stands comes from the CLI (`checkState`,
`stateWords`), so the status bar, the view, `status` and CI say the same thing. See docs/understanding-check.md.

## How it fits together

- `index.ts` activates the check; `wiring.ts` connects it to the rest of the extension (`host.ts` says what it needs).
- `controller.ts` builds the parts and runs the refresh, the command, the view's requests and opening questions.
- `state.ts` holds what the check knows now (`CheckState`) and what every part gets (`CheckCore`). Each part takes
  only the ports it uses (its `…Ports` interface, next to it), never the controller.
- `query.ts` is what the rest of the extension may ask (`CheckQuery`) and the thread commands' arguments.
- A part changes the check file only through `updateCheck` (state.ts): read, changed, written in one go.

## The parts

| file | job |
|---|---|
| writer.ts | Claude writes the questions and the tour |
| grading.ts | answers and grades |
| threads.ts | the questions as note threads (what changes is planned in threadSync.ts) |
| concern.ts | concerns about the code (fix, TODO, flag, dismiss; the TODO's text in todoComment.ts, its edit in editor.ts) |
| push.ts | Commit & push (its git calls in pushGit.ts) |
| park.ts | a check moved aside while another branch is checked out |
| background.ts | questions written after a push (pushSeen.ts says when one happened) |
| invalidFile.ts | a check file that can't be read |
| view.ts | the Check view's webview |
| statusItem.ts | the status bar item |

The vscode-free model they share is in `types.ts`, `viewModel.ts`, `viewRequests.ts`, `navigation.ts`,
`checkText.ts` and the other files that say so; the CLI (`cli/understanding/`) holds the rules. Each has its tests
in `test/check<Module>.test.ts` (the view model's: `test/checkModel.test.ts`).
