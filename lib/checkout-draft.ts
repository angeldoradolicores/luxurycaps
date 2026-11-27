/**
 * Borrador del checkout guardado en el navegador del cliente.
 * Permite volver de Wompi (botón atrás o "Continuar con mi compra") sin perder lo escrito.
 *
 * - Una clave por usuario: nunca se mezclan datos entre cuentas del mismo navegador.
 * - Caduca a las 24 h y se borra al aprobarse el pago o al cerrar sesión.
 * - Sólo datos que el propio cliente escribió; nada de precios: el servidor los recalcula siempre.
 */

const PREFIX = 'luxurycaps:checkout-draft:'
const TTL_MS = 24 * 60 * 60 * 1000

export interface CheckoutDraft {
  step: number
  shippingData: {
    fullName: string
    email: string
    phone: string
    city: string
    address: string
    postalCode: string
  }
  selectedDepartment: string
  selectedShipping: string
  selectedPayment: string
  selectedAddressId: string
  promoCode: string
  appliedPromoCode: string | null
}

const key = (userId: string) => PREFIX + userId

export function loadCheckoutDraft(userId: string): CheckoutDraft | null {
  try {
    const raw = window.localStorage.getItem(key(userId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as { savedAt: number; draft: CheckoutDraft }
    if (!parsed?.draft || typeof parsed.savedAt !== 'number' || Date.now() - parsed.savedAt > TTL_MS) {
      window.localStorage.removeItem(key(userId))
      return null
    }
    return parsed.draft
  } catch {
    return null
  }
}

export function saveCheckoutDraft(userId: string, draft: CheckoutDraft) {
  try {
    window.localStorage.setItem(key(userId), JSON.stringify({ savedAt: Date.now(), draft }))
  } catch {
    // almacenamiento lleno o bloqueado (modo privado): el checkout sigue funcionando sin borrador
  }
}

export function clearCheckoutDraft(userId?: string | null) {
  try {
    if (userId) {
      window.localStorage.removeItem(key(userId))
      return
    }
    // Sin usuario (p. ej. al cerrar sesión): borra todos los borradores de este navegador
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const k = window.localStorage.key(i)
      if (k?.startsWith(PREFIX)) window.localStorage.removeItem(k)
    }
  } catch {}
}
