import { getAdmin } from '@/lib/supabase/require-admin'
import { NextResponse } from 'next/server'

export async function GET() {
  try {
    const { error: denied, supabase } = await getAdmin()
    if (denied) return denied

    const columns = (extra: string) => `
        id, order_number, created_at, status, subtotal, shipping_cost, total,
        shipping_method, payment_method, shipping_address,
        tracking_number, carrier, tracking_photo_url, admin_note,
        shipped_at, delivered_at, user_id${extra},
        items:order_items(id, product_name, quantity, price, color, size, product_image)
      `
    const load = (extra: string) =>
      supabase.from('orders').select(columns(extra)).order('created_at', { ascending: false })

    let { data: orders, error } = await load(', payment_issue')
    // 42703 = columna inexistente (supabase-security-fix-4.sql aún no aplicado)
    if (error?.code === '42703') ({ data: orders, error } = await load(''))

    if (error) {
      console.error('[admin/orders] GET', { code: error.code })
      return NextResponse.json({ error: 'No se pudieron cargar los pedidos' }, { status: 500 })
    }

    return NextResponse.json({ orders: orders || [] })
  } catch (error) {
    console.error('[admin/orders] GET error', { msg: (error as Error).message })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// El cambio de estado se hace SOLO en /api/admin/orders/[id]/shipping,
// que aplica las transiciones permitidas y libera el stock al cancelar.
