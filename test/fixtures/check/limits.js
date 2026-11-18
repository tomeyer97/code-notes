// Orders per customer per hour.
const counts = new Map()

export function allow(customer, now = Date.now()) {
  const c = counts.get(customer)
  if (!c || now - c.since > 3600_000) { counts.set(customer, { since: now, n: 1 }); return true }
  return ++c.n <= 5
}

// One count per customer: a customer splitting a big cart into orders is still one customer.
export function reset(customer) {
  counts.delete(customer)
}
export const LIMIT_0 = 0
export const LIMIT_1 = 1
export const LIMIT_2 = 2
export const LIMIT_3 = 3
export const LIMIT_4 = 4
export const LIMIT_5 = 5
export const LIMIT_6 = 6
export const LIMIT_7 = 7
export const LIMIT_8 = 8
export const LIMIT_9 = 9
export const LIMIT_10 = 10
export const LIMIT_11 = 11
export const LIMIT_12 = 12
export const LIMIT_13 = 13
export const LIMIT_14 = 14
export const LIMIT_15 = 15
export const LIMIT_16 = 16
export const LIMIT_17 = 17
export const LIMIT_18 = 18
export const LIMIT_19 = 19
export const LIMIT_20 = 20
export const LIMIT_21 = 21
export const LIMIT_22 = 22
export const LIMIT_23 = 23
export const LIMIT_24 = 24
export const LIMIT_25 = 25
export const LIMIT_26 = 26
export const LIMIT_27 = 27
export const LIMIT_28 = 28
export const LIMIT_29 = 29
export const LIMIT_30 = 30
export const LIMIT_31 = 31
export const LIMIT_32 = 32
export const LIMIT_33 = 33
export const LIMIT_34 = 34
export const LIMIT_35 = 35
export const LIMIT_36 = 36
export const LIMIT_37 = 37
export const LIMIT_38 = 38
export const LIMIT_39 = 39
export const LIMIT_40 = 40
export const LIMIT_41 = 41
export const LIMIT_42 = 42
export const LIMIT_43 = 43
export const LIMIT_44 = 44
export const LIMIT_45 = 45
export const LIMIT_46 = 46
export const LIMIT_47 = 47
export const LIMIT_48 = 48
export const LIMIT_49 = 49
export const LIMIT_50 = 50
export const LIMIT_51 = 51
