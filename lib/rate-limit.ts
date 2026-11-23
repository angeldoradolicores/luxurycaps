import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * IP del cliente. En Vercel, x-real-ip / x-forwarded-for los fija la plataforma
 * (sobrescribe lo que envíe el cliente), así que no se pueden falsificar.
 */
export function getClientIp(request: Request): string {
  const real = request.headers.get('x-real-ip')
  if (real) return real.trim()
  const fwd = request.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return 'unknown'
}

/**
 * Rate limit de ventana fija persistido en Supabase (compartido entre instancias serverless).
 * Devuelve true si la petición está permitida.
 * Si la BD falla, permite la petición (fail-open) para no tumbar la tienda por un contador.
 */
export async function checkRateLimit(bucket: string, identifier: string, limit: number, windowSeconds: number) {
  const key = crypto.createHash('sha256').update(`${bucket}:${identifier}`).digest('hex')
  try {
    const { data, error } = await createAdminClient().rpc('check_rate_limit', {
      p_key: key,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    })
    if (error) {
      console.error('[rate-limit] rpc error', { bucket, code: error.code })
      return true
    }
    return data === true
  } catch (err) {
    console.error('[rate-limit] error', { bucket, msg: (err as Error).message })
    return true
  }
}

export function tooManyRequests(retryAfterSeconds: number, message = 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.') {
  return NextResponse.json(
    { error: message },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } }
  )
}

/** Atajo: aplica el límite por IP y devuelve la respuesta 429 si se excede (o null si puede continuar). */
export async function limitByIp(request: Request, bucket: string, limit: number, windowSeconds: number) {
  const ok = await checkRateLimit(bucket, getClientIp(request), limit, windowSeconds)
  return ok ? null : tooManyRequests(windowSeconds)
}
