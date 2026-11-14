import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user }, error: userError } = await supabase.auth.getUser()

    if (userError) {
      return NextResponse.json({ items: [], userId: null })
    }

    if (!user) {
      return NextResponse.json({ items: [], userId: null })
    }

    const { data: dbFavs, error } = await supabase
      .from('favorites')
      .select('product:products(*)')
      .eq('user_id', user.id)

    if (error) {
      console.warn('[favorites GET] Query error', { code: error.code })
      return NextResponse.json({ items: [], userId: user.id })
    }

    const items = (dbFavs ?? [])
      .filter((f: any) => f.product)
      .map((f: any) => ({
        id: f.product.id,
        name: f.product.name,
        slug: f.product.slug,
        description: f.product.description,
        price: f.product.price,
        original_price: f.product.original_price,
        images: f.product.images || [],
        category: f.product.category || 'Premium',
        colors: f.product.colors || [],
        sizes: f.product.sizes || [],
        stock: f.product.stock || 0,
        featured: f.product.featured || false,
      }))

    return NextResponse.json({ items, userId: user.id })
  } catch (err) {
    console.error('[favorites GET] Catch error:', err)
    return NextResponse.json({ items: [], userId: null })
  }
}

export async function POST(req: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json().catch(() => null)
    const product_id = body?.product_id

    if (typeof product_id !== 'string' || !UUID.test(product_id)) {
      return NextResponse.json({ error: 'Producto inválido' }, { status: 400 })
    }

    const { error } = await supabase
      .from('favorites')
      .upsert({
        user_id: user.id,
        product_id,
      }, {
        onConflict: 'user_id,product_id',
      })

    if (error) {
      console.error('[favorites POST] Error', { code: error.code })
      return NextResponse.json({ error: 'No se pudo guardar el favorito' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[favorites POST]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json().catch(() => null)
    const product_id = body?.product_id

    if (typeof product_id !== 'string' || !UUID.test(product_id)) {
      return NextResponse.json({ error: 'Producto inválido' }, { status: 400 })
    }

    const { error } = await supabase
      .from('favorites')
      .delete()
      .eq('user_id', user.id)
      .eq('product_id', product_id)

    if (error) {
      console.error('[favorites DELETE] Error', { code: error.code })
      return NextResponse.json({ error: 'No se pudo eliminar el favorito' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[favorites DELETE]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
