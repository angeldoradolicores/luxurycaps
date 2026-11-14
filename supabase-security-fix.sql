-- =====================================================================
-- SECURITY FIX: RLS, stock atómico, expiración de órdenes, cupones
-- Ejecutar COMPLETO en el SQL Editor de Supabase (es idempotente).
-- Requisito para el código nuevo de app/api/orders y lib/payments.ts
-- =====================================================================

-- ---------- Columnas necesarias ----------
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS promo_code TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS discount INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_orders_pending_created ON public.orders (created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_orders_wompi_tx ON public.orders (wompi_transaction_id);

-- ---------- Helper admin (SECURITY DEFINER: evita recursión en políticas de profiles) ----------
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce((SELECT is_admin FROM public.profiles WHERE id = auth.uid()), false)
$$;
REVOKE ALL ON FUNCTION public.is_admin() FROM public;
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated, service_role;

-- =====================================================================
-- PROFILES: cada usuario solo ve/edita su fila y NUNCA puede tocar is_admin
-- =====================================================================
DROP POLICY IF EXISTS "Public profiles are viewable by everyone" ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can insert their own profile" ON public.profiles;
DROP POLICY IF EXISTS profiles_select_own ON public.profiles;
DROP POLICY IF EXISTS profiles_select_admin ON public.profiles;
DROP POLICY IF EXISTS profiles_update_own ON public.profiles;
DROP POLICY IF EXISTS profiles_insert_own ON public.profiles;

CREATE POLICY profiles_select_own   ON public.profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY profiles_select_admin ON public.profiles FOR SELECT USING (public.is_admin());
CREATE POLICY profiles_update_own   ON public.profiles FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
CREATE POLICY profiles_insert_own   ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id AND coalesce(is_admin, false) = false);

-- Bloquea cambios de is_admin desde anon/authenticated (SQL Editor y service_role siguen pudiendo)
CREATE OR REPLACE FUNCTION public.protect_is_admin() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_admin IS DISTINCT FROM OLD.is_admin AND auth.role() IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'is_admin solo puede modificarse desde el servidor';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_protect_is_admin ON public.profiles;
CREATE TRIGGER trg_protect_is_admin BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_is_admin();

-- =====================================================================
-- ORDERS: lectura propia/admin. INSERT solo vía backend (service_role)
-- =====================================================================
DROP POLICY IF EXISTS "Users can view own orders" ON public.orders;
DROP POLICY IF EXISTS "Users can view their own orders" ON public.orders;
DROP POLICY IF EXISTS "Users can create orders" ON public.orders;
DROP POLICY IF EXISTS "Users can insert their own orders" ON public.orders;
DROP POLICY IF EXISTS "Admins can view all orders" ON public.orders;
DROP POLICY IF EXISTS "Admins can modify orders" ON public.orders;
DROP POLICY IF EXISTS "Only admins can update orders" ON public.orders;
DROP POLICY IF EXISTS orders_select_own ON public.orders;
DROP POLICY IF EXISTS orders_select_admin ON public.orders;
DROP POLICY IF EXISTS orders_update_admin ON public.orders;

CREATE POLICY orders_select_own   ON public.orders FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY orders_select_admin ON public.orders FOR SELECT USING (public.is_admin());
CREATE POLICY orders_update_admin ON public.orders FOR UPDATE USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Ni siquiera un admin con su JWT puede marcar 'paid' a mano: solo service_role (lib/payments.ts)
CREATE OR REPLACE FUNCTION public.protect_order_paid() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid' AND auth.role() IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'El estado paid solo lo asigna la confirmación de Wompi';
  END IF;
  IF (NEW.total, NEW.subtotal, NEW.shipping_cost, NEW.discount) IS DISTINCT FROM (OLD.total, OLD.subtotal, OLD.shipping_cost, OLD.discount)
     AND auth.role() IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'Los montos de una orden no se pueden modificar';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_protect_order_paid ON public.orders;
CREATE TRIGGER trg_protect_order_paid BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.protect_order_paid();

-- =====================================================================
-- ORDER_ITEMS
-- =====================================================================
DROP POLICY IF EXISTS "Order items viewable by order owner" ON public.order_items;
DROP POLICY IF EXISTS "Users can view their order items" ON public.order_items;
DROP POLICY IF EXISTS "Order items insertable with order" ON public.order_items;
DROP POLICY IF EXISTS "Users can insert order items" ON public.order_items;
DROP POLICY IF EXISTS "Admins can view all order items" ON public.order_items;
DROP POLICY IF EXISTS order_items_select_own ON public.order_items;
DROP POLICY IF EXISTS order_items_select_admin ON public.order_items;

CREATE POLICY order_items_select_own ON public.order_items FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_items.order_id AND o.user_id = auth.uid())
);
CREATE POLICY order_items_select_admin ON public.order_items FOR SELECT USING (public.is_admin());

-- =====================================================================
-- NOTIFICATIONS / PROMOTIONS
-- =====================================================================
-- service_role ignora RLS: esta política solo abría INSERT a cualquiera
DROP POLICY IF EXISTS "Service role can insert notifications" ON public.notifications;
-- Los códigos solo se validan vía /api/promotions (service_role); no se pueden enumerar con la anon key
DROP POLICY IF EXISTS "Active promotions viewable by everyone" ON public.promotions;

-- =====================================================================
-- STOCK: reserva atómica, liberación, expiración de pendientes
-- =====================================================================
DROP FUNCTION IF EXISTS public.decrement_stock(uuid, integer);

CREATE OR REPLACE FUNCTION public.reserve_stock(p_items jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; n int;
BEGIN
  FOR r IN
    SELECT (e->>'product_id')::uuid AS pid, sum((e->>'quantity')::int) AS qty
    FROM jsonb_array_elements(p_items) e
    GROUP BY 1
    ORDER BY 1            -- orden fijo: evita deadlocks entre compras simultáneas
  LOOP
    IF r.qty IS NULL OR r.qty <= 0 THEN RAISE EXCEPTION 'INVALID_QTY'; END IF;
    UPDATE public.products SET stock = stock - r.qty WHERE id = r.pid AND stock >= r.qty;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN RAISE EXCEPTION 'OUT_OF_STOCK:%', r.pid; END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.release_order_stock(p_order_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.products p SET stock = p.stock + s.qty
  FROM (
    SELECT product_id, sum(quantity) AS qty
    FROM public.order_items
    WHERE order_id = p_order_id AND product_id IS NOT NULL
    GROUP BY product_id
  ) s
  WHERE p.id = s.product_id;
$$;

CREATE OR REPLACE FUNCTION public.expire_pending_orders() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record;
BEGIN
  FOR r IN
    UPDATE public.orders SET status = 'cancelled', updated_at = now()
    WHERE status = 'pending' AND created_at < now() - interval '2 hours'
    RETURNING id
  LOOP
    PERFORM public.release_order_stock(r.id);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.increment_promo_usage(p_code text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.promotions SET used_count = coalesce(used_count, 0) + 1 WHERE code = p_code;
$$;

-- Las funciones en public se exponen por /rest/v1/rpc: solo el backend puede ejecutarlas
REVOKE ALL ON FUNCTION public.reserve_stock(jsonb)          FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_order_stock(uuid)     FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.expire_pending_orders()       FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.increment_promo_usage(text)   FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_stock(jsonb)        TO service_role;
GRANT EXECUTE ON FUNCTION public.release_order_stock(uuid)   TO service_role;
GRANT EXECUTE ON FUNCTION public.expire_pending_orders()     TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_promo_usage(text) TO service_role;

-- =====================================================================
-- CRON: expirar órdenes pendientes cada 15 min
-- Requiere la extensión pg_cron (Database → Extensions → pg_cron)
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.unschedule('expire-pending-orders')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'expire-pending-orders');
SELECT cron.schedule('expire-pending-orders', '*/15 * * * *', $$SELECT public.expire_pending_orders()$$);

-- =====================================================================
-- VERIFICACIÓN
-- =====================================================================
-- SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' ORDER BY 1, 2;
