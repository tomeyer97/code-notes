// Low-stock alerts: when a product's stock falls under its threshold, operations get an email.
import { pool } from '../api/pg.js'
import { sendMail } from './notify.js'

const OPS_EMAIL = process.env.OPS_EMAIL

export async function checkStock() {
  const { rows } = await pool.query('SELECT id, name, stock, low_at FROM products WHERE stock < low_at')
  if (!rows.length || !OPS_EMAIL) return 0
  const text = rows.map((p) => `${p.name}: ${p.stock} left`).join('\n')
  await sendMail(OPS_EMAIL, `Low stock: ${rows.length} products`, text)
  return rows.length
}
