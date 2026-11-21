import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { sendOrderStatusEmail } from '@/lib/mail'
import { requireAdmin, ADMIN_ASSIGNABLE_STATUSES, UUID_RE } from '@/lib/supabase/require-admin'

// Transiciones válidas para un admin. 'paid' solo lo asigna Wompi (lib/payments.ts)
const TRANSITIONS: Record<string, string[]> = {
  pending: ['cancelled'],
  paid: ['processing', 'shipped', 'delivered', 'cancelled'],
  processing: ['shipped', 'delivered', 'cancelled'],
  shipped: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
}
// Si se cancela antes de despachar, el inventario reservado vuelve a estar disponible
const RELEASE_STOCK_FROM = ['pending', 'paid', 'processing']

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const denied = await requireAdmin()
    if (denied) return denied

    const { id: orderId } = await params
    const body = await request.json()
    const { status, tracking_number, carrier, tracking_photo_url, admin_note } = body

    if (!UUID_RE.test(orderId)) {
      return NextResponse.json({ error: 'ID de orden requerido' }, { status: 400 })
    }

    // La foto de la guía se muestra al cliente: sólo enlaces https (nada de javascript:, data:, etc.)
    if (typeof tracking_photo_url === 'string' && tracking_photo_url !== '' && !/^https:\/\/[^\s"'<>]+$/i.test(tracking_photo_url)) {
      return NextResponse.json({ error: 'La URL de la foto de la guía debe empezar por https://' }, { status: 400 })
    }

    for (const [field, value, max] of [
      ['tracking_number', tracking_number, 100],
      ['carrier', carrier, 100],
      ['tracking_photo_url', tracking_photo_url, 1000],
      ['admin_note', admin_note, 1000],
    ] as const) {
      if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > max)) {
        return NextResponse.json({ error: `Campo inválido: ${field}` }, { status: 400 })
      }
    }

    const supabaseAdmin = createAdminClient()

    const { data: current, error: currentError } = await supabaseAdmin
      .from('orders')
      .select('status')
      .eq('id', orderId)
      .maybeSingle()
    if (currentError || !current) {
      return NextResponse.json({ error: 'Orden no encontrada' }, { status: 404 })
    }

    // Si el formulario reenvía el estado actual, no es un cambio de estado
    const statusChange: string | null = status && status !== current.status ? status : null
    if (statusChange) {
      const allowedNext = TRANSITIONS[current.status] ?? []
      if (!(ADMIN_ASSIGNABLE_STATUSES as readonly string[]).includes(statusChange) || !allowedNext.includes(statusChange)) {
        return NextResponse.json(
          { error: `No se puede pasar de "${current.status}" a "${statusChange}"` },
          { status: 400 }
        )
      }
    }

    // Cancelar = cambio de estado + devolución de stock en UNA transacción (cancel_order).
    // Si falla, no cambia nada y no se suma stock (antes cada reintento fallido inflaba el inventario).
    if (statusChange === 'cancelled') {
      const { data: cancelled, error: cancelErr } = await supabaseAdmin.rpc('cancel_order', {
        p_order_id: orderId,
        p_from: [current.status],
        p_release: RELEASE_STOCK_FROM.includes(current.status),
      })
      if (cancelErr) {
        console.error('[shipping] cancel_order', { orderId, code: cancelErr.code })
        return NextResponse.json({ error: 'Error al cancelar la orden' }, { status: 500 })
      }
      if (cancelled !== true) {
        return NextResponse.json({ error: 'La orden cambió mientras la editabas, recarga e intenta de nuevo' }, { status: 409 })
      }
    }

    // Build update object (el estado "cancelled" ya quedó aplicado arriba)
    const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (statusChange && statusChange !== 'cancelled') updateData.status = statusChange
    if (tracking_number !== undefined) updateData.tracking_number = tracking_number
    if (carrier !== undefined) updateData.carrier = carrier
    if (tracking_photo_url !== undefined) updateData.tracking_photo_url = tracking_photo_url
    if (admin_note !== undefined) updateData.admin_note = admin_note
    if (statusChange === 'shipped') updateData.shipped_at = new Date().toISOString()
    if (statusChange === 'delivered') updateData.delivered_at = new Date().toISOString()

    // Update condicional al estado esperado (evita carreras con el webhook)
    const expectedStatus = statusChange === 'cancelled' ? 'cancelled' : current.status
    const { data: order, error: orderError } = await supabaseAdmin
      .from('orders')
      .update(updateData)
      .eq('id', orderId)
      .eq('status', expectedStatus)
      .select('*, items:order_items(*)')
      .maybeSingle()

    if (orderError) {
      console.error('[shipping] Order update error', { orderId, code: orderError.code })
      return NextResponse.json({ error: 'Error al actualizar la orden' }, { status: 500 })
    }
    if (!order) {
      return NextResponse.json({ error: 'La orden cambió mientras la editabas, recarga e intenta de nuevo' }, { status: 409 })
    }

    // Create notification for the customer if they have a user_id
    if (order.user_id && statusChange) {
      const notificationMap: Record<string, { title: string; message: string; type: string }> = {
        processing: {
          title: '🛍️ Tu pedido está siendo preparado',
          message: `Tu pedido #${order.order_number} está siendo procesado. Te notificaremos cuando sea enviado.`,
          type: 'order_update',
        },
        shipped: {
          title: '🚚 ¡Tu pedido fue enviado!',
          message: `Tu pedido #${order.order_number} ya está en camino${carrier ? ` con ${carrier}` : ''}${tracking_number ? `. Número de guía: ${tracking_number}` : ''}.${admin_note ? ` Nota: ${admin_note}` : ''}`,
          type: 'shipped',
        },
        delivered: {
          title: '✅ ¡Tu pedido fue entregado!',
          message: `Tu pedido #${order.order_number} ha sido entregado. ¡Gracias por tu compra en Urban Crown!`,
          type: 'delivered',
        },
        cancelled: {
          title: '❌ Tu pedido fue cancelado',
          message: `Tu pedido #${order.order_number} ha sido cancelado.${admin_note ? ` Razón: ${admin_note}` : ' Si tienes dudas, contáctanos.'}`,
          type: 'order_update',
        },
      }

      const notification = notificationMap[statusChange]
      if (notification) {
        const { error: notifError } = await supabaseAdmin
          .from('notifications')
          .insert({
            user_id: order.user_id,
            order_id: orderId,
            title: notification.title,
            message: notification.message,
            type: notification.type,
          })

        if (notifError) {
          console.warn('[shipping] Notification insert warning:', notifError.message)
        }
      }
    }

    // Send email notification to customer
    const customerEmail = order.shipping_address?.email || order.guest_email
    if (customerEmail && status) {
      // Async send email so it doesn't block the API response
      sendOrderStatusEmail(
        customerEmail,
        order.order_number,
        order.status,
        {
          carrier: order.carrier,
          trackingNumber: order.tracking_number,
          trackingPhotoUrl: order.tracking_photo_url,
          adminNote: order.admin_note,
        },
        {
          subtotal: order.subtotal,
          shipping_cost: order.shipping_cost,
          total: order.total,
          items: order.items,
        }
      ).catch((err) => console.error('[shipping-api] Async email error:', err))
    }

    return NextResponse.json({ success: true, order })
  } catch (error) {
    console.error('[shipping] API error', { msg: (error as Error).message })
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}
