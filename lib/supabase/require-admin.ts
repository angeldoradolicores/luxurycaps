import { NextResponse } from 'next/server'
import { createClient } from './server'

/**
 * Verifica que la petición venga de un admin (JWT validado con getUser + is_admin en BD).
 * Devuelve una respuesta de error si NO es admin, o null si puede continuar.
 */
export async function requireAdmin(): Promise<NextResponse | null> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('id', user.id)
    .maybeSingle()

  return profile?.is_admin === true ? null : NextResponse.json({ error: 'Acceso denegado' }, { status: 403 })
}

/** Estados que un admin puede asignar manualmente. 'paid' solo lo asigna Wompi (lib/payments.ts). */
export const ADMIN_ASSIGNABLE_STATUSES = ['processing', 'shipped', 'delivered', 'cancelled'] as const
