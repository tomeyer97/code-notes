# Changelog

## Unreleased

- **Journey podcasts (prototype).** A journey with an audio episode next to it (`<journey>.podcast.json` and its
  audio, [docs/podcast-format.md](docs/podcast-format.md)) gets a ▶ on its row and a player at the bottom of the
  journey panel: play and pause, back and forward 15 s, previous and next step, speed (1×, 1.25×, 1.5×), and a
  timeline marked by step (hover names the step; click or drag to go there). The walk follows the voice: steps open
  and animations move beat by beat, exactly as when you walk them; any seek puts the walk where it is at that time,
  backwards too. Next, Previous, a step or a beat you pick moves the audio to its part. The audio goes on while the
  panel is behind another tab or VS Code is in the background. Ctrl+' Space plays and pauses from anywhere, Ctrl+' ← →
  skip; the status bar shows where it is.
  - Seeking works in VS Code for the web and remote windows too: the panel loads the audio whole, and the walk, the
    player and the status bar always show where the audio actually is (a seek that can't get there is said and
    logged). One clock: the status bar shows the player's second.
  - Where you were is kept per journey: another journey, ending the walk, closing the panel, a reload, or saving the
    podcast file again (the same moment of the same segment) keep it, and ▶ goes on from there.
  - A step the podcast skips: the walk stays on it, the audio pauses and says so, and ▶ goes on after that step.
  - A beat whose code is in another file opens that file directly; a part on the map closes the walk's code tab.
  - Space and K play and pause anywhere in the panel, also after clicking the animation's ‹ ›. An audio that can't
    play stays paused and says why.
- **Listen: the podcast player, reworked.** Podcasts are called **Listen** now: ▶ Listen on the row, **Code Notes:
  Listen to Journey**, **Listen: Play/Pause**, **Back 15 s**, **Forward 15 s**, **Previous Step**, **Next Step**
  (new, Ctrl+' Shift+← →). The command ids and the `.podcast.json` format are unchanged.
  - The audio lives in a new **Listen** view (Code Notes side bar): closing the journey panel, or a layout that hides
    it, no longer stops the episode. The panel's player and the status bar are remotes; the status bar says
    **Listening · 6:58** / **Paused · 6:58** (the glyph shows the state), its tooltip lists the actions with their
    keys, and its click opens the journey's map, whose player shows where the audio is.
  - The caption is the sentence being said, two lines at most and never cut (a long sentence in parts), with the
    speaker's name when the voice changes. A segment may give its own sentence times (`sentences`, checked when
    present); else they are estimated from the text.
  - The timeline: the player's whole width, a mark per step with its number (at least 8 px to hit), the playhead
    always shown, hover says the time and the step in full and goes when the pointer leaves, the part a cut-off audio
    can't reach greyed. The ±15 s buttons are gone (the keys stay); a narrow panel keeps ▶ ⏮ ⏭ first. Speed is a menu
    from 0.75× to 2× (< > too); mute (M) is new; both are remembered. K works by its place on the keyboard. A seek
    after the end plays on; the end offers Replay, Walk it yourself and Next journey.
  - The storyline is the chapter list: start times, ♪ on the step being said, "not narrated" on a skipped step, ▶ per
    step (plays that step and stops), a transcript per step (current sentence marked, click to go there, found by
    Ctrl+F when shut). While it plays the panel's header is one line ("Step 6 of 14 · …"), and the animation's own
    sentence and the code snippet give way to the caption; the panel scrolls to a step the voice moves to.
  - Rows mark journeys with a podcast ("♪ 12:47"; "♪ Listening", "♪ Paused at 3:38"), with ⏸ / Resume on the row and a
    tooltip line; the journey being walked is listed once (not again under "In this file"); Open Journey… and the
    panel's journey list mark podcasts too. The scene's beat shows as dots.
  - Accessibility: the timeline is an ARIA slider (↑ ↓ Home End Page Up/Down) whose value text gives the time, the
    total and the step; step changes are announced once; controls have names and keys. Media keys and the system's
    "now playing" work (Media Session).
- **Listen: the editor while it plays.** The editor is calmer: a view is held at least 8 s (a shorter part in
  another file stays in the view before; beats in the same file just move the highlight). Scroll or click in the
  narrated code and it stops following until the next step; **Follow along** on the step card snaps back. While it
  plays the step card is one line ("narrating · beat 2/6", ⏸, ⏮ ⏭) and its ⏮ ⏭, Ctrl+' A / D and the player's are one
  transport (⏮ is always the part before; in the Intro and Recap the keys move the episode). The Intro and Recap close
  the walk's code so the map has the editor; the code comes back in one group beside the panel, never on your own
  unsaved or untitled file. The first play says "The walk follows the voice: code opens beside the map". A note or a
  question being written pauses it (closing the panel does not: the audio is in the Listen view). The panel no longer changes width on its own: focusing it, ‹ Journeys and the row
  of the journey you're in keep its width (VS Code widening a panel focused at its minimum is undone), a reload never
  closes it, and the journey you're in is focused, not reopened; Ctrl+' V gives a narrow panel room for the map. A
  journey edited under the podcast keeps the step (by id); a removed step shows what the podcast says at its time;
  quick ⏭ ⏭ open only the last target; a beat it doesn't narrate pauses it; End Journey ends the listening (▶ says
  where it goes on); Ctrl+' Space in a journey without a podcast says so instead of starting another one. Reopened,
  the panel shows the beat it was at; the output logs plays, pauses and stops with why.
- **Listen: marks, highlights as the words are said.** A segment may carry `marks`: while the voice says "requires a
  model", that check lights, down to the characters (`match`, its `nth`); on "right there", the line that rejects it.
  The newest mark is a strong tint (whole lines: one tinted block with a bar on the left, no lines between rows), the
  segment's earlier ones stay, lighter, over the beat's own line;
  the next segment clears them. A mark lights 0.12 s before its word; marks with the same phrase light together; at
  any time (a seek, paused too) exactly the marks said by then show. Code that moved is found within 20 lines (said
  once in the output), else the whole lines light. An off-screen mark is scrolled to, never under a reader who is
  looking around; a mark in another file opens it only after the view hold (8 s). The check (extension and
  `journey.py podcast`) says marks that can't be used, phrases not in the text, marks out of order, and, reading the
  code, a missing file, lines past its end, or a `match` not where it says (and whether it is found nearby).
- **Listen: camera moves give you time to read.** When the next mark, beat or step is out of view, a cue at the
  editor's edge says where the code goes ("↓ 340", "↑ 212", "→ main.ts") 0.8 s before; the code moves only once what
  was just lit has been on screen 2.5 s (`codeNotes.listen.readBeforeMove`), and the audio then waits 0.8 s with the
  new mark lit (`codeNotes.listen.settleAfterMove`). The player says it is waiting; ▶ or Space plays on at once. No
  waits when the code is on screen, under the follow lock, after your own seeks, or on the map.
- **Listen: more checks of the podcast file.** A step the journey doesn't have is said once with its segments and times; a beat written
  as a string, a reused segment id (with both times), and narration in another order than the journey's are warnings;
  a podcast recorded for an older commit whose steps' code changed since gets a quiet note; a podcast file not named
  after its journey says in the output why it's ignored. `journey.py podcast` stays in step.
- **Podcasts: broken files are explained.** One check of the podcast file, with errors (it can't be played) and
  warnings (a part is not what the file says: a step or beat the journey doesn't have, overlapping or out-of-order
  times, an end before its start or past the audio, a cut-off audio, written for another journey). Every problem is
  in the Problems view on the `.podcast.json` and in the output at warning level. A podcast that can't be played
  keeps a greyed ▶ on its row (the tooltip says why) and a "Podcast unavailable · Show why" line in the panel; one
  with warnings says them in one short line. A file that breaks while it plays keeps the last good version playing;
  the status item goes with its podcast; putting the audio file back brings the podcast back. `audio` outside the
  journeys folder is refused at load. `journey.py podcast` (the code-journey skill) runs the same checks, and
  `journey.py check` runs them too. Segments may carry other fields, e.g. `say`, the spoken form (ignored).
  [docs/podcast-format.md](docs/podcast-format.md) ships with the extension.
- **Understanding check: a tour of the change.** Right after the questions, Claude writes a short journey of the change
  (6-10 steps through the changed code and the code it depends on), each question placed after the step that shows
  its answer. Check my understanding (or **Walk the tour** in the Check view) walks it in the journey panel: the
  questions are rows of the storyline, Next stops at each open one and opens its thread, a pass walks on. Rows of the
  Check view say their step and go there. The tour is stored in the check file (`journey`); a top-up adds steps for
  the new part. The grader may point at a step; the merge request comment gets one line about the tour. A question,
  and the tour's last step, may say "See also" a journey of the repository that walks the same code.
- **Faster over Remote-SSH and on big repositories.** The understanding check reads git on a worker thread: the
  extension host (shared with every other extension, and over Remote-SSH with the editor) never waits for git. It
  reads again only when something it shows can have changed: another `git status` (the Git view, a terminal, an agent)
  no longer makes it refresh, and a burst of triggers is one refresh. A code link, Back, the next or previous step, a
  link from a chat and opening a question each wait for at most one call into the window (fixed waits and repeated
  context keys, decorations and lens refreshes are gone), so they slow down less with the network's latency.
- **Remote-SSH: files are read where they are.** Notes, journeys and step files are read and written with Node's fs
  instead of through the window (a round trip each): opening a folder with many notes and journeys no longer takes a
  round trip per file. A quick Next, Next, Next ends on the last step asked for, with its file and card. A reply, a
  note or an answer sent twice with a quick double Ctrl+Enter is saved once, and shows at once ("Checking…" for an
  answer). Links from a Claude Code chat are recognised on newer VS Code versions too. A code link's Back names its
  step and goes away once the walk moves on. Copied link text has no hidden zero-width spaces.
- **Fixes.** The sidebar no longer logs "Failed to resolve tree node" (a reveal waits until the view holds the row,
  and redraws are spaced so the window applies each). Undo of Mark All Read makes resolves and reopens unread again.
  Notes queued for Claude no longer stay "Queued…" when the Claude Code CLI isn't found. A note on a file that shrank
  no longer fails to place. A notes-folder setting like `notes\` or `./notes` works. Step text: a bare `file#L9` ref
  links to its line, `#L` and range labels move with the code, a sentence ref is hidden only when every place it names
  is on screen, a gone ref names where it was looked for, and a step link opens the journey of its own folder. The
  CLI places notes exactly as the extension does, and reads a removed `-- comment` line as code, not a file header.
  Commit & push sees an unsaved fix behind a `git:` diff view. The default branch is one rule everywhere: origin/HEAD
  when known, else main or master, plus the compared-with branch. With reduced motion, journey scenes don't animate
  at all. A question id with a quote no longer stops the Check view drawing; a status or screen named like
  `constructor` no longer breaks a scene.
- **Internals:** the extension's code is split into small modules by area (`src/ask`, `check`, `notes`, `tour`,
  `journeys`, `sidebar`, `write`, `webview`); the CLI's source is modules under `cli/understanding/`, bundled into
  `cli/understanding.mjs`; tests are one test per behaviour, in a file per module. Behaviour is unchanged apart from
  the fixes above.

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
