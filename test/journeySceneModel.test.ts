// A step animation's data side (media/journey-scene-model.js): where the actors go, each actor's state at a beat, the
// actor a beat looks at, older scenes read in today's names, and what a status word means.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageModule } from './pageModule'

type Scene = { actors: any[]; wires?: [string, string][]; beats: any[] }
type Rect = { x: number; y: number; w: number; h: number }
const M = pageModule<{
  upgradeScene(s: Scene): Scene
  layoutScene(s: Scene, sizeOf: (a: any) => [number, number] | undefined): { rects: Record<string, Rect>; W: number; H: number; wires: { f: string; t: string; y: number; x1: number; x2: number }[] }
  stateAt(s: Scene, i: number): Record<string, Record<string, unknown>>
  focusOf(s: Scene, rects: Record<string, Rect>, i: number): string
  statusTone(word: unknown): string
}>('media/journey-scene-model.js')
const scenePage = pageModule<{ registerActor(type: string, t: object): void; WINDOW_BOX: [number, number] }>('media/journey-scene.js')

/** Every known type a 100 × 50 box; anything else none. */
const KNOWN = new Set(['service', 'table', 'app'])
const box = (a: { type: string }): [number, number] | undefined => (KNOWN.has(a.type) ? [100, 50] : undefined)

test('actors go in their columns, top to bottom; a wire is level with the middle of its smaller end', () => {
  const L = M.layoutScene({
    actors: [{ id: 'a', type: 'service', col: 0 }, { id: 'b', type: 'service', col: 0 }, { id: 'c', type: 'table', col: 1 }],
    wires: [['a', 'c'], ['c', 'nobody']],
    beats: [{ focus: 'a', caption: '.' }],
  }, box)
  assert.deepEqual({ ...L.rects }, { a: { x: 0, y: 0, w: 100, h: 50 }, b: { x: 0, y: 70, w: 100, h: 50 }, c: { x: 200, y: 0, w: 100, h: 50 } })
  assert.deepEqual([L.W, L.H], [300, 120])
  assert.deepEqual(L.wires, [{ f: 'a', t: 'c', y: 25, x1: 100, x2: 200 }], 'a wire to an actor not there is left out')
})

test('a beat\'s state is every set up to it, merged; going back undoes the later ones', () => {
  const s: Scene = { actors: [], beats: [{ set: { a: { done: 1, x: 1 } } }, { set: { a: { done: 2 } } }, {}] }
  assert.deepEqual({ ...M.stateAt(s, 0) }, { a: { done: 1, x: 1 } })
  assert.deepEqual({ ...M.stateAt(s, 2) }, { a: { done: 2, x: 1 } })
})

test('a beat looks at its own focus, else the last one looked at before, else the next', () => {
  const rects = { a: { x: 0, y: 0, w: 1, h: 1 }, b: { x: 0, y: 0, w: 1, h: 1 } }
  const s: Scene = { actors: [], beats: [{ focus: 'all' }, { focus: 'b' }, { focus: 'all' }] }
  assert.deepEqual([0, 1, 2].map((i) => M.focusOf(s, rects, i)), ['b', 'b', 'b'])
  assert.equal(M.focusOf({ actors: [], beats: [{ focus: 'all' }] }, rects, 0), 'a', 'none at all: the first actor')
})

test('older scenes are read in today\'s names once: the console type, its flat fields, its screens and its beat state', () => {
  const s = M.upgradeScene({
    actors: [{ id: 'c', type: 'console', test: 'Login test', env: 'staging', status: 'Running', findings: [{ title: 'x' }], provider: 'GitHub', screen: 'run-page' }, { id: 's', type: 'service' }],
    beats: [{ focus: 'c', set: { c: { screen: 'login', findings: 1, newFinding: 0, pane: 'desktop', desktop: 'connecting' }, s: { done: 1 } } }],
  })
  const c = s.actors[0]
  assert.equal(c.type, 'app')
  assert.equal(c.screen, 'detail')
  assert.deepEqual(c.dialog, { item: 'Login test', lines: [['Environment', 'staging']] })
  assert.deepEqual(c.detail, { status: 'Running', cards: [{ title: 'x' }], timeline: undefined, chat: undefined })
  assert.deepEqual(c.signin, { provider: 'GitHub' })
  assert.deepEqual(s.beats[0].set.c, { screen: 'signin', findings: 1, cards: 1, newFinding: 0, newCard: 0, pane: 'picture', desktop: 'connecting', picture: 'connecting' })
  assert.deepEqual(s.beats[0].set.s, { done: 1 }, 'other actors\' state as written')
  assert.equal(s.actors[1].type, 'service')
})

test('a status word means one thing for every actor', () => {
  assert.deepEqual(['queued', 'starting', 'Running', 'passed', 'FAILED', 'Pending'].map(M.statusTone), ['waiting', 'live', 'live', 'good', 'bad', 'neutral'])
})

test('ids, types, states and screens named like Object.prototype\'s keys are plain names', () => {
  // As JSON text: an object literal would turn "__proto__" into a prototype.
  const odd: Scene = JSON.parse(`{
    "actors": [
      { "id": "__proto__", "type": "service", "col": 0 },
      { "id": "constructor", "type": "app", "col": 1, "screen": "__proto__", "detail": { "status": "constructor" } },
      { "id": "odd", "type": "toString", "col": 2 }
    ],
    "wires": [["__proto__", "constructor"], ["hasOwnProperty", "constructor"]],
    "beats": [
      { "focus": "constructor", "set": { "constructor": { "screen": "detail" }, "toString": { "x": 1 } } },
      { "focus": "valueOf", "set": { "__proto__": { "done": 1 } } },
      { "focus": "__proto__" }
    ]
  }`)
  const s = M.upgradeScene(odd)
  assert.equal(Object.getPrototypeOf(s.beats[1].set), Object.prototype, 'no prototype set from the data')
  assert.deepEqual(Object.keys(s.beats[1].set), ['__proto__'])
  assert.equal(s.actors[1].screen, '__proto__', 'a screen named like a key of the alias table is not an older name')
  const L = M.layoutScene(s, box)
  assert.deepEqual(Object.keys(L.rects).sort(), ['__proto__', 'constructor'], 'the unknown type is left out')
  assert.deepEqual(L.wires.map((w) => `${w.f}-${w.t}`), ['__proto__-constructor'], 'a wire to no actor is left out')
  const st = M.stateAt(s, 1)
  assert.deepEqual(Object.keys(st).sort(), ['__proto__', 'constructor', 'toString'])
  assert.deepEqual({ ...st['__proto__'] }, { done: 1 })
  assert.equal(M.focusOf(s, L.rects, 1), 'constructor', 'a focus on no actor keeps the last one looked at')
  assert.equal(M.statusTone('constructor'), 'neutral')
  assert.equal(M.statusTone('__proto__'), 'neutral')
})

test('an actor type is registered once; the window-like ones share one box', () => {
  assert.deepEqual(scenePage.WINDOW_BOX, [320, 250])
  assert.throws(() => scenePage.registerActor('service', { make: () => undefined, size: () => [1, 1] }), /registered twice/)
})
