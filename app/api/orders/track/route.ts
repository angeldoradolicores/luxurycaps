import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { limitByIp } from '@/lib/rate-limit'

export async function GET(request: Request) {
  try {
    // Polling de invitados: 1 cada 30 s (≈20/10 min) + búsquedas manuales
    const limited = await limitByIp(request, 'orders:track:ip', 40, 600)
    if (limited) return limited

    const { searchParams } = new URL(request.url)
    const orderNumber = searchParams.get('order_number')?.trim()
    const email = searchParams.get('email')?.trim().toLowerCase()

    if (!orderNumber || !email) {
      return NextResponse.json(
        { error: 'Número de pedido y correo electrónico son requeridos' },
        { status: 400 }
      )
    }

    const supabaseAdmin = createAdminClient()

    // Fetch order details with products
    const { data: order, error } = await supabaseAdmin
      .from('orders')
      .select('id, order_number, user_id, guest_email, shipping_address, created_at, status, total, subtotal, shipping_cost, discount, shipping_method, tracking_number, carrier, tracking_photo_url, admin_note, shipped_at, delivered_at, items:order_items(product_name, product_image, price, quantity, color, size)')
      .eq('order_number', orderNumber)
      .maybeSingle()

    if (error) {
      console.error('[track-api] Database error', { code: error.code })
      return NextResponse.json({ error: 'Error al buscar el pedido' }, { status: 500 })
    }

    if (!order) {
      return NextResponse.json(
        { error: 'Pedido no encontrado. Verifica el número de pedido y correo.' },
        { status: 404 }
      )
    }

    // Security Verification: Check if the provided email matches guest_email, shipping_address.email, or the user's profile email
    const guestEmail = order.guest_email?.toLowerCase()
    const shippingEmail = order.shipping_address?.email?.toLowerCase()

    let matches = false

    if (guestEmail === email || shippingEmail === email) {
      matches = true
    }

    // If the order has a user_id, check the profile email as well
    if (!matches && order.user_id) {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('email')
        .eq('id', order.user_id)
        .maybeSingle()

      if (profile && profile.email?.toLowerCase() === email) {
        matches = true
      }
    }

    if (!matches) {
      // Return 404 (instead of 403) to prevent order enumeration attacks
      return NextResponse.json(
        { error: 'Pedido no encontrado. Verifica el número de pedido y correo.' },
        { status: 404 }
      )
    }

    const { user_id: _userId, guest_email: _guestEmail, shipping_address: _address, ...customerOrder } = order
    return NextResponse.json({ order: customerOrder })
  } catch (error) {
    console.error('[track-api] Server error:', error)
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}
