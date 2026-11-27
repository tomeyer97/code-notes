// The path of a folder note's page (pages.ts): written and read here only, so the two can't disagree. Pure.

/** Shown in the page's tab after the folder's path. */
const FOLDER_SUFFIX = ' (folder)'

/** The page path of folder `file` (relative to its workspace folder). */
export const folderPagePath = (file: string) => `/${file}${FOLDER_SUFFIX}`

/** The folder (relative to its workspace folder) a page path names; undefined when it is not a folder page's. */
export function folderOfPagePath(path: string): string | undefined {
  if (!path.startsWith('/') || !path.endsWith(FOLDER_SUFFIX)) return undefined
  return path.slice(1, -FOLDER_SUFFIX.length)
}
