import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { getAdmin, UUID_RE } from '@/lib/supabase/require-admin'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { error: denied } = await getAdmin()
    if (denied) return denied

    const { id: orderId } = await params
    if (!UUID_RE.test(orderId)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

    const { data: history, error } = await createAdminClient()
      .from('notifications')
      .select('id, title, message, type, created_at')
      .eq('order_id', orderId)
      .order('created_at', { ascending: true })

    if (error) {
      console.error('[admin/orders/history]', { code: error.code })
      return NextResponse.json({ error: 'No se pudo cargar el historial' }, { status: 500 })
    }
    const { data: recoveries, error: recoveryError } = await createAdminClient()
      .from('order_payment_recoveries').select('id, transaction_id, admin_id, note, created_at')
      .eq('order_id', orderId).order('created_at')
    if (recoveryError) throw recoveryError
    const recoveryHistory = (recoveries || []).map(entry => ({
      id: entry.id, title: 'Pedido recuperado con pago verificado', created_at: entry.created_at,
      message: `Transacción ${entry.transaction_id}. Admin ${entry.admin_id}: ${entry.note}`,
    }))
    return NextResponse.json({ history: [...(history || []), ...recoveryHistory]
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)) })
  } catch (err) {
    console.error('[admin/orders/history] error', { msg: (err as Error).message })
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
