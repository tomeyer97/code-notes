// The orders table. One row per order; its status goes from pending to paid or failed, once.
import { DatabaseSync } from 'node:sqlite'
import { config } from '../config/load.js'

const db = new DatabaseSync(process.env.SHOP_DB ?? 'shop.db')

db.exec(`CREATE TABLE IF NOT EXISTS orders (
  id          INTEGER PRIMARY KEY,
  customer    TEXT    NOT NULL,
  items       TEXT    NOT NULL,
  total       INTEGER NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending',
  payment_id  TEXT,
  error       TEXT,
  created_at  TEXT    NOT NULL
)`)

export function insertOrder({ customer, items, total }) {
  const last = db.prepare('SELECT MAX(id) AS id FROM orders').get().id
  const id = last ? last + 1 : config.orders.firstNumber

  db.prepare('INSERT INTO orders (id, customer, items, total, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, customer, JSON.stringify(items), total, 'pending', new Date().toISOString())
  return getOrder(id)
}

export function getOrder(id) {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id)
  return row ? { ...row, items: JSON.parse(row.items) } : null
}

export function markPaid(id, paymentId) {
  return settle(id, 'paid', paymentId, null)
}

export function markFailed(id, error) {
  return settle(id, 'failed', null, error)
}

// Only a pending order changes: a second report for the same order changes nothing and returns false.
function settle(id, status, paymentId, error) {
  const done = db
    .prepare("UPDATE orders SET status = ?, payment_id = ?, error = ? WHERE id = ? AND status = 'pending'")
    .run(status, paymentId, error, id)
  return done.changes === 1
}
