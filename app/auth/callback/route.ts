import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { safeRedirectPath } from '@/lib/safe-redirect'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  // Solo rutas internas: evita redirecciones abiertas (?next=@evil.com, //evil.com, https://evil.com)
  const next = safeRedirectPath(searchParams.get('next'))

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    
    if (!error) {
      let finalNext = next

      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('is_admin')
          .eq('id', user.id)
          .maybeSingle()
          
        if (profile?.is_admin) {
          finalNext = '/admin'
        }
      }

      // Base fija (no se confía en cabeceras Host / X-Forwarded-Host)
      const base = process.env.NODE_ENV === 'development' ? origin : process.env.NEXT_PUBLIC_SITE_URL || origin
      return NextResponse.redirect(new URL(finalNext, base))
    }
  }

  // URL to redirect to after sign up process completes
  return NextResponse.redirect(`${origin}/auth/auth-code-error`)
}
