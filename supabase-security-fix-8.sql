-- Pagos por intento y recuperación controlada de pedidos cancelados.
-- Ejecutar DESPUÉS de los parches anteriores y ANTES de desplegar el código.
-- No recupera ni modifica el estado de ningún pedido existente.
BEGIN;

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS cancelled_from text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS stock_released boolean;

CREATE TABLE IF NOT EXISTS public.order_payment_attempts (
  transaction_id text PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES public.orders(id),
  status text NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'DECLINED', 'ERROR', 'VOIDED')),
  amount_in_cents bigint NOT NULL,
  currency text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  checked_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS order_payment_attempts_order_idx ON public.order_payment_attempts(order_id);
ALTER TABLE public.order_payment_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_payment_attempts FROM anon, authenticated;
GRANT ALL ON public.order_payment_attempts TO service_role;

CREATE TABLE IF NOT EXISTS public.order_payment_recoveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id),
  transaction_id text NOT NULL,
  admin_id uuid NOT NULL,
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.order_payment_recoveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_payment_recoveries FROM anon, authenticated;
GRANT ALL ON public.order_payment_recoveries TO service_role;

-- Un rechazo pertenece a UN intento. Sólo una cancelación explícita o la
-- expiración del pedido libera el stock. Se registra de dónde se canceló.
CREATE OR REPLACE FUNCTION public.cancel_order(p_order_id uuid, p_from text[], p_release boolean, p_tx_id text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o record;
BEGIN
  SELECT * INTO o FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR o.status::text <> ALL(p_from) OR o.status = 'cancelled' THEN RETURN false; END IF;
  IF p_release IS DISTINCT FROM (o.status IN ('pending', 'paid', 'processing')) THEN
    RAISE EXCEPTION 'INVALID_STOCK_RELEASE';
  END IF;
  IF p_release THEN PERFORM release_order_stock(p_order_id); END IF;
  UPDATE orders SET status = 'cancelled', cancelled_from = o.status::text,
    stock_released = p_release, wompi_transaction_id = coalesce(p_tx_id, wompi_transaction_id),
    updated_at = now() WHERE id = p_order_id;
  RETURN true;
END $$;

-- Sólo recibe transacciones consultadas por el backend en la API de Wompi.
-- La fila del pedido serializa webhook, consulta de confirmación, cron y admin.
CREATE OR REPLACE FUNCTION public.apply_wompi_transaction(
  p_order_id uuid, p_tx_id text, p_status text, p_amount bigint, p_currency text,
  p_payment_ref text, p_created_at timestamptz, p_finalized_at timestamptz
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o record; a record; v_issue text;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('PENDING','APPROVED','DECLINED','ERROR','VOIDED')
     OR p_tx_id IS NULL OR length(p_tx_id) NOT BETWEEN 5 AND 64 THEN
    RAISE EXCEPTION 'INVALID_TRANSACTION';
  END IF;
  SELECT * INTO o FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  SELECT * INTO a FROM order_payment_attempts WHERE transaction_id = p_tx_id;
  IF FOUND THEN
    IF a.order_id <> p_order_id THEN RAISE EXCEPTION 'TRANSACTION_ORDER_MISMATCH'; END IF;
    -- Una consulta anterior que termina tarde no revierte un resultado definitivo.
    IF a.status = 'VOIDED' AND p_status <> 'VOIDED'
       OR a.status = 'APPROVED' AND p_status IN ('PENDING','DECLINED','ERROR')
       OR a.status <> 'PENDING' AND p_status = 'PENDING' THEN RETURN 'noop'; END IF;
  END IF;
  INSERT INTO order_payment_attempts(transaction_id, order_id, status, amount_in_cents, currency, created_at, finalized_at)
    VALUES(p_tx_id, p_order_id, p_status, p_amount, p_currency, coalesce(p_created_at, now()), p_finalized_at)
    ON CONFLICT(transaction_id) DO UPDATE SET status = excluded.status,
      amount_in_cents = excluded.amount_in_cents, currency = excluded.currency,
      finalized_at = excluded.finalized_at, checked_at = now(),
      resolved_at = CASE WHEN order_payment_attempts.status = excluded.status THEN order_payment_attempts.resolved_at ELSE NULL END;

  -- No reabrir una conciliación al recibir el mismo evento nuevamente.
  IF (a.status = p_status AND a.resolved_at IS NOT NULL)
     OR (p_status = 'APPROVED' AND position(p_tx_id IN coalesce(o.payment_issue_resolved, '')) > 0) THEN
    RETURN 'noop';
  END IF;

  IF p_currency IS DISTINCT FROM 'COP' OR p_amount IS DISTINCT FROM o.total::bigint * 100 THEN
    IF p_status = 'APPROVED' THEN
      v_issue := 'WOMPI_AMOUNT_MISMATCH: transacción ' || p_tx_id || '. El monto o la moneda no coincide con el pedido. Revisa el cobro.';
    ELSE RETURN 'mismatch'; END IF;
  ELSIF p_status = 'APPROVED' THEN
    IF o.status = 'pending' THEN
      UPDATE orders SET status = 'paid', wompi_transaction_id = p_tx_id,
        payment_reference = p_payment_ref, updated_at = now() WHERE id = p_order_id;
      IF o.promo_code IS NOT NULL THEN
        UPDATE promotions SET used_count = coalesce(used_count, 0) + 1 WHERE code = o.promo_code;
      END IF;
      RETURN 'updated';
    ELSIF o.status <> 'cancelled' AND o.wompi_transaction_id = p_tx_id THEN
      RETURN 'noop';
    ELSIF o.status = 'cancelled' THEN
      v_issue := 'Wompi APROBÓ el pago (transacción ' || p_tx_id || ') pero el pedido estaba cancelado. Usa la recuperación con pago verificado o concilia el reembolso.';
    ELSE
      v_issue := 'Pago DUPLICADO: Wompi aprobó otra transacción (' || p_tx_id || ') para un pedido ya pagado. Concilia el cobro extra.';
    END IF;
  ELSIF p_status = 'VOIDED' AND o.wompi_transaction_id = p_tx_id
      AND o.status IN ('paid','processing','shipped','delivered') THEN
    v_issue := 'WOMPI_VOIDED: Wompi ANULÓ la transacción ' || p_tx_id || '. No despaches: revisa el pago.';
  ELSE
    -- PENDING / DECLINED / ERROR / VOIDED de otro intento: pedido y stock intactos.
    RETURN 'noop';
  END IF;

  IF position(v_issue IN coalesce(o.payment_issue, '')) = 0 THEN
    UPDATE orders SET payment_issue = concat_ws(E'\n', payment_issue, v_issue), updated_at = now()
      WHERE id = p_order_id;
  END IF;
  RETURN 'flagged';
END $$;

-- Compatibilidad durante el despliegue: el backend anterior tampoco cancelará
-- pedidos por intentos fallidos ni enviará un correo de cancelación.
CREATE OR REPLACE FUNCTION public.apply_failed_wompi_transaction(p_order_id uuid, p_tx_id text, p_status text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_total bigint;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('DECLINED','ERROR','VOIDED') THEN RAISE EXCEPTION 'INVALID_STATUS'; END IF;
  SELECT total::bigint * 100 INTO v_total FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  RETURN apply_wompi_transaction(p_order_id,p_tx_id,p_status,v_total,'COP',NULL,NULL,NULL);
END $$;

CREATE OR REPLACE FUNCTION public.mark_order_paid(p_order_id uuid, p_tx_id text, p_payment_ref text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_total bigint;
BEGIN
  SELECT total::bigint * 100 INTO v_total FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  RETURN apply_wompi_transaction(p_order_id,p_tx_id,'APPROVED',v_total,'COP',p_payment_ref,NULL,NULL);
END $$;

CREATE OR REPLACE FUNCTION public.recover_cancelled_order(
  p_order_id uuid, p_tx_id text, p_amount bigint, p_currency text, p_payment_ref text,
  p_admin_id uuid, p_note text, p_expected_updated_at timestamptz, p_legacy_failed_tx_id text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o record; a record; v_items jsonb; v_count_promo boolean;
BEGIN
  IF p_note IS NULL OR length(trim(p_note)) NOT BETWEEN 5 AND 500 THEN RAISE EXCEPTION 'NOTE_REQUIRED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM profiles WHERE id = p_admin_id AND is_admin) THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  SELECT * INTO o FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;
  IF o.status <> 'cancelled' OR o.updated_at IS DISTINCT FROM p_expected_updated_at THEN RAISE EXCEPTION 'ORDER_CHANGED'; END IF;
  IF o.shipped_at IS NOT NULL OR o.delivered_at IS NOT NULL
     OR coalesce(o.cancelled_from, 'pending') NOT IN ('pending','paid','processing') THEN
    RAISE EXCEPTION 'ORDER_ALREADY_DISPATCHED';
  END IF;
  SELECT * INTO a FROM order_payment_attempts WHERE transaction_id = p_tx_id AND order_id = p_order_id;
  IF (FOUND AND (a.status = 'VOIDED' OR a.resolved_at IS NOT NULL))
     OR position(p_tx_id IN coalesce(o.payment_issue_resolved, '')) > 0 THEN
    RAISE EXCEPTION 'PAYMENT_NOT_RECOVERABLE';
  END IF;
  IF p_currency IS DISTINCT FROM 'COP' OR p_amount IS DISTINCT FROM o.total::bigint * 100
     THEN
    RAISE EXCEPTION 'PAYMENT_MISMATCH';
  END IF;
  -- Más de un cobro o una alerta distinta deben conciliarse por separado.
  -- Cada línea de la alerta activa debe ser "pago aprobado sobre pedido cancelado" de ESTE
  -- cobro. Las alertas anteriores a este parche (otro cobro, monto distinto) no tienen fila
  -- en order_payment_attempts, así que se validan por su texto y nunca se borran en silencio.
  IF EXISTS(SELECT 1 FROM order_payment_attempts WHERE order_id = p_order_id
      AND transaction_id <> p_tx_id AND status = 'APPROVED' AND resolved_at IS NULL)
     OR coalesce(o.payment_issue, '') ~ 'WOMPI_VOIDED|WOMPI_AMOUNT_MISMATCH|DUPLICADO'
     OR EXISTS(SELECT 1 FROM regexp_split_to_table(coalesce(o.payment_issue, ''), E'\n') AS l(line)
       WHERE btrim(line) <> ''
         AND NOT (starts_with(line, 'Wompi APROBÓ el pago (transacción ' || p_tx_id || ')')
                  AND position('pedido estaba cancelado' IN line) > 0)) THEN
    RAISE EXCEPTION 'OTHER_PAYMENT_ISSUES';
  END IF;
  IF o.cancelled_from IS NULL THEN
    -- Pedidos antiguos: el backend debe verificar en Wompi que el intento que
    -- causó la cancelación fue DECLINED/ERROR. No inferirlo de texto libre.
    IF p_legacy_failed_tx_id IS NULL OR p_legacy_failed_tx_id IS DISTINCT FROM o.wompi_transaction_id
       OR p_legacy_failed_tx_id = p_tx_id THEN RAISE EXCEPTION 'LEGACY_CANCELLATION_UNKNOWN'; END IF;
    v_count_promo := true;
  ELSE
    IF o.stock_released IS DISTINCT FROM true THEN RAISE EXCEPTION 'STOCK_RELEASE_UNKNOWN'; END IF;
    v_count_promo := o.cancelled_from = 'pending';
  END IF;
  SELECT jsonb_agg(jsonb_build_object('product_id', product_id, 'quantity', quantity))
    INTO v_items FROM order_items WHERE order_id = p_order_id;
  IF v_items IS NULL OR EXISTS(SELECT 1 FROM order_items WHERE order_id = p_order_id AND product_id IS NULL) THEN
    RAISE EXCEPTION 'ORDER_ITEMS_UNAVAILABLE';
  END IF;
  -- Mantener orden de bloqueos: pedido -> cupón -> productos (igual que checkout).
  IF v_count_promo AND o.promo_code IS NOT NULL THEN
    UPDATE promotions SET used_count = coalesce(used_count, 0) + 1 WHERE code = o.promo_code;
  END IF;
  PERFORM reserve_stock(v_items); -- falta de stock revierte TODO, incluido cupón/historial
  INSERT INTO order_payment_attempts(transaction_id,order_id,status,amount_in_cents,currency)
    VALUES(p_tx_id,p_order_id,'APPROVED',p_amount,p_currency)
    ON CONFLICT(transaction_id) DO UPDATE SET status = 'APPROVED', amount_in_cents = excluded.amount_in_cents,
      currency = excluded.currency, checked_at = now()
      WHERE order_payment_attempts.order_id = p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'TRANSACTION_ORDER_MISMATCH'; END IF;
  INSERT INTO order_payment_recoveries(order_id,transaction_id,admin_id,note)
    VALUES(p_order_id,p_tx_id,p_admin_id,trim(p_note));
  UPDATE orders SET status = 'paid', wompi_transaction_id = p_tx_id, payment_reference = p_payment_ref,
    cancelled_from = NULL, stock_released = false, payment_issue = NULL,
    -- La alerta que se cierra queda en el historial junto al motivo de la recuperación.
    payment_issue_resolved = concat_ws(E'\n\n', payment_issue_resolved,
      '[' || now() || '] ' || concat_ws(E'\n→ ', o.payment_issue,
        'Pedido recuperado por admin ' || p_admin_id || ' con la transacción ' || p_tx_id || ': ' || trim(p_note))),
    payment_issue_resolved_at = now(), updated_at = now() WHERE id = p_order_id;
  RETURN 'updated';
END $$;

CREATE OR REPLACE FUNCTION public.resolve_order_payment_issue(p_order_id uuid, p_admin_id uuid, p_note text, p_expected_issue text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o record;
BEGIN
  IF p_note IS NULL OR length(trim(p_note)) NOT BETWEEN 5 AND 500 THEN RAISE EXCEPTION 'NOTE_REQUIRED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM profiles WHERE id = p_admin_id AND is_admin) THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  SELECT * INTO o FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR o.payment_issue IS NULL OR o.payment_issue IS DISTINCT FROM p_expected_issue THEN RETURN false; END IF;
  UPDATE order_payment_attempts SET resolved_at = now()
    WHERE order_id = p_order_id AND position(transaction_id IN o.payment_issue) > 0;
  UPDATE orders SET payment_issue = NULL, payment_issue_resolved_at = now(), updated_at = now(),
    payment_issue_resolved = concat_ws(E'\n\n', payment_issue_resolved,
      '[' || now() || '] ' || payment_issue || E'\n→ Resuelto por admin ' || p_admin_id || ': ' || trim(p_note))
    WHERE id = p_order_id;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.apply_wompi_transaction(uuid,text,text,bigint,text,text,timestamptz,timestamptz) FROM public,anon,authenticated;
REVOKE ALL ON FUNCTION public.recover_cancelled_order(uuid,text,bigint,text,text,uuid,text,timestamptz,text) FROM public,anon,authenticated;
REVOKE ALL ON FUNCTION public.resolve_order_payment_issue(uuid,uuid,text,text) FROM public,anon,authenticated;
REVOKE ALL ON FUNCTION public.cancel_order(uuid,text[],boolean,text) FROM public,anon,authenticated;
REVOKE ALL ON FUNCTION public.mark_order_paid(uuid,text,text) FROM public,anon,authenticated;
REVOKE ALL ON FUNCTION public.apply_failed_wompi_transaction(uuid,text,text) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.apply_wompi_transaction(uuid,text,text,bigint,text,text,timestamptz,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.recover_cancelled_order(uuid,text,bigint,text,text,uuid,text,timestamptz,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_order_payment_issue(uuid,uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_order(uuid,text[],boolean,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_order_paid(uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_failed_wompi_transaction(uuid,text,text) TO service_role;
COMMIT;
