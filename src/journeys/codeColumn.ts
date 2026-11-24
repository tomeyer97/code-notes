// The code group's rule for an editor already on screen (codeGroup.ts). No vscode here: unit-tested.

interface EditorLike { document: { uri: { toString(): string } }; viewColumn?: number }

/** The editor among `editors` showing `uri`, not in the map's group (`mapColumn`; none: any group). */
export function shownOutside<E extends EditorLike>(editors: readonly E[], uri: string, mapColumn: number | undefined): E | undefined {
  const outside = (e: E) => mapColumn === undefined || (e.viewColumn !== undefined && e.viewColumn !== mapColumn)
  return editors.find((e) => e.document.uri.toString() === uri && outside(e))
}
