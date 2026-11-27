'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'

export function RecoverOrder({ order, onRecovered }: {
  order: { id: string; payment_issue?: string | null; shipped_at?: string; delivered_at?: string }
  onRecovered: () => void | Promise<void>
}) {
  const [transactionId, setTransactionId] = useState(() =>
    order.payment_issue?.match(/transacción ([\w-]+)/)?.[1] ?? '')
  const [note, setNote] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  if (order.shipped_at || order.delivered_at) {
    return <p className="rounded-xl border border-border p-4 text-sm text-muted-foreground">
      Este pedido ya tuvo un despacho. Su recuperación requiere conciliar el envío y el pago.
    </p>
  }

  async function recover() {
    setSaving(true)
    setError('')
    try {
      const response = await fetch(`/api/admin/orders/${order.id}/recover`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactionId, note, confirmNotRefunded: confirmed }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'No se pudo recuperar el pedido.')
      toast.success('Pedido recuperado como pagado. Inventario reservado y pago verificado.')
      await onRecovered()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo recuperar el pedido.')
    } finally {
      setSaving(false)
    }
  }

  return <div className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm">
    <p className="font-semibold">Recuperar pedido con pago verificado</p>
    <p className="text-muted-foreground">
      Si el pago se aprobó, puedes recuperar este pedido como pagado. Se verificará el monto en Wompi
      y se reservarán nuevamente los productos. Si no hay existencias, el pedido seguirá cancelado.
    </p>
    <label className="block space-y-1">
      <span>Transacción aprobada en Wompi</span>
      <Input value={transactionId} onChange={e => setTransactionId(e.target.value)}
        placeholder="Ej: 1426088-1795816999-35299" maxLength={64} disabled={saving} />
    </label>
    <label className="block space-y-1">
      <span>Motivo de la recuperación</span>
      <Input value={note} onChange={e => setNote(e.target.value)} maxLength={500} disabled={saving}
        placeholder="Ej: Segundo intento aprobado; se acordó entregar el pedido" />
    </label>
    <label className="flex items-start gap-2">
      <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}
        disabled={saving} className="mt-1" />
      <span>Revisé el pago: no fue reembolsado ni tiene un reembolso en trámite, y corresponde despachar este pedido.</span>
    </label>
    {error && <p role="alert" className="text-red-400">{error}</p>}
    <Button onClick={recover} disabled={saving || !confirmed || note.trim().length < 5 || !transactionId.trim()}>
      {saving ? 'Verificando pago e inventario…' : 'Verificar y recuperar como pagado'}
    </Button>
  </div>
}
