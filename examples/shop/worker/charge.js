// Charges the card for one order. A declined card is final; an unreachable provider is tried again
// with the same key, so the provider never charges an order twice.
import { config } from '../config/load.js'
import { createCharge, PaymentDeclined } from '../payments/client.js'

export async function chargeOrder(job) {
  const idempotencyKey = `order-${job.orderId}`
  const { maxAttempts, retryMs } = config.worker

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const payment = await createCharge({
        amount: job.amount,
        currency: job.currency,
        source: job.cardToken,
        idempotencyKey,
      })
      return { paid: true, paymentId: payment.id }
    } catch (err) {
      if (err instanceof PaymentDeclined) return { paid: false, error: err.reason }
      if (attempt === maxAttempts) break
      await sleep(attempt * retryMs)
    }
  }
  return { paid: false, error: 'the payment service could not be reached' }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
