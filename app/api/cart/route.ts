import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_QTY = 20
// '' en vez de NULL: con NULL el UNIQUE no funciona (duplica filas y el borrado no encuentra el ítem)
const variant = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 40) : '')

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

    const { data: dbItems, error } = await supabase
      .from('cart_items')
      .select(`
        quantity,
        selected_color,
        selected_size,
        product:products(*)
      `)
      .eq('user_id', user.id)

    if (error) {
      console.warn('[cart GET] Query error', { code: error.code })
      return NextResponse.json({ items: [], userId: user.id })
    }

    const items = (dbItems ?? [])
      .filter((item: any) => item.product)
      .map((item: any) => ({
        id: `${item.product.id}::${item.selected_color || 'default'}::${item.selected_size || 'default'}`,
        product: {
          id: item.product.id,
          name: item.product.name,
          slug: item.product.slug,
          description: item.product.description,
          price: item.product.price,
          original_price: item.product.original_price,
          images: item.product.images || [],
          category: item.product.category || 'Premium',
          colors: item.product.colors || [],
          sizes: item.product.sizes || [],
          stock: item.product.stock || 0,
          featured: item.product.featured || false,
        },
        quantity: item.quantity,
        selectedColor: item.selected_color,
        selectedSize: item.selected_size,
      }))

    return NextResponse.json({ items, userId: user.id })
  } catch (err) {
    console.error('[cart GET] Catch error:', err)
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
    const { product_id, quantity, selected_color, selected_size } = body ?? {}

    if (typeof product_id !== 'string' || !UUID.test(product_id)) {
      return NextResponse.json({ error: 'Producto inválido' }, { status: 400 })
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) {
      return NextResponse.json({ error: `Cantidad inválida (1-${MAX_QTY})` }, { status: 400 })
    }

    const { error } = await supabase
      .from('cart_items')
      .upsert({
        user_id: user.id,
        product_id,
        quantity,
        selected_color: variant(selected_color),
        selected_size: variant(selected_size),
      }, {
        onConflict: 'user_id,product_id,selected_color,selected_size',
      })

    if (error) {
      console.error('[cart POST] Error', { code: error.code })
      return NextResponse.json({ error: 'No se pudo actualizar el carrito' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[cart POST]', err)
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
    const { product_id, selected_color, selected_size, clear_all } = body ?? {}

    // Handle clear_all case (for logout)
    if (clear_all) {
      const { error } = await supabase
        .from('cart_items')
        .delete()
        .eq('user_id', user.id)

      if (error) {
        console.error('[cart DELETE clear_all] Error', { code: error.code })
        return NextResponse.json({ error: 'No se pudo vaciar el carrito' }, { status: 500 })
      }

      return NextResponse.json({ success: true })
    }

    // Handle individual item deletion
    if (typeof product_id !== 'string' || !UUID.test(product_id)) {
      return NextResponse.json({ error: 'Producto inválido' }, { status: 400 })
    }

    const { error } = await supabase
      .from('cart_items')
      .delete()
      .eq('user_id', user.id)
      .eq('product_id', product_id)
      .eq('selected_color', variant(selected_color))
      .eq('selected_size', variant(selected_size))

    if (error) {
      console.error('[cart DELETE] Error', { code: error.code })
      return NextResponse.json({ error: 'No se pudo eliminar el producto' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[cart DELETE]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
