import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { generateWompiSignature } from '@/lib/wompi'
import crypto from 'crypto'
import { z } from 'zod'
import { checkRateLimit, limitByIp, tooManyRequests } from '@/lib/rate-limit'

// Máximo de pedidos sin pagar simultáneos por usuario (evita acaparar inventario)
const MAX_PENDING_ORDERS_PER_USER = 3

// Unidades máximas de un mismo producto por pedido y por usuario en pedidos pendientes.
// Debe coincidir con el tope de supabase-security-fix-7.sql (create_pending_order).
const MAX_UNITS_PER_PRODUCT = 20

const SHIPPING_RATES = { interrapidisimo: 17000, recoger: 0 } as const

// Vigencia del enlace de pago de Wompi (el pedido pendiente expira a las 2 h)
const CHECKOUT_TTL_MS = 90 * 60 * 1000

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
    const limited = await limitByIp(request, 'orders:create:ip', 10, 600)
    if (limited) return limited

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

    // Comprar exige sesión (el checkout ya lo exige en la interfaz)
    if (!user) {
      return NextResponse.json({ error: 'Debes iniciar sesión para completar la compra' }, { status: 401 })
    }

    if (!(await checkRateLimit('orders:create:user', user.id, 5, 600))) {
      return tooManyRequests(600)
    }

    const { count: pendingCount } = await db
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('status', 'pending')
    if ((pendingCount ?? 0) >= MAX_PENDING_ORDERS_PER_USER) {
      return NextResponse.json(
        { error: 'Tienes pedidos pendientes de pago. Complétalos o espera unos minutos antes de crear otro.' },
        { status: 429 }
      )
    }

    // 1) Precios SIEMPRE desde la base de datos
    const ids = [...new Set(items.map((i) => i.productId))]
    const { data: products, error: pErr } = await db
      .from('products')
      .select('id, name, price, images, colors, sizes')
      .in('id', ids)
    if (pErr) {
      console.error('[orders] products lookup', { code: pErr.code })
      return NextResponse.json({ error: 'No pudimos verificar los productos, intenta de nuevo' }, { status: 503 })
    }
    const byId = new Map((products ?? []).map((p: any) => [p.id, p]))
    // Productos inexistentes o sin precio válido (p. ej. $0 por error) no se venden
    if (byId.size !== ids.length || [...byId.values()].some((p: any) => !Number.isInteger(Number(p.price)) || Number(p.price) <= 0)) {
      return NextResponse.json({ error: 'Algún producto ya no está disponible' }, { status: 400 })
    }

    // Color y talla deben existir en el producto (nada de texto libre en el pedido)
    const invalidVariant = items.some((i) => {
      const p: any = byId.get(i.productId)
      const okColor = !i.color || !Array.isArray(p.colors) || p.colors.length === 0 || p.colors.includes(i.color)
      const okSize = !i.size || !Array.isArray(p.sizes) || p.sizes.length === 0 || p.sizes.includes(i.size)
      return !okColor || !okSize
    })
    if (invalidVariant) {
      return NextResponse.json({ error: 'Color o talla no disponible. Revisa tu carrito.' }, { status: 400 })
    }

    // Tope de unidades por producto en UN pedido (sumando todas sus líneas).
    // Sin esto, 30 líneas de 20 unidades reservaban 600 de un mismo producto.
    const unitsByProduct = new Map<string, number>()
    for (const i of items) {
      unitsByProduct.set(i.productId, (unitsByProduct.get(i.productId) ?? 0) + i.quantity)
    }
    if ([...unitsByProduct.values()].some((q) => q > MAX_UNITS_PER_PRODUCT)) {
      return NextResponse.json(
        { error: `Máximo ${MAX_UNITS_PER_PRODUCT} unidades por producto en un mismo pedido.` },
        { status: 400 }
      )
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
      // Usos máximos: cuenta también los pedidos pendientes que ya reservaron este cupón
      if (promo!.max_uses) {
        const { count: reserved } = await db
          .from('orders')
          .select('id', { count: 'exact', head: true })
          .eq('promo_code', promo!.code)
          .eq('status', 'pending')
        if ((promo!.used_count ?? 0) + (reserved ?? 0) >= promo!.max_uses) {
          return NextResponse.json({ error: 'Este código ya no está disponible' }, { status: 400 })
        }
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

    // 3) Pedido + ítems + reserva de stock en UNA transacción (create_pending_order).
    //    Los topes (3 pendientes por usuario, usos del cupón) se vuelven a verificar ahí bajo bloqueo,
    //    así que peticiones simultáneas no los pueden saltar.
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const orderNumber = `LH-${dateStr}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`

    const { data: orderId, error: createError } = await db.rpc('create_pending_order', {
      p_order: {
        order_number: orderNumber,
        user_id: user.id,
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
        notes: shippingInfo.notes || '',
      },
      p_items: lines,
      p_max_pending: MAX_PENDING_ORDERS_PER_USER,
    })

    if (createError || typeof orderId !== 'string') {
      const msg = createError?.message || ''
      if (msg.includes('OUT_OF_STOCK')) {
        return NextResponse.json({ error: 'Uno de los productos se agotó. Revisa tu carrito.' }, { status: 409 })
      }
      if (msg.includes('PRODUCT_LIMIT')) {
        return NextResponse.json(
          { error: `Ya tienes ${MAX_UNITS_PER_PRODUCT} unidades de un producto en pedidos pendientes. Completa o espera tu pedido anterior.` },
          { status: 429 }
        )
      }
      if (msg.includes('TOO_MANY_PENDING')) {
        return NextResponse.json(
          { error: 'Tienes pedidos pendientes de pago. Complétalos o espera unos minutos antes de crear otro.' },
          { status: 429 }
        )
      }
      if (msg.includes('PROMO_EXHAUSTED') || msg.includes('PROMO_INVALID')) {
        return NextResponse.json({ error: 'Este código ya no está disponible' }, { status: 400 })
      }
      console.error('[orders] create_pending_order', { code: createError?.code, msg })
      return NextResponse.json({ error: 'No pudimos crear tu pedido, intenta de nuevo' }, { status: 500 })
    }
    const order = { id: orderId }

    // 5) Firma de integridad sobre el monto calculado en servidor
    // El enlace de pago caduca ANTES de que el pedido expire (2 h, expire_pending_orders):
    // así nadie puede pagar un pedido cuyo stock ya se liberó.
    const amountInCents = Math.round(total * 100)
    const expirationTime = new Date(Date.now() + CHECKOUT_TTL_MS).toISOString() // 2026-01-01T12:00:00.000Z
    const signature = generateWompiSignature(order.id, amountInCents, 'COP', expirationTime)
    const query: Record<string, string> = {
      'public-key': wompiPublicKey,
      currency: 'COP',
      'amount-in-cents': String(amountInCents),
      reference: order.id,
      'signature:integrity': signature,
      'expiration-time': expirationTime,
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
      console.error('[orders] GET list', { code: error.code })
      return NextResponse.json({ error: 'No se pudieron cargar tus pedidos' }, { status: 500 })
    }

    return NextResponse.json(orders || [])
  } catch (error) {
    console.error('[orders] GET error', { msg: (error as Error).message })
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}
