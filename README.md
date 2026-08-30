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

The incomplete second catalog item is kept inactive until its English copy,
images, per-SKU pricing and logistics data have been verified.

## Local development

```bash
npm ci
npm run build
npm run check
npm run serve
```

Open `http://127.0.0.1:4173/PawShop.html`.

## Release status

This branch is for a draft PR only. It does not merge into `main` or deploy
the live GitHub Pages site. A storefront preview release and opening real
commerce are separate approval gates. See [LAUNCH_READINESS.md](LAUNCH_READINESS.md)
for the remaining decisions, risks and acceptance criteria.

## Safety baseline

`npm run check` validates HTML and rejects regressions such as client-side
payment choices, fake order success, published demo credentials and browser-
stored service tokens. It also runs Node regression tests for catalog loading,
rendering inputs and prelaunch data boundaries. Pull requests and pushes to `main`
run the same checks. These checks are not a complete security or legal audit.

## Planned commerce migration

1. Keep the current site in transparent prelaunch mode.
2. Establish the business entity, logistics, return route and support channel.
3. Use Shopify Admin for products, variants/SKUs, inventory, orders, fulfillment
   and refunds.
4. Enable checkout only after an eligible payment provider and complete policies
   are configured and tested.
5. Add custom internal operations tooling later only for PawShop-specific needs,
   such as supplier sourcing, landed cost and AI-assisted catalog review.
