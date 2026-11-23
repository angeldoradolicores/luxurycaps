import { NextResponse } from 'next/server'
import type { User } from '@supabase/supabase-js'
import { createClient } from './server'

type ServerClient = Awaited<ReturnType<typeof createClient>>

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Verifica que la petición venga de un admin (JWT validado con getUser + is_admin en BD).
 * Devuelve { error } si NO es admin, o { user, supabase } para continuar.
 */
export async function getAdmin(): Promise<
  { error: NextResponse; user?: never; supabase?: never } | { error?: never; user: User; supabase: ServerClient }
> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'No autorizado' }, { status: 401 }) }

  const { data: profile } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('id', user.id)
    .maybeSingle()

  if (profile?.is_admin !== true) {
    return { error: NextResponse.json({ error: 'Acceso denegado' }, { status: 403 }) }
  }
  return { user, supabase }
}

/** Atajo: devuelve una respuesta de error si NO es admin, o null si puede continuar. */
export async function requireAdmin(): Promise<NextResponse | null> {
  const { error } = await getAdmin()
  return error ?? null
}

/** Estados que un admin puede asignar manualmente. 'paid' solo lo asigna Wompi (lib/payments.ts). */
export const ADMIN_ASSIGNABLE_STATUSES = ['processing', 'shipped', 'delivered', 'cancelled'] as const
