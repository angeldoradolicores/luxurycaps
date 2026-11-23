-- =====================================================================
-- Luxury Caps — Seguridad / correcciones (3): admin
-- Ejecutar en Supabase > SQL Editor. Es idempotente (se puede repetir).
-- =====================================================================

-- 1) Reparar los slugs de categorías.
--    Un byte corrupto en el código borraba todas las letras, dejando slugs como "", "-1", "-2".
with base as (
  select
    id,
    coalesce(
      nullif(
        trim(both '-' from regexp_replace(
          lower(translate(name,
            'ÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇáàäâãéèëêíìïîóòöôõúùüûñç',
            'AAAAAEEEEIIIIOOOOOUUUUNCaaaaaeeeeiiiiooooouuuunc')),
          '[^a-z0-9]+', '-', 'g')),
        ''),
      'categoria') as slug,
    created_at
  from public.categories
),
numbered as (
  select id, slug, row_number() over (partition by slug order by created_at, id) as n
  from base
)
update public.categories c
set slug = case when n.n = 1 then n.slug else n.slug || '-' || (n.n - 1) end
from numbered n
where c.id = n.id
  and c.slug is distinct from (case when n.n = 1 then n.slug else n.slug || '-' || (n.n - 1) end);

-- 2) Bucket "products": sólo formatos seguros (sin SVG/HTML, que pueden contener scripts)
--    y máximo 50 MB por archivo.
update storage.buckets
set allowed_mime_types = array[
      'image/jpeg', 'image/png', 'image/webp', 'image/gif',
      'video/mp4', 'video/webm', 'video/quicktime'
    ],
    file_size_limit = 52428800
where id = 'products';

-- Verificación
select name, slug from public.categories order by name;
select id, allowed_mime_types, file_size_limit from storage.buckets where id = 'products';
