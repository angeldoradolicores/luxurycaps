export function paymentView(order: { status: string; paymentReview?: boolean; transactionStatus?: string }) {
  if (order.paymentReview) return 'review'
  if (['paid', 'processing', 'shipped', 'delivered'].includes(order.status)) return 'approved'
  if (order.status === 'cancelled') return 'cancelled'
  if (['DECLINED', 'ERROR', 'VOIDED'].includes(order.transactionStatus ?? '')) return 'failed'
  return 'pending'
}
