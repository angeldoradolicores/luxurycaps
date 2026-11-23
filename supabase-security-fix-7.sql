-- =====================================================================
-- Luxury Caps — Seguridad / correcciones (7): tope de reserva de stock por usuario
-- Hallazgo: una cuenta podía reservar todo el stock de un producto con pedidos
--   pendientes (30 líneas x 20 unidades = 600 por pedido, 3 pedidos a la vez) y
--   renovarlo al expirar. Aquí se limita, por usuario y producto, las unidades
--   reservadas en pedidos pendientes, bajo el mismo bloqueo que el tope de pedidos.
-- Ejecutar en Supabase > SQL Editor DESPUÉS de supabase-security-fix-6.sql. Idempotente.
-- El tope (20) debe coincidir con MAX_UNITS_PER_PRODUCT en app/api/orders/route.ts.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.create_pending_order(p_order jsonb, p_items jsonb, p_max_pending int)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user  uuid := (p_order->>'user_id')::uuid;
  v_code  text := nullif(p_order->>'promo_code', '');
  v_id    uuid;
  v_promo record;
  r       record;
  n       int;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'USER_REQUIRED'; END IF;

  -- Serializa los checkouts del MISMO usuario (topes de pedidos y de unidades)
  PERFORM pg_advisory_xact_lock(hashtextextended('create_order:' || v_user::text, 0));

  SELECT count(*) INTO n FROM orders WHERE user_id = v_user AND status = 'pending';
  IF n >= p_max_pending THEN RAISE EXCEPTION 'TOO_MANY_PENDING'; END IF;

  -- NUEVO: unidades de un mismo producto reservadas por el usuario en pedidos pendientes
  FOR r IN
    SELECT (e->>'product_id')::uuid AS pid, sum((e->>'quantity')::int) AS qty
    FROM jsonb_array_elements(p_items) e
    GROUP BY 1
  LOOP
    SELECT coalesce(sum(oi.quantity), 0) INTO n
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
     WHERE o.user_id = v_user AND o.status = 'pending' AND oi.product_id = r.pid;
    IF n + r.qty > 20 THEN RAISE EXCEPTION 'PRODUCT_LIMIT'; END IF;
  END LOOP;

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

  -- Si no hay stock, la excepción revierte también el pedido y sus ítems
  PERFORM reserve_stock(p_items);
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.create_pending_order(jsonb, jsonb, int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_pending_order(jsonb, jsonb, int) TO service_role;

-- Verificación
SELECT proname, prosrc LIKE '%PRODUCT_LIMIT%' AS tiene_tope_unidades
  FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'create_pending_order';
