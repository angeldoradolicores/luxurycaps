import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAdmin, UUID_RE } from '@/lib/supabase/require-admin'
import { generateUniqueSlug } from '@/lib/slug'

type ServerClient = NonNullable<Awaited<ReturnType<typeof getAdmin>>['supabase']>

const httpsUrl = z
  .string()
  .trim()
  .max(1000)
  .refine((u) => {
    try {
      return new URL(u).protocol === 'https:'
    } catch {
      return false
    }
  }, 'URL inválida (debe ser https)')

const label = z.string().trim().min(1).max(40)
const money = z.number().int('El precio debe ser un número entero').min(0).max(100_000_000)

// Precio y stock: enteros no negativos. Nada de campos extra (paid, slug, etc.)
const ProductSchema = z.object({
  name: z.string().trim().min(1, 'Nombre requerido').max(150),
  description: z.string().max(5000).optional(),
  // Precio > 0: un producto en $0 se podría "comprar" pagando sólo el envío
  price: money.min(100, 'El precio mínimo es $100').optional(),
  original_price: money.nullable().optional(),
  category_id: z.string().max(100).nullable().optional(),
  category: z.string().max(100).nullable().optional(),
  stock: z.number().int('El stock debe ser un número entero').min(0).max(100_000).optional(),
  featured: z.boolean().optional(),
  is_promotion: z.boolean().optional(),
  colors: z.array(label).max(30).optional(),
  sizes: z.array(label).max(30).optional(),
  images: z.array(httpsUrl).max(20).optional(),
  videos: z.array(httpsUrl).max(10).optional(),
})

type ProductInput = z.infer<typeof ProductSchema>

function badRequest(err: z.ZodError) {
  const first = err.issues[0]
  return NextResponse.json(
    { error: `Dato inválido en "${first?.path.join('.') || 'producto'}": ${first?.message}` },
    { status: 400 }
  )
}

async function resolveCategoryId(supabase: ServerClient, input: ProductInput): Promise<string | null> {
  const req = input.category_id || input.category
  if (!req || req === 'Todos') return null
  if (UUID_RE.test(req)) return req

  const { data: bySlug } = await supabase.from('categories').select('id').eq('slug', req.toLowerCase()).limit(1)
  if (bySlug?.length) return bySlug[0].id

  const escaped = req.replace(/[\\%_]/g, (c) => `\\${c}`)
  const { data: byName } = await supabase.from('categories').select('id').ilike('name', escaped).limit(1)
  return byName?.length ? byName[0].id : null
}

async function replaceMedia(supabase: ServerClient, productId: string, input: ProductInput, replace: boolean) {
  if (input.images) {
    if (replace) await supabase.from('product_images').delete().eq('product_id', productId)
    if (input.images.length > 0) {
      const { error } = await supabase.from('product_images').insert(
        input.images.map((url, index) => ({ product_id: productId, url, is_primary: index === 0, sort_order: index }))
      )
      if (error) console.error('[admin/products] images', { code: error.code })
    }
  }
  if (input.videos) {
    if (replace) await supabase.from('product_videos').delete().eq('product_id', productId)
    if (input.videos.length > 0) {
      const { error } = await supabase.from('product_videos').insert(
        input.videos.map((url) => ({ product_id: productId, url }))
      )
      if (error) console.error('[admin/products] videos', { code: error.code })
    }
  }
}

async function loadForClient(supabase: ServerClient, id: string, fallback: unknown) {
  const { data: finalProduct } = await supabase
    .from('products')
    .select('*, product_images(url, is_primary, sort_order), category:categories(name, slug)')
    .eq('id', id)
    .maybeSingle()

  if (!finalProduct) return fallback
  const images = (finalProduct.product_images || [])
    .sort((a: any, b: any) => (a.sort_order || 0) - (b.sort_order || 0))
    .map((img: any) => img.url)
  return { ...finalProduct, images, category: finalProduct.category?.name || 'Premium' }
}

// GET - Listado para el admin
export async function GET() {
  try {
    const { error: denied, supabase } = await getAdmin()
    if (denied) return denied

    const { data: products, error } = await supabase
      .from('products')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[admin/products] GET', { code: error.code })
      return NextResponse.json({ error: 'No se pudieron cargar los productos', products: [] }, { status: 500 })
    }
    return NextResponse.json({ products: products || [] })
  } catch (error) {
    console.error('[admin/products] GET error', { msg: (error as Error).message })
    return NextResponse.json({ error: 'Error interno', products: [] }, { status: 500 })
  }
}

// POST - Crear producto
export async function POST(request: Request) {
  try {
    const { error: denied, supabase } = await getAdmin()
    if (denied) return denied

    const parsed = ProductSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return badRequest(parsed.error)
    const input = parsed.data
    if (input.price === undefined) {
      return NextResponse.json({ error: 'Dato inválido en "price": el precio es obligatorio' }, { status: 400 })
    }

    const slug = await generateUniqueSlug(supabase, 'products', input.name, 'producto')
    const { data: product, error } = await supabase
      .from('products')
      .insert({
        name: input.name,
        slug,
        description: input.description ?? '',
        price: input.price,
        original_price: input.original_price || null,
        category_id: await resolveCategoryId(supabase, input),
        stock: input.stock ?? 0,
        featured: input.featured ?? false,
        is_promotion: input.is_promotion ?? false,
        colors: input.colors?.length ? input.colors : ['Negro'],
        sizes: input.sizes?.length ? input.sizes : ['M'],
      })
      .select()
      .single()

    if (error) {
      console.error('[admin/products] create', { code: error.code })
      return NextResponse.json({ error: 'No se pudo crear el producto' }, { status: 500 })
    }

    await replaceMedia(supabase, product.id, input, false)
    return NextResponse.json({ product: await loadForClient(supabase, product.id, product) }, { status: 201 })
  } catch (error) {
    console.error('[admin/products] POST error', { msg: (error as Error).message })
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}

// PUT - Actualizar producto
export async function PUT(request: Request) {
  try {
    const { error: denied, supabase } = await getAdmin()
    if (denied) return denied

    const body = await request.json().catch(() => null)
    if (!UUID_RE.test(String(body?.id))) {
      return NextResponse.json({ error: 'ID y nombre requeridos' }, { status: 400 })
    }
    const parsed = ProductSchema.safeParse(body)
    if (!parsed.success) return badRequest(parsed.error)
    const input = parsed.data
    const id: string = body.id

    const slug = await generateUniqueSlug(supabase, 'products', input.name, 'producto', id)
    const updates: Record<string, unknown> = {
      name: input.name,
      slug,
      original_price: input.original_price || null,
      category_id: await resolveCategoryId(supabase, input),
      featured: input.featured ?? false,
      is_promotion: input.is_promotion ?? false,
      colors: input.colors?.length ? input.colors : ['Negro'],
      sizes: input.sizes?.length ? input.sizes : ['M'],
    }
    if (input.description !== undefined) updates.description = input.description
    if (input.price !== undefined) updates.price = input.price
    if (input.stock !== undefined) updates.stock = input.stock

    const { data: product, error } = await supabase
      .from('products')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      console.error('[admin/products] update', { code: error.code })
      return NextResponse.json({ error: 'No se pudo actualizar el producto' }, { status: 500 })
    }

    await replaceMedia(supabase, id, input, true)
    return NextResponse.json({ product: await loadForClient(supabase, id, product) })
  } catch (error) {
    console.error('[admin/products] PUT error', { msg: (error as Error).message })
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}

// DELETE - Eliminar producto
export async function DELETE(request: Request) {
  try {
    const { error: denied, supabase } = await getAdmin()
    if (denied) return denied

    const body = await request.json().catch(() => null)
    if (!UUID_RE.test(String(body?.id))) {
      return NextResponse.json({ error: 'ID requerido' }, { status: 400 })
    }

    const { error } = await supabase.from('products').delete().eq('id', body.id)
    if (error) {
      console.error('[admin/products] delete', { code: error.code })
      return NextResponse.json({ error: 'No se pudo eliminar el producto' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[admin/products] DELETE error', { msg: (error as Error).message })
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
