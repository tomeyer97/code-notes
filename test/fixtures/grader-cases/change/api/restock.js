// Refunded items: each refunded line is recorded, and its quantity goes back into the product's stock.
export async function refundItems(client, number, items) {
  for (const { sku, qty } of items) {
    await client.query('INSERT INTO refund_items (order_number, sku, qty) VALUES ($1, $2, $3)', [number, sku, qty])
    await client.query('UPDATE products SET stock = stock + $2 WHERE sku = $1', [sku, qty])
  }
}
