// Refunds: staff refund part or all of an order. `key` is the request's Idempotency-Key: a retry with the
// same key gets the refund made the first time back instead of a second refund.
import { pool } from './pg.js'

export class RefundError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

export async function createRefund(number, amount, key) {
  if (!Number.isInteger(amount) || amount < 1) throw new RefundError(422, 'The amount must be a whole number of cents.')
  const { rows: [prev] } = await pool.query(
    'SELECT * FROM refunds WHERE order_number = $1 AND idempotency_key = $2', [number, key])
  if (prev) return { refund: prev, replayed: true }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: [order] } = await client.query('SELECT number, total, refunded FROM orders WHERE number = $1 FOR UPDATE', [number])
    if (!order) throw new RefundError(404, 'Order not found')
    if (order.refunded + amount > order.total) throw new RefundError(422, `Only ${order.total - order.refunded} can still be refunded.`)
    const { rows: [refund] } = await client.query(
      'INSERT INTO refunds (order_number, idempotency_key, amount) VALUES ($1, $2, $3) RETURNING *', [number, key, amount])
    await client.query('UPDATE orders SET refunded = refunded + $2 WHERE number = $1', [number, amount])
    await client.query(`INSERT INTO jobs (kind, payload) VALUES ('refund_notice', $1)`, [{ number, refund: refund.id }])
    await client.query('COMMIT')
    return { refund, replayed: false }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
