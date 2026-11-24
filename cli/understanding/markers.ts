// The hidden markers that make a comment or thread the bot's own, and how they are recognised. They are a contract
// with every merge request this tool has commented on: changing a marker's text or a parser orphans the old comments
// and threads (they would be posted again, and never updated or closed). Keep them stable.

/** In the merge request comment: the one comment the job writes and then updates. */
export const MARKER = '<!-- understanding-check -->'

/** In a review thread: the question it is about (an earlier version used `discuss-<id>` for "Worth discussing"). */
export const concernMarker = (id: string): string => `<!-- understanding-concern:${id} -->`
/** In GitHub's "No longer flagged." reply (or appended to a comment): the question whose concern was closed. */
export const closedMarker = (id: string): string => `<!-- understanding-concern-closed:${id} -->`

const CONCERN_ID = /<!-- understanding-concern:([\w-]+) -->/
const CLOSED_ID = /<!-- understanding-concern-closed:([\w-]+) -->/

/** The id in a thread's concern marker, or undefined. */
export const concernIdOf = (body: unknown): string | undefined => CONCERN_ID.exec(String(body ?? ''))?.[1]
/** The id in a "No longer flagged." marker, or undefined. */
export const closedIdOf = (body: unknown): string | undefined => CLOSED_ID.exec(String(body ?? ''))?.[1]
/** The merge request comment this tool wrote. */
export const isOwnComment = (body: unknown): boolean => typeof body === 'string' && body.includes(MARKER)
/**
 * A thread the bot posted as a concern (threadBody puts "⚠" first on a line after the marker), not as "Worth
 * discussing": only those does the bot close when they are no longer flagged.
 */
export const isConcernThread = (body: unknown): boolean => /\n⚠/.test(String(body))
