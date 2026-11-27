-- Sólo para el PostgreSQL temporal creado por test-payments.cjs.
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE TYPE order_status AS ENUM ('pending','paid','processing','shipped','delivered','cancelled');
CREATE TABLE profiles(id uuid PRIMARY KEY, is_admin boolean);
CREATE TABLE products(id uuid PRIMARY KEY, stock integer NOT NULL);
CREATE TABLE promotions(code text PRIMARY KEY, used_count integer, max_uses integer, active boolean);
CREATE TABLE orders(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_number text, user_id uuid, guest_email text,
  status order_status DEFAULT 'pending', total integer, subtotal integer, shipping_cost integer, discount integer,
  promo_code text, shipping_method text, shipping_address jsonb, payment_method text, notes text,
  wompi_transaction_id text, payment_reference text, payment_issue text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  shipped_at timestamptz, delivered_at timestamptz
);
CREATE TABLE order_items(
  id uuid DEFAULT gen_random_uuid(), order_id uuid REFERENCES orders, product_id uuid REFERENCES products,
  quantity integer, product_name text, product_image text, price integer, color text, size text
);
