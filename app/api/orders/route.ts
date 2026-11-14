import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { generateWompiSignature } from '@/lib/wompi'
import crypto from 'crypto'
import { z } from 'zod'

const SHIPPING_RATES = { interrapidisimo: 17000, recoger: 0 } as const

const OrderSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().min(1).max(20),
        color: z.string().max(40).optional().nullable(),
        size: z.string().max(10).optional().nullable(),
      })
    )
    .min(1)
    .max(30),
  shippingMethod: z.enum(['interrapidisimo', 'recoger']),
  promoCode: z.string().trim().max(40).optional().nullable(),
  paymentMethod: z.string().max(20).optional(),
  shippingInfo: z.object({
    name: z.string().trim().min(2).max(120),
    phone: z.string().trim().regex(/^[0-9+ ]{7,15}$/),
    email: z.string().trim().toLowerCase().email().max(160),
    address: z.string().trim().min(5).max(250),
    city: z.string().trim().min(1).max(80),
    state: z.string().trim().min(1).max(80),
    postalCode: z.string().trim().max(10).optional(),
    notes: z.string().max(500).optional(),
  }),
})

export async function POST(request: Request) {
  try {
    const parsed = OrderSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json({ error: 'Datos del pedido inválidos' }, { status: 400 })
    }
    const { items, shippingInfo, shippingMethod, promoCode } = parsed.data

    const wompiPublicKey = process.env.NEXT_PUBLIC_WOMPI_PUBLIC_KEY
    const siteUrl =
      process.env.NEXT_PUBLIC_SITE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')
    if (
      !process.env.NEXT_PUBLIC_SUPABASE_URL ||
      !process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !wompiPublicKey ||
      !process.env.WOMPI_INTEGRITY_KEY ||
      !siteUrl
    ) {
      console.error('[orders] Configuración de pagos incompleta')
      return NextResponse.json({ error: 'Los pagos no están disponibles temporalmente' }, { status: 503 })
    }

    const supabase = await createClient()
    const db = createAdminClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    // 1) Precios SIEMPRE desde la base de datos
    const ids = [...new Set(items.map((i) => i.productId))]
    const { data: products, error: pErr } = await db
      .from('products')
      .select('id, name, price, images')
      .in('id', ids)
    if (pErr) {
      console.error('[orders] products lookup', { code: pErr.code })
      return NextResponse.json({ error: 'No pudimos verificar los productos, intenta de nuevo' }, { status: 503 })
    }
    const byId = new Map((products ?? []).map((p: any) => [p.id, p]))
    if (byId.size !== ids.length) {
      return NextResponse.json({ error: 'Algún producto ya no está disponible' }, { status: 400 })
    }

    const lines = items.map((i) => {
      const p: any = byId.get(i.productId)
      return {
        product_id: p.id as string,
        product_name: p.name as string,
        product_image: (p.images?.[0] as string) ?? '',
        price: Number(p.price),
        quantity: i.quantity,
        color: i.color ?? '',
        size: i.size ?? '',
      }
    })
    const subtotal = lines.reduce((s, l) => s + l.price * l.quantity, 0)
    const shippingCost = SHIPPING_RATES[shippingMethod]

    // 2) Cupón validado en servidor
    let discount = 0
    let appliedCode: string | null = null
    if (promoCode) {
      const code = promoCode.toUpperCase()
      const { data: promo } = await db
        .from('promotions')
        .select('code, discount_type, discount_value, min_purchase, max_uses, used_count, start_date, end_date')
        .eq('code', code)
        .eq('active', true)
        .maybeSingle()
      const now = Date.now()
      const valid =
        !!promo &&
        (!promo.start_date || new Date(promo.start_date).getTime() <= now) &&
        (!promo.end_date || new Date(promo.end_date).getTime() >= now) &&
        (!promo.max_uses || (promo.used_count ?? 0) < promo.max_uses) &&
        (!promo.min_purchase || subtotal >= promo.min_purchase)
      if (!valid) {
        return NextResponse.json({ error: 'Código de descuento no válido' }, { status: 400 })
      }
      discount =
        promo!.discount_type === 'percentage'
          ? Math.round((subtotal * promo!.discount_value) / 100)
          : promo!.discount_value
      discount = Math.min(Math.max(discount, 0), subtotal)
      appliedCode = promo!.code
    }

    const total = subtotal + shippingCost - discount
    if (total <= 0) {
      return NextResponse.json({ error: 'Total inválido' }, { status: 400 })
    }

    // 3) Crear orden + ítems
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const orderNumber = `LH-${dateStr}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`

    const { data: order, error: orderError } = await db
      .from('orders')
      .insert({
        order_number: orderNumber,
        user_id: user?.id ?? null,
        guest_email: user ? null : shippingInfo.email,
        status: 'pending',
        subtotal,
        shipping_cost: shippingCost,
        discount,
        promo_code: appliedCode,
        total,
        shipping_method: shippingMethod,
        shipping_address: {
          name: shippingInfo.name,
          phone: shippingInfo.phone,
          email: shippingInfo.email,
          address: shippingInfo.address,
          city: shippingInfo.city,
          state: shippingInfo.state,
          postal_code: shippingInfo.postalCode || '',
          country: 'Colombia',
        },
        payment_method: 'wompi',
        notes: shippingInfo.notes || '',
      })
      .select('id')
      .single()

    if (orderError || !order) {
      console.error('[orders] insert order', { code: orderError?.code, msg: orderError?.message })
      return NextResponse.json({ error: 'No pudimos crear tu pedido, intenta de nuevo' }, { status: 500 })
    }

    const { error: itemsError } = await db
      .from('order_items')
      .insert(lines.map((l) => ({ ...l, order_id: order.id })))
    if (itemsError) {
      await db.from('orders').delete().eq('id', order.id)
      console.error('[orders] insert items', { code: itemsError.code })
      return NextResponse.json({ error: 'No pudimos crear tu pedido, intenta de nuevo' }, { status: 500 })
    }

    // 4) Reserva de stock atómica (una sola transacción en Postgres)
    const { error: stockError } = await db.rpc('reserve_stock', {
      p_items: lines.map((l) => ({ product_id: l.product_id, quantity: l.quantity })),
    })
    if (stockError) {
      await db.from('orders').update({ status: 'cancelled' }).eq('id', order.id)
      const outOfStock = stockError.message?.includes('OUT_OF_STOCK')
      if (!outOfStock) console.error('[orders] reserve_stock', { code: stockError.code, msg: stockError.message })
      return NextResponse.json(
        {
          error: outOfStock
            ? 'Uno de los productos se agotó. Revisa tu carrito.'
            : 'No pudimos reservar el inventario, intenta de nuevo',
        },
        { status: outOfStock ? 409 : 503 }
      )
    }

    // 5) Firma de integridad sobre el monto calculado en servidor
    const amountInCents = Math.round(total * 100)
    const signature = generateWompiSignature(order.id, amountInCents, 'COP')
    const query: Record<string, string> = {
      'public-key': wompiPublicKey,
      currency: 'COP',
      'amount-in-cents': String(amountInCents),
      reference: order.id,
      'signature:integrity': signature,
      'redirect-url': `${siteUrl}/checkout/confirmacion?ref=${order.id}`,
      'customer-data:email': shippingInfo.email,
      'customer-data:full-name': shippingInfo.name,
      'customer-data:phone-number': shippingInfo.phone.replace(/\D/g, ''),
    }
    const checkoutUrl =
      'https://checkout.wompi.co/p/?' +
      Object.entries(query)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&')

    return NextResponse.json({ success: true, orderId: order.id, total, checkoutUrl })
  } catch (error) {
    console.error('[orders] POST error', { msg: (error as Error).message })
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const orderId = searchParams.get('id')
    
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (orderId) {
      // Get specific order
      const { data: order, error } = await supabase
        .from('orders')
        .select(`
          *,
          order_items (*)
        `)
        .eq('id', orderId)
        .single()

      if (error) {
        return NextResponse.json({ error: 'Orden no encontrada' }, { status: 404 })
      }

      // Check if user owns this order or is admin
      if (order.user_id !== user?.id) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('is_admin')
          .eq('id', user?.id || '')
          .maybeSingle()

        if (!profile?.is_admin) {
          return NextResponse.json({ error: 'No autorizado' }, { status: 403 })
        }
      }

      return NextResponse.json(order)
    }

    // Get user's orders
    if (!user) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
    }

    const { data: orders, error } = await supabase
      .from('orders')
      .select(`
        *,
        order_items (*)
      `)
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(orders || [])
  } catch (error) {
    console.error('[orders] GET error', { msg: (error as Error).message })
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}
