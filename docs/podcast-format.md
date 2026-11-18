# Journey podcasts

A journey can have a podcast: one audio file that talks through the journey, whose parts are linked to the journey's
steps and animation beats. Code Notes plays it in the journey panel and moves the walk with the voice: each step's code
opens as the voice reaches it, and its animation goes to the beat being talked about. The extension only plays
podcasts; how you make one (a text-to-speech service, a recording) is up to you.

## Where it goes

Next to its journey, with the same name:

```
journeys/
  place-order.json            the journey
  place-order.podcast.json    its podcast (this format)
  place-order.mp3             the audio (any name: `audio` says which)
```

`audio` is a path relative to the podcast file. It must be inside the journeys folder (or a folder under it): the
panel can only load files from there, so a path that leaves it (`../x.mp3`), an absolute path or a URL is refused
("audio must be in the journeys folder (got ../x.mp3)"). mp3 plays in VS Code (tested); so do ogg/opus and wav. The
panel loads the file whole before it plays (it is held in memory while the panel is open), so seeking works wherever
VS Code runs: in the browser and in remote windows the panel's files are served without HTTP Range requests, and a
streamed file can't be sought in.

A journey with a podcast has a ▶ on its row in the Journeys view, and its panel has the player at the bottom.

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
| `speaker`, `text` | Who says what (the panel shows the text as a one-line caption) |
| `say` | Optional: the spoken form a generator sent to text-to-speech (numbers, names spelled out). The player ignores it |
| `start`, `end` | Seconds in the audio. Gaps between segments belong to the segment before them |

Other fields, in the file or in a segment, are ignored: generators can keep their own data there.

Steps are named by id, so reordering a journey's steps keeps the podcast right. Beats have no ids: they are linked by
position.

## What the player does

- **At any time the walk is where the podcast is at that time**: the segment playing then (the last one started)
  says the step and beat. Seeking anywhere, backwards too, applies that directly, never the parts in between; of quick
  seeks (a drag, a key held down), only the last one moves the walk.
- **Moving the walk yourself moves the audio**: Next, Previous, a step in the storyline or a beat of the animation
  (‹ ›) jump the audio to the first segment about it. Ending the walk or opening another journey pauses it. Pausing
  never ends the walk.
- **A step the podcast never talks about**: the walk stays on it, the audio pauses, and the player says the step isn't
  in the podcast. ▶ then goes on with the first segment after that step (the next step it talks about), not back to
  where the audio was.
- **On a beat whose code is in another file**, that file opens directly (never the step's own file first). A segment
  on the map (`at: null`) ends the walk and closes the code tab the walk opened.
- **Where it was is kept, per journey**: opening another journey, ending the walk, closing the panel or reloading the
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

## Playing

- **▶** on the journey's row, the command **Play Journey Podcast**, or the player's ▶ in the panel.
- In the panel: Space or K play and pause (anywhere in the panel but a text field, also after clicking a button
  such as the animation's ‹ ›; a button you reached with Tab still presses with Space), ← → go back and forward 15 s,
  Shift+← → the previous and next step; on the timeline, Home and End, Page Up and Page Down. Hovering over the timeline names the step at that point; click or
  drag to go there.
- From anywhere: **Ctrl+' Space** plays and pauses, **Ctrl+' ←** / **→** go back and forward 15 s. The status bar
  shows where it is; click it to pause or play.
- The audio plays in the journey panel and goes on while the panel is behind another tab or VS Code isn't focused.
  Closing the panel stops it; where it was is kept for next time, per journey.
- If the audio can't play (a broken or cut file), ▶ stays paused and the player says why; it never shows "playing"
  with the clock standing still.
- VS Code lets a panel play sound only after a click or a key in it: the first time a panel plays, its ▶ takes the
  keyboard and says "Press Space to play". After that, the keys and commands play it directly.

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
| Links | `at` missing or not `null` / `{ step, beat }`; a step id the journey doesn't have; a beat the step doesn't have |
| Times | `start` missing or not a number (the segment is skipped); `end` not a number; `end` before `start`; a segment that starts before the one above it in the file (out of order), or before the one before it in time ends (overlap); an end past `duration` |
| The audio's length | `duration` differs from it; a segment ends after it; the audio is much shorter than the episode, with parts after its end: one warning, "The audio is 0:13 long but the episode is 12:47: the file looks cut off" |
| Others | `journey.id` is another journey's; a segment that isn't an object; a duplicate `id`; a `cue` other than `map`, `open`, `beat`; a `duration` that isn't a length |

The audio's length is known once the panel has loaded the audio (for `journey.py podcast`: the argument, a WAV's
header, or `ffprobe` when it is installed).

## What you see when something is wrong

- **A podcast that can't be played** keeps a trace: its row in the Journeys view has a greyed ▶ and the row's tooltip
  says why ("Podcast unavailable: version 2: this player reads version 1"); the panel shows one line, "Podcast
  unavailable", with **Show why**; Play Journey Podcast says why too.
- **One that plays with warnings**: the panel shows one short line above the timeline ("2 parts can't be shown",
  "Written for “Test run”", the cut-off audio), with **Show why**; the row's tooltip says the same.
- **Every problem** is in the Problems view, on the `.podcast.json` at the field or segment it is about, and in the
  "Code Notes" output (at warning level, once per change).
- **A file that breaks while it plays** (half-written by an agent or an editor) doesn't stop the audio: the last good
  version plays on, the panel says "The podcast file has errors: playing the last good version", and the file is
  read again as soon as it is valid. Paused or not playing, the file is shown as it is.
- **The audio file** is watched like the podcast file: deleting it makes the podcast unavailable, putting it back
  brings it back. An audio the panel can't decode says which file and that it looks cut off or damaged.
