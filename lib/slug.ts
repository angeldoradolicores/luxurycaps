type ServerClient = Awaited<ReturnType<typeof import('@/lib/supabase/server').createClient>>

/** "Gorra Ñandú 2024" -> "gorra-nandu-2024" */
export function normalizeSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita tildes (solo marcas diacríticas combinadas)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80)
}

/** Slug único en la tabla indicada (añade -1, -2… si ya existe). */
export async function generateUniqueSlug(
  supabase: ServerClient,
  table: 'products' | 'categories',
  name: string,
  fallback: string,
  excludeId?: string
): Promise<string> {
  const baseSlug = normalizeSlug(name) || fallback
  let query = supabase.from(table).select('slug').ilike('slug', `${baseSlug}%`)
  if (excludeId) query = query.neq('id', excludeId)

  const { data: existing, error } = await query
  if (error) throw error

  const slugs = new Set((existing || []).map((item: { slug: string }) => item.slug))
  if (!slugs.has(baseSlug)) return baseSlug

  let suffix = 1
  while (slugs.has(`${baseSlug}-${suffix}`)) suffix += 1
  return `${baseSlug}-${suffix}`
}
