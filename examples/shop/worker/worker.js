// The worker: asks the API for a charge job, charges the card, reports the result. One job at a time.
import { config } from '../config/load.js'
import { chargeOrder } from './charge.js'

const API = process.env.SHOP_API ?? `http://localhost:${config.api.port}`
const headers = { 'Content-Type': 'application/json', 'X-Worker-Key': process.env.WORKER_KEY ?? '' }

async function takeJob() {
  const res = await fetch(`${API}/internal/jobs/next`, { method: 'POST', headers })
  if (res.status === 204) return null
  if (!res.ok) throw new Error(`the API answered ${res.status}`)
  return (await res.json()).job
}

async function report(orderId, result) {
  const res = await fetch(`${API}/internal/orders/${orderId}/result`, {
    method: 'POST',
    headers,
    body: JSON.stringify(result),
  })
  if (res.status === 409) console.warn(`order ${orderId}: already settled`)
}

// Takes one job and finishes it. Returns false when no job was waiting.
export async function pollOnce() {
  const job = await takeJob()
  if (!job) return false

  const result = await chargeOrder(job)
  await report(job.orderId, result)
  console.log(`order ${job.orderId}: ${result.paid ? `paid ${result.paymentId}` : `failed, ${result.error}`}`)
  return true
}

async function run() {
  console.log(`worker: polling every ${config.worker.pollMs} ms`)
  for (;;) {
    try {
      const worked = await pollOnce()
      if (worked) continue // more jobs may be waiting: take the next one at once
    } catch (err) {
      console.error(`poll failed: ${err.message}`)
    }
    await sleep(config.worker.pollMs)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

run()
