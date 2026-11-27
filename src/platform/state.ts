// Everything the extension keeps in VS Code's stored state, in one table: each key once, with its scope (this
// workspace, or every workspace), its type and its value when nothing is stored. The key strings are what users'
// stored state is under: never rename one (add a migration instead). The migrations of older keys are at the end,
// run once at activation. No vscode at run time (only its types): unit-tested.
import type * as vscode from 'vscode'
import type { CompactAnchor } from '../core/anchors/compact'
import type { Sort } from '../core/list/journeyList'

/** 'workspace': this workspace's state (context.workspaceState); 'global': every workspace's (context.globalState). */
export type Scope = 'workspace' | 'global'

/** A stored value: its key, scope, and what `get` gives when nothing is stored. */
export interface StateKey<T> {
  readonly key: string
  readonly scope: Scope
  readonly fallback: T
}

const ws = <T>(key: string, fallback: T): StateKey<T> => ({ key, scope: 'workspace', fallback })
const global = <T>(key: string, fallback: T): StateKey<T> => ({ key, scope: 'global', fallback })

/** Where a journey's walk was left: its step (1-based), the step's id, and when. */
export interface JourneyPos { step: number; id?: string; at: string }
/** Questions being written when the window went away: by whom (the process) and since when. */
export interface CheckWriting { branch: string; started: number; pid?: number }

/** Every stored value of the extension. */
export const STATE = {
  // ---------- notes ----------
  /** Note id -> how many of its messages the person has seen. */
  seenCount: ws<Record<string, number>>('codeNotes.seenCount', {}),
  /** Note id -> how many of its status changes the person has seen. */
  seenEvents: ws<Record<string, number>>('codeNotes.seenEvents', {}),
  /** v0.1: note id -> when the person last saw it (ISO time). Migrated to seenCount (MIGRATIONS). */
  seenTimes: ws<Record<string, string> | undefined>('codeNotes.seen', undefined),
  /** Names this person wrote under before (the author setting changed): still theirs. */
  pastNames: ws<string[]>('codeNotes.pastNames', []),
  /** Sessions hidden in the Code Notes view. */
  hiddenSessions: ws<string[]>('codeNotes.hiddenSessions', []),
  /** The Code Notes view's grouping: 'file' or 'session' (unset: by file). */
  groupBy: ws<string | undefined>('codeNotes.groupBy', undefined),
  /** Note id -> why asking Claude about it failed: survives a reload, until retried or dismissed. */
  askErrors: ws<Record<string, string>>('codeNotes.askErrors', {}),

  // ---------- journeys and the tour ----------
  /** The running tour's journey (its posKey), restored after a reload. */
  tour: ws<string | undefined>('codeNotes.tour', undefined),
  /** posKey -> where its walk was left. */
  journeyPos: ws<Record<string, JourneyPos>>('codeNotes.journeyPos', {}),
  /** The journey last shown on the map (its posKey). */
  mapJourney: ws<string | undefined>('codeNotes.mapJourney', undefined),
  /** Journeys seen in the list (posKeys); one added since is "new" until opened. Unset: everything there now is known. */
  journeysSeen: ws<string[] | undefined>('codeNotes.journeysSeen', undefined),
  /** The Journeys view's sort. */
  journeySort: ws<Sort>('codeNotes.journeySort', 'area'),
  /** The editor column the map panel was last in. */
  mapColumn: ws<number | undefined>('codeNotes.mapColumn', undefined),
  /** The map's legend is folded away (it is shown on demand). */
  legendHidden: ws<boolean>('codeNotes.legendHidden', true),
  /** A step's code as the reader's own edits left it (by step); the journey file is never written. */
  journeyFollowed: ws<Record<string, CompactAnchor>>('codeNotes.journeyFollowed', {}),
  /** Files steps followed through a rename (folder|file -> new path). */
  journeyRenames: ws<Record<string, string>>('codeNotes.journeyRenames', {}),
  /** The map column's width in wide panels, as last dragged: every panel, every journey. */
  mapWidth: global<number | undefined>('codeNotes.mapWidth', undefined),
  /** The panel's width as the reader left it (a share of the editor area), every journey. */
  panelShare: global<number | undefined>('codeNotes.panelShare', undefined),
  /** A journey has been opened once: the Journeys view's quiet intro line is gone. */
  journeyOpened: global<boolean>('codeNotes.journeyOpened', false),
  /** The tutorial was seen (or skipped). */
  tutorialSeen: global<boolean>('codeNotes.tutorialSeen', false),

  // ---------- podcasts ----------
  /** posKey -> where its podcast was left (seconds). */
  podcastPos: ws<Record<string, number>>('codeNotes.podcastPos', {}),
  podcastRate: global<number>('codeNotes.podcastRate', 1),
  podcastMuted: global<boolean>('codeNotes.podcastMuted', false),
  /** The Listen view's hint was shown once. */
  listenHintShown: global<boolean>('codeNotes.listenHintShown', false),

  // ---------- the understanding check ----------
  /** Commits whose background questions were written (never twice for the same commit). */
  checkBackgroundHeads: ws<string[]>('codeNotes.understanding.backgroundHeads', []),
  /** Per branch, per question: the file and line a TODO was added at (offered, not committed, by Commit & push). */
  checkTodos: ws<Record<string, Record<string, { file: string; line: number }>>>('codeNotes.understanding.todoFiles', {}),
  /** Per branch, per question: the file its suggested fix was applied to (offered, ticked, by Commit & push). */
  checkFixes: ws<Record<string, Record<string, string>>>('codeNotes.understanding.fixFiles', {}),
  /** Per check file, per question: unsent answers typed in the Check view's box (this workspace only). */
  checkDrafts: ws<Record<string, Record<string, string>>>('codeNotes.understanding.drafts', {}),
  /** Questions being written: a window reloaded meanwhile says so instead of offering Start again. */
  checkWriting: ws<CheckWriting | undefined>('codeNotes.understanding.writing', undefined),

  // ---------- keys ----------
  /** The chord prefix last used (Ctrl+' or Ctrl+<): the hints name it. */
  chordPrefix: global<string | undefined>('codeNotes.chordPrefix', undefined),
} as const

/** Keys made from a value: one key per value, each declared here. */
export const STATE_FAMILIES = {
  /** "Notes are kept out of git" (true) or "can now be committed" (false) was said once. */
  gitSaid: (on: boolean) => global<boolean>(`codeNotes.gitSaid.${on}`, false),
} as const

/** A record kept under one key (`Kept` before): a value per id. */
export interface StoredRecord<T> {
  all(): Record<string, T>
  get(id: string): T | undefined
  /** `undefined` drops `id`. */
  set(id: string, v: T | undefined): Promise<void>
}

/** A record per scope (a branch, a check file), each a value per id (`PerScope` before). */
export interface ScopedRecord<T> {
  /** The scope's record ({} when there is no scope or nothing stored). */
  get(scope: string | undefined): Record<string, T>
  /** Sets (or, `v` undefined, removes) `id`'s value in the scope. */
  set(scope: string, id: string, v: T | undefined): Promise<void>
  /** Replaces the scope's whole record. */
  replace(scope: string, record: Record<string, T>): Promise<void>
}

/** A fallback object is copied: a caller that changes what it got must not change the fallback. */
const fresh = <T>(v: T): T => (v !== null && typeof v === 'object' ? structuredClone(v) : v)

/**
 * The stored state, read and written by STATE's keys. The Mementos are read at each call (not copied): VS Code keeps
 * them in memory, and the integration tests count the writes by wrapping `update`.
 */
export class StateStore {
  /** No Mementos (unit tests): nothing is stored, every key reads its fallback. */
  constructor(private readonly workspace?: vscode.Memento, private readonly global?: vscode.Memento) {}

  private memento(k: StateKey<unknown>): vscode.Memento | undefined {
    return k.scope === 'workspace' ? this.workspace : this.global
  }

  get<T>(k: StateKey<T>): T {
    const v = this.memento(k)?.get<T>(k.key)
    return v ?? fresh(k.fallback)
  }

  /** Whether anything is stored under `k`. */
  has(k: StateKey<unknown>): boolean { return this.memento(k)?.get(k.key) !== undefined }

  /** `undefined` removes the key. */
  async set<T>(k: StateKey<T>, v: T | undefined): Promise<void> {
    await this.memento(k)?.update(k.key, v)
  }

  record<T>(k: StateKey<Record<string, T>>): StoredRecord<T> {
    const all = () => this.get(k)
    return {
      all,
      get: (id) => all()[id],
      set: async (id, v) => {
        const next = { ...all() }
        if (v !== undefined) next[id] = v
        else if (id in next) delete next[id]
        else return
        await this.set(k, next)
      },
    }
  }

  scoped<T>(k: StateKey<Record<string, Record<string, T>>>): ScopedRecord<T> {
    const all = () => this.get(k)
    return {
      get: (scope) => (scope === undefined ? undefined : all()[scope]) ?? {},
      set: async (scope, id, v) => {
        const a = all()
        const mine = { ...(a[scope] ?? {}) }
        if (v === undefined) delete mine[id]
        else mine[id] = v
        await this.set(k, { ...a, [scope]: mine })
      },
      replace: (scope, record) => this.set(k, { ...all(), [scope]: record }),
    }
  }

  /** The Mementos (the integration tests count their writes). */
  mementos(): vscode.Memento[] { return [this.workspace, this.global].filter((m): m is vscode.Memento => !!m) }
}

// ---------- migrations ----------

/** What a migration may read besides the state: the notes as loaded. */
export interface MigrationContext {
  notes: () => readonly { id: string; messages: readonly { at?: string }[] }[]
}

export interface Migration {
  /** For the log. */
  what: string
  /** The old key: the migration runs while something is stored under it, and removes it. */
  from: StateKey<unknown>
  run(store: StateStore, ctx: MigrationContext): Promise<void>
}

/**
 * v0.1's time a note was last seen, as how many of its messages had come by then (messages without a time count as
 * before it). Notes that already have a count, or that v0.1 never saw, are left out.
 */
export function seenCountsFromTimes(
  times: Record<string, string>, notes: readonly { id: string; messages: readonly { at?: string }[] }[], counted: Record<string, number>,
): [string, number][] {
  const out: [string, number][] = []
  for (const n of notes) {
    const at = Date.parse(times[n.id] ?? '')
    if (!at || counted[n.id] !== undefined) continue
    let count = 0
    for (const m of n.messages) {
      if ((Date.parse(m.at ?? '') || 0) <= at) count++
      else break
    }
    out.push([n.id, count])
  }
  return out
}

/** The migrations, oldest first. Each runs at activation while its old key is stored (after the notes are loaded). */
export const MIGRATIONS: readonly Migration[] = [
  {
    what: 'seen times to seen counts (v0.1)',
    from: STATE.seenTimes,
    async run(store, ctx) {
      const counts = store.get(STATE.seenCount)
      const add = seenCountsFromTimes(store.get(STATE.seenTimes) ?? {}, ctx.notes(), counts)
      if (add.length) await store.set(STATE.seenCount, { ...counts, ...Object.fromEntries(add) })
      await store.set(STATE.seenTimes, undefined)
    },
  },
]

/** Runs the migrations whose old key is stored; one that fails is left for the next start (and logged by the caller). */
export async function runMigrations(store: StateStore, ctx: MigrationContext, list: readonly Migration[] = MIGRATIONS): Promise<string[]> {
  const ran: string[] = []
  for (const m of list) {
    if (!store.has(m.from)) continue
    await m.run(store, ctx)
    ran.push(m.what)
  }
  return ran
}
