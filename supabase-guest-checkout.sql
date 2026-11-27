-- Compras sin registro. Ejecutar después de supabase-security-fix-7.sql.
-- Idempotente: conserva los límites por cliente y la reserva atómica de inventario.
-- El correo de invitado nunca concede acceso público a orders u order_items.
BEGIN;

CREATE INDEX IF NOT EXISTS idx_orders_pending_guest
  ON public.orders (guest_email) WHERE user_id IS NULL AND status = 'pending';

CREATE OR REPLACE FUNCTION public.create_pending_order(p_order jsonb, p_items jsonb, p_max_pending int)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user  uuid := (p_order->>'user_id')::uuid;
  v_guest text := nullif(lower(btrim(p_order->>'guest_email')), '');
  v_customer text;
  v_code  text := nullif(p_order->>'promo_code', '');
  v_id    uuid;
  v_promo record;
  r       record;
  n       int;
BEGIN
  IF v_user IS NULL AND (v_guest IS NULL OR length(v_guest) > 160 OR position('@' IN v_guest) < 2) THEN
    RAISE EXCEPTION 'GUEST_EMAIL_REQUIRED';
  END IF;
  v_customer := CASE WHEN v_user IS NOT NULL THEN 'user:' || v_user::text ELSE 'guest:' || v_guest END;

  -- Serializa los checkouts del MISMO cliente (topes de pedidos y de unidades)
  PERFORM pg_advisory_xact_lock(hashtextextended('create_order:' || v_customer, 0));

  SELECT count(*) INTO n FROM orders WHERE status = 'pending' AND
    ((v_user IS NOT NULL AND user_id = v_user) OR
     (v_user IS NULL AND user_id IS NULL AND guest_email = v_guest));
  IF n >= p_max_pending THEN RAISE EXCEPTION 'TOO_MANY_PENDING'; END IF;

  -- Unidades de un mismo producto reservadas por el cliente en pedidos pendientes
  FOR r IN
    SELECT (e->>'product_id')::uuid AS pid, sum((e->>'quantity')::int) AS qty
    FROM jsonb_array_elements(p_items) e
    GROUP BY 1
  LOOP
    SELECT coalesce(sum(oi.quantity), 0) INTO n
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
     WHERE o.status = 'pending' AND oi.product_id = r.pid AND
       ((v_user IS NOT NULL AND o.user_id = v_user) OR
        (v_user IS NULL AND o.user_id IS NULL AND o.guest_email = v_guest));
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
  VALUES (p_order->>'order_number', v_user, CASE WHEN v_user IS NULL THEN v_guest ELSE NULL END, 'pending',
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


COMMIT;
