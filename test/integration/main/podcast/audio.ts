// Long recordings made from small ones, so no multi-megabyte file is committed: ten minutes of the tone (MP3) and ten
// minutes of silence (WAV). Kept apart from the scenarios: a reader of those only needs to know what they get.
import * as fs from 'fs'

/**
 * `mp3` (an MPEG-2 Layer III file, as test/fixtures/podcast/tone.mp3 is) `n` times over: its audio frames
 * repeated. An MP3 file is an optional ID3 tag (10 bytes of header, then its size as four 7-bit bytes) followed by
 * frames, each a 4-byte header and its data. A frame's length follows from its header: 72 × bitrate / sample rate
 * bytes, plus one when the padding bit is set (MPEG-2 Layer III). The first frame (a length header that would
 * announce the short file's duration) is left out: the player measures the stream itself.
 */
export function repeatMp3(mp3: string, n: number): Buffer {
  const d = fs.readFileSync(mp3)
  const id3Size = (d[6] << 21) | (d[7] << 14) | (d[8] << 7) | d[9]
  let i = d.subarray(0, 3).toString() === 'ID3' ? 10 + id3Size : 0
  // MPEG-2 Layer III: bitrate (kbit/s) by the header's 4-bit index, sample rate (Hz) by its 2-bit index.
  const BITRATE = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  const SAMPLE_RATE = [22050, 24000, 16000]
  const isFrame = (k: number) => k + 4 <= d.length && d[k] === 0xff && (d[k + 1] & 0xe0) === 0xe0
  const frames: Buffer[] = []
  while (isFrame(i)) {
    const h = d[i + 2]
    const bitrate = BITRATE[(h >> 4) & 15], rate = SAMPLE_RATE[(h >> 2) & 3], padding = (h >> 1) & 1
    const len = Math.floor((72 * bitrate * 1000) / rate) + padding
    frames.push(d.subarray(i, i + len))
    i += len
  }
  const body = Buffer.concat(frames.slice(1))
  return Buffer.concat(Array.from({ length: n }, () => body))
}

/** `secs` seconds of silence as a WAV file: 8 kHz, 8-bit, mono PCM (8,000 bytes a second after a 44-byte header). */
export function silentWav(secs: number): Buffer {
  const rate = 8000, bytes = secs * rate
  const wav = Buffer.alloc(44 + bytes, 128) // 128: silence in 8-bit PCM
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + bytes, 4); wav.write('WAVE', 8)
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16) // the format chunk, 16 bytes:
  wav.writeUInt16LE(1, 20) // PCM
  wav.writeUInt16LE(1, 22) // one channel
  wav.writeUInt32LE(rate, 24) // samples a second
  wav.writeUInt32LE(rate, 28) // bytes a second
  wav.writeUInt16LE(1, 32) // bytes a sample
  wav.writeUInt16LE(8, 34) // bits a sample
  wav.write('data', 36); wav.writeUInt32LE(bytes, 40)
  return wav
}
