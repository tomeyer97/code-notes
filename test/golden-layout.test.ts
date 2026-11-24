// Golden tests (test/README.md): the pure parts of the map's layout (media/journey-layout.js) as they work today, byte
// for byte.
import { test } from 'node:test'
import * as fs from 'fs'
import * as path from 'path'
import * as vm from 'vm'
import { expectGolden } from './golden'
import { FIXTURES, parsed, root } from './goldenJourneys'

const AREA = 'journey'

// ---------- the map's layout (media/journey-layout.js): its pure parts ----------

const media = path.join(root, 'media')
const window: Record<string, any> = { JourneyModel: {} }
const context = vm.createContext({ window })
for (const f of ['common.js', 'journey-layout.js']) vm.runInContext(fs.readFileSync(path.join(media, f), 'utf8'), context)
const L = window.JourneyLayout

test('golden: the map layout\'s pure parts for each fixture journey', () => {
  for (const name of Object.keys(FIXTURES)) {
    const j = parsed(name)
    const byId = new Map(j.nodes.map((n) => [n.id, n]))
    expectGolden(AREA, `layout.${name}`, {
      signature: L.signature(j),
      stepsOf: [...L.stepsOf(j)],
      ancestors: j.nodes.map((n) => [n.id, L.ancestors(byId, n.id)]),
      verbs: j.edges.map((e) => [e.label, L.verb(e.label)]),
    })
  }
  const pts = [{ x: 0, y: 0 }, { x: 0, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 21 }]
  const bez = [{ x: 0, y: 0 }, { x: 10, y: 40 }, { x: 50, y: -10 }, { x: 60, y: 30 }]
  expectGolden(AREA, 'layout.geometry', {
    pathD: [L.pathD([]), L.pathD(pts.slice(0, 1)), L.pathD(pts.slice(0, 2)), L.pathD(pts)],
    curveD: L.curveD(bez),
    samplesPolyline: L.samples({ pts }),
    samplesCurve: L.samples({ bez }),
  })
})
