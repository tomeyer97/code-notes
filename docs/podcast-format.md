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
panel can only load files from there. mp3 plays in VS Code (tested); so do ogg/opus and wav.

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
| `journey` | The journey it was written for: `id`, and optionally `file` and `commit`. The player uses the journey next to the file; a different `id` is only logged |
| `audio` | The audio file, relative to this file |
| `duration` | Seconds (optional; the audio's own length wins) |
| `segments` | The parts, each with the fields below |

A segment:

| Field | |
|---|---|
| `id` | Stable when segments are edited or removed |
| `at` | Where it belongs: `null` (the whole journey: the map, no step open), `{ "step": "<step id>" }` (the step, without its animation), or `{ "step": "<step id>", "beat": n }` (the step's animation at beat `n`, 1-based, counted in the step's `scene.beats`) |
| `cue` | How the change of place is shown: `map`, `open` or `beat`. The player shows what `at` says; `cue: "map"` on a step shows the step without its animation |
| `speaker`, `text` | Who says what (the panel shows the text as a one-line caption) |
| `start`, `end` | Seconds in the audio. Gaps between segments belong to the segment before them |

Steps are named by id, so reordering a journey's steps keeps the podcast right. Beats have no ids: they are linked by
position.

## What the player does

- **At any time the walk is where the podcast is at that time**: the segment playing then (the last one started)
  says the step and beat. Seeking anywhere, backwards too, applies that directly, never the parts in between; of quick
  seeks (a drag, a key held down), only the last one moves the walk.
- **Moving the walk yourself moves the audio**: Next, Previous, a step in the storyline or a beat of the animation
  (‹ ›) jump the audio to the first segment about it. A step the podcast never talks about pauses it, and so does
  ending the walk or opening another journey. Pausing never ends the walk.
- **A link the journey can't show degrades**: a beat the step doesn't have (the journey was edited) shows the step
  without its animation; a step id that isn't in the journey keeps the view of the segment before it. Each is logged
  in the Code Notes output channel.

## Playing

- **▶** on the journey's row, the command **Play Journey Podcast**, or the player's ▶ in the panel.
- In the panel: Space or K play and pause, ← → go back and forward 15 s, Shift+← → the previous and next step; on
  the timeline, Home and End, Page Up and Page Down. Hovering over the timeline names the step at that point; click or
  drag to go there.
- From anywhere: **Ctrl+' Space** plays and pauses, **Ctrl+' ←** / **→** go back and forward 15 s. The status bar
  shows where it is; click it to pause or play.
- The audio plays in the journey panel and goes on while the panel is behind another tab or VS Code isn't focused.
  Closing the panel stops it; where it was is kept for next time, per journey.
- VS Code lets a panel play sound only after a click or a key in it: the first time a panel plays, its ▶ takes the
  keyboard and says "Press Space to play". After that, the keys and commands play it directly.
