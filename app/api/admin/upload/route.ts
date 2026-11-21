import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { getAdmin } from '@/lib/supabase/require-admin'
import { checkRateLimit, tooManyRequests } from '@/lib/rate-limit'

/**
 * Subida firmada: el admin pide permiso aquí (tipo + tamaño), el servidor genera la ruta
 * y una URL de subida de un solo uso, y el navegador sube el archivo DIRECTO a Supabase.
 * Así se evita el límite de 4,5 MB del cuerpo de las funciones de Vercel.
 * El bucket "products" además restringe tipos MIME y tamaño (supabase-security-fix-3.sql).
 */
const IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}
const VIDEO_TYPES: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
}
const MAX_IMAGE_SIZE = 10 * 1024 * 1024 // 10 MB
const MAX_VIDEO_SIZE = 50 * 1024 * 1024 // 50 MB (límite por archivo del plan de Supabase)
const BUCKET = 'products'

export async function POST(request: Request) {
  try {
    const { error: denied, user } = await getAdmin()
    if (denied) return denied

    if (!(await checkRateLimit('admin:upload:user', user.id, 60, 600))) {
      return tooManyRequests(600, 'Demasiadas subidas seguidas. Espera unos minutos.')
    }

    const body = await request.json().catch(() => null)
    const contentType = typeof body?.contentType === 'string' ? body.contentType.toLowerCase() : ''
    const size = Number(body?.size)

    const imageExt = IMAGE_TYPES[contentType]
    const videoExt = VIDEO_TYPES[contentType]
    if (!imageExt && !videoExt) {
      return NextResponse.json(
        { error: 'Tipo de archivo no permitido. Imágenes: JPG, PNG, WebP o GIF. Videos: MP4, WebM o MOV.' },
        { status: 400 }
      )
    }

    const isImage = Boolean(imageExt)
    const maxSize = isImage ? MAX_IMAGE_SIZE : MAX_VIDEO_SIZE
    if (!Number.isFinite(size) || size <= 0 || size > maxSize) {
      return NextResponse.json(
        { error: `El archivo es demasiado grande. Máximo ${maxSize / (1024 * 1024)} MB para ${isImage ? 'imágenes' : 'videos'}.` },
        { status: 400 }
      )
    }

    // Ruta generada por el servidor: nada del nombre original del archivo
    const folder = isImage ? 'images' : 'videos'
    const storagePath = `${folder}/${crypto.randomUUID()}.${imageExt || videoExt}`

    const storage = createAdminClient().storage.from(BUCKET)
    const { data, error } = await storage.createSignedUploadUrl(storagePath)
    if (error || !data) {
      console.error('[admin/upload] signed url', { msg: error?.message })
      return NextResponse.json({ error: 'No se pudo preparar la subida' }, { status: 500 })
    }

    const { data: { publicUrl } } = storage.getPublicUrl(storagePath)
    return NextResponse.json({
      path: data.path,
      token: data.token,
      contentType,
      url: publicUrl,
      type: isImage ? 'image' : 'video',
    })
  } catch (error) {
    console.error('[admin/upload] error', { msg: (error as Error).message })
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}
