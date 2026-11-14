-- =====================================================================
-- SECURITY FIX 2: rate limiting persistente + higiene de carrito
-- Ejecutar COMPLETO en el SQL Editor de Supabase (es idempotente).
-- Requisito para lib/rate-limit.ts
-- =====================================================================

-- ---------- Rate limiting (ventana fija, compartido entre instancias serverless) ----------
CREATE TABLE IF NOT EXISTS public.rate_limits (
  key          TEXT PRIMARY KEY,          -- hash SHA-256 de "bucket:identificador" (no se guarda la IP en claro)
  window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  count        INTEGER NOT NULL DEFAULT 0
);
-- RLS activado y SIN políticas: solo service_role puede leer/escribir
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.check_rate_limit(p_key text, p_limit int, p_window_seconds int)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int;
BEGIN
  INSERT INTO public.rate_limits AS r (key, window_start, count)
  VALUES (p_key, now(), 1)
  ON CONFLICT (key) DO UPDATE SET
    count = CASE WHEN r.window_start < now() - make_interval(secs => p_window_seconds) THEN 1 ELSE r.count + 1 END,
    window_start = CASE WHEN r.window_start < now() - make_interval(secs => p_window_seconds) THEN now() ELSE r.window_start END
  RETURNING count INTO v_count;
  RETURN v_count <= p_limit;
END $$;

REVOKE ALL ON FUNCTION public.check_rate_limit(text, int, int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(text, int, int) TO service_role;

-- Limpieza diaria de contadores viejos
SELECT cron.unschedule('purge-rate-limits')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-rate-limits');
SELECT cron.schedule('purge-rate-limits', '17 3 * * *',
  $$DELETE FROM public.rate_limits WHERE window_start < now() - interval '1 day'$$);

-- ---------- Carrito: color/talla nunca NULL (NULL rompe el UNIQUE y duplica filas) ----------
-- Elimina duplicados que se hayan creado por NULL (conserva una fila por producto/color/talla)
DELETE FROM public.cart_items a
USING public.cart_items b
WHERE a.ctid < b.ctid
  AND a.user_id = b.user_id
  AND a.product_id = b.product_id
  AND coalesce(a.selected_color, '') = coalesce(b.selected_color, '')
  AND coalesce(a.selected_size, '') = coalesce(b.selected_size, '');
UPDATE public.cart_items SET selected_color = '' WHERE selected_color IS NULL;
UPDATE public.cart_items SET selected_size  = '' WHERE selected_size  IS NULL;
ALTER TABLE public.cart_items ALTER COLUMN selected_color SET DEFAULT '';
ALTER TABLE public.cart_items ALTER COLUMN selected_size  SET DEFAULT '';
ALTER TABLE public.cart_items ALTER COLUMN selected_color SET NOT NULL;
ALTER TABLE public.cart_items ALTER COLUMN selected_size  SET NOT NULL;

-- Cantidad razonable en carrito
ALTER TABLE public.cart_items DROP CONSTRAINT IF EXISTS cart_items_quantity_check;
UPDATE public.cart_items SET quantity = LEAST(GREATEST(quantity, 1), 20);
ALTER TABLE public.cart_items ADD CONSTRAINT cart_items_quantity_check CHECK (quantity BETWEEN 1 AND 20);

-- =====================================================================
-- VERIFICACIÓN
-- =====================================================================
-- SELECT public.check_rate_limit('test', 2, 60);  -- true, true, false...
-- SELECT * FROM cron.job;
