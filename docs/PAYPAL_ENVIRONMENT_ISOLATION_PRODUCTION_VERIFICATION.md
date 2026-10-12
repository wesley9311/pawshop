# Environment isolation production Sandbox verification — 2026-10-12

## Active release

`ecc43ea6bc4dd95ba01fba54a25fc4be40f1106c` activated from
`64429533b426312a774a36da874d7ad6ecd422af`.
Immutable content digest:
`b9ccc2f68d40227de77825d13466b5f1177bbd8dc707e2c5806a5f10faac1301`.
Production source exact/clean, release manifest and tracked-tree checks passed.
Actual secret scan:0matches. No Live credentials/configuration activated.
Equivalent active config remains PAYPAL_SANDBOX=true, resolves active=sandbox;
Live verifier is inactive/unavailable, not Live-verified.

## Governance and rollback

Migration file set exactly identical to predecessor;0new migrations/models/links.
Standard sensitive release path used because module service changes are ineligible
for code-only governance. Its idempotent migration runner reported Database already
up-to-date; schema-only dump normalized for pg_dump restrict tokens was byte-identical
before/after (SHA25679fd100dba22fe7d87cabf5bb8ada9e42a0d5d7638197e109c4b9c2e8330e1e7).
155relations before/after. Pre-upgrade encrypted backup, post-check backup, offsite
read-back and isolated restore passed. No new migration/schema change applied.
Predecessor retained, manifest reverified, schema/migration compatibility reviewed,
rollback script conditions reviewed. Actual rollback was NOT performed (no defect).

## Runtime

Application/HTTPS storefront200, serviceactive, NRestarts0, shared worker,
RedisPONG. Payment convergence, financial notification recovery and order email retry
all completed successive60second cycles after activation and after the new transaction.
Published compiled-artifact isolation probes15/15 passed in a separate process with
mock clients; they neither changed service env nor called real Live APIs. These prove
historical Sandbox routing with a Live-active fixture, refund/notification routing,
cross-environment webhook rejection and namespaced idempotency. No payment architecture
or UI was changed in this release verification.

## Legacy

Original31sessions and24payments remain Sandbox. Full rows minus the two previously
approved environment fields exactly match the forensic before snapshot, including
amounts/status/IDs/relations/timestamps.7unapproved remote sessions remain UNKNOWN /
UNVERIFIED; local pending/CREATED unchanged. No lifecycle status inferred from404.
Original23order/payment/capture/refund baseline remains untouched except the approved
environment/provenance enrichment. No historical order was repaired for this test.

## Single new real Sandbox transaction

Existing catalog variant/SKU PAW-1, existing customer, explicit Admin draft test quote
1.00USD with0test shipping; catalog prices unchanged. Sandbox metadata labels the
quote and order. Draft converted only after trusted capture, so order confirmation
was sent after capture. No physical shipping was performed.

Order:`order_01M4R8WX4ESWGPFXZYH10PRPKR`.
PayPal Sandbox order:`3JP15624UT1654219`.
PayPal capture:`00U69578HS345272N`.
Medusa payment:`pay_01M4R8ZZ9ZSF1Z3DN1G6GTS1X8`.
Buyer approved1.00USD. New session persisted Sandbox immediately and payment inherited
Sandbox. Backend automatic capture1; PayPal capture1, Medusa capture1/1.00USD.
Order confirmation relay accepted once, attempts1. Official fulfillment creation
allowed:`ful_01M4R93HPAM6F0GTW8MM8Y1DQB`.

Official Medusa refund0.01USD completed at PayPal:
`7MY704653C5771939`, local `ref_01M4R9596DFBN59B0VSSVD77X6`.
Exactly1refund; refund confirmation relay accepted once, attempts1. Net test amount0.99USD.
Native refund used persisted Sandbox client. Real signed refund webhook reconciled
`sandbox:7MY704653C5771939` as applied, matching amount/currency/capture/payment/order.

## Webhook

Configured public Sandbox webhook remains https://pawlivora.com/hooks/payment/paypal
(nginx routes it to the provider's application path /hooks/payment/paypal_paypal).
Sandbox APPROVED, CAPTURE.COMPLETED and CAPTURE.REFUNDED real notifications received.
PayPal API resent the exact COMPLETED and REFUNDED notifications.5application POSTs,
all200; after duplicate/delayed capture notification (current capture already partially
refunded), still1capture/1refund/1reconciliation and no duplicate emails. The compiled
dual verifier and local persisted environment guard are enabled; Live has no credential
set and is unavailable, not a fabricated PASS.

## Commerce facts

Formal release's commerce-facts.sql run read-only in default Live and explicit Sandbox
scope. Live business metrics have no capture/attribution rows; real revenue0. No real
AOV, customer-value/repeat or SKU-sales fact is inferred from test transactions.
Sandbox/Test:13captured orders,568.30USD gross,39.81USD refund,528.49USD net,
16units, AOV43.72(TEST ONLY). New test adds1.00gross/0.01refund/0.99net and1unit;
Live metrics remain empty. Environment missing/conflict/mixed integrity counts0.
Existing historical integrity exceptions are preserved and reported, not repaired.

## Regression and evidence

Candidate full suite428tests:422pass,3existing order-lookup failures,3skip; no new failure.
Types and controlled Medusa/PG/SMTP workflows passed. Published compiled probe15pass.
Private root evidence outside immutable release:
- pawshop-env-release-preflight.json
- pawshop-env-release-upgrade.log / drill.log / activate.log
- pawshop-env-release-runtime-proof.json / final-proof.json
- pawshop-env-compiled-probe.log
- pawshop-env-release-facts-live.log / facts-sandbox.log
- pawshop-env-release-transaction.json

GO for independent INACTIVE Live credential preparation only. No Live configuration
was performed in this round; no activation/real-money/Live-verification claim.
Sandbox production-path VERIFIED; not OWNER VERIFIED (SMTP relay acceptance does not
prove inbox delivery). Stop at this checkpoint.
