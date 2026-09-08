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

## Private production topology round — 2026-09-08

- Added an explicit low-cost `single-host-private` topology. PostgreSQL, Redis
  and Medusa are fixed to loopback addresses; the owner admin origin is a local
  SSH-tunnel endpoint rather than a public admin domain.
- Production now registers Redis-backed caching, events, workflow execution and
  locking instead of falling back to development in-memory modules.
- Production product uploads require an S3-compatible file provider. Credentials
  and endpoints have no defaults and must remain outside Git.
- Added an Ubuntu host preflight requiring the system `/usr/bin/node` at Node 22
  or 24 LTS and the production command set. At that stage the purchased server
  measured roughly 894 MiB usable RAM, so activation was blocked until the later
  2 GB plan upgrade recorded below.
- Added a production boundary verifier covering health, unauthenticated admin
  rejection, and continued 503 responses for products, carts and customer signup.
- The production scaffold was first accepted with twenty-three commerce tests,
  TypeScript checking, and a production-mode Medusa build
  with inert `.invalid` fixtures, and the fourteen public-site safety tests pass.

This round prepares the private owner backend but does not install packages on
the live server, publish the admin, migrate production data, enable Store APIs,
create orders, collect customer data or enable payment.

## Native Ubuntu operations round — 2026-09-08

- Chose native Ubuntu services for the initial low-cost launch rather than
  Docker: systemd runs Medusa as an unprivileged `pawshop` user while the host
  runs PostgreSQL, Redis and the already-working Nginx service.
- Added hardened Medusa and daily-backup systemd units. The application unit
  waits for a bounded production identity, listener and closed-route check
  before startup is accepted.
- Added an Ubuntu production backup command that streams PostgreSQL over loopback
  directly into encryption, suppresses command output, never writes a plaintext
  database dump, encrypts with
  AES-256-CBC/PBKDF2, and records SHA-256 plus keyed HMAC integrity evidence.
- Backup directories and the external key file are restricted to approved
  private Ubuntu paths outside all public and release directories. The key must
  be a root-owned nonsymlink file, group-readable only by the service account.
- The expanded commerce suite now contains forty passing tests; the
  native service files remain inactive templates until real-host verification.
- Added a manual-only production restore unit running as a separate unprivileged
  OS account from root-installed immutable scripts. It authenticates the staged
  manifest and archive, creates a private throwaway PostgreSQL 17 cluster with
  no network listener, checks critical table counts, and records success only
  after the cluster directory is removed. It never connects to production.

None of these units have been installed or enabled on the undersized live server.

## Offsite backup retention round — 2026-09-08

- Added a separate S3-compatible encrypted-backup path using systemd credentials;
  the database key is never uploaded and no remote delete API exists in runtime code.
- Requires bucket versioning, a declared minimum 90-day lifecycle, and an explicit
  no-delete credential gate before any object request.
- Newly uploaded ciphertext and manifests are fully read back by their exact
  returned version IDs and SHA-256 checked; later runs validate exact recorded
  version IDs against HMAC-signed local receipts.
- Local pruning keeps at least seven sets and never removes the latest, young, or
  remotely unverified set. Remote retention remains controlled by the bucket owner.

The next implementation step is atomic release activation and rollback. Real S3
upload/read-back/delete-denial evidence still requires an owner-created bucket and
least-privilege credentials; no external account or data was used in this round.

## Atomic commerce release and admin language round — 2026-09-08

- Added an immutable commerce release builder with an exact Git identity, clean-tree
  gate, secret-isolated `pawshop-build` dependency/build steps, root-owned final artifact and atomic
  current-link activation.
- Failed startup verification restores the prior release. Manual rollback requires
  a retained exact release plus an explicit database-schema compatibility gate;
  neither path runs migrations or deletes retained releases.
- The production environment file has an exact parser and root/service-group mode
  contract instead of being evaluated as shell code.
- Added a `语言 / Language` admin route that switches Medusa's existing full UI
  resources between Simplified Chinese and English. It explicitly does not translate
  merchant-entered product or policy content.
- The completed local verification passed 45 commerce tests, TypeScript checking,
  the full Medusa backend/admin build, 14 storefront safety tests, shell and Node
  syntax checks, HTML validation, security checks and Git whitespace validation.

These remain inactive templates. The Alibaba Cloud SWAS instance is now on its
2 vCPU / 2 GB / 40 GB plan. Ubuntu reports 1,651,800 KiB RAM with 2 GB swap; the
host gate now accepts no less than 1,600,000 KiB while still rejecting the former
1 GB plan. The root ext4 filesystem was expanded online from 30 GB to 40 GB after
storing a root-only partition-table backup; it has about 33 GB free. Node,
PostgreSQL, Redis, database migration and commerce activation have not been performed.
