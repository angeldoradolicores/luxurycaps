/**
 * Devuelve una ruta interna segura para redirigir, o el fallback.
 * Bloquea redirecciones abiertas: "https://evil.com", "//evil.com", "/\\evil.com",
 * "@evil.com" (que concatenado al origin daría https://sitio@evil.com) y caracteres de control.
 */
export function safeRedirectPath(input: unknown, fallback = '/'): string {
  if (typeof input !== 'string') return fallback
  const value = input.trim()
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.startsWith('/\\') ||
    /[\u0000-\u001F\u007F\\]/.test(value) ||
    value.length > 512
  ) {
    return fallback
  }
  return value
}
