// The shop's HTTP API. The web app places and reads orders; the worker takes jobs and reports results.
import { createServer } from 'node:http'
import { config } from '../config/load.js'
import { validateOrder } from './validate.js'
import { insertOrder, getOrder, markPaid, markFailed } from './store.js'
import { jobs } from './queue.js'

export async function createOrder(req, res) {
  const checked = validateOrder(await readJson(req))
  if (!checked.ok) return send(res, 400, { error: checked.error })
  if (jobs.isFull()) return send(res, 503, { error: 'The shop is busy' })

  // The card token goes into the job only: the orders table never holds it.
  const { cardToken, ...details } = checked.order
  const order = insertOrder(details)
  jobs.push({ orderId: order.id, amount: order.total, currency: config.shop.currency, cardToken })
  send(res, 201, { order })
}

export function readOrder(req, res, id) {
  const order = getOrder(id)
  if (!order) return send(res, 404, { error: 'No such order' })
  send(res, 200, { order })
}

// The worker asks for the next job: 204 when none is waiting.
export function nextJob(req, res) {
  const job = jobs.take()
  if (!job) return send(res, 204)
  send(res, 200, { job })
}

// The worker reports how the charge went: 409 when the order was settled before.
export async function settleOrder(req, res, id) {
  const result = await readJson(req)
  const changed = result.paid ? markPaid(id, result.paymentId) : markFailed(id, result.error)
  send(res, changed ? 200 : 409, { order: getOrder(id) })
}

const routes = [
  ['POST', /^\/api\/orders$/, createOrder],
  ['GET', /^\/api\/orders\/(\d+)$/, readOrder],
  ['POST', /^\/internal\/jobs\/next$/, nextJob],
  ['POST', /^\/internal\/orders\/(\d+)\/result$/, settleOrder],
]

createServer((req, res) => {
  const internal = req.url.startsWith('/internal/')
  if (internal && req.headers['x-worker-key'] !== process.env.WORKER_KEY) return send(res, 401, { error: 'Not allowed' })

  for (const [method, pattern, handler] of routes) {
    const match = req.method === method && pattern.exec(req.url)
    if (match) return handler(req, res, Number(match[1]))
  }
  send(res, 404, { error: 'Not found' })
}).listen(config.api.port)

async function readJson(req) {
  let text = ''
  for await (const chunk of req) text += chunk
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body ? JSON.stringify(body) : undefined)
}
