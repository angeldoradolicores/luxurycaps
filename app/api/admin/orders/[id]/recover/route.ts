import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getAdmin, UUID_RE } from '@/lib/supabase/require-admin'
import { getTransaction } from '@/lib/wompi'
import { schedulePaymentConfirmed } from '@/lib/payments'

const RECOVERY_ERRORS: Record<string, string> = {
  ORDER_CHANGED: 'El pedido cambió durante la revisión. Recarga antes de intentarlo de nuevo.',
  ORDER_ALREADY_DISPATCHED: 'Este pedido ya tuvo un despacho. Requiere conciliación manual.',
  PAYMENT_NOT_RECOVERABLE: 'Este pago fue anulado o su alerta ya se cerró. Requiere conciliación manual.',
  PAYMENT_MISMATCH: 'El monto o la moneda no coincide con el pedido.',
  OTHER_PAYMENT_ISSUES: 'Hay otros cobros o alertas pendientes. Concilia esos pagos antes de recuperar el pedido.',
  LEGACY_CANCELLATION_UNKNOWN: 'No se pudo verificar cómo se canceló este pedido antiguo. Requiere conciliación manual.',
  STOCK_RELEASE_UNKNOWN: 'No se pudo verificar la devolución del inventario. Requiere revisión manual.',
  ORDER_ITEMS_UNAVAILABLE: 'Uno de los productos del pedido ya no está disponible.',
  OUT_OF_STOCK: 'No hay existencias suficientes. El pedido sigue cancelado y el inventario no se modificó.',
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { error: denied, user } = await getAdmin()
    if (denied) return denied
    const { id } = await params
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
    const body = await request.json().catch(() => null)
    const txId = typeof body?.transactionId === 'string' ? body.transactionId.trim() : ''
    const note = typeof body?.note === 'string' ? body.note.trim() : ''
    if (!/^[\w-]{5,64}$/.test(txId) || note.length < 5 || note.length > 500 || body?.confirmNotRefunded !== true) {
      return NextResponse.json({ error: 'Indica la transacción, el motivo y confirma que el pago no fue reembolsado ni tiene un reembolso en trámite.' }, { status: 400 })
    }
    const db = createAdminClient()
    const { data: order, error: readError } = await db.from('orders')
      .select('id, status, total, updated_at, cancelled_from, wompi_transaction_id, shipped_at, delivered_at')
      .eq('id', id).maybeSingle()
    if (readError) throw readError
    if (!order) return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 })
    if (order.status !== 'cancelled') return NextResponse.json({ error: 'Sólo se pueden recuperar pedidos cancelados.' }, { status: 409 })
    if (order.shipped_at || order.delivered_at) {
      return NextResponse.json({ error: RECOVERY_ERRORS.ORDER_ALREADY_DISPATCHED }, { status: 409 })
    }

    let tx
    let legacyFailedTxId: string | null = null
    try {
      tx = await getTransaction(txId)
      if (tx.id !== txId || tx.reference !== id || tx.status !== 'APPROVED' || tx.currency !== 'COP'
          || tx.amount_in_cents !== Math.round(Number(order.total) * 100)) {
        return NextResponse.json({ error: 'Wompi debe confirmar un pago aprobado para este pedido, por el monto exacto en COP.' }, { status: 409 })
      }
      if (order.cancelled_from === null) {
        if (!order.wompi_transaction_id || order.wompi_transaction_id === txId) {
          return NextResponse.json({ error: RECOVERY_ERRORS.LEGACY_CANCELLATION_UNKNOWN }, { status: 409 })
        }
        const previous = await getTransaction(order.wompi_transaction_id)
        if (previous.id !== order.wompi_transaction_id || previous.reference !== id
            || !['DECLINED', 'ERROR'].includes(previous.status)) {
          return NextResponse.json({ error: RECOVERY_ERRORS.LEGACY_CANCELLATION_UNKNOWN }, { status: 409 })
        }
        legacyFailedTxId = previous.id
      }
    } catch {
      return NextResponse.json({ error: 'No se pudo verificar el pago en Wompi. No se modificó el pedido; intenta de nuevo.' }, { status: 502 })
    }

    const { error, data } = await db.rpc('recover_cancelled_order', {
      p_order_id: id, p_tx_id: tx.id, p_amount: tx.amount_in_cents, p_currency: tx.currency,
      p_payment_ref: tx.payment_method?.extra?.external_identifier ?? null,
      p_admin_id: user.id, p_note: note, p_expected_updated_at: order.updated_at,
      p_legacy_failed_tx_id: legacyFailedTxId,
    })
    if (error) {
      const known = Object.keys(RECOVERY_ERRORS).find(code => error.message.includes(code))
      if (known) return NextResponse.json({ error: RECOVERY_ERRORS[known] }, { status: 409 })
      throw error
    }
    if (data !== 'updated') throw new Error('Unexpected recovery result')
    schedulePaymentConfirmed(id)
    return NextResponse.json({ success: true, status: 'paid' })
  } catch (error) {
    console.error('[admin/recover]', { message: (error as Error).message })
    return NextResponse.json({ error: 'No se pudo recuperar el pedido.' }, { status: 500 })
  }
}
