import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getTransaction } from '@/lib/wompi'
import { applyWompiTransaction } from '@/lib/payments'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Solo campos no sensibles: nada de dirección, teléfono ni email
const PUBLIC_FIELDS =
  'id, order_number, status, subtotal, shipping_cost, discount, total, shipping_method, created_at, wompi_transaction_id, items:order_items(product_name, product_image, price, quantity, color, size)'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ reference: string }> }
) {
  try {
    const { reference } = await params
    // Solo UUID (no enumerable). La búsqueda por order_number exige email en /api/orders/track
    if (!UUID.test(reference)) {
      return NextResponse.json({ error: 'Orden no encontrada' }, { status: 404 })
    }

    const db = createAdminClient()
    const load = () => db.from('orders').select(PUBLIC_FIELDS).eq('id', reference).maybeSingle()

    let { data: order } = await load()
    if (!order) {
      return NextResponse.json({ error: 'Orden no encontrada' }, { status: 404 })
    }

    let transactionStatus: string | undefined
    let transactionMessage: string | undefined
    const wompiIdParam = new URL(request.url).searchParams.get('wompi_id')?.trim()
    const txId = wompiIdParam || order.wompi_transaction_id

    // Verificación activa contra la API de Wompi (fallback si el webhook no ha llegado)
    if (order.status === 'pending' && txId) {
      try {
        const tx = await getTransaction(txId)
        // La transacción debe pertenecer a ESTA orden; el monto lo valida applyWompiTransaction
        if (tx.reference === order.id) {
          transactionStatus = tx.status
          transactionMessage = tx.status_message
          const result = await applyWompiTransaction(tx)
          if (result === 'updated') {
            ;({ data: order } = await load())
          }
        } else {
          console.warn('[orders/reference] wompi_id no corresponde a la orden', { orderId: reference })
        }
      } catch (err) {
        console.warn('[orders/reference] No se pudo verificar con Wompi', {
          orderId: reference,
          msg: (err as Error).message,
        })
      }
    }

    const { wompi_transaction_id: _omit, ...publicOrder } = order!
    return NextResponse.json({ ...publicOrder, transactionStatus, transactionMessage })
  } catch (error) {
    console.error('[orders/reference] Error', { msg: (error as Error).message })
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}
