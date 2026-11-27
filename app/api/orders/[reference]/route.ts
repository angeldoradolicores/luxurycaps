import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getTransaction, generateWompiSignature } from '@/lib/wompi'
import { applyWompiTransaction } from '@/lib/payments'
import { limitByIp } from '@/lib/rate-limit'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Solo campos no sensibles: nada de dirección, teléfono ni email
const PUBLIC_FIELDS =
  'id, order_number, status, subtotal, shipping_cost, discount, total, shipping_method, created_at, wompi_transaction_id, payment_issue, items:order_items(product_name, product_image, price, quantity, color, size)'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ reference: string }> }
) {
  try {
    // La confirmación hace polling cada 3 s durante ~2 min (≈40 peticiones)
    const limited = await limitByIp(request, 'orders:reference:ip', 120, 600)
    if (limited) return limited

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
    if (['pending', 'cancelled'].includes(order.status) && txId) {
      try {
        const tx = await getTransaction(txId)
        // La transacción debe pertenecer a ESTA orden; el monto lo valida applyWompiTransaction
        if (tx.reference === order.id) {
          transactionStatus = tx.status
          transactionMessage = tx.status_message
          const result = await applyWompiTransaction(tx)
          if (result === 'updated' || result === 'flagged') {
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

    if (!order) return NextResponse.json({ error: 'Orden no encontrada' }, { status: 404 })
    const { data: latest, error: attemptError } = await db.from('order_payment_attempts')
      .select('transaction_id, status').eq('order_id', reference)
      .order('created_at', { ascending: false }).order('transaction_id', { ascending: false }).limit(1).maybeSingle()
    if (attemptError) throw attemptError
    if (latest) {
      transactionStatus = latest.status
      if (latest.transaction_id !== txId) transactionMessage = undefined
    }

    // Reintenta sobre el MISMO pedido y dentro de la vigencia original del enlace.
    let retryCheckoutUrl: string | undefined
    const expiresAt = new Date(Date.parse(order.created_at) + 90 * 60 * 1000)
    const publicKey = process.env.NEXT_PUBLIC_WOMPI_PUBLIC_KEY
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')
    if (order.status === 'pending' && !order.payment_issue && ['DECLINED', 'ERROR', 'VOIDED'].includes(transactionStatus ?? '')
        && expiresAt.getTime() > Date.now() && publicKey && siteUrl && process.env.WOMPI_INTEGRITY_KEY) {
      const amount = Math.round(Number(order.total) * 100)
      const query = new URLSearchParams({
        'public-key': publicKey, currency: 'COP', 'amount-in-cents': String(amount), reference,
        'signature:integrity': generateWompiSignature(reference, amount, 'COP', expiresAt.toISOString()),
        'expiration-time': expiresAt.toISOString(), 'redirect-url': `${siteUrl}/checkout/confirmacion?ref=${reference}`,
      })
      retryCheckoutUrl = `https://checkout.wompi.co/p/?${query}`
    }
    const { wompi_transaction_id: _omit, payment_issue, ...publicOrder } = order
    return NextResponse.json({ ...publicOrder, paymentReview: Boolean(payment_issue), transactionStatus, transactionMessage, retryCheckoutUrl })
  } catch (error) {
    console.error('[orders/reference] Error', { msg: (error as Error).message })
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}
