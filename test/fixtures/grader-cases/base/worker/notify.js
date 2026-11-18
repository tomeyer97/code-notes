// Notification jobs: rows in the jobs table, taken one at a time by tick(). A handler that throws is retried
// with backoff, up to MAX_TRIES; after that the job is marked dead.
import net from 'node:net'
import { pool } from '../api/pg.js'

const SMTP_HOST = process.env.SMTP_HOST
const MAX_TRIES = 5

// Sends one mail over plain SMTP: HELO, MAIL FROM, RCPT TO, DATA, QUIT. Throws on any reply that is not 2xx/3xx.
export async function sendMail(to, subject, text) {
  const s = net.connect(25, SMTP_HOST)
  const say = (line) => new Promise((resolve, reject) => {
    s.once('data', (d) => (/^[23]/.test(String(d)) ? resolve(String(d)) : reject(new Error(`SMTP: ${String(d).trim()}`))))
    if (line) s.write(`${line}\r\n`)
  })
  await say()
  await say('HELO shop')
  await say('MAIL FROM:<shop@example.com>')
  await say(`RCPT TO:<${to}>`)
  await say('DATA')
  await say(`Subject: ${subject}\r\n\r\n${text}\r\n.`)
  await say('QUIT')
  s.end()
}

async function orderConfirmation({ number }) {
  const { rows: [o] } = await pool.query('SELECT number, email, total FROM orders WHERE number = $1', [number])
  const text = `Thanks for your order #${o.number}. Total: ${(o.total / 100).toFixed(2)}.`
  await sendMail(o.email, `Your order #${o.number}`, text)
  await pool.query('UPDATE orders SET receipt_sent_at = now() WHERE number = $1', [number])
}

const handlers = { order_confirmation: orderConfirmation }

// Takes the oldest due job; runs its handler; deletes it when the handler returns. A handler that throws: the
// job comes back after 2^tries seconds, and is marked dead after MAX_TRIES.
export async function tick() {
  const { rows: [job] } = await pool.query(
    `UPDATE jobs SET taken_at = now() WHERE id = (
       SELECT id FROM jobs WHERE dead = false AND run_at <= now() ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING *`)
  if (!job) return false
  try {
    await handlers[job.kind](job.payload)
    await pool.query('DELETE FROM jobs WHERE id = $1', [job.id])
  } catch (err) {
    const tries = job.tries + 1
    await pool.query(
      `UPDATE jobs SET tries = $2, dead = $2 >= $3, run_at = now() + make_interval(secs => power(2, $2)), last_error = $4 WHERE id = $1`,
      [job.id, tries, MAX_TRIES, String(err.message)])
  }
  return true
}
