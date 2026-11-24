# Format versions

One rule for every file the extension reads (the numbers are `VERSIONS` in versions.ts; every reader imports it):

- A file's `version` is the version of its schema (schema/*.schema.json). It changes only when an existing reader
  could not read the new files: a new optional field does not change it (readers keep fields they don't know).
- A reader reads its current version. An older version it can no longer read is refused with a reason that says so
  (a v1 journey: "format v1 …: migrate it to v2"); a newer one is refused
  too, with its own reason ("format v3 is newer than this extension reads (v2)"), not listed as one to migrate.
- An anchor's kind is not a file version: it is told by the anchor's own `v` (`v: 3`: compact; none: full text), and
  a file of any version may hold either.

| format | file | version | without `version` |
|---|---|---|---|
| journey | `journeys/<slug>.json` | 2 | refused (v1: steps as notes); a newer version: refused as newer |
| podcast | `journeys/<slug>.podcast.json` | 1 | refused |
| note | `.code-notes/<id>.json` | 1 | read as 1; the extension writes `"version": 1` |
| check | `understanding/<branch>.json` | 1 | refused (the CLI's `validate`) |

A journey file was never written as version 3 (journey.py writes version 2 with compact anchors), so version 3 is not
read.
