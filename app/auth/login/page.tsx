"use client"

import { useState, useEffect, Suspense } from "react"
import { motion } from "framer-motion"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Eye, EyeOff, Mail, Lock, ArrowRight, Loader2 } from "lucide-react"
import SparklesUI from '@/components/sparkles'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { createClient } from "@/lib/supabase/client"
import { toast } from "sonner"
import { useAuthStore, useCartStore, useFavoritesStore } from "@/lib/store"
import { safeRedirectPath } from '@/lib/safe-redirect'

function LoginForm() {
  const [showPassword, setShowPassword] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  const router = useRouter()
  const searchParams = useSearchParams()
  const redirectTo = safeRedirectPath(searchParams.get('redirect'), '/admin')
  
  const [formData, setFormData] = useState({
    email: "",
    password: "",
  })

  const [formErrors, setFormErrors] = useState({
    email: "",
    password: "",
  })

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

  const validateField = (name: keyof typeof formErrors, value: string) => {
    let error = ""

    if (name === 'email') {
      if (!value.trim()) {
        error = 'El correo es obligatorio'
      } else if (!emailRegex.test(value.trim())) {
        error = 'Ingresa un correo válido'
      }
    }

    if (name === 'password') {
      if (!value) {
        error = 'La contraseña es obligatoria'
      } else if (value.length < 8) {
        error = 'Debe tener al menos 8 caracteres'
      }
    }

    setFormErrors((prev) => ({ ...prev, [name]: error }))
    return error === ""
  }

  const validateLoginForm = () => {
    const emailValid = validateField('email', formData.email)
    const passwordValid = validateField('password', formData.password)
    return emailValid && passwordValid
  }

  useEffect(() => {
    // Reset auth state and switch cart/favorites back to guest mode.
    useAuthStore.getState().setUser(null)
    useAuthStore.getState().setIsAdmin(false)
    useAuthStore.getState().setInitialized(false)
    useCartStore.getState().setUserId(null)
    useCartStore.getState().hydrateCart(null)
    useFavoritesStore.getState().setUserId(null)
    useFavoritesStore.getState().hydrateFavorites(null)
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validateLoginForm()) {
      return
    }

    setIsLoading(true)

    try {
      const supabase = createClient()
      const email = formData.email.trim()
      const password = formData.password

      // Step 1: Sign in
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      })

      if (signInError) {
        const errorMsg = signInError.message === 'Invalid login credentials'
          ? 'Email o contraseña incorrectos'
          : signInError.message || 'Error al iniciar sesión'
        console.error('[login] Sign in error:', signInError)
        toast.error(errorMsg)
        return
      }

      // Step 2: Get user
      const { data: { user }, error: userError } = await supabase.auth.getUser()
      if (userError || !user) {
        console.error('[login] Get user error:', userError)
        toast.error('No se pudo obtener información del usuario')
        return
      }

      // Step 3: Get profile/admin status
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('is_admin')
        .eq('id', user.id)
        .maybeSingle()

      if (profileError) {
        console.error('[login] Profile error:', profileError)
        // Don't fail on profile error, just assume not admin
      }

      const is_admin = profile?.is_admin === true
      if (!is_admin) {
        await supabase.auth.signOut()
        toast.error('Este acceso está reservado para administradores. Puedes comprar sin registrarte.')
        return
      }

      // Step 4: Update global stores
      useAuthStore.getState().setUser(user)
      useAuthStore.getState().setIsAdmin(is_admin)
      useAuthStore.getState().setInitialized(true)
      useCartStore.getState().setUserId(user.id)
      useFavoritesStore.getState().setUserId(user.id)

      // Step 5: Sync data from server
      try {
        await Promise.all([
          useCartStore.getState().syncCartFromServer(),
          useFavoritesStore.getState().syncFavoritesFromServer(),
        ])
      } catch (syncErr) {
        console.warn('[login] Sync error (non-blocking):', syncErr)
        // Don't fail on sync errors
      }

      // Step 6: Wait a bit for React to process state updates
      await new Promise(resolve => setTimeout(resolve, 100))

      // Step 7: Determine redirect URL
      let finalRedirect = redirectTo
      if (is_admin && redirectTo === '/') {
        finalRedirect = '/admin/dashboard'
      } else if (redirectTo.startsWith('/admin') && !is_admin) {
        finalRedirect = '/'
      }

      console.log('[login] Success, redirecting to:', finalRedirect)
      router.push(finalRedirect)
    } catch (err) {
      console.error('[login] Unexpected error:', err)
      const errorMessage = err instanceof Error ? err.message : 'Error al iniciar sesión'
      toast.error(errorMessage)
    } finally {
      setIsLoading(false)
    }
  }


  return (
    <div className="min-h-screen bg-background flex">
      {/* Left Side - Decorative */}
      <div className="hidden lg:flex lg:w-1/2 relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-chrome/20 via-background to-background" />
          <div className="absolute inset-0 opacity-30">
            <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-chrome/20 rounded-full blur-3xl animate-pulse" />
            <div className="absolute bottom-1/4 right-1/4 w-72 h-72 bg-chrome/10 rounded-full blur-3xl animate-pulse delay-1000" />
          </div>
          <SparklesUI extra={2} />

        <div className="relative z-10 flex flex-col justify-center items-center w-full p-12">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
            className="text-center"
          >
            <div className="mx-auto mb-6 text-chrome text-6xl font-black">✝</div>
            <h1 className="text-5xl font-bold text-foreground mb-4">
              ✝ URBAN <span className="text-chrome">CROWN</span> ✝
            </h1>
            <p className="text-muted-foreground text-lg max-w-md">
              Acceso privado para administrar tu tienda, productos y pedidos.
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5, duration: 1 }}
            className="mt-12 grid grid-cols-3 gap-4"
          >
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="w-24 h-24 rounded-2xl bg-card/50 backdrop-blur border border-chrome/20 flex items-center justify-center"
              >
              </div>
            ))}
          </motion.div>
        </div>
      </div>

      {/* Right Side - Login Form */}
      <div className="w-full lg:w-1/2 flex items-center justify-center p-8">
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.6 }}
          className="w-full max-w-md"
        >
          {/* Mobile Logo */}
          <div className="lg:hidden text-center mb-8">
            <Link href="/">
              <div className="mx-auto mb-4 text-chrome text-6xl font-black">✝</div>
              <h1 className="text-3xl font-bold">
                URBAN <span className="text-chrome">CROWN</span>
              </h1>
            </Link>
          </div>

          <div className="bg-card/50 backdrop-blur-xl border border-border rounded-3xl p-8 shadow-2xl">
            <h2 className="text-2xl font-bold text-foreground mb-2">Administración</h2>
            <p className="text-muted-foreground mb-8">Ingresa con tu cuenta de administrador</p>

            <form onSubmit={handleSubmit} className="space-y-6" autoComplete="off">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Email</label>
                <div className="relative">
                  <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
                  <Input
                    type="email"
                    placeholder="ejemplo@correo.com"
                    value={formData.email}
                    onChange={(e) => {
                      setFormData({ ...formData, email: e.target.value })
                      if (formErrors.email) validateField('email', e.target.value)
                    }}
                    onBlur={(e) => validateField('email', e.target.value)}
                    className="pl-12 h-14 bg-background/50 border-border rounded-xl focus:border-chrome focus:ring-chrome/20"
                    required
                    disabled={isLoading}
                    autoComplete="off"
                  />
                  {formErrors.email ? (
                    <p className="text-xs text-red-500 mt-1">{formErrors.email}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground mt-1">Ej: ejemplo@correo.com</p>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Contraseña</label>
                <div className="relative">
                  <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
                  <Input
                    type={showPassword ? "text" : "password"}
                    placeholder="Mínimo 8 caracteres"
                    value={formData.password}
                    onChange={(e) => {
                      setFormData({ ...formData, password: e.target.value })
                      if (formErrors.password) validateField('password', e.target.value)
                    }}
                    onBlur={(e) => validateField('password', e.target.value)}
                    className="pl-12 pr-12 h-14 bg-background/50 border-border rounded-xl focus:border-chrome focus:ring-chrome/20"
                    required
                    disabled={isLoading}
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                </div>
                {formErrors.password ? (
                  <p className="text-xs text-red-500 mt-1">{formErrors.password}</p>
                ) : (
                  <p className="text-xs text-muted-foreground mt-1">Usa al menos 8 caracteres</p>
                )}
              </div>

              <div className="flex items-center justify-end">
                <Link href="/auth/recuperar" className="text-sm text-chrome hover:text-chrome/80 transition-colors">
                  Olvidaste tu contrasena?
                </Link>
              </div>

              <Button
                type="submit"
                disabled={isLoading}
                className="w-full h-14 bg-chrome hover:bg-chrome/90 text-obsidian font-semibold rounded-xl transition-all duration-300 group glint-strong"
              >
                {isLoading ? (
                  <Loader2 className="w-6 h-6 animate-spin" />
                ) : (
                  <>
                    Ingresar
                    <ArrowRight className="ml-2 w-5 h-5 group-hover:translate-x-1 transition-transform" />
                  </>
                )}
              </Button>
            </form>

            <p className="mt-8 text-center text-sm text-muted-foreground">
              Para comprar no necesitas una cuenta.{' '}
              <Link href="/catalogo" className="text-chrome hover:underline">Ir a la colección</Link>
            </p>
          </div>

          {/* Back to home */}
          <div className="mt-6 text-center">
            <Link href="/" className="text-sm text-muted-foreground hover:text-chrome transition-colors">
              Volver al inicio
            </Link>
          </div>
        </motion.div>
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-background flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-chrome" /></div>}>
      <LoginForm />
    </Suspense>
  )
}
