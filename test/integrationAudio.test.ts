import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as path from 'path'
import { repeatMp3, silentWav } from './integration/main/podcast/audio'

// The long recordings the podcast integration tests make from the tone (test/integration/main/podcast/audio.ts).

const tone = path.join(__dirname, '../../test/fixtures/podcast/tone.mp3')

/** The MPEG frames' lengths in `d` from byte `i` (MPEG-2 Layer III), and where they stop. */
function frames(d: Buffer, i = 0): { lengths: number[]; end: number } {
  const BITRATE = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  const RATE = [22050, 24000, 16000]
  const lengths: number[] = []
  while (i + 4 <= d.length && d[i] === 0xff && (d[i + 1] & 0xe0) === 0xe0) {
    const len = Math.floor((72 * BITRATE[(d[i + 2] >> 4) & 15] * 1000) / RATE[(d[i + 2] >> 2) & 3]) + ((d[i + 2] >> 1) & 1)
    lengths.push(len)
    i += len
  }
  return { lengths, end: i }
}

test('repeatMp3: the tone\'s frames but the first, n times over, nothing else', () => {
  const once = repeatMp3(tone, 1)
  const fifteen = repeatMp3(tone, 15)
  assert.equal(fifteen.length, once.length * 15)
  assert.ok(fifteen.subarray(0, once.length).equals(once) && fifteen.subarray(once.length * 14).equals(once))
  const own = frames(once)
  assert.equal(own.end, once.length, 'whole frames only')
  const d = fs.readFileSync(tone)
  const id3 = d.subarray(0, 3).toString() === 'ID3' ? 10 + ((d[6] << 21) | (d[7] << 14) | (d[8] << 7) | d[9]) : 0
  assert.equal(own.lengths.length, frames(d, id3).lengths.length - 1, 'one frame fewer than the tone (its length header)')
  assert.ok(own.lengths.length > 100, `a tone of many frames: ${own.lengths.length}`)
})

test('silentWav: a 44-byte PCM header, 8 kHz 8-bit mono, then silence', () => {
  const w = silentWav(2)
  assert.equal(w.length, 44 + 16000)
  assert.equal(w.toString('ascii', 0, 4), 'RIFF')
  assert.equal(w.readUInt32LE(4), 36 + 16000)
  assert.equal(w.toString('ascii', 8, 16), 'WAVEfmt ')
  assert.deepEqual([w.readUInt32LE(16), w.readUInt16LE(20), w.readUInt16LE(22), w.readUInt32LE(24), w.readUInt32LE(28), w.readUInt16LE(32), w.readUInt16LE(34)], [16, 1, 1, 8000, 8000, 1, 8])
  assert.equal(w.toString('ascii', 36, 40), 'data')
  assert.equal(w.readUInt32LE(40), 16000)
  assert.ok(w.subarray(44).every((b) => b === 128), 'silence')
})
