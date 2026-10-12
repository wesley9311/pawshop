# PayPal environment isolation — 2026-10-12

## Scope and production state

Owner approved exactly31 sessions +24 linked payments for Sandbox environment
backfill and forensic provenance. Runtime remains PAYPAL_SANDBOX=true; active
commerce release is64429533b426312a774a36da874d7ad6ecd422af. No Live credentials,
remote financial mutation, Stripe, UI, new table or migration was introduced.
Isolation code below is a tested release candidate; not yet activated in production.

## Executed backfill

One transaction locked target rows and checked exact31/24/55 counts, provider,
exact expected IDs/data, absent target keys, unchanged payment-session relations,
and Sandbox approval URLs with tokens matching provider order IDs. Any failure
would roll back all rows. Only data.paypal_environment and
 data.paypal_environment_evidence were added; full rows minus those keys compared
identically before COMMIT and on a separate post-COMMIT read (including timestamps).
Result:31 Sandbox sessions,24 Sandbox payments,0 Live,0 unknown environment.

24 sessions use sandbox_api_verified provenance (linked payments use the same).
Sandbox GET returned200 with matching order/custom session ID and matching existing
authorization/capture identities.7 session GETs returned404; their persisted
Sandbox approval URLs/token relationships prove origin, not current remote state.
They use sandbox_approval_url_verified. Their local pending / CREATED values remain
unchanged; remote lifecycle remains UNKNOWN / UNVERIFIED. Creation range
2026-09-27T18:28:46.295+08:00 through2026-10-12T10:20:29.263+08:00.

Private evidence outside release:
/root/pawshop-environment-backfill-20261012-{before,after,proof}.json.
Local guarded rollback and exact snapshots reside under
/Users/zhaoxiaomin/Documents/PawShop_Private/audits/paypal-environment-approved-*.
Rollback is NOT executed and refuses to overwrite later data changes.
No credential values are included in evidence or this checkpoint.

## Canonical data and routing

session.data.paypal_environment is sandbox | live, fixed at creation; payment.data
inherits it. Financial actions reject missing/invalid values, conflicting approval
origin, payment/session disagreement and mixed collection environments before
provider mutation. Session/payment updates cannot change the environment. Active
environment selects NEW sessions only; AsyncLocalStorage gives each concurrent
operation an independent persisted environment, never mutable singleton routing.

Provider authorize/capture/refund/void/read-back, scheduled convergence, external
refund/reversal reconciliation and notification fact reads use that environment.
Fulfillment independently rejects unverified/mixed payment environments.
PayPal request IDs, reconciliation external/event identities and resource locks
include environment. Existing raw ledger identities are recognized only through
an exact linked persisted payment environment, without another backfill.
Internal Medusa entity IDs remain globally unique; notification dedup stays keyed
by those business identities and facts are re-read from persisted payment/session.

## Webhook

One endpoint, independent Sandbox and Live verifiers. Every configured environment
uses its own credentials, API base and webhook ID. Exactly one successful verifier
is required; zero/two matches or unverifiable candidates fail closed. Raw bytes
must agree with parsed event. Local session/payment environment must agree before
business processing. External refund context includes environment and cannot
adopt a refund in another environment. Environment failures enter reconciliation
review; no wrong payment is silently modified.
Live credentials are absent: only controlled Live verifier fixtures are verified,
NOT a real Live webhook or payment.

## Configuration contract

PAYPAL_ACTIVE_ENV=sandbox|live
PAYPAL_SANDBOX_CLIENT_ID / PAYPAL_SANDBOX_CLIENT_SECRET / PAYPAL_SANDBOX_WEBHOOK_ID
PAYPAL_LIVE_CLIENT_ID / PAYPAL_LIVE_CLIENT_SECRET / PAYPAL_LIVE_WEBHOOK_ID
PAYPAL_RETURN_URL / PAYPAL_CANCEL_URL

Every configured environment requires all3 credentials. Shared client ID, secret
or webhook ID is rejected. Existing six-key PAYPAL_SANDBOX=true configuration maps
only to the Sandbox client for compatibility; legacy false cannot enable Live.
Secrets belong only in protected production configuration. Inactive Live setup
must preserve active Sandbox. No production config was modified in this round.

## Commerce facts v2

Default payment_environment=live. Explicit --set payment_environment=sandbox
selects test metrics. All revenue/AOV/customer sequence/units/product/SKU attribution
uses the same strict environment scope and linked core capture/refund evidence;
collection aggregates must agree, capture must be unique/complete, and refunds must
have mapped identities. Missing/mixed records are excluded and globally audited.
Snapshot grouping, no current has_account classification, and existing integrity
checks are retained. Scope is printed with every metric run.

Production read-only runs: Live has no business metric rows (no Live capture);
Sandbox12 captured orders,567.30USD gross,39.80USD refund,527.50USD net.
Sandbox AOV47.28 is TEST ONLY. Original integrity exceptions are retained, not
repaired. Environment missing/conflict/mixed counts are all0 after backfill.
Live/Sandbox audit-only observations are explicitly labelled as observations,
not trusted business metrics. Logs:/root/pawshop-commerce-facts-v2-{live,sandbox}.log.

## Controlled acceptance

15 environment-specific behavioural tests passed: persisted Sandbox with active
Live fixture, new Live fixture creation, concurrent same-ID operations with distinct
keys, both refund/notification client routes, missing/conflicting environment block,
independent verifiers, ambiguous signature rejection, opposite-environment
reconciliation rejection and isolated credential configuration.
20 existing payment safety behavioural tests passed. Full suite428tests:
422pass,3previous order-lookup failures,3skip; no new failure. Typecheck passed.

Real Medusa/PG isolated controlled acceptance proves local webhook environment
matching and both cross-environment rejects, immutable session updates, official
capture/refund workflows, fulfillment gates, and execution of commerce-facts.sql
for Sandbox, Live fixtures, mismatched and missing environment. Final evidence:
/var/folders/gc/l9xqtlv13fl5vgf2z46qm1zr0000gn/T/pawshop-payment-acceptance-VMoR5T.
Financial notification workflow +TLS SMTP sink passed after collection enforcement:
/var/folders/gc/l9xqtlv13fl5vgf2z46qm1zr0000gn/T/pawshop-payment-acceptance-Pa6TGZ.
No real Live endpoints/funds were used for controlled fixtures.

## Release boundary

No migration/backfill beyond the approved55 rows was executed. No runtime activation
was done in this round. The existing release governance classifies src/modules
changes as sensitive (not eligible for the lighter code-only release path); its
normal activation path calls upgrade migration/backup/restore gates. That production
release must be completed before treating isolation as production-verified or
accepting Live funds. Controlled code readiness permits INACTIVE Live credential
provisioning only; it does not permit changing active environment or Live testing.
