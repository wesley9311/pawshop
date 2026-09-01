# Self-hosted commerce status

Validated locally on 2026-09-01:

- Medusa 2.19.0 on Node 22 LTS builds successfully.
- Dedicated PostgreSQL 17 data is outside the repository and listens only on `127.0.0.1:54329`.
- Owner credentials and generated secrets are mode `0600` files under `~/Documents/PawShop_Private/development/`.
- One source product was imported as an unpublished draft with one SKU, nine approved images and USD 29.90.
- Store APIs and customer-auth routes are rejected in this phase.
- Medusa creates one local publishable-key fixture; verified Store routes still
  return `503` when that valid key is supplied.
- No sales region, customer, order, demo seed or external payment service is
  configured. Medusa's local system-default payment module is not a usable
  customer payment channel.
- GitHub Pages explicitly excludes `_commerce/`.

This is an operations foundation, not a live store. The current public site is unchanged and remains a non-transactional showcase.

## Local owner workflow

Use Node 22 LTS for all commands:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
npm --prefix _commerce run setup:local
npm --prefix _commerce run db:migrate
npm --prefix _commerce run admin:create
npm --prefix _commerce run catalog:import
npm --prefix _commerce run catalog:verify
npm --prefix _commerce run dev
# In another terminal while the server is running:
npm --prefix _commerce run foundation:verify
```

Then open `http://127.0.0.1:9000/app`. The local owner credentials are stored in `~/Documents/PawShop_Private/development/local-admin.txt`; never copy them into Git, screenshots or support messages.

## Still blocked before real sales

- production hosting and network boundary;
- production-grade Redis/event bus, secrets and database operations;
- administrator MFA/role review and recovery;
- logistics, return address, tax, policies and customer-support route;
- payment-provider eligibility plus sandbox success/failure/refund/webhook tests;
- customer privacy retention, export and deletion procedures;
- backups, restore drill, monitoring, alerts and rollback;
- storefront-to-backend integration and end-to-end order tests.
