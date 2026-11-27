import { after } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendOrderStatusEmail } from '@/lib/mail'
import type { WompiTransaction } from '@/lib/wompi'

export type ApplyResult = 'updated' | 'noop' | 'not_found' | 'mismatch' | 'flagged'

const ORDER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Sólo acepta transacciones obtenidas de la API de Wompi por el llamador.
 * Intento, pedido, stock y cupón se procesan bajo un único bloqueo en PostgreSQL.
 */
export async function applyWompiTransaction(tx: WompiTransaction): Promise<ApplyResult> {
  // Cobros de la cuenta Wompi que no son pedidos de la tienda (p. ej. links de pago del
  // panel con otra referencia): sin esto el cast a uuid falla y Wompi reintenta para siempre.
  if (typeof tx.reference !== 'string' || !ORDER_ID_RE.test(tx.reference)) return 'not_found'
  const db = createAdminClient()
  const { data, error } = await db.rpc('apply_wompi_transaction', {
    p_order_id: tx.reference,
    p_tx_id: tx.id,
    p_status: tx.status,
    p_amount: tx.amount_in_cents,
    p_currency: tx.currency,
    p_payment_ref: tx.payment_method?.extra?.external_identifier ?? null,
    p_created_at: tx.created_at,
    p_finalized_at: tx.finalized_at ?? null,
  })
  if (error) throw error
  const result = data as ApplyResult
  if (result === 'updated') schedulePaymentConfirmed(tx.reference)
  return result
}

/** Compartido por aprobación normal y recuperación. Sólo tras una transición real. */
export function schedulePaymentConfirmed(orderId: string) {
  after(async () => {
    const db = createAdminClient()
    const { data: order, error } = await db.from('orders')
      .select('id, order_number, status, subtotal, shipping_cost, total, user_id, guest_email, shipping_address, items:order_items(*)')
      .eq('id', orderId).maybeSingle()
    if (error) throw error
    if (!order || !['paid', 'processing', 'shipped', 'delivered'].includes(order.status)) return

    if (order.user_id) {
      const { error: notifErr } = await db.from('notifications').insert({
        user_id: order.user_id,
        order_id: order.id,
        type: 'order_update',
        title: '💰 Pago Confirmado',
        message: `¡Tu pago para el pedido #${order.order_number} fue aprobado con éxito!`,
      })
      if (notifErr) console.warn('[payments] notification insert', { orderId, code: notifErr.code })
    }
    const email = order.shipping_address?.email || order.guest_email
    if (email) {
      await sendOrderStatusEmail(email, order.order_number, 'paid',
        { adminNote: 'Pago aprobado por Wompi.' },
        { subtotal: order.subtotal, shipping_cost: order.shipping_cost, total: order.total, items: order.items },
      ).catch((e) => console.error('[payments] email error', { orderId, msg: (e as Error).message }))
    }
  })
}
