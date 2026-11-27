// Recuperar un cancelado exige la acción dedicada que verifica pago e inventario.
export const ORDER_TRANSITIONS: Record<string, readonly string[]> = {
  pending: ['cancelled'],
  paid: ['processing', 'shipped', 'delivered', 'cancelled'],
  processing: ['shipped', 'delivered', 'cancelled'],
  shipped: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
}

export function allowedOrderTransitions(status: string, paymentIssue?: string | null) {
  return (ORDER_TRANSITIONS[status] ?? []).filter(next =>
    !paymentIssue || !['processing', 'shipped', 'delivered'].includes(next))
}
