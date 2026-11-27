# File formats

Every file the extension, the understanding CLI and the skills read or write, one module per format: TypeScript
types, a reader that returns `Parsed<T>` (result.ts: the value, or why the file was refused), and a JSON Schema in
schema/ (published: agents and scripts validate against it). VERSIONS.md is the version policy.

| format | reader | schema |
|---|---|---|
| journey (with its scenes and marks) | journeyModel.ts `parseJourney`, `readJourney` | schema/journey.schema.json |
| marks (journeys and podcasts) | marks.ts `readMarks` | schema/marks.schema.json |
| podcast | podcast/model.ts `parsePodcast`, podcast/validate.ts `validatePodcast` | schema/podcast.schema.json |
| note | noteModel.ts `parseNote`, `serialize` | schema/note.schema.json |
| understanding check | cli/understanding/validate.ts `validateCheck` | schema/check.schema.json |

The schemas use a small set of keywords, checked by schemaCheck.ts (no dependency): `$ref` (in the file or
`<name>.schema.json#/…`), `type`, `enum`, `const`, `properties`, `required`, `additionalProperties` (true or false),
`items`, `prefixItems`, `minItems`, `maxItems`, `minLength`, `maxLength`, `minimum`, `maximum`, `pattern`, `oneOf`,
`anyOf`. Rules across fields (ids that exist, an end not before its start) are the readers'. test/formatSchemas.test.ts
checks every fixture and example against its schema, and that the readers refuse what the schema refuses.
