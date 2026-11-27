// The bridge's messages, both ways, as JSON text frames on one WebSocket: the extension dials the controller (a local
// program that drives Code Notes) and says who it is; the controller sends requests, the extension answers each one.
// docs/bridge.md is the same protocol for a controller's author.

/** The protocol's version, in the hello: a controller can refuse a window it does not speak to. */
export const BRIDGE_PROTOCOL = 1

/** A workspace folder of the window: its name, its path on the machine the extension runs on, and its URI. */
export interface BridgeFolder { name: string; path: string; uri: string }

/** Where the window is: its folders, VS Code's remote name ("wsl", "ssh-remote", none locally) and the WSL distro. */
export interface BridgeWindow {
  folders: BridgeFolder[]
  remoteName: string | null
  wslDistro: string | null
}

/** Extension → controller. `hello` first, on every connection; `window` when the folders change; one `response` per
 *  request. */
export type FromExtension =
  | { type: 'hello'; protocol: number; token: string; client: 'code-notes'; version: string; window: BridgeWindow }
  | { type: 'window'; window: BridgeWindow }
  | BridgeResponse

export type BridgeResponse =
  | { type: 'response'; id: string; ok: true; result: unknown }
  | { type: 'response'; id: string; ok: false; error: string }

/** Controller → extension: a request (`method` one of BRIDGE_METHODS). */
export interface BridgeRequest { type: 'request'; id: string; method: string; params?: unknown }

/** What a controller may ask, each answered once. */
export const BRIDGE_METHODS = ['reveal', 'journey.play', 'note.add', 'context.get'] as const
export type BridgeMethod = typeof BRIDGE_METHODS[number]

/** 1-based, inclusive lines of a file: workspace-relative (in the window's first folder that has it) or absolute. */
export interface BridgeLines { file: string; start: number; end: number }

/** reveal: the lines opened and lit; `text` shown beside them until the reader dismisses it. */
export interface RevealParams extends BridgeLines { text?: string }
/** journey.play: a journey (its id) walked from step `step` (its number, or its id; none: 1). */
export interface JourneyPlayParams { id: string; step?: number | string; folder?: string }
/** note.add: a note on the lines, `body` its first message, in session `session`. */
export interface NoteAddParams extends BridgeLines { body: string; session: string }
/** context.get: `selectionText` also sends the selected text (file contents are sent only when asked). */
export interface ContextGetParams { selectionText?: boolean }

/** A position as the reader sees it: 1-based line and column. */
export interface BridgePosition { line: number; column: number }

/** context.get's result. Without an active file editor, `file` is null and the rest is absent. */
export interface EditorContext {
  file: { relative: string | null; absolute: string; folder: string | null } | null
  languageId?: string
  visible?: { start: number; end: number }
  selection?: { start: BridgePosition; end: BridgePosition; text?: string }
}
