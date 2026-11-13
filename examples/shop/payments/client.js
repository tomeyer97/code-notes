// Client for the payment provider's HTTP API. The only code in the shop that talks to it.
import { config } from '../config/load.js'

export class PaymentDeclined extends Error {
  constructor(reason) {
    super(`card declined: ${reason}`)
    this.reason = reason
  }
}

// Charges `amount` (in cents) to the card behind `source`. Sending the same idempotency key again
// returns the first charge instead of making a second one.
export async function createCharge({ amount, currency, source, idempotencyKey }) {
  const res = await fetch(`${config.payments.url}/charges`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.PAYMENTS_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ amount, currency, source }),
    signal: AbortSignal.timeout(config.payments.timeoutMs),
  })

  if (res.status === 402) {
    const { reason } = await res.json()
    throw new PaymentDeclined(reason)
  }
  if (!res.ok) throw new Error(`the payment provider answered ${res.status}`)

  return res.json() // { id: 'pay_…', amount, currency, status: 'succeeded' }
}
