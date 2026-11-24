// Local HTTP servers standing in for the APIs the CLI calls: one factory (fakeServer), every request recorded in one
// shape. The forges' APIs are built on it in forges.mjs.
import http from 'node:http'

/**
 * A local JSON server answering with `handle(method, path, body, headers)` → [status, json, responseHeaders?]
 * (undefined: 404). Every request is recorded in `calls` as { method, path, body, headers }. Returns { url, calls, close }.
 */
export async function fakeServer(handle) {
  const calls = []
  const srv = http.createServer((req, res) => {
    let b = ''
    req.on('data', (x) => { b += x })
    req.on('end', () => {
      const p = req.url.split('?')[0]
      const body = b ? JSON.parse(b) : undefined
      calls.push({ method: req.method, path: p, body, headers: req.headers })
      const [status, json, headers = {}] = handle(req.method, p, body, req.headers) ?? [404, {}]
      res.statusCode = status
      for (const [k, v] of Object.entries({ 'content-type': 'application/json', ...headers })) res.setHeader(k, v)
      res.end(json === null ? '' : JSON.stringify(json ?? {}))
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${srv.address().port}`, calls, close: () => srv.close() }
}

/** A handler for fakeServer from a table: "METHOD path" → a value, or (body) => value; answered with 200. */
export const routes = (table) => (method, p, body) => {
  const h = table[`${method} ${p}`]
  if (h !== undefined) return [200, typeof h === 'function' ? h(body) : h]
}

/** The Anthropic Messages API, replying `text` to every request. */
export const fakeAnthropic = (text) => fakeServer(routes({
  'POST /v1/messages': { stop_reason: 'end_turn', content: [{ type: 'text', text }] },
}))

/** A git remote over HTTP that wants a password (401 to everything). */
export const remoteWantingPassword = () => fakeServer(() => [401, null, { 'www-authenticate': 'Basic realm="git"' }])
