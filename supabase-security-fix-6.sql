-- =====================================================================
-- Luxury Caps — Seguridad / correcciones (6): auditoría Codex v2
--   A1: un pago ANULADO (VOIDED) después de aprobado dejaba el pedido "pagado" y despachable
--   B8: el admin, con su sesión, podía saltarse las transiciones (pendiente -> enviado) vía Supabase
-- Ejecutar en Supabase > SQL Editor DESPUÉS de supabase-security-fix-5.sql. Idempotente.
-- =====================================================================

-- Historial de alertas resueltas (la alerta activa sigue en payment_issue)
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_issue_resolved text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_issue_resolved_at timestamptz;

-- 1) Transacción fallida/anulada de Wompi, en una sola transacción:
--    - pedido pendiente      -> cancelar y devolver stock
--    - pago APROBADO anulado -> alerta y bloqueo de despacho (el pedido NO se toca solo)
--    - fallo de OTRO intento -> no afecta un pago válido
CREATE OR REPLACE FUNCTION public.apply_failed_wompi_transaction(p_order_id uuid, p_tx_id text, p_status text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o record;
BEGIN
  IF p_status NOT IN ('DECLINED', 'ERROR', 'VOIDED') THEN RAISE EXCEPTION 'INVALID_STATUS'; END IF;

  SELECT status::text AS status, wompi_transaction_id, payment_issue
    INTO o FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;

  IF o.status = 'pending' THEN
    PERFORM cancel_order(p_order_id, ARRAY['pending'], true, p_tx_id);
    RETURN 'updated';
  END IF;

  IF p_status = 'VOIDED' AND o.wompi_transaction_id = p_tx_id
     AND o.status IN ('paid', 'processing', 'shipped', 'delivered') THEN
    IF coalesce(o.payment_issue, '') NOT LIKE '%WOMPI_VOIDED%' THEN
      UPDATE orders
         SET payment_issue = concat_ws(E'\n', payment_issue,
               'WOMPI_VOIDED: Wompi ANULÓ la transacción ' || p_tx_id ||
               ' de este pedido ya pagado. No lo despaches: concilia con Wompi y decide si cancelar.'),
             updated_at = now()
       WHERE id = p_order_id;
    END IF;
    RETURN 'flagged';
  END IF;

  RETURN 'noop';
END $$;

REVOKE ALL ON FUNCTION public.apply_failed_wompi_transaction(uuid, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_failed_wompi_transaction(uuid, text, text) TO service_role;

-- 2) Ningún pedido con alerta de pago activa puede avanzar a preparación/envío/entrega.
--    Se aplica en la misma escritura de la fila, para cualquier rol (también service_role).
CREATE OR REPLACE FUNCTION public.block_unreconciled_dispatch() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.status IN ('processing', 'shipped', 'delivered')
     AND NEW.status IS DISTINCT FROM OLD.status
     AND (OLD.payment_issue IS NOT NULL OR NEW.payment_issue IS NOT NULL) THEN
    RAISE EXCEPTION 'PAYMENT_REVIEW_REQUIRED';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_block_unreconciled_dispatch ON public.orders;
CREATE TRIGGER trg_block_unreconciled_dispatch
  BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.block_unreconciled_dispatch();

-- 3) El admin ya no puede modificar pedidos directamente con su sesión:
--    todos los cambios pasan por la API del panel (transiciones validadas + service_role).
--    Sigue pudiendo VER todos los pedidos (orders_select_admin).
DROP POLICY IF EXISTS orders_update_admin ON public.orders;

-- Verificación
SELECT 'apply_failed_wompi_transaction' AS objeto, count(*) FROM pg_proc WHERE proname = 'apply_failed_wompi_transaction'
UNION ALL
SELECT 'trigger bloqueo despacho', count(*) FROM pg_trigger WHERE tgname = 'trg_block_unreconciled_dispatch'
UNION ALL
SELECT 'política update admin (debe ser 0)', count(*) FROM pg_policies WHERE tablename = 'orders' AND policyname = 'orders_update_admin';
