-- PawShop Commerce Fact Query v1
--
-- Purpose: one read-only, repeatable source for the core commerce metrics used
-- by operations and future reporting. Run against the PawShop PostgreSQL
-- database with psql. The transaction is explicitly read-only and the script
-- creates no views, tables, or other database objects.
--
-- Example:
--   sudo -u postgres psql --no-psqlrc --dbname pawshop \
--     --set ON_ERROR_STOP=1 --file _commerce/scripts/commerce-facts.sql

\set ON_ERROR_STOP on
\pset pager off

BEGIN TRANSACTION READ ONLY;

SELECT
  'pawshop_commerce_fact_v1'::text AS fact_version,
  current_database()::text AS database_name,
  transaction_timestamp() AS observed_at;

-- Definitions are emitted with every run so exported numbers retain their
-- meaning. Amounts use the order/payment currency and are never converted.
SELECT metric, definition
FROM (VALUES
  ('captured_orders',
   'Distinct non-deleted orders whose linked payment collections have captured_amount > 0.'),
  ('captured_revenue',
   'Sum of payment_collection.captured_amount for captured orders, before refunds. Authorization alone is excluded. This is financially real only after separately confirming that the payment provider is live rather than sandbox and is reconciled.'),
  ('product_revenue',
   'Current-version order item quantity * snapshot unit price, less line-item adjustments, for fully captured orders only; shipping is excluded.'),
  ('shipping',
   'Current-version shipping method amount, less shipping adjustments, for fully captured orders only.'),
  ('discount',
   'Current-version line-item adjustments plus shipping-method adjustments for fully captured orders.'),
  ('refund',
   'Sum of payment_collection.refunded_amount. Refund-table totals are checked separately for agreement.'),
  ('net_revenue',
   'captured_revenue minus refund.'),
  ('units_sold',
   'Sum of current-version order_item.quantity for fully captured orders; fulfillment quantity is not used.'),
  ('product_sku_sales',
   'Two separate dimensions: product rows group only by snapshot product_id; sku rows group by snapshot product_id, variant_id, and variant_sku. Snapshot titles are labels and never split a fact group.'),
  ('paying_customers',
   'Distinct non-null order.customer_id values on captured orders.'),
  ('first_purchase',
   'The earliest captured order for a customer, ordered by order.created_at then order.id.'),
  ('repeat_purchase',
   'A captured order after that customer''s first captured order. customer.has_account is never used.'),
  ('repeat_revenue',
   'Captured revenue from repeat-purchase orders.'),
  ('aov',
   'captured_revenue divided by captured_orders; this is gross captured AOV before refunds.'),
  ('fully_captured_order',
   'An order with captured_amount > 0 and captured_amount >= payment collection amount. Partial captures are excluded from item, product, SKU, shipping, discount, and units metrics and surfaced separately.'),
  ('partial_capture_scope',
   'Partial-capture count and revenue are reported separately. They remain in captured order/revenue/customer metrics but are excluded from component and unit attribution because no allocation rule is defined.')
) AS definitions(metric, definition)
ORDER BY metric;

-- Core facts. Current-version predicates prevent superseded order rows from
-- being counted. Order-line snapshot fields preserve the sold product/SKU even
-- if the live catalog changes later.
WITH
base_orders AS (
  SELECT o.id, o.display_id, o.customer_id, o.currency_code, o.created_at,
         o.version
  FROM "order" o
  WHERE o.deleted_at IS NULL
),
payment_by_order AS (
  SELECT bo.id AS order_id,
         count(DISTINCT pc.id) AS payment_collection_count,
         coalesce(sum(pc.amount), 0) AS order_amount,
         coalesce(sum(pc.authorized_amount), 0) AS authorized_amount,
         coalesce(sum(pc.captured_amount), 0) AS captured_amount,
         coalesce(sum(pc.refunded_amount), 0) AS refunded_amount
  FROM base_orders bo
  LEFT JOIN order_payment_collection opc
    ON opc.order_id = bo.id AND opc.deleted_at IS NULL
  LEFT JOIN payment_collection pc
    ON pc.id = opc.payment_collection_id AND pc.deleted_at IS NULL
  GROUP BY bo.id
),
order_facts AS (
  SELECT bo.*,
         pbo.payment_collection_count,
         pbo.order_amount,
         pbo.authorized_amount,
         pbo.captured_amount,
         pbo.refunded_amount,
         pbo.captured_amount > 0 AS is_captured,
         pbo.captured_amount > 0
           AND pbo.captured_amount >= pbo.order_amount AS is_fully_captured
  FROM base_orders bo
  JOIN payment_by_order pbo ON pbo.order_id = bo.id
),
captured_order_sequence AS (
  SELECT ofa.*,
         row_number() OVER (
           PARTITION BY ofa.customer_id
           ORDER BY ofa.created_at, ofa.id
         ) AS purchase_sequence
  FROM order_facts ofa
  WHERE ofa.is_captured
),
current_items AS (
  SELECT bo.id AS order_id,
         oli.product_id,
         oli.product_title,
         oli.variant_id,
         oli.variant_title,
         oli.variant_sku,
         oi.item_id,
         oi.quantity,
         oli.unit_price,
         coalesce(sum(adj.amount), 0) AS line_discount
  FROM base_orders bo
  JOIN order_item oi
    ON oi.order_id = bo.id
   AND oi.version = bo.version
   AND oi.deleted_at IS NULL
  JOIN order_line_item oli
    ON oli.id = oi.item_id
   AND oli.deleted_at IS NULL
  LEFT JOIN order_line_item_adjustment adj
    ON adj.item_id = oli.id
   AND adj.version = bo.version
   AND adj.deleted_at IS NULL
  GROUP BY bo.id, oli.product_id, oli.product_title, oli.variant_id,
           oli.variant_title, oli.variant_sku, oi.item_id, oi.quantity,
           oli.unit_price
),
item_by_order AS (
  SELECT ci.order_id,
         sum(ci.quantity) AS units,
         sum(ci.quantity * ci.unit_price) AS gross_product_revenue,
         sum(ci.line_discount) AS line_discount
  FROM current_items ci
  GROUP BY ci.order_id
),
shipping_by_order AS (
  SELECT bo.id AS order_id,
         coalesce(sum(osm.amount), 0) AS gross_shipping,
         coalesce(sum(adj.amount), 0) AS shipping_discount
  FROM base_orders bo
  LEFT JOIN order_shipping os
    ON os.order_id = bo.id
   AND os.version = bo.version
   AND os.deleted_at IS NULL
  LEFT JOIN order_shipping_method osm
    ON osm.id = os.shipping_method_id
   AND osm.deleted_at IS NULL
  LEFT JOIN (
    SELECT osma.shipping_method_id, osma.version, sum(osma.amount) AS amount
    FROM order_shipping_method_adjustment osma
    WHERE osma.deleted_at IS NULL
    GROUP BY osma.shipping_method_id, osma.version
  ) adj
    ON adj.shipping_method_id = osm.id
   AND adj.version = bo.version
  GROUP BY bo.id
),
captured_summary AS (
  SELECT
    cos.currency_code,
    count(*) AS captured_orders,
    count(*) FILTER (WHERE cos.is_fully_captured) AS fully_captured_orders,
    count(*) FILTER (WHERE NOT cos.is_fully_captured) AS partial_capture_orders,
    count(DISTINCT cos.customer_id) FILTER (WHERE cos.customer_id IS NOT NULL)
      AS paying_customers,
    sum(cos.captured_amount) AS captured_revenue,
    sum(cos.captured_amount) FILTER (WHERE NOT cos.is_fully_captured)
      AS partial_captured_revenue,
    sum(cos.refunded_amount) AS refund,
    sum(cos.captured_amount - cos.refunded_amount) AS net_revenue,
    sum(ibo.gross_product_revenue - ibo.line_discount)
      FILTER (WHERE cos.is_fully_captured) AS product_revenue,
    sum(sbo.gross_shipping - sbo.shipping_discount)
      FILTER (WHERE cos.is_fully_captured) AS shipping,
    sum(coalesce(ibo.line_discount, 0) + coalesce(sbo.shipping_discount, 0))
      FILTER (WHERE cos.is_fully_captured) AS discount,
    sum(ibo.units) FILTER (WHERE cos.is_fully_captured) AS units_sold,
    count(*) FILTER (
      WHERE cos.customer_id IS NOT NULL AND cos.purchase_sequence = 1
    ) AS first_purchases,
    count(*) FILTER (
      WHERE cos.customer_id IS NOT NULL AND cos.purchase_sequence > 1
    ) AS repeat_purchases,
    sum(cos.captured_amount) FILTER (
      WHERE cos.customer_id IS NOT NULL AND cos.purchase_sequence > 1
    )
      AS repeat_revenue
  FROM captured_order_sequence cos
  LEFT JOIN item_by_order ibo ON ibo.order_id = cos.id
  LEFT JOIN shipping_by_order sbo ON sbo.order_id = cos.id
  GROUP BY cos.currency_code
),
order_count_by_currency AS (
  SELECT currency_code, count(*) AS total_orders
  FROM base_orders
  GROUP BY currency_code
)
SELECT
  oc.currency_code,
  oc.total_orders,
  cs.captured_orders,
  cs.fully_captured_orders,
  cs.partial_capture_orders,
  cs.captured_revenue,
  coalesce(cs.partial_captured_revenue, 0) AS partial_captured_revenue,
  cs.product_revenue,
  cs.shipping,
  cs.discount,
  cs.refund,
  cs.net_revenue,
  cs.units_sold,
  cs.paying_customers,
  cs.first_purchases,
  cs.repeat_purchases,
  cs.repeat_revenue,
  round(cs.captured_revenue / nullif(cs.captured_orders, 0), 2) AS aov
FROM order_count_by_currency oc
LEFT JOIN captured_summary cs ON cs.currency_code = oc.currency_code
ORDER BY oc.currency_code;

-- Product/SKU facts for fully captured orders only.
WITH
base_orders AS (
  SELECT o.id, o.version, o.currency_code
  FROM "order" o
  WHERE o.deleted_at IS NULL
),
payment_by_order AS (
  SELECT bo.id AS order_id,
         bo.currency_code,
         coalesce(sum(pc.amount), 0) AS order_amount,
         coalesce(sum(pc.captured_amount), 0) AS captured_amount
  FROM base_orders bo
  LEFT JOIN order_payment_collection opc
    ON opc.order_id = bo.id AND opc.deleted_at IS NULL
  LEFT JOIN payment_collection pc
    ON pc.id = opc.payment_collection_id AND pc.deleted_at IS NULL
  GROUP BY bo.id, bo.currency_code
),
fully_captured_orders AS (
  SELECT order_id
  FROM payment_by_order
  WHERE captured_amount > 0 AND captured_amount >= order_amount
),
current_items AS (
  SELECT bo.id AS order_id,
         bo.currency_code,
         oli.product_id,
         oli.product_title,
         oli.variant_id,
         oli.variant_title,
         oli.variant_sku,
         oi.item_id,
         oi.quantity,
         oli.unit_price,
         coalesce(sum(adj.amount), 0) AS line_discount
  FROM base_orders bo
  JOIN fully_captured_orders fco ON fco.order_id = bo.id
  JOIN order_item oi
    ON oi.order_id = bo.id
   AND oi.version = bo.version
   AND oi.deleted_at IS NULL
  JOIN order_line_item oli
    ON oli.id = oi.item_id
   AND oli.deleted_at IS NULL
  LEFT JOIN order_line_item_adjustment adj
    ON adj.item_id = oli.id
   AND adj.version = bo.version
   AND adj.deleted_at IS NULL
  GROUP BY bo.id, bo.currency_code, oli.product_id, oli.product_title, oli.variant_id,
           oli.variant_title, oli.variant_sku, oi.item_id, oi.quantity,
           oli.unit_price
),
sales_dimensions AS (
  SELECT
    'product'::text AS dimension_type,
    currency_code,
    product_id AS dimension_key,
    product_id,
    max(product_title) AS product_title,
    NULL::text AS variant_id,
    NULL::text AS variant_title,
    NULL::text AS sku,
    sum(quantity) AS units_sold,
    sum(quantity * unit_price) AS gross_product_revenue,
    sum(line_discount) AS discount,
    sum(quantity * unit_price - line_discount) AS product_revenue
  FROM current_items
  GROUP BY currency_code, product_id

  UNION ALL

  SELECT
    'sku'::text AS dimension_type,
    currency_code,
    coalesce(variant_sku, variant_id) AS dimension_key,
    product_id,
    max(product_title) AS product_title,
    variant_id,
    max(variant_title) AS variant_title,
    variant_sku AS sku,
    sum(quantity) AS units_sold,
    sum(quantity * unit_price) AS gross_product_revenue,
    sum(line_discount) AS discount,
    sum(quantity * unit_price - line_discount) AS product_revenue
  FROM current_items
  GROUP BY currency_code, product_id, variant_id, variant_sku
)
SELECT *
FROM sales_dimensions
ORDER BY dimension_type, currency_code, product_revenue DESC, dimension_key;

-- Integrity checks return one row per invariant. A zero issue_count is clean.
-- Nonzero rows are evidence to investigate; this script never repairs them.
WITH
base_orders AS (
  SELECT o.id, o.customer_id, o.currency_code, o.version
  FROM "order" o
  WHERE o.deleted_at IS NULL
),
current_items AS (
  SELECT bo.id AS order_id, bo.version, oi.item_id,
         oli.id AS line_item_id, oi.quantity,
         oli.product_id, oli.variant_id, oli.variant_sku
  FROM base_orders bo
  LEFT JOIN order_item oi
    ON oi.order_id = bo.id
   AND oi.version = bo.version
   AND oi.deleted_at IS NULL
  LEFT JOIN order_line_item oli
    ON oli.id = oi.item_id
   AND oli.deleted_at IS NULL
),
refund_by_payment AS (
  SELECT r.payment_id, sum(r.amount) AS refund_table_amount
  FROM refund r
  WHERE r.deleted_at IS NULL
  GROUP BY r.payment_id
),
capture_by_payment AS (
  SELECT c.payment_id,
         count(*) AS capture_rows,
         sum(c.amount) AS captured_amount,
         count(*) FILTER (WHERE c.amount < 0) AS negative_capture_rows
  FROM capture c
  WHERE c.deleted_at IS NULL
  GROUP BY c.payment_id
),
payment_by_collection AS (
  SELECT pc.id AS payment_collection_id,
         pc.currency_code,
         pc.amount,
         pc.captured_amount,
         pc.refunded_amount,
         coalesce(sum(cbp.capture_rows), 0) AS capture_rows,
         coalesce(sum(cbp.captured_amount), 0) AS capture_table_amount,
         count(*) FILTER (
           WHERE p.id IS NOT NULL
             AND p.currency_code IS DISTINCT FROM pc.currency_code
         ) AS payment_currency_mismatches,
         count(*) FILTER (
           WHERE p.id IS NOT NULL AND p.amount < 0
         ) + coalesce(sum(cbp.negative_capture_rows), 0)
           AS negative_payment_or_capture_rows,
         coalesce(sum(rbp.refund_table_amount), 0) AS refund_table_amount
  FROM payment_collection pc
  LEFT JOIN payment p
    ON p.payment_collection_id = pc.id AND p.deleted_at IS NULL
  LEFT JOIN capture_by_payment cbp ON cbp.payment_id = p.id
  LEFT JOIN refund_by_payment rbp ON rbp.payment_id = p.id
  WHERE pc.deleted_at IS NULL
  GROUP BY pc.id, pc.currency_code, pc.amount, pc.captured_amount,
           pc.refunded_amount
),
payment_by_order AS (
  SELECT bo.id AS order_id,
         count(DISTINCT pbc.payment_collection_id) AS payment_collection_count,
         coalesce(sum(pbc.amount), 0) AS order_amount,
         coalesce(sum(pbc.captured_amount), 0) AS captured_amount,
         coalesce(sum(pbc.refunded_amount), 0) AS refunded_amount,
         coalesce(sum(pbc.capture_rows), 0) AS capture_rows,
         coalesce(sum(pbc.capture_table_amount), 0) AS capture_table_amount,
         count(*) FILTER (
           WHERE pbc.payment_collection_id IS NOT NULL
             AND pbc.currency_code IS DISTINCT FROM bo.currency_code
         ) AS collection_currency_mismatches,
         coalesce(sum(pbc.payment_currency_mismatches), 0)
           AS payment_currency_mismatches,
         count(*) FILTER (
           WHERE pbc.captured_amount < 0 OR pbc.refunded_amount < 0
         ) + coalesce(sum(pbc.negative_payment_or_capture_rows), 0)
           AS negative_payment_amount_rows,
         count(*) FILTER (
           WHERE pbc.refunded_amount > pbc.captured_amount
         ) AS refund_exceeds_capture_rows,
         coalesce(sum(pbc.refund_table_amount), 0) AS refund_table_amount
  FROM base_orders bo
  LEFT JOIN order_payment_collection opc
    ON opc.order_id = bo.id AND opc.deleted_at IS NULL
  LEFT JOIN payment_by_collection pbc
    ON pbc.payment_collection_id = opc.payment_collection_id
  GROUP BY bo.id
),
fulfillment_by_order AS (
  SELECT ofl.order_id,
         bool_or(f.delivered_at IS NOT NULL) AS delivered
  FROM order_fulfillment ofl
  JOIN fulfillment f
    ON f.id = ofl.fulfillment_id
   AND f.deleted_at IS NULL
   AND f.canceled_at IS NULL
  WHERE ofl.deleted_at IS NULL
  GROUP BY ofl.order_id
),
fulfillment_line_facts AS (
  SELECT ofl.order_id, fi.line_item_id,
         sum(fi.quantity) AS fulfilled_quantity,
         count(*) FILTER (WHERE fi.quantity <= 0) AS nonpositive_rows
  FROM order_fulfillment ofl
  JOIN fulfillment f
    ON f.id = ofl.fulfillment_id
   AND f.deleted_at IS NULL
   AND f.canceled_at IS NULL
  JOIN fulfillment_item fi
    ON fi.fulfillment_id = f.id
   AND fi.deleted_at IS NULL
  WHERE ofl.deleted_at IS NULL
  GROUP BY ofl.order_id, fi.line_item_id
),
checks AS (
  SELECT 'order_without_customer_id'::text AS check_name,
         count(*) FILTER (WHERE bo.customer_id IS NULL)::bigint AS issue_count
  FROM base_orders bo

  UNION ALL
  SELECT 'order_with_missing_customer', count(*) FILTER (WHERE c.id IS NULL)::bigint
  FROM base_orders bo
  LEFT JOIN customer c ON c.id = bo.customer_id AND c.deleted_at IS NULL

  UNION ALL
  SELECT 'order_without_current_item', count(*)::bigint
  FROM base_orders bo
  WHERE NOT EXISTS (
    SELECT 1 FROM current_items ci
    WHERE ci.order_id = bo.id AND ci.item_id IS NOT NULL
  )

  UNION ALL
  SELECT 'item_without_line_snapshot', count(*) FILTER (
    WHERE item_id IS NOT NULL AND line_item_id IS NULL
  )::bigint
  FROM current_items

  UNION ALL
  SELECT 'item_without_product_id', count(*) FILTER (
    WHERE line_item_id IS NOT NULL AND product_id IS NULL
  )::bigint FROM current_items

  UNION ALL
  SELECT 'item_without_variant_id', count(*) FILTER (
    WHERE line_item_id IS NOT NULL AND variant_id IS NULL
  )::bigint FROM current_items

  UNION ALL
  SELECT 'item_without_sku_snapshot', count(*) FILTER (
    WHERE line_item_id IS NOT NULL AND nullif(btrim(variant_sku), '') IS NULL
  )::bigint FROM current_items

  UNION ALL
  SELECT 'item_with_nonpositive_quantity', count(*) FILTER (
    WHERE line_item_id IS NOT NULL AND quantity <= 0
  )::bigint FROM current_items

  UNION ALL
  SELECT 'snapshot_product_missing_from_catalog', count(*) FILTER (
    WHERE ci.product_id IS NOT NULL AND p.id IS NULL
  )::bigint
  FROM current_items ci
  LEFT JOIN product p ON p.id = ci.product_id AND p.deleted_at IS NULL

  UNION ALL
  SELECT 'snapshot_variant_missing_from_catalog', count(*) FILTER (
    WHERE ci.variant_id IS NOT NULL AND pv.id IS NULL
  )::bigint
  FROM current_items ci
  LEFT JOIN product_variant pv
    ON pv.id = ci.variant_id AND pv.deleted_at IS NULL

  UNION ALL
  SELECT 'variant_product_mismatch', count(*) FILTER (
    WHERE pv.id IS NOT NULL AND pv.product_id IS DISTINCT FROM ci.product_id
  )::bigint
  FROM current_items ci
  LEFT JOIN product_variant pv
    ON pv.id = ci.variant_id AND pv.deleted_at IS NULL

  UNION ALL
  SELECT 'catalog_sku_differs_from_snapshot', count(*) FILTER (
    WHERE pv.id IS NOT NULL AND pv.sku IS DISTINCT FROM ci.variant_sku
  )::bigint
  FROM current_items ci
  LEFT JOIN product_variant pv
    ON pv.id = ci.variant_id AND pv.deleted_at IS NULL

  UNION ALL
  SELECT 'order_without_payment_collection', count(*) FILTER (
    WHERE payment_collection_count = 0
  )::bigint FROM payment_by_order

  UNION ALL
  SELECT 'order_with_multiple_payment_collections', count(*) FILTER (
    WHERE payment_collection_count > 1
  )::bigint FROM payment_by_order

  UNION ALL
  SELECT 'captured_amount_without_capture_row', count(*) FILTER (
    WHERE captured_amount > 0 AND capture_rows = 0
  )::bigint FROM payment_by_order

  UNION ALL
  SELECT 'captured_amount_capture_table_mismatch', count(*) FILTER (
    WHERE captured_amount IS DISTINCT FROM capture_table_amount
  )::bigint FROM payment_by_order

  UNION ALL
  SELECT 'order_payment_collection_currency_mismatch', count(*) FILTER (
    WHERE collection_currency_mismatches > 0
  )::bigint FROM payment_by_order

  UNION ALL
  SELECT 'payment_currency_mismatch', count(*) FILTER (
    WHERE payment_currency_mismatches > 0
  )::bigint FROM payment_by_order

  UNION ALL
  SELECT 'negative_payment_or_refund_amount', count(*) FILTER (
    WHERE negative_payment_amount_rows > 0
  )::bigint FROM payment_by_order

  UNION ALL
  SELECT 'refund_exceeds_capture', count(*) FILTER (
    WHERE refund_exceeds_capture_rows > 0
  )::bigint FROM payment_by_order

  UNION ALL
  SELECT 'partial_capture_order', count(*) FILTER (
    WHERE captured_amount > 0 AND captured_amount < order_amount
  )::bigint FROM payment_by_order

  UNION ALL
  SELECT 'capture_exceeds_order_amount', count(*) FILTER (
    WHERE captured_amount > order_amount
  )::bigint FROM payment_by_order

  UNION ALL
  SELECT 'payment_collection_refund_mismatch', count(*) FILTER (
    WHERE refunded_amount IS DISTINCT FROM refund_table_amount
  )::bigint FROM payment_by_order

  UNION ALL
  SELECT 'delivered_without_recorded_capture', count(*) FILTER (
    WHERE coalesce(fbo.delivered, false) AND pbo.captured_amount = 0
  )::bigint
  FROM payment_by_order pbo
  LEFT JOIN fulfillment_by_order fbo ON fbo.order_id = pbo.order_id

  UNION ALL
  SELECT 'fulfillment_item_without_same_order_line', count(*) FILTER (
    WHERE flf.line_item_id IS NULL OR ci.item_id IS NULL
  )::bigint
  FROM fulfillment_line_facts flf
  LEFT JOIN current_items ci
    ON ci.order_id = flf.order_id
   AND ci.item_id = flf.line_item_id

  UNION ALL
  SELECT 'fulfillment_item_nonpositive_quantity',
         coalesce(sum(nonpositive_rows), 0)::bigint
  FROM fulfillment_line_facts

  UNION ALL
  SELECT 'fulfillment_quantity_exceeds_ordered', count(*) FILTER (
    WHERE ci.item_id IS NOT NULL AND flf.fulfilled_quantity > ci.quantity
  )::bigint
  FROM fulfillment_line_facts flf
  LEFT JOIN current_items ci
    ON ci.order_id = flf.order_id
   AND ci.item_id = flf.line_item_id

  UNION ALL
  SELECT 'order_fulfillment_with_missing_side', count(*) FILTER (
    WHERE bo.id IS NULL OR f.id IS NULL
  )::bigint
  FROM order_fulfillment ofl
  LEFT JOIN base_orders bo ON bo.id = ofl.order_id
  LEFT JOIN fulfillment f
    ON f.id = ofl.fulfillment_id AND f.deleted_at IS NULL
  WHERE ofl.deleted_at IS NULL

  UNION ALL
  SELECT 'refund_without_payment', count(*) FILTER (
    WHERE p.id IS NULL
  )::bigint
  FROM refund r
  LEFT JOIN payment p ON p.id = r.payment_id AND p.deleted_at IS NULL
  WHERE r.deleted_at IS NULL

  UNION ALL
  SELECT 'refund_not_linked_to_order', count(*) FILTER (
    WHERE opc.order_id IS NULL
  )::bigint
  FROM refund r
  JOIN payment p ON p.id = r.payment_id AND p.deleted_at IS NULL
  LEFT JOIN order_payment_collection opc
    ON opc.payment_collection_id = p.payment_collection_id
   AND opc.deleted_at IS NULL
  WHERE r.deleted_at IS NULL

  UNION ALL
  SELECT 'current_order_summary_missing_or_duplicate', count(*)::bigint
  FROM (
    SELECT bo.id
    FROM base_orders bo
    LEFT JOIN order_summary os
      ON os.order_id = bo.id
     AND os.version = bo.version
     AND os.deleted_at IS NULL
    GROUP BY bo.id
    HAVING count(os.id) <> 1
  ) bad_summary

  UNION ALL
  SELECT 'order_summary_payment_amount_mismatch', count(*) FILTER (
    WHERE os.id IS NOT NULL
      AND (os.totals->>'current_order_total')::numeric
          IS DISTINCT FROM pbo.order_amount
  )::bigint
  FROM base_orders bo
  JOIN payment_by_order pbo ON pbo.order_id = bo.id
  LEFT JOIN order_summary os
    ON os.order_id = bo.id
   AND os.version = bo.version
   AND os.deleted_at IS NULL

  UNION ALL
  SELECT 'tax_lines_present_requires_metric_extension', count(*)::bigint
  FROM (
    SELECT id FROM order_line_item_tax_line WHERE deleted_at IS NULL
    UNION ALL
    SELECT id FROM order_shipping_method_tax_line WHERE deleted_at IS NULL
  ) tax_lines
)
SELECT check_name, issue_count,
       CASE WHEN issue_count = 0 THEN 'PASS' ELSE 'REVIEW' END AS result
FROM checks
ORDER BY check_name;

COMMIT;
