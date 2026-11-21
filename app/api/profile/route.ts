import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'

export async function PUT(request: Request) {
  try {
    const serverSupabase = await createClient()
    const { data: { user } } = await serverSupabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
    }

    const { fullName, phone, birthDate } = (await request.json().catch(() => null)) ?? {}
    if (!fullName && phone === undefined && birthDate === undefined) {
      return NextResponse.json({ error: 'No hay datos para actualizar' }, { status: 400 })
    }
    if (fullName !== undefined && (typeof fullName !== 'string' || fullName.trim().length > 120)) {
      return NextResponse.json({ error: 'Nombre inválido' }, { status: 400 })
    }
    if (phone && (typeof phone !== 'string' || !/^[0-9+ ()-]{7,20}$/.test(phone))) {
      return NextResponse.json({ error: 'Teléfono inválido' }, { status: 400 })
    }
    if (birthDate && (typeof birthDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate) || Number.isNaN(Date.parse(birthDate)))) {
      return NextResponse.json({ error: 'Fecha de nacimiento inválida' }, { status: 400 })
    }

    // Sólo los campos enviados: antes, cambiar el nombre borraba el teléfono y la fecha
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (fullName !== undefined) updates.full_name = fullName.trim()
    if (phone !== undefined) updates.phone = phone || null
    if (birthDate !== undefined) updates.birth_date = birthDate || null

    const supabaseAdmin = createAdminClient()
    const { error } = await supabaseAdmin
      .from('profiles')
      .update(updates)
      .eq('id', user.id)

    if (error) {
      console.error('[profile] update error', { code: error.code })
      return NextResponse.json({ error: 'Error al actualizar perfil' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[profile] route error', { msg: (error as Error).message })
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}
