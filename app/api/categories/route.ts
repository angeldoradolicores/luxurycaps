import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET() {
  try {
    const supabase = await createClient()

    const { data: categories, error } = await supabase
      .from('categories')
      .select('*')
      .order('name')

    if (error) {
      console.error('[categories] GET', { code: error.code })
      return NextResponse.json({ error: 'No se pudieron cargar las categorías' }, { status: 500 })
    }

    return NextResponse.json(categories)
  } catch (error) {
    console.error('[v0] Categories API error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
