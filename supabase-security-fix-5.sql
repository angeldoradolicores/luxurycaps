-- =====================================================================
-- Luxury Caps — Seguridad / correcciones (5): operaciones atómicas
-- Hallazgos de la auditoría de Codex (audit/results.json):
--   * el stock se liberaba aunque fallara la cancelación (inventario inflado)
--   * si fallaba la liberación de stock o el conteo del cupón, nunca se reintentaba
--   * un APPROVED que competía con la expiración perdía la alerta payment_issue
--   * checkouts simultáneos superaban el límite de usos del cupón y el tope de 3 pendientes
--   * un segundo pago APROBADO sobre un pedido ya pagado pasaba en silencio
-- Cada función hace TODO o NADA en una sola transacción. Si algo falla, se revierte
-- y el llamador (webhook de Wompi / cron / admin) puede reintentar sin duplicar efectos.
-- Ejecutar en Supabase > SQL Editor. Es idempotente (se puede repetir).
-- =====================================================================

-- 1) Crear pedido pendiente + ítems + reserva de stock, con topes verificados bajo bloqueo
CREATE OR REPLACE FUNCTION public.create_pending_order(p_order jsonb, p_items jsonb, p_max_pending int)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user  uuid := (p_order->>'user_id')::uuid;
  v_code  text := nullif(p_order->>'promo_code', '');
  v_id    uuid;
  v_promo record;
  n       int;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'USER_REQUIRED'; END IF;

  -- Serializa los checkouts del MISMO usuario (el tope de pendientes ya no se puede saltar)
  PERFORM pg_advisory_xact_lock(hashtextextended('create_order:' || v_user::text, 0));

  SELECT count(*) INTO n FROM orders WHERE user_id = v_user AND status = 'pending';
  IF n >= p_max_pending THEN RAISE EXCEPTION 'TOO_MANY_PENDING'; END IF;

  IF v_code IS NOT NULL THEN
    -- Bloquea la fila del cupón: dos compradores no pueden tomar el último uso a la vez
    SELECT * INTO v_promo FROM promotions WHERE code = v_code AND active FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PROMO_INVALID'; END IF;
    IF coalesce(v_promo.max_uses, 0) > 0 THEN
      SELECT count(*) INTO n FROM orders WHERE promo_code = v_code AND status = 'pending';
      IF coalesce(v_promo.used_count, 0) + n >= v_promo.max_uses THEN RAISE EXCEPTION 'PROMO_EXHAUSTED'; END IF;
    END IF;
  END IF;

  INSERT INTO orders (order_number, user_id, guest_email, status, subtotal, shipping_cost, discount,
                      promo_code, total, shipping_method, shipping_address, payment_method, notes)
  VALUES (p_order->>'order_number', v_user, NULL, 'pending',
          (p_order->>'subtotal')::int, (p_order->>'shipping_cost')::int, coalesce((p_order->>'discount')::int, 0),
          v_code, (p_order->>'total')::int, p_order->>'shipping_method', p_order->'shipping_address',
          'wompi', coalesce(p_order->>'notes', ''))
  RETURNING id INTO v_id;

  INSERT INTO order_items (order_id, product_id, product_name, product_image, price, quantity, color, size)
  SELECT v_id, (e->>'product_id')::uuid, e->>'product_name', coalesce(e->>'product_image', ''),
         (e->>'price')::int, (e->>'quantity')::int, coalesce(e->>'color', ''), coalesce(e->>'size', '')
  FROM jsonb_array_elements(p_items) e;

  -- Si no hay stock, la excepción revierte también el pedido y sus ítems (no quedan pedidos huérfanos)
  PERFORM reserve_stock(p_items);
  RETURN v_id;
END $$;

-- 2) Marcar pagado (pending -> paid) + contar el uso del cupón, en la misma transacción.
--    Devuelve: 'updated' | 'noop' | 'flagged' | 'not_found'
CREATE OR REPLACE FUNCTION public.mark_order_paid(p_order_id uuid, p_tx_id text, p_payment_ref text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o record;
BEGIN
  -- FOR UPDATE: espera a que termine cualquier cancelación/expiración en curso y lee el estado real
  SELECT id, status::text AS status, promo_code, wompi_transaction_id, payment_issue
    INTO o FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;

  IF o.status = 'pending' THEN
    UPDATE orders SET status = 'paid', wompi_transaction_id = p_tx_id, payment_reference = p_payment_ref,
                      updated_at = now()
     WHERE id = p_order_id;
    IF o.promo_code IS NOT NULL THEN
      UPDATE promotions SET used_count = coalesce(used_count, 0) + 1 WHERE code = o.promo_code;
    END IF;
    RETURN 'updated';
  END IF;

  -- Mismo evento repetido sobre un pedido ya pagado: nada que hacer
  IF o.status <> 'cancelled' AND o.wompi_transaction_id IS NOT DISTINCT FROM p_tx_id THEN
    RETURN 'noop';
  END IF;

  -- Pago aprobado sobre pedido cancelado, o un SEGUNDO pago aprobado: alerta para el admin
  IF o.payment_issue IS NULL THEN
    UPDATE orders
       SET payment_issue = CASE WHEN o.status = 'cancelled'
             THEN 'Wompi APROBÓ el pago (transacción ' || p_tx_id || ') pero el pedido estaba cancelado. Reembolsa o despacha manualmente.'
             ELSE 'Pago DUPLICADO: Wompi aprobó otra transacción (' || p_tx_id || ') para un pedido ya pagado (' ||
                  coalesce(o.wompi_transaction_id, '?') || '). Reembolsa el cobro extra.' END,
           updated_at = now()
     WHERE id = p_order_id;
    RETURN 'flagged';
  END IF;
  RETURN 'noop';
END $$;

-- 3) Cancelar + devolver stock, en la misma transacción. Sólo desde los estados indicados.
--    Devuelve true si canceló (y liberó, si p_release), false si el pedido ya no estaba en esos estados.
CREATE OR REPLACE FUNCTION public.cancel_order(p_order_id uuid, p_from text[], p_release boolean, p_tx_id text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  UPDATE orders
     SET status = 'cancelled',
         wompi_transaction_id = coalesce(p_tx_id, wompi_transaction_id),
         updated_at = now()
   WHERE id = p_order_id AND status::text = ANY (p_from)
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN RETURN false; END IF;
  IF p_release THEN PERFORM release_order_stock(p_order_id); END IF;
  RETURN true;
END $$;

-- 4) Expiración: cada pedido se cancela y libera en el mismo bloque.
--    Si falla uno, se revierte sólo ese y el cron lo reintenta en la siguiente pasada.
CREATE OR REPLACE FUNCTION public.expire_pending_orders() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT id FROM orders
     WHERE status = 'pending' AND created_at < now() - interval '2 hours'
     FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      PERFORM cancel_order(r.id, ARRAY['pending'], true, NULL);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'expire_pending_orders: % falló: %', r.id, SQLERRM;
    END;
  END LOOP;
END $$;

-- Sólo el backend (service_role) puede ejecutarlas
REVOKE ALL ON FUNCTION public.create_pending_order(jsonb, jsonb, int)          FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_order_paid(uuid, text, text)                FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_order(uuid, text[], boolean, text)        FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.expire_pending_orders()                          FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_pending_order(jsonb, jsonb, int)       TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_order_paid(uuid, text, text)             TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_order(uuid, text[], boolean, text)     TO service_role;
GRANT EXECUTE ON FUNCTION public.expire_pending_orders()                       TO service_role;

-- Verificación: deben aparecer las 4 funciones
SELECT proname FROM pg_proc
 WHERE pronamespace = 'public'::regnamespace
   AND proname IN ('create_pending_order', 'mark_order_paid', 'cancel_order', 'expire_pending_orders');
