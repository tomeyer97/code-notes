// Reads config/shop.yaml once. The file is two levels of "key: value", so this is the whole parser.
import { readFileSync } from 'node:fs'

export function loadConfig(path = 'config/shop.yaml') {
  const config = {}
  let section = null
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trimEnd()
    if (!line.trim() || line.startsWith('#')) continue

    const [key, ...rest] = line.trim().split(':')
    const value = rest.join(':').trim()
    if (!line.startsWith(' ')) {
      section = config[key] = {}
      continue
    }
    section[key] = /^\d+$/.test(value) ? Number(value) : value
  }
  return config
}

export const config = loadConfig(process.env.SHOP_CONFIG)
