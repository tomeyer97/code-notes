// Checks an order request before anything is stored. Names and prices come from the catalog here,
// never from the browser.
import { config } from '../config/load.js'

// Prices in cents.
export const CATALOG = {
  'lamp-desk': { name: 'Desk lamp', price: 4900 },
  'lamp-floor': { name: 'Floor lamp', price: 12900 },
  'bulb-e27': { name: 'LED bulb E27', price: 600 },
}

export function validateOrder(body) {
  if (!body) return fail('The order could not be read')
  if (typeof body.customer !== 'string' || !body.customer.trim()) return fail('Sign in to order')
  if (!Array.isArray(body.items) || body.items.length === 0) return fail('The cart is empty')
  if (body.items.length > config.orders.maxItems) return fail(`At most ${config.orders.maxItems} products per order`)
  if (typeof body.cardToken !== 'string' || !body.cardToken.startsWith('tok_')) return fail('Add a card to pay')

  const items = []
  let total = 0
  for (const item of body.items) {
    const product = CATALOG[item.sku]
    if (!product) return fail(`Unknown product ${item.sku}`)
    if (!Number.isInteger(item.qty) || item.qty < 1) return fail(`Choose how many of ${product.name}`)

    items.push({ sku: item.sku, name: product.name, qty: item.qty, price: product.price })
    total += product.price * item.qty
  }

  return { ok: true, order: { customer: body.customer.trim(), items, total, cardToken: body.cardToken } }
}

function fail(error) {
  return { ok: false, error }
}
