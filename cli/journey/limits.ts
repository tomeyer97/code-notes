// What a scene's text and lists may hold, read from the journey schema (src/core/format/schema/journey.schema.json):
// the schema is where a box's limits are written, so the check and the published shape say the same. What the schema
// cannot say (widths in pixels, two fields sharing one line) is named here, next to the CSS it estimates.
import schema from '../../src/core/format/schema/journey.schema.json'

const defs = (schema as any).$defs

/** The schema part at `path` under definition `def`: a name is a property, '[]' the items, a number a prefix item. */
function part(def: string, ...path: (string | number)[]): any {
  let s = defs[def]
  for (const p of path) {
    s = p === '[]' ? s.items : typeof p === 'number' ? s.prefixItems[p] : s.properties[p]
    if (!s) throw new Error(`journey schema: nothing at ${def} ${path.join(' ')}`)
  }
  return s
}
const maxLength = (def: string, ...path: (string | number)[]): number => part(def, ...path).maxLength
const maxItems = (def: string, ...path: (string | number)[]): number => part(def, ...path).maxItems

/** The actor types, in the order a message lists them, and their older names. */
export const TYPES = ['app', 'service', 'table', 'cluster', 'browser', 'terminal', 'file', 'chat', 'queue', 'gauge'] as const
export type ActorType = typeof TYPES[number]
export const TYPE_ALIAS: Record<string, string> = { console: 'app' }
export const COMMON_KEYS = ['id', 'type', 'col', 'label', 'sub']

const fields = (def: string) => Object.keys(defs[def].properties)
/** What each actor type reads, besides the common keys. */
export const ACTOR_KEYS = Object.fromEntries(TYPES.map((t) => [t, fields(`actor.${t}`).filter((k) => !COMMON_KEYS.includes(k))])) as Record<ActorType, string[]>
/** What a beat's `set` may change on each actor type. */
export const SET_KEYS = Object.fromEntries(TYPES.map((t) => [t, fields(`setState.${t}`)])) as Record<ActorType, string[]>
export const SCENE_KEYS = fields('scene')
export const BEAT_KEYS = fields('beat')

export const MIN_BEATS = part('scene', 'beats').minItems as number
export const MAX_BEATS = maxItems('scene', 'beats')
export const SOFT_BEATS = 6
export const MAX_ACTORS = maxItems('scene', 'actors')
export const SOFT_CAPTION = 70
export const SOFT_CAPTION_ALL = 110
export const MAX_PACKET = 24

/** The label and sub on a box's top line, by type. */
export const LABEL_CHARS = Object.fromEntries(TYPES.map((t) => [t, maxLength(`actor.${t}`, 'label')])) as Record<ActorType, number>
export const DEFAULT_LABEL: Partial<Record<ActorType, string>> = { app: 'Web app', browser: 'Browser', terminal: 'Terminal', file: 'file', chat: 'Chat' }
/** Nothing is shown until a beat sets `show`. */
export const STARTS_EMPTY = ['terminal', 'chat']

export const FN_CHARS = maxLength('actor.service', 'fn')
export const MAX_CHECKS = maxItems('actor.service', 'checks')
export const MAX_CHECK = maxLength('actor.service', 'checks', '[]')
export const MAX_ROWS = maxItems('actor.table', 'rows')
export const INNER_LABEL_CHARS = maxLength('actor.cluster', 'inner', 'label')
export const BROWSER_CHARS: [string, number][] = ['url', 'title', 'shop', 'button', 'cart', 'markLabel'].map((k) => [k, maxLength('actor.browser', k)])
export const PRODUCT_CHARS = part('actor.browser', 'products', 0).anyOf[0].maxLength as number
/** The shop's name and the cart share one line. */
export const SHOP_TOP = 26
export const FILE_CHARS = maxLength('actor.file', 'lines', '[]')
/** With line numbers (`from`) a file's lines hold fewer characters. */
export const FILE_NUM_CHARS = defs['actor.file'].anyOf[0].properties.lines.items.maxLength as number
export const CHAT_CHARS = maxLength('actor.chat', 'messages', '[]', 'text')
export const CHAT_TOOL_CHARS = part('actor.chat', 'messages', '[]').anyOf[0].properties.text.maxLength as number
export const NOTE_CHARS = maxLength('actor.queue', 'cap')
export const QUEUE_SLOTS = 8
export const MAX_TERM_LINE = maxLength('actor.terminal', 'lines', '[]')

// The app actor's window.
export const SCREENS = ['dialog', 'detail', 'signin']
export const SCREEN_ALIAS = ['run-dialog', 'run-page', 'login']
export const PANES = ['picture', 'chat', 'desktop']
export const TONES = part('actor.app', 'detail', 'tone').enum as string[]
export const LOCKS = ['ok', 'warn']
export const MAX_TABS = maxItems('actor.app', 'tabs')
export const TAB_CHARS = maxLength('actor.app', 'tabs', '[]')
export const DIALOG_CHARS: [string, number][] = ['title', 'item', 'button'].map((k) => [k, maxLength('actor.app', 'dialog', k)])
export const DIALOG_LINES = maxItems('actor.app', 'dialog', 'lines')
export const LINE_KEY = maxLength('actor.app', 'dialog', 'lines', '[]', 0)
export const LINE_VALUE = maxLength('actor.app', 'dialog', 'lines', '[]', 1)
export const DETAIL_CHARS: [string, number][] = ['title', 'status', 'empty', 'picture', 'placeholder'].map((k) => [k, maxLength('actor.app', 'detail', k)])
export const PICTURE_CHARS = maxLength('actor.app', 'detail', 'picture')
export const STATUS_CHARS = maxLength('actor.app', 'detail', 'status')
export const SIGNIN_CHARS: [string, number][] = ['title', 'notice', 'provider', 'button'].map((k) => [k, maxLength('actor.app', 'signin', k)])
export const SIGNIN_TITLE = maxLength('actor.app', 'signin', 'title')
/** Older journeys' flat fields. */
export const OLD_CHARS: [string, number][] = ['test', 'env', 'provider', 'status'].map((k) => [k, maxLength('actor.app', k)])
export const CARD_CHARS = maxLength('actor.app', 'detail', 'cards', '[]', 'title')
export const TIMELINE_CHARS = maxLength('actor.app', 'detail', 'timeline', '[]')
export const APP_CHAT_CHARS = maxLength('actor.app', 'detail', 'chat', '[]', 'text')
export const APP_CHAT_FROM = part('actor.app', 'detail', 'chat', '[]', 'from').enum as string[]
/** A page's title and its status chip share one line. */
export const TITLE_CHIP = 30
export const PAGE_ROWS = 4
export const PAGE_KEY = 12
export const PAGE_VALUE = 20
export const PAGE_BANNER = 38
/** Rows, the banner and the button: what fits under a page's title. */
export const PAGE_ITEMS = 4
export const PAGE_CHARS: [string, number][] = [['title', 22], ['chip', 12], ['tab', TAB_CHARS], ['button', 20]]

// Widths in pixels, estimated from character counts (media/journey-scene.css; calibrated with the panel check,
// test/journey-scene/check.mjs).
/** The app window's top bar (.ap-win, 304 px wide): the logo, the brand and the tabs. */
export const TOP_PX = 280
/** The brand: 12.5 px bold. */
export const BRAND_PX = 7.8
/** A tab: 12 px. */
export const TAB_PX = 6.8
export const TAB_GAP = 12
/** A table row (.scn-row): the id in 13 px mono (at least 70 px), then pills of 12 px text, 9 px apart. */
export const ROW_PX = 300
export const MONO_13_PX = 7.8
export const ROW_ID_MIN_PX = 70
export const PILL_PX = 6.2
export const PILL_GAP = 9
export const PILL_PAD = 18
/** Pods side by side (.scn-pod: a 14 px label over a 12 px note). */
export const PODS_PX = 320
export const INNER_PODS_PX = 296
export const LABEL_14_PX = 7.2
export const NOTE_12_PX = 6.4
