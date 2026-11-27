// The journey files the golden tests read (test/golden-*.test.ts), by a short name, and the repository root.
import * as fs from 'fs'
import * as path from 'path'
import { Journey } from '../src/core/format/journeyModel'
import { journeyOf } from './formats'

/** The repository (this file runs from out/test/). */
export const root = path.join(__dirname, '../..')
/** A file of the repository, by its path from the root. */
export const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8')

/** Every journey file in the repository's fixtures, by a short name. */
export const FIXTURES: Record<string, string> = {
  'shop-place-order': 'examples/shop/journeys/place-order.json',
  'fixture-place-order': 'test/fixtures/journey/journeys/v2-full.json',
  'fixture-order-lifecycle': 'test/fixtures/journey/journeys/order-lifecycle.json',
  'scene-sample': 'test/journey-scene/sample.json',
}
/** The fixture `name` as parseJourney reads it. */
export const parsed = (name: string): Journey => journeyOf(read(FIXTURES[name]), name)
