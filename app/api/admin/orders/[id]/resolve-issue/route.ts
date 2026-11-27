import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { getAdmin, UUID_RE } from '@/lib/supabase/require-admin'

/**
 * Marca como resuelta la alerta de pago de un pedido (reembolso hecho, conciliado con Wompi, etc.).
 * La alerta se mueve al historial (payment_issue_resolved) con la nota del admin y la fecha.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { error: denied, user } = await getAdmin()
    if (denied) return denied

    const { id: orderId } = await params
    if (!UUID_RE.test(orderId)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

    const body = await request.json().catch(() => null)
    const note = typeof body?.note === 'string' ? body.note.trim() : ''
    if (note.length < 5 || note.length > 500) {
      return NextResponse.json(
        { error: 'Describe cómo se resolvió (entre 5 y 500 caracteres), por ejemplo: "Reembolsado en Wompi el 21/11".' },
        { status: 400 }
      )
    }

    const db = createAdminClient()
    const { data: order } = await db
      .from('orders')
      .select('payment_issue, payment_issue_resolved')
      .eq('id', orderId)
      .maybeSingle()
    if (!order) return NextResponse.json({ error: 'Orden no encontrada' }, { status: 404 })
    if (!order.payment_issue) return NextResponse.json({ error: 'Este pedido no tiene una alerta activa' }, { status: 409 })

    const { data: updated, error } = await db.rpc('resolve_order_payment_issue', {
      p_order_id: orderId, p_admin_id: user.id, p_note: note,
      p_expected_issue: order.payment_issue,
    })

    if (error) {
      console.error('[admin/resolve-issue]', { orderId, code: error.code })
      return NextResponse.json({ error: 'No se pudo resolver la alerta' }, { status: 500 })
    }
    if (!updated) {
      return NextResponse.json({ error: 'La alerta cambió mientras la revisabas, recarga e intenta de nuevo' }, { status: 409 })
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[admin/resolve-issue] error', { msg: (error as Error).message })
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
