# Journey podcasts

A journey can have a podcast: one audio file that talks through the journey, whose parts are linked to the journey's
steps and animation beats. Code Notes plays it in the journey panel and moves the walk with the voice: each step's code
opens as the voice reaches it, and its animation goes to the beat being talked about. The extension only plays
podcasts; how you make one (a text-to-speech service, a recording) is up to you.

## Where it goes

Next to its journey, with the same name (a podcast file named otherwise is not played; the "Code Notes" output says
why, and which journey its `journey.id` names):

```
journeys/
  place-order.json            the journey
  place-order.podcast.json    its podcast (this format)
  place-order.mp3             the audio (any name: `audio` says which)
```

`audio` is a path relative to the podcast file. It must be inside the journeys folder (or a folder under it): the
panel can only load files from there, so a path that leaves it (`../x.mp3`), an absolute path or a URL is refused
("audio must be in the journeys folder (got ../x.mp3)"). mp3 plays in VS Code (tested); so do ogg/opus and wav. The
Listen view loads the file whole before it plays (it is held in memory while it is loaded), so seeking works wherever
VS Code runs: in the browser and in remote windows a webview's files are served without HTTP Range requests, and a
streamed file can't be sought in.

A journey with a podcast has ▶ Listen on its row in the Journeys view (and its length, "♪ 12:47"), and its panel has
the player at the bottom.

## The file

```jsonc
{
  "version": 1,
  "title": "Placing an order, end to end",
  "journey": { "id": "place-order", "file": "journeys/place-order.json", "commit": "a1b2c3d" },
  "audio": "place-order.mp3",
  "duration": 767.88,
  "segments": [
    { "id": "s01", "at": null, "cue": "map", "speaker": "host", "text": "Welcome…", "start": 0, "end": 29.2 },
    { "id": "s04", "at": { "step": "checks-first", "beat": 1 }, "cue": "open", "speaker": "host", "text": "First, the page…", "start": 57.22, "end": 71.14 },
    { "id": "s05", "at": { "step": "checks-first", "beat": 3 }, "cue": "beat", "speaker": "host", "text": "Then it sends…", "start": 71.44, "end": 79.28 }
  ]
}
```

| Field | |
|---|---|
| `version` | `1` |
| `title` | The episode's title |
| `journey` | The journey it was written for: `id`, and optionally `file` and `commit`. The player uses the journey next to the file; a different `id` is a warning, and the player says "Written for “…”" |
| `audio` | The audio file, relative to this file |
| `duration` | Seconds (optional; the audio's own length wins, and a difference of more than 1 s, or 1 %, is a warning) |
| `segments` | The parts, each with the fields below |

A segment:

| Field | |
|---|---|
| `id` | Stable when segments are edited or removed |
| `at` | Where it belongs: `null` (the whole journey: the map, no step open), `{ "step": "<step id>" }` (the step, without its animation), or `{ "step": "<step id>", "beat": n }` (the step's animation at beat `n`, 1-based, counted in the step's `scene.beats`) |
| `cue` | How the change of place is shown: `map`, `open` or `beat`. The player shows what `at` says; `cue: "map"` on a step shows the step without its animation |
| `speaker`, `text` | Who says what. The caption shows the sentence being said, two lines at most (a long sentence in parts), and the speaker's name when the voice changes (in an episode with more than one) |
| `say` | Optional: the spoken form a generator sent to text-to-speech (numbers, names spelled out). The player ignores it |
| `start`, `end` | Seconds in the audio. Gaps between segments belong to the segment before them |
| `sentences` | Optional: when each sentence of `text` starts, `[{ "start": <seconds in the audio>, "text": "<the sentence>" }]` (e.g. a text-to-speech service's alignment); the caption shows the current one. Used only when every item has a number `start` and a `text`, the starts go up, and each is within the segment (its `start` to its `end`, or the next segment's start); otherwise it is a warning, and, as without it, the player estimates each sentence's time by its share of the text |
| `marks` | Optional: parts of the code that light up while the voice says a phrase ([Marks](#marks-highlights-as-words-are-said)) |

Other fields, in the file or in a segment, are ignored: generators can keep their own data there.

Steps are named by id, so reordering a journey's steps keeps the podcast right. Beats have no ids: they are linked by
position.

## What the player does

- **At any time the walk is where the podcast is at that time**: the segment playing then (the last one started)
  says the step and beat. Seeking anywhere, backwards too, applies that directly, never the parts in between; of quick
  seeks (a drag, a key held down), only the last one moves the walk.
- **Moving the walk yourself moves the audio**: a step in the storyline or a beat of the animation (‹ ›), and, while
  paused, Next and Previous, jump the audio to the first segment about it. Ending the walk or opening another journey
  pauses it and ends the listening (the status item goes; ▶ goes on where it was, and says from where). Pausing never
  ends the walk.
- **One transport while it plays**: the step card's ⏮ ⏭, Ctrl+' A / D and the player's ⏮ ⏭ do the same thing: the
  part before or after, in the order of the audio. ⏮ always goes to the part before (it never restarts the one
  playing). In the Intro and the Recap, Ctrl+' A / D move the episode too.
- **A step the podcast never talks about**: the walk stays on it, the audio pauses, and the player says the step isn't
  in the podcast. ▶ then goes on with the first segment after that step (the next step it talks about), not back to
  where the audio was. A beat of the animation it doesn't narrate, picked while it plays, is the same: shown, the
  audio paused ("Beat 4 isn't narrated"), ▶ goes on with the next part.
- **The journey edited under it** keeps the step (by id), not its number: the walk and the audio stay where they are.
  The step on screen removed: the walk shows what the podcast says at its time now (the view before a part about a
  step that is gone). Quick ⏭ ⏭ open only the last target.
- **On a beat whose code is in another file**, that file opens directly (never the step's own file first). A segment
  on the map (`at: null`) ends the walk and closes the code tab the walk opened.
- **Where it was is kept, per journey**: opening another journey, ending the walk, closing the Listen view or reloading the
  window keeps the time, and ▶ goes on from there. When the walk is on another step than that time is about, ▶ starts
  at that step's first segment.
- **The podcast file saved again** while it plays keeps its place: the same time, or, when the segment playing then has
  new times, the same moment of that segment (by `id`); it keeps playing if it was.
- **The time shown is the audio's own**: after a seek, the walk, the player and the status bar show where the audio
  actually is. If it could not get there, the player says so and the Code Notes output channel logs it, as it logs
  audio errors.
- **A link the journey can't show degrades**: a beat the step doesn't have (the journey was edited) shows the step
  without its animation; a step id that isn't in the journey keeps the view of the segment before it. Each is a
  warning (below), and the player counts them: "2 parts can't be shown".

## Listening

- **▶ Listen** on the journey's row (⏸ while it plays, ▶ Resume when it is paused there), the ▶ on its row in
  **Open Journey…**, the command **Code Notes: Listen to Journey**, or the player's ▶ in the panel.
- **Where the audio lives**: in the **Listen** view (in the Code Notes side bar, under Journeys; shown once there is a
  podcast). It goes on when the journey panel is closed, behind another tab, or VS Code isn't focused; the panel's
  player and the status bar are its remotes. Closing the Listen view itself stops it (where it was is kept).
- **The player** (in the panel and the Listen view): the caption, the timeline with a mark per step (click a mark: that
  step's start; hover: the time and the step; the part a cut-off audio can't reach is greyed), ⏮ ▶ ⏭, the time and
  the step, the speed (0.75× to 2×) and mute. In a narrow panel the step's name, then mute, the total time and the
  speed give way; ▶ ⏮ ⏭ stay. At the end: **Replay**, **Walk it yourself**, **Next journey** (the next one with a
  podcast). A seek after the end plays on.
- **The storyline is the chapter list**: each step's start time, ♪ on the one being said, "not narrated" on a step the
  podcast skips; ▶ on a row plays that step alone and stops at its end; ≡ opens its transcript (the sentence being
  said marked, a click goes there; Ctrl+F finds words in shut transcripts too). The intro and the recap have rows.
- **While it plays, one text channel**: the caption. The panel's header shrinks to one line ("Step 6 of 14 · …"), the
  animation's own sentence and the code snippet under it hide; they come back on pause. When the voice moves to
  another step, the panel scrolls to it (unless you just scrolled).
- **Keys in the panel**: Space or K play and pause (K by its place on the keyboard: Caps Lock and other layouts too;
  anywhere but a text field, also after clicking a button such as the animation's ‹ ›; a button you reached with Tab
  still presses with Space), M mutes, < > change the speed, ← → go back and forward 15 s, Shift+← → the previous and
  next step (⏮ is always the part before). On the timeline (a slider): ↑ → and ↓ ← 15 s, Home and End, Page Up
  and Page Down a step.
- **From anywhere** (the editor too): **Ctrl+' Space** plays and pauses, **Ctrl+' ←** / **→** go back and forward
  15 s, **Ctrl+' Shift+←** / **→** the previous and next step (commands **Listen: Play/Pause**, **Listen: Back 15 s**,
  **Listen: Forward 15 s**, **Listen: Previous Step**, **Listen: Next Step**). The status bar says **Listening ·
  6:58** or **Paused · 6:58**; its tooltip has these actions and keys; a click opens the journey's map. Headphone and
  media keys work too (the system's "now playing" names the journey and the step).
- The speed and muting are remembered (every journey).

## The editor while it plays

- **The walk follows the voice: code opens beside the map.** The first play says so once. Step code always opens in
  one group beside the panel: the group the walk used before (another journey, the map's moments and a reload keep
  it), never a group holding your own unsaved or untitled file, never in two groups.
- **A view is held at least 8 s** (`VIEW_HOLD_S`): a part shorter than that whose `at` would show another file stays in
  the view before it; beats in the same file move the highlight. A seek shows exactly its time. (Generators: merge
  brief beats by the same rule.)
- **Reading around**: scroll or click in the narrated code yourself and the editor stops following (the beat is still
  lit where it is); the step card says **Follow along** to snap back, and the next step follows again.
- **The step card** is one line while it plays: "3/14 · title", ⏸, "narrating · beat 2/6", ⏮ ⏭. Paused, the full
  card comes back, with ▶ Play.
- **The map's moments** (Intro, Recap, `at: null`): the walk's code tabs close, so the map has the editor; the code
  comes back beside it at the next step. The editor at a time depends only on that time.
- **A note or a question** (Ctrl+' C, Ask on the card) pauses it: the code stays under your draft; ▶ (the card,
  Ctrl+' Space) goes on.
- **The panel keeps its width**: focusing it, ‹ Journeys, its row in the Journeys view or Open Journey… on the journey
  you're in (which focus it, never close it) don't resize it, and a reload doesn't close it. Ctrl+' V in a panel too
  narrow for the map gives it the room.
- Reopened mid-episode, the panel shows the beat at the time it was left, and the status item shows the paused time.
  The output logs each play, pause and stop with why.
- If the audio can't play (a broken or cut file), ▶ stays paused and the player says why; it never shows "playing"
  with the clock standing still.
- VS Code lets a view play sound only after a click or a key in it: the first time the Listen view plays, it takes
  the keyboard and says "Press Space to play" (the panel says to click ▶ there). After that, the keys and commands
  play it directly.
- For screen readers: the timeline is a slider whose value says the time, the total and the step (once a second);
  a step change while playing is announced once, politely; every control has a name and its keys in its tooltip.

## Marks: highlights as words are said

A segment may carry `marks`: parts of the code that light up while the voice says a phrase. The segment's `at` (its
step and beat) decides the file and the view; marks light parts of it, down to a few characters. "If the test requires
a model and the run is strict, it is rejected right there": on "requires a model" the check lights, on "right there"
the line that rejects it.

```jsonc
"marks": [
  { "phrase": "requires a model", "at": 2.8, "lines": [338, 338], "match": "spec.NeedsModel(steps)" },
  { "phrase": "right there", "at": 11.36, "lines": [339, 340] },
  { "phrase": "the replay file", "at": 13.0, "file": "runner/src/replay.ts", "lines": [40, 52] }
]
```

| Field | |
|---|---|
| `phrase` | The words in `text` the mark goes with (the first occurrence after the mark before's phrase). Marks with the same phrase one after the other light together (two places at once) |
| `at` | Seconds from the segment's `start` when the phrase is said (its first character), within the segment |
| `file` | Optional: the file, relative to the repository. Default: the segment's beat's file, else its step's. Required in a segment whose `at` is `null` |
| `lines` | `[first, last]`, 1-based, inclusive, in the code at the journey's commit |
| `match` | Optional: only this text within `lines` lights (whitespace as written; it may span the lines) |
| `nth` | Optional, 1-based: which occurrence of `match` within `lines` (default 1) |

While it plays:

- A mark lights 0.12 s before `start + at` (the eye gets there as the word is said). The beat's own line box stays;
  marks have no borders: a mark within a line tints its characters, a mark of whole lines tints the full lines as one
  block (the newest with a thin bar on the left). The newest mark is the stronger tint, the segment's earlier marks
  stay, lighter. The next segment clears them.
- At any time T, exactly the marks lit by T in the segment playing at T show: a seek forward lights them, a seek back
  takes them away, also while paused.
- `match` not where `lines` say (the code moved): the nearest place with the same lines shifted up to 20 lines up or
  down (nearer first, up before down; `nth` counts within the shifted lines), said once in the output; not found
  there either: the whole `lines` light (each line from its text, never its indentation). Lines past the end of the file: nothing.
- A mark that lights while it plays and is off screen is scrolled to (centred); one on screen never moves the editor.
  A reader looking around on their own (the follow lock) is never scrolled: marks still light where they are.
- A mark in another file than the one on screen is a view change: it opens that file only once the view has been on
  screen at least `VIEW_HOLD_S` (8 s); sooner, it is skipped (the output says so at debug level).

## Validation

The extension checks the file every time it, the journey or the audio file changes. The code-journey skill's
`journey.py podcast <repo> <slug> [<audio seconds>]` runs the same checks for authors and agents (`journey.py check`
runs them too when the podcast file exists).

**Errors: the podcast can't be played.**

| | |
|---|---|
| The file | not valid JSON (the message gives the line and column), not an object |
| `version` | missing or not `1` |
| `audio` | missing; a URL, an absolute path or a path out of the journeys folder; the file isn't there, or is empty |
| `segments` | missing, not a list, empty, or no segment with a start time |

**Warnings: it plays, but a part is not what the file says.** Each names its segment.

| | |
|---|---|
| Links | `at` missing or not `null` / `{ step, beat }`; a step id the journey doesn't have (said once per step, with its segments and times: "step "x" isn't in the journey (segments s14–s21, 2:45–3:52)"); a beat the step doesn't have, or written as a string ("beat must be a number, got the string "2"") |
| Order | the steps narrated in another order than the journey's (its steps were reordered since): one warning, at the first step out of order |
| Times | `start` missing or not a number (the segment is skipped); `end` not a number; `end` before `start`; a segment that starts before the one above it in the file (out of order), or before the one before it in time ends (overlap); an end past `duration` |
| The audio's length | `duration` differs from it; a segment ends after it; the audio is much shorter than the episode, with parts after its end: one warning, "The audio is 0:13 long but the episode is 12:47: the file looks cut off" |
| Sentences | `sentences` not a non-empty list of `{ start, text }`; a start before the one above it; a start outside the segment. One warning per segment; the caption is estimated from the text instead |
| Marks | `marks` not a list; a mark that isn't `{ phrase, at, lines }`, with `at` outside the segment, `lines` not `[first, last]`, `nth` under 1, or without `file` in a segment on the map (ignored); marks out of time order, a `phrase` not in `text` (kept). Against the code, when the file can be read (the extension: the workspace; `journey.py`: the repository): the file not there, `lines` past its end, `match` (its `nth`) not within `lines`: "found 2 lines down, lit there", or "nor within 20 lines: the whole lines light" |
| Others | `journey.id` is another journey's; a segment that isn't an object; a duplicate `id` (with both times); a `cue` other than `map`, `open`, `beat`; a `duration` that isn't a length |

**Notes: nothing wrong with the file.** `journey.commit` set and steps' code changed since that commit (git): "recorded
for 609d0bb; 3 steps changed since (steps 2, 5, 9)", in the output at info level, the Problems view as information,
and, when nothing else is said, the player's line. `journey.py podcast` prints it on its summary line.

The audio's length is known once the panel has loaded the audio (for `journey.py podcast`: the argument, a WAV's
header, or `ffprobe` when it is installed).

## What you see when something is wrong

- **A podcast that can't be played** keeps a trace: its row in the Journeys view has a greyed ▶ and the row's tooltip
  says why ("Podcast unavailable: version 2: this player reads version 1"); the panel shows one line, "Podcast
  unavailable", with **Show why**; Listen to Journey says why too.
- **One that plays with warnings**: the panel shows one short line above the timeline ("2 parts can't be shown",
  "Written for “Test run”", the cut-off audio), with **Show why**; the row's tooltip says the same.
- **Every problem** is in the Problems view, on the `.podcast.json` at the field or segment it is about, and in the
  "Code Notes" output (at warning level, once per change).
- **A file that breaks while it plays** (half-written by an agent or an editor) doesn't stop the audio: the last good
  version plays on, the panel says "The podcast file has errors: playing the last good version", and the file is
  read again as soon as it is valid. Paused or not playing, the file is shown as it is.
- **The audio file** is watched like the podcast file: deleting it makes the podcast unavailable, putting it back
  brings it back. An audio the panel can't decode says which file and that it looks cut off or damaged.
