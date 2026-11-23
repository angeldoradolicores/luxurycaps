import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * Middleware using Supabase SSR to refresh session cookies on every request.
 * This is REQUIRED so the auth token stays alive across page navigations.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Anti-CSRF: las APIs que modifican datos sólo aceptan peticiones del propio sitio.
 * Un navegador siempre envía Origin / Sec-Fetch-Site en un POST/PUT/DELETE entre sitios.
 * El webhook de Wompi queda fuera (llega servidor a servidor y se valida por checksum).
 */
function isCrossSiteMutation(request: NextRequest): boolean {
  const path = request.nextUrl.pathname
  if (!path.startsWith('/api/') || SAFE_METHODS.has(request.method) || path.startsWith('/api/webhooks/')) return false

  if (request.headers.get('sec-fetch-site') === 'cross-site') return true
  const origin = request.headers.get('origin')
  if (!origin) return false // clientes no-navegador (sin cookies de un tercero)

  const allowed = new Set([request.nextUrl.origin])
  try {
    if (process.env.NEXT_PUBLIC_SITE_URL) allowed.add(new URL(process.env.NEXT_PUBLIC_SITE_URL).origin)
  } catch {}
  return !allowed.has(origin)
}

export async function middleware(request: NextRequest) {
  if (isCrossSiteMutation(request)) {
    return NextResponse.json({ error: 'Origen no permitido' }, { status: 403 })
  }

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const path = request.nextUrl.pathname
  const needsVerifiedUser = path.startsWith('/admin') || path.startsWith('/perfil')

  // En /admin y /perfil se valida el JWT con el servidor de Auth (getUser);
  // getSession() sólo lee la cookie y no comprueba la firma.
  const user = needsVerifiedUser
    ? (await supabase.auth.getUser()).data.user
    : (await supabase.auth.getSession()).data.session?.user ?? null

  // Protect /admin routes
  if (path.startsWith('/admin')) {
    if (!user) {
      const login = request.nextUrl.clone()
      login.pathname = '/auth/login'
      login.search = ''
      login.searchParams.set('redirect', path)
      return NextResponse.redirect(login)
    }

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', user.id)
      .maybeSingle()

    if (error) console.error('[middleware] profile lookup', { code: error.code })

    // Sin perfil, error o no-admin => fuera (fail-closed)
    if (profile?.is_admin !== true) {
      const home = request.nextUrl.clone()
      home.pathname = '/'
      home.search = ''
      home.searchParams.set('unauthorized', '1')
      return NextResponse.redirect(home)
    }
  }

  // Protect /perfil routes
  if (path.startsWith('/perfil') && !user) {
    const login = request.nextUrl.clone()
    login.pathname = '/auth/login'
    login.search = ''
    login.searchParams.set('redirect', path)
    return NextResponse.redirect(login)
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    /*
     * Match all request paths except static assets.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
