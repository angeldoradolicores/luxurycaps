import { after } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendOrderStatusEmail } from '@/lib/mail'
import type { WompiTransaction } from '@/lib/wompi'

export type ApplyResult = 'updated' | 'noop' | 'not_found' | 'mismatch'

const FAILED_STATUSES = new Set(['DECLINED', 'ERROR', 'VOIDED'])

/**
 * Único punto del sistema que puede marcar una orden como pagada o cancelada
 * a partir de una transacción de Wompi.
 *
 * - Exige que la transacción venga de la API de Wompi (el llamador la obtiene con getTransaction).
 * - Valida que monto y moneda coincidan EXACTAMENTE con la orden en BD.
 * - Transición atómica e idempotente: solo desde 'pending'.
 */
export async function applyWompiTransaction(tx: WompiTransaction): Promise<ApplyResult> {
  const db = createAdminClient()

  const { data: order, error } = await db
    .from('orders')
    .select('id, order_number, status, subtotal, shipping_cost, discount, total, user_id, guest_email, shipping_address, promo_code, items:order_items(*)')
    .eq('id', tx.reference)
    .maybeSingle()

  if (error) throw error
  if (!order) return 'not_found'

  const expectedCents = Math.round(Number(order.total) * 100)
  if (tx.currency !== 'COP' || Number(tx.amount_in_cents) !== expectedCents) {
    console.error('[payments] Monto/moneda no coincide — revisión manual', {
      orderId: order.id,
      txId: tx.id,
      expectedCents,
      got: tx.amount_in_cents,
      currency: tx.currency,
    })
    // Un APPROVED con otro monto/moneda no paga el pedido, pero el admin debe verlo (posible reembolso)
    if (tx.status === 'APPROVED') {
      const { error: flagErr } = await db
        .from('orders')
        .update({
          payment_issue: `Wompi aprobó la transacción ${tx.id} por ${tx.amount_in_cents} ${tx.currency} (centavos), pero el pedido es de ${expectedCents} COP. NO se marcó como pagado: revisa y reembolsa.`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', order.id)
        .is('payment_issue', null)
      if (flagErr) throw flagErr
    }
    return 'mismatch'
  }

  const target: 'paid' | 'cancelled' | null =
    tx.status === 'APPROVED' ? 'paid' : FAILED_STATUSES.has(tx.status) ? 'cancelled' : null
  if (!target) return 'noop' // PENDING: todavía no hay nada que hacer

  // Cambio de estado + stock/cupón en UNA transacción de BD (supabase-security-fix-5.sql).
  // Si falla, se lanza el error → el webhook responde 500 → Wompi reintenta sin duplicar efectos.
  if (target === 'paid') {
    const { data: result, error: rpcErr } = await db.rpc('mark_order_paid', {
      p_order_id: order.id,
      p_tx_id: tx.id,
      p_payment_ref: tx.payment_method?.extra?.external_identifier ?? null,
    })
    if (rpcErr) throw rpcErr
    if (result === 'flagged') {
      console.error('[payments] Pago aprobado sobre pedido cancelado o pago duplicado — marcado en payment_issue', {
        orderId: order.id,
        txId: tx.id,
      })
    }
    if (result !== 'updated') return 'noop'
  } else {
    // Pendiente → cancelar y devolver stock. Pago ya aprobado y luego ANULADO → alerta + despacho bloqueado.
    // Un fallo de OTRO intento nunca invalida un pago válido (supabase-security-fix-6.sql).
    const { data: failureResult, error: rpcErr } = await db.rpc('apply_failed_wompi_transaction', {
      p_order_id: order.id,
      p_tx_id: tx.id,
      p_status: tx.status,
    })
    if (rpcErr) throw rpcErr
    if (failureResult === 'flagged') {
      console.error('[payments] Transacción anulada sobre pedido pagado: despacho bloqueado; revisar payment_issue', {
        orderId: order.id,
        txId: tx.id,
      })
    }
    if (failureResult !== 'updated') return 'noop' // evento duplicado, otro intento o ya resuelto
  }

  // Efectos secundarios después de responder (after() evita que se corten en serverless)
  after(async () => {
    const paid = target === 'paid'

    if (order.user_id) {
      const { error: notifErr } = await db.from('notifications').insert({
        user_id: order.user_id,
        order_id: order.id,
        type: 'order_update',
        title: paid ? '💰 Pago Confirmado' : '❌ Pago Cancelado/Rechazado',
        message: paid
          ? `¡Tu pago para el pedido #${order.order_number} fue aprobado con éxito! Estamos preparando tu envío.`
          : `El pago para tu pedido #${order.order_number} fue declinado o cancelado.`,
      })
      if (notifErr) console.warn('[payments] notification insert', { orderId: order.id, code: notifErr.code })
    }

    const email = order.shipping_address?.email || order.guest_email
    if (email) {
      await sendOrderStatusEmail(
        email,
        order.order_number,
        target,
        { adminNote: paid ? 'Pago aprobado por Wompi.' : 'Transacción de pago rechazada o cancelada en Wompi.' },
        {
          subtotal: order.subtotal,
          shipping_cost: order.shipping_cost,
          total: order.total,
          items: order.items,
        },
      ).catch((e) => console.error('[payments] email error', { orderId: order.id, msg: (e as Error).message }))
    }
  })

  return 'updated'
}
