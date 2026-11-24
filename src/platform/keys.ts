// Composite keys built in more than one place: one builder each, so a key made here and looked up there agree. No
// vscode here: unit-tested.

/** Anything that prints as a URI (a vscode.Uri, a folder's URI string). */
type UriLike = { toString(): string } | string

/** A file in a workspace folder: `<folder uri>|<path>` (a step's referenced files, a step file's rename). */
export const folderFileKey = (folder: UriLike, file: string) => `${folder}|${file}`

/** A note's file in its session (the Code Notes view's grouping): `<session>|<folder uri>|<path>`. */
export const sessionFileKey = (session: string | undefined, folder: UriLike, file: string | undefined) => `${session ?? ''}|${folder}|${file}`

/** A question typed on a step, not sent yet: `<journey id>|<step id>`. */
export const stepDraftKey = (journeyId: string | undefined, stepId: string | undefined) => `${journeyId}|${stepId}`

/** The code links of one message of a check thread: `check|<note id>|<message index>`. */
export const checkLinkKey = (noteId: string, index: number | undefined) => `check|${noteId}|${index}`

/** checkLinkKey's note id and message index; undefined: not such a key. */
export function parseCheckLinkKey(key: string): { noteId: string; index: number } | undefined {
  const m = /^check\|([^|]+)\|(\d+)$/.exec(key)
  return m ? { noteId: m[1], index: Number(m[2]) } : undefined
}
