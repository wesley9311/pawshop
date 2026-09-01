# PawShop

PawShop is currently a prelaunch product-preview storefront. Payments, customer
orders, address collection and inquiry submission are intentionally disabled
until a server-side commerce backend and verified business operations are ready.

## Current operating mode

- Public catalog source: `catalog.json`
- Primary pilot market: United States
- Display currency: USD
- Fulfillment origin: China
- Checkout: disabled
- Customer inquiry collection: disabled
- Public legacy admin and analytics: disabled

The incomplete second catalog item is preserved in a private local operations
backup outside the website directory until its English copy, images, per-SKU
pricing and logistics data have been verified.

## Local development

```bash
npm ci
npm run build
npm run check
npm run serve
```

Open `http://127.0.0.1:4173/PawShop.html`.

## Release status

The owner authorized replacing the legacy live website with this prelaunch
showcase on 2026-08-30. GitHub Pages publishes `main`. This approval does not
enable orders, payments or customer-information collection. A showcase release
and opening real commerce are separate gates. See
[LAUNCH_READINESS.md](LAUNCH_READINESS.md) for the remaining decisions and
[MIGRATION_STATUS.md](MIGRATION_STATUS.md) for data preservation boundaries.

## Safety baseline

`npm run check` validates HTML and rejects regressions such as client-side
payment choices, fake order success, published demo credentials and browser-
stored service tokens. It also runs Node regression tests for catalog loading,
rendering inputs and prelaunch data boundaries. Pull requests and pushes to `main`
run the same checks. These checks are not a complete security or legal audit.

## Self-hosted commerce migration

PawShop is building its own commerce backend instead of subscribing to Shopify.
The first foundation uses Medusa 2.19 and PostgreSQL 17 and remains local-only:
it is not connected to the public storefront and cannot accept customer data,
orders or payments. See [`_commerce/README.md`](_commerce/README.md) and
[`_commerce/STATUS.md`](_commerce/STATUS.md).

1. Keep the current site in transparent prelaunch mode.
2. Validate local catalog and owner-admin workflows without publishing products.
3. Establish the business entity, logistics, return route and support channel.
4. Design an authenticated production deployment, backups, monitoring and
   server-side checkout before collecting any customer information.
5. Integrate an eligible payment provider only after sandbox payment, refund,
   webhook and reconciliation tests pass.
