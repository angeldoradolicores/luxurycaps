import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'

// Listado público: SIN el código (los códigos no deben poder enumerarse)
export async function GET() {
  try {
    const db = createAdminClient()
    const { data: promotions, error } = await db
      .from('promotions')
      .select('id, description, discount_type, discount_value, min_purchase, start_date, end_date')
      .eq('active', true)
      .gte('end_date', new Date().toISOString())
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[promotions] GET', { code: error.code })
      return NextResponse.json({ error: 'No se pudieron cargar las promociones' }, { status: 500 })
    }

    return NextResponse.json(promotions)
  } catch (error) {
    console.error('[promotions] GET error', { msg: (error as Error).message })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// Validación de un código para mostrar el descuento estimado.
// El descuento REAL lo recalcula /api/orders en el servidor.
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null)
    const code = typeof body?.code === 'string' ? body.code.trim().toUpperCase() : ''
    if (!code || code.length > 40) {
      return NextResponse.json({ error: 'Codigo no valido' }, { status: 400 })
    }

    const db = createAdminClient()
    const { data: promotion, error } = await db
      .from('promotions')
      .select('code, discount_type, discount_value, min_purchase, max_uses, used_count, start_date, end_date')
      .eq('code', code)
      .eq('active', true)
      .maybeSingle()

    if (error || !promotion) {
      return NextResponse.json({ error: 'Codigo no valido' }, { status: 404 })
    }

    const now = Date.now()
    if (promotion.start_date && new Date(promotion.start_date).getTime() > now) {
      return NextResponse.json({ error: 'Codigo no valido' }, { status: 404 })
    }
    if (promotion.end_date && new Date(promotion.end_date).getTime() < now) {
      return NextResponse.json({ error: 'Este codigo ha expirado' }, { status: 400 })
    }
    if (promotion.max_uses && (promotion.used_count ?? 0) >= promotion.max_uses) {
      return NextResponse.json({ error: 'Este codigo ya no esta disponible' }, { status: 400 })
    }

    return NextResponse.json({
      code: promotion.code,
      discount_type: promotion.discount_type,
      discount_value: promotion.discount_value,
      min_purchase: promotion.min_purchase,
    })
  } catch (error) {
    console.error('[promotions] POST error', { msg: (error as Error).message })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
