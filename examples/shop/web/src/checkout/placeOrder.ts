// The shop page: every "Buy now" button places an order for one of that product, paid with the saved card.
import { openOrderPage, watchOrder } from './OrderStatus'

export interface OrderRequest {
  customer: string
  items: { sku: string; qty: number }[]
  cardToken: string
}

const API = '/api'

export function wireShop(doc: Document): void {
  const { customer = '', card = '' } = doc.body.dataset
  doc.querySelector('#who')!.textContent = customer

  for (const button of doc.querySelectorAll<HTMLButtonElement>('button.buy')) {
    button.addEventListener('click', async () => {
      button.disabled = true
      try {
        await placeOrder({ customer, items: [{ sku: button.dataset.sku!, qty: 1 }], cardToken: card })
      } finally {
        button.disabled = false
      }
    })
  }
}

export async function placeOrder(request: OrderRequest): Promise<void> {
  const res = await fetch(`${API}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  const body = await res.json()

  if (res.status === 503) return showNotice('The shop is busy. Please try again in a minute.')
  if (!res.ok) return showNotice(body.error)

  // 201: the order exists and is pending. Nothing has been charged yet.
  openOrderPage(body.order)
  watchOrder(body.order.id)
}

function showNotice(text: string): void {
  const notice = document.querySelector<HTMLElement>('#notice')!
  notice.textContent = text
  notice.hidden = false
}
