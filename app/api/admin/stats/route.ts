import { NextResponse } from 'next/server'
import { getAdmin } from '@/lib/supabase/require-admin'

type ServerClient = NonNullable<Awaited<ReturnType<typeof getAdmin>>['supabase']>

// Estados que cuentan como venta real (pagada por Wompi)
const PAID_STATUSES = ['paid', 'processing', 'shipped', 'delivered']
// Colombia: UTC-5 fijo (sin horario de verano). Los cortes de día/mes son en hora de Bogotá.
const TZ_OFFSET_MS = 5 * 60 * 60 * 1000
const TZ = 'America/Bogota'
const MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']

/** Fecha "de pared" en Bogotá (usar sólo los getters UTC*) */
const bogota = (d: Date) => new Date(d.getTime() - TZ_OFFSET_MS)
/** Instante UTC correspondiente a medianoche de Bogotá */
const bogotaMidnight = (y: number, m: number, day = 1) => new Date(Date.UTC(y, m, day) + TZ_OFFSET_MS)
const dayLabel = (d: Date) => d.toLocaleDateString('es-CO', { month: 'short', day: 'numeric', timeZone: TZ })
const weekLabel = (d: Date) => d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', timeZone: TZ })

/** PostgREST devuelve máx. 1000 filas por consulta: pagina hasta traerlas todas */
async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> {
  const PAGE = 1000
  const rows: T[] = []
  for (let from = 0; from < 100_000; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return rows
}

async function count(supabase: ServerClient, table: 'orders' | 'products' | 'profiles', gte?: Date, lt?: Date) {
  let q = supabase.from(table).select('*', { count: 'exact', head: true })
  if (gte) q = q.gte('created_at', gte.toISOString())
  if (lt) q = q.lt('created_at', lt.toISOString())
  const { count: c } = await q
  return c || 0
}

export async function GET() {
  try {
    const { error: denied, supabase } = await getAdmin()
    if (denied) return denied

    const now = new Date()
    const local = bogota(now)
    const y = local.getUTCFullYear()
    const m = local.getUTCMonth()
    const startOfMonth = bogotaMidnight(y, m)
    const startOfLastMonth = bogotaMidnight(y, m - 1)

    const [paidOrders, soldItems, ordersThisMonth, ordersLastMonth, totalOrders, totalProducts, totalCustomers, newCustomers, recent] =
      await Promise.all([
        fetchAll<{ total: number; created_at: string }>((f, t) =>
          supabase.from('orders').select('total, created_at').in('status', PAID_STATUSES).order('created_at').range(f, t)
        ),
        // Sólo artículos de pedidos PAGADOS (antes contaba también pendientes y cancelados)
        fetchAll<any>((f, t) =>
          supabase
            .from('order_items')
            .select('product_name, price, quantity, order:orders!inner(status), product:products(category:categories(name))')
            .in('order.status', PAID_STATUSES)
            .range(f, t)
        ),
        count(supabase, 'orders', startOfMonth),
        count(supabase, 'orders', startOfLastMonth, startOfMonth),
        count(supabase, 'orders'),
        count(supabase, 'products'),
        count(supabase, 'profiles'),
        count(supabase, 'profiles', startOfMonth),
        supabase
          .from('orders')
          .select('id, order_number, total, status, created_at, shipping_address')
          .order('created_at', { ascending: false })
          .limit(8),
      ])

    // ── Ventas ────────────────────────────────────────────────────────────
    let totalRevenue = 0
    let totalSalesThisMonth = 0
    let totalSalesLastMonth = 0
    const dailyMap = new Map<string, number>()
    const weekMap = new Map<string, number>()
    const monthMap = new Map<string, number>()
    const quarterMap = new Map<string, number>()
    const oneYearAgo = now.getTime() - 365 * 24 * 60 * 60 * 1000

    for (const o of paidOrders) {
      const total = o.total || 0
      const created = new Date(o.created_at)
      totalRevenue += total
      if (created >= startOfMonth) totalSalesThisMonth += total
      else if (created >= startOfLastMonth) totalSalesLastMonth += total
      if (created.getTime() < oneYearAgo) continue

      const lc = bogota(created)
      dailyMap.set(dayLabel(created), (dailyMap.get(dayLabel(created)) || 0) + total)

      const weekStart = new Date(created.getTime() - ((lc.getUTCDay() + 6) % 7) * 86_400_000)
      weekMap.set(weekLabel(weekStart), (weekMap.get(weekLabel(weekStart)) || 0) + total)

      const monthKey = `${lc.getUTCFullYear()}-${lc.getUTCMonth()}`
      monthMap.set(monthKey, (monthMap.get(monthKey) || 0) + total)

      const quarterKey = `Q${Math.floor(lc.getUTCMonth() / 3) + 1} ${lc.getUTCFullYear()}`
      quarterMap.set(quarterKey, (quarterMap.get(quarterKey) || 0) + total)
    }

    const salesByDay = Array.from({ length: 30 }, (_, i) => {
      const label = dayLabel(new Date(now.getTime() - (29 - i) * 86_400_000))
      return { name: label, ventas: dailyMap.get(label) || 0 }
    })

    const currentWeekStart = new Date(now.getTime() - ((local.getUTCDay() + 6) % 7) * 86_400_000)
    const salesByWeek = Array.from({ length: 12 }, (_, i) => {
      const label = weekLabel(new Date(currentWeekStart.getTime() - (11 - i) * 7 * 86_400_000))
      return { name: label, ventas: weekMap.get(label) || 0 }
    })

    const salesByMonth = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(Date.UTC(y, m - (5 - i), 1))
      return { name: MONTHS[d.getUTCMonth()], ventas: monthMap.get(`${d.getUTCFullYear()}-${d.getUTCMonth()}`) || 0 }
    })

    const salesByQuarter = Array.from({ length: 4 }, (_, i) => {
      const d = new Date(Date.UTC(y, m - (3 - i) * 3, 1))
      const label = `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`
      return { name: label, ventas: quarterMap.get(label) || 0 }
    })

    // ── Top productos y ventas por categoría (sólo pedidos pagados) ───────
    const productSales = new Map<string, { name: string; total_sold: number; revenue: number; price: number; category: string }>()
    const catRevenue = new Map<string, number>()
    let itemsRevenue = 0
    for (const item of soldItems) {
      const revenue = (item.price || 0) * (item.quantity || 0)
      const category = item.product?.category?.name || 'Otros'
      const existing = productSales.get(item.product_name) || {
        name: item.product_name, total_sold: 0, revenue: 0, price: item.price, category,
      }
      existing.total_sold += item.quantity || 0
      existing.revenue += revenue
      productSales.set(item.product_name, existing)
      catRevenue.set(category, (catRevenue.get(category) || 0) + revenue)
      itemsRevenue += revenue
    }

    const topProducts = [...productSales.values()].sort((a, b) => b.total_sold - a.total_sold).slice(0, 6)
    const salesByCategory = [...catRevenue.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, value]) => ({ name, value: itemsRevenue > 0 ? Math.round((value / itemsRevenue) * 100) : 0 }))

    const recentOrders = (recent.data || []).map((o) => ({
      id: o.id,
      reference: o.order_number,
      customer_name: (o.shipping_address as any)?.name || 'Cliente',
      total: o.total,
      status: o.status,
    }))

    const pct = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : 0)

    return NextResponse.json({
      stats: {
        totalRevenue,
        totalSales: totalSalesThisMonth,
        totalOrders,
        ordersThisMonth,
        totalProducts,
        totalCustomers,
        newCustomersThisMonth: newCustomers,
        salesChange: pct(totalSalesThisMonth, totalSalesLastMonth),
        ordersChange: pct(ordersThisMonth, ordersLastMonth),
        productsChange: 0,
        customersChange: Math.round((newCustomers / Math.max(totalCustomers, 1)) * 1000) / 10,
      },
      salesByDay,
      salesByWeek,
      salesByMonth,
      salesByQuarter,
      salesByCategory,
      recentOrders,
      topProducts,
    })
  } catch (error) {
    console.error('[admin/stats] error', { msg: (error as Error).message })
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
