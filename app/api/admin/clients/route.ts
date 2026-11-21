import { getAdmin } from '@/lib/supabase/require-admin'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'

export async function GET() {
  try {
    const { error: denied } = await getAdmin()
    if (denied) return denied

    const supabaseAdmin = createAdminClient()

    // Get all profiles
    const { data: profiles, error } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, email, phone, created_at, is_admin')
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[admin/clients]', { code: error.code })
      return NextResponse.json({ error: 'No se pudieron cargar los clientes' }, { status: 500 })
    }

    // Get orders summary per user
    const { data: orders } = await supabaseAdmin
      .from('orders')
      .select('user_id, total, created_at, status')
      .not('user_id', 'is', null)

    // Build per-customer stats
    const orderMap = new Map<string, { count: number; spent: number; last: string }>()
    orders?.forEach(o => {
      if (!o.user_id) return
      const existing = orderMap.get(o.user_id) || { count: 0, spent: 0, last: '' }
      existing.count += 1
      if (o.status !== 'cancelled') existing.spent += o.total || 0
      if (!existing.last || o.created_at > existing.last) existing.last = o.created_at
      orderMap.set(o.user_id, existing)
    })

    const customers = (profiles || []).map(p => ({
      ...p,
      total_orders: orderMap.get(p.id)?.count || 0,
      total_spent: orderMap.get(p.id)?.spent || 0,
      last_order_at: orderMap.get(p.id)?.last || null,
    }))

    return NextResponse.json({ customers })
  } catch (error) {
    console.error('[admin/clients] error', { msg: (error as Error).message })
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
