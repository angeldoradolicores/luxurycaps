import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendConfirmationEmail } from '@/lib/mail'
import { checkRateLimit, getClientIp, tooManyRequests } from '@/lib/rate-limit'

async function getSiteUrl(request: Request) {
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL
  }

  // Sin NEXT_PUBLIC_SITE_URL solo se acepta localhost: no se confía en la cabecera Host
  const host = request.headers.get('host')
  if (!host || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return 'http://localhost:3000'

  const protocol = host.includes('localhost') || host.includes('127.0.0.1') ? 'http' : 'https'
  return `${protocol}://${host}`
}

export async function POST(request: Request) {
  try {
    if (!(await checkRateLimit('register:ip', getClientIp(request), 5, 3600))) {
      return tooManyRequests(3600, 'Demasiados registros desde esta conexión. Intenta más tarde.')
    }

    const body = await request.json()
    let email = (body.email || '').trim()
    const password = body.password
    const fullName = body.fullName || ''

    // Normalize and validate email
    email = email.toLowerCase()
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!email || !password) {
      return NextResponse.json({ error: 'Email y contraseña son requeridos.' }, { status: 400 })
    }

    if (!emailRegex.test(email) || email.length > 160) {
      return NextResponse.json({ error: 'Email inválido.' }, { status: 400 })
    }

    if (typeof password !== 'string' || password.length < 8 || password.length > 72) {
      return NextResponse.json({ error: 'La contraseña debe tener entre 8 y 72 caracteres.' }, { status: 400 })
    }

    if (typeof fullName !== 'string' || fullName.length > 120) {
      return NextResponse.json({ error: 'Nombre inválido.' }, { status: 400 })
    }

    // Optional: quick MX lookup to reduce bounces
    try {
      const dns = await import('dns')
      const mx = await dns.promises.resolveMx(email.split('@')[1])
      if (!mx || mx.length === 0) {
        console.warn('[register] No MX records for domain')
        return NextResponse.json({ error: 'Dominio de correo no válido.' }, { status: 400 })
      }
    } catch (e) {
      // DNS lookup may fail in some envs; don't block registration but log
      console.warn('[register] MX lookup failed:', e)
    }

    const siteUrl = await getSiteUrl(request)
    const redirectTo = `${siteUrl}/auth/callback`

    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return NextResponse.json({ error: 'El servicio de registro no está disponible en este momento.' }, { status: 500 })
    }

    const adminSupabase = createAdminClient()
    const { data: linkData, error: linkError } = await adminSupabase.auth.admin.generateLink({
      type: 'signup',
      email,
      password,
      options: {
        data: {
          full_name: fullName,
          phone: body.phone || '',
        },
        redirectTo,
      },
    })

    if (linkError) {
      const message = linkError.message.includes('already registered')
        ? 'Este email ya está registrado.'
        : linkError.message || 'No se pudo crear la cuenta.'
      return NextResponse.json({ error: message }, { status: 400 })
    }

    if (!linkData?.properties?.action_link) {
      console.error('[register] generateLink returned no action link')
      return NextResponse.json({ error: 'No se pudo generar el enlace de confirmación.' }, { status: 500 })
    }

    await sendConfirmationEmail(email, linkData.properties.action_link, fullName)

    return NextResponse.json({ success: true, message: 'Cuenta creada. Revisa tu email para confirmar tu cuenta.' })
  } catch (error) {
    console.error('[register] Unexpected error:', error)
    return NextResponse.json({ error: 'Error interno del servidor.' }, { status: 500 })
  }
}
