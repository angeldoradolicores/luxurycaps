import { NextResponse } from 'next/server'
import { verifyWompiEventChecksum, getTransaction } from '@/lib/wompi'
import { applyWompiTransaction } from '@/lib/payments'

export async function POST(request: Request) {
  let event: any
  try {
    event = JSON.parse(await request.text())
  } catch {
    return NextResponse.json({ error: 'Bad JSON' }, { status: 400 })
  }

  // Checksum obligatorio: sin firma válida no se procesa nada
  let valid = false
  try {
    valid = verifyWompiEventChecksum(event)
  } catch {
    valid = false
  }
  if (!valid) {
    console.warn('[wompi-webhook] Checksum inválido o ausente')
    return NextResponse.json({ error: 'Invalid checksum' }, { status: 401 })
  }

  const txId = event?.data?.transaction?.id
  if (event.event !== 'transaction.updated' || !txId) {
    return NextResponse.json({ received: true })
  }

  try {
    // Defensa en profundidad: la fuente de verdad es la API de Wompi, no el payload recibido
    const tx = await getTransaction(String(txId))
    const result = await applyWompiTransaction(tx)
    return NextResponse.json({ received: true, result })
  } catch (err) {
    console.error('[wompi-webhook] Error procesando evento', { txId, msg: (err as Error).message })
    // 500 → Wompi reintentará el evento
    return NextResponse.json({ error: 'retry' }, { status: 500 })
  }
}
