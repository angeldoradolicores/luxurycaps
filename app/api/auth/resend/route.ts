import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendConfirmationEmail } from '@/lib/mail'
import { checkRateLimit, getClientIp, tooManyRequests } from '@/lib/rate-limit'

async function getSiteUrl(request: Request) {
  // URL fija: la cabecera Host la controla el cliente y permitiría robar el enlace de confirmación
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL
  const host = request.headers.get('host')
  if (host && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return `http://${host}`
  return 'http://localhost:3000'
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    let email = (body.email || '').trim().toLowerCase()
    const fullName = body.fullName || ''

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!email || !emailRegex.test(email) || email.length > 160) {
      return NextResponse.json({ error: 'Email inválido.' }, { status: 400 })
    }

    // Evita usar el servidor para enviar correos masivos
    if (
      !(await checkRateLimit('resend:ip', getClientIp(request), 5, 3600)) ||
      !(await checkRateLimit('resend:email', email, 3, 3600))
    ) {
      return tooManyRequests(3600, 'Ya enviamos varios correos. Revisa tu bandeja (y spam) o intenta más tarde.')
    }

    const siteUrl = await getSiteUrl(request)
    const redirectTo = `${siteUrl}/auth/callback`

    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return NextResponse.json({ error: 'El servicio no está disponible.' }, { status: 500 })
    }

    const adminSupabase = createAdminClient()
    const { data: linkData, error: linkError } = await adminSupabase.auth.admin.generateLink({
      type: 'signup',
      email,
      // Supabase acepta null en runtime para reenviar el enlace a un usuario existente
      password: null as unknown as string,
      options: {
        data: { full_name: fullName },
        redirectTo,
      },
    })

    if (linkError) {
      return NextResponse.json({ error: linkError.message }, { status: 400 })
    }

    if (!linkData?.properties?.action_link) {
      console.error('[resend] generateLink returned no action link')
      return NextResponse.json({ error: 'No se pudo generar el enlace de confirmación.' }, { status: 500 })
    }

    await sendConfirmationEmail(email, linkData.properties.action_link, fullName)
    return NextResponse.json({ success: true, message: 'Enlace de confirmación reenviado.' })
  } catch (err) {
    console.error('[resend] Unexpected error:', err)
    return NextResponse.json({ error: 'Error interno del servidor.' }, { status: 500 })
  }
}
