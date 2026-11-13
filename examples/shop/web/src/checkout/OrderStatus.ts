// The order page: a title, a status chip and a short history. It asks the API until the order is settled.
const API = '/api'
const POLL_MS = 1000
const GIVE_UP_MS = 30000

export interface Order {
  id: number
  status: 'pending' | 'paid' | 'failed'
  total: number // in cents
  error: string | null
}

const HISTORY: Record<Order['status'], (order: Order) => string> = {
  pending: () => 'Order placed',
  paid: () => 'Payment received',
  failed: (order) => `Payment failed: ${order.error}`,
}

export function openOrderPage(order: Order): void {
  const main = document.querySelector<HTMLElement>('#main')!
  main.innerHTML = `<h1>Order ${order.id} <span id="status"></span></h1> <h2>History</h2> <ul id="history"></ul>`
  showStatus(order)
}

export function showStatus(order: Order): void {
  const chip = document.querySelector<HTMLElement>('#status')!
  chip.textContent = order.status
  chip.dataset.status = order.status
  addHistory(HISTORY[order.status](order))
}

export function watchOrder(id: number): void {
  const started = Date.now()
  const timer = setInterval(async () => {
    if (Date.now() - started > GIVE_UP_MS) {
      clearInterval(timer)
      addHistory('Still waiting for the payment. Reload this page later.')
      return
    }
    const res = await fetch(`${API}/orders/${id}`)
    const { order } = await res.json()
    if (order.status === 'pending') return

    clearInterval(timer)
    showStatus(order)
  }, POLL_MS)
}

function addHistory(text: string): void {
  const line = document.createElement('li')
  line.textContent = text
  document.querySelector('#history')!.append(line)
}
