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

## Real local operations validation

Validated against the actual owner environment on 2026-09-02, without demo data:

- the owner logged into the running admin UI successfully;
- the actual product is Draft, has one SKU and nine exact source images;
- it is assigned to no sales channel;
- the actual Orders and Customers pages contain no records;
- an AES-256 encrypted dump of the active database was created;
- that dump was restored into a new real PostgreSQL database and its product,
  price, image, owner, customer and order boundaries were verified;
- private manifests contain the encrypted-backup and restore-verification evidence;
- restore verification now removes its temporary plaintext database by default.

See [`OPERATIONS_ZH.md`](OPERATIONS_ZH.md) for the owner workflow.

## Local operations follow-up — 2026-09-03

- Recovered an unresponsive local development server: the old process occupied
  the loopback port at approximately 100% CPU and did not respond to HTTP checks.
  Graceful termination did not stop it, so that specific process was terminated
  and the backend restarted. The underlying hang cause is not yet established.
- Logged into the actual admin UI and verified the draft product, nine product
  images, one SKU, USD 29.90 price, and empty customer/order lists.
- Created an encrypted backup before changing real store configuration through
  the admin UI. Store name is now PawShop; USD is the default supported currency,
  with EUR retained. EUR's existing tax-inclusive preference is unchanged; USD
  uses `is_tax_inclusive=false`. This does not configure tax rates or sales regions.
- Compared critical-data fingerprints before and after the configuration change:
  products, variants, price links, prices, images, customers, orders and owner
  users were unchanged. Product sales-channel links remain absent and
  `reviewed_for_sale` remains false. Default region/location remain unset.
- `catalog:verify` and `foundation:verify` passed after the change. Store/customer routes remain
  closed; the public storefront was not changed or connected to this backend.
- Remaining local operations gaps include unmanaged SKU inventory, missing
  shipping attributes, and admin dialog accessibility/ref warnings. Product
  images are assigned at product level; the variant has no separate media.
  Development in-memory locking and local event handling are not a production
  reliability solution. No stock quantity, shipping weight, or sales policy was
  invented to fill these gaps.

The change was independently reviewed. Browser evidence and the backup manifest
remain in the private operations directory, outside the repository.

## Local owner workflow

### Verification hardening — 2026-09-04

- Foundation HTTP probes now have a five-second deadline, reject redirects, and
  cancel response bodies without logging their content or request credentials.
- PostgreSQL probes ignore local psql startup files and enforce connection,
  statement and subprocess deadlines, with sanitized failure messages.
- Thirteen tests passed, including real loopback HTTP timeout/redirect checks.
  These failure-injection tests do not create business records or replace the
  actual database/backend verification.
- The actual local foundation verification passed after the development watcher
  finished reloading. The verifier correctly failed during the reload window;
  it did not retry away the failure or report success while unavailable.
- This improves failure detection, not uptime or the cause of the previous hang.
  Production hosting, durable runtime services and access protection remain open.

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

## Production configuration scaffold — 2026-09-05

- Added a separate `production-admin-only` configuration path. It does not read
  the private Mac development env file and does not weaken the unconditional
  Store/customer API gate.
- Production configuration requires TLS-authenticated PostgreSQL and Redis,
  distinct generated secrets, separate HTTPS storefront/admin origins, an
  allowlisted worker mode, and a bounded port. Known loopback spellings fail.
- Production build, sixteen tests, TypeScript checking, and the actual local
  closed-route verification passed. Fixture build hostnames use `.invalid` and
  contain no production credentials or customer data.
- This is a deployable-configuration scaffold, not a live deployment. Redis
  infrastructure modules, durable object storage, Linux production backups,
  monitoring and reverse-proxy access control await the selected vendor's real
  service details. No cloud purchase was made.

## Still blocked before real sales

- production hosting and network boundary;
- production-grade Redis/event bus, secrets and database operations;
- administrator MFA/role review and recovery;
- logistics, return address, tax, policies and customer-support route;
- payment-provider eligibility plus sandbox success/failure/refund/webhook tests;
- customer privacy retention, export and deletion procedures;
- backups, restore drill, monitoring, alerts and rollback;
- storefront-to-backend integration and end-to-end order tests.
