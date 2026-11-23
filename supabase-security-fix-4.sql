-- =====================================================================
-- Luxury Caps — Seguridad / correcciones (4): conciliación de pagos
-- Ejecutar en Supabase > SQL Editor. Es idempotente (se puede repetir).
-- =====================================================================

-- Marca visible en el panel de admin cuando Wompi aprueba un pago
-- sobre un pedido que ya estaba cancelado (expirado o cancelado por el admin).
alter table public.orders add column if not exists payment_issue text;

create index if not exists orders_payment_issue_idx
  on public.orders (created_at desc) where payment_issue is not null;

-- Verificación
select column_name, data_type from information_schema.columns
where table_schema = 'public' and table_name = 'orders' and column_name = 'payment_issue';
