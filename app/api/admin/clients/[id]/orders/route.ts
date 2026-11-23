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

    const { id: clientId } = await params
    if (!UUID_RE.test(clientId)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

    const { data: orders, error } = await createAdminClient()
      .from('orders')
      .select('id, order_number, created_at, total, status, tracking_number, carrier, shipping_address')
      .eq('user_id', clientId)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[admin/clients/:id/orders]', { code: error.code })
      return NextResponse.json({ error: 'No se pudieron cargar los pedidos' }, { status: 500 })
    }
    return NextResponse.json({ orders: orders || [] })
  } catch (error) {
    console.error('[admin/clients/:id/orders] error', { msg: (error as Error).message })
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
