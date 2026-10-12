# AUTO CAPTURE + HARD FULFILLMENT GATE — checkpoint

Date: 2026-10-11. Candidate only; **not deployed, not Sandbox E2E verified, not Live verified**.
Accepted base: `be4e1e35628afd9887fbb9413333de381e555400`.
Existing storefront/media changes remain outside this candidate.

## IMPLEMENTED

- Keep `AUTHORIZE`. Provider `authorizePayment` captures on backend after approval/authorization and returns `captured` only for exact completed capture. Medusa's official authorization service then records capture facts. Stable request keys, provider re-read on retry, 10-second API timeouts, pending/denied/mismatched amounts fail closed.
- Five Admin fulfillment mutation routes enforce matching currency, full capture amount, confirmed `captured_at`, no cancellation/refunds, and no pending/review reconciliation. Generic shipment resolves the fulfillment relationship; order-scoped shipment/delivery must agree with that relationship. Clean zero-total orders have an explicit separate policy.
- Verified external refund events re-read refund and capture facts, validate order/session/amount/currency, and use the official refund workflow with a backend-only adoption context. Adoption does GET only at PayPal, never a second refund POST. Reversals enter review and block fulfillment instead of being mislabeled as refunds.
- Additive durable reconciliation ledger, unique event and external resource IDs. Resource/capture locks serialize external refunds. Per-order locks serialize guarded Admin fulfillment, Admin payment refunds and external reconciliation through the response lifecycle.

## CONTROLLED TEST VERIFIED

- Payment provider/safety targeted tests: 26 pass.
- Dedicated fresh local PostgreSQL database, full Medusa 2.21 migration, real module/services/query/workflows, mocked PayPal responses only.
- Real Medusa capture row, collection aggregate, all five middleware/query paths reject before capture and after refund; allow after capture. Reconciliation review also blocks them.
- Official external-refund adoption updates refund row, payment collection aggregate and order refund transaction; no PayPal refund POST.
- Accepted `commerce-facts.sql` computes one captured order, gross 25 USD, refund 5 USD, net 20 USD in that fresh fixture database.
- Type check and build pass. Full suite retains only the three pre-existing order lookup failures (21/22/26); do not fix them in this task.

Repeat with Node 22/24: `node _commerce/scripts/payment-controlled-acceptance.mjs`.
Runner creates only a fresh `pawshop_payment_acceptance_*` database on dedicated loopback PostgreSQL port 54329. It uses fake provider credentials and intercepts provider requests; it cannot use production credentials. Database and evidence logs are retained for inspection. Fixtures are clearly marked controlled and never written to production.
Latest fresh evidence directory: `/var/folders/gc/l9xqtlv13fl5vgf2z46qm1zr0000gn/T/pawshop-payment-acceptance-CzUjc5`.

## SANDBOX E2E VERIFIED

**Pending.** No new PayPal Sandbox transaction was approved or captured in this implementation round. Old 23 production-hosted Sandbox orders were not modified. A real Sandbox buyer approval is needed; ask only for browser participation, never a password in chat.

## KNOWN RISKS / remaining acceptance

- Candidate is not production-installed. Additive migration, sensitive release governance, deployed route/workflow regression and Sandbox webhook subscription verification remain required.
- A–K complete acceptance is not finished. Current five-route tests execute real middleware/query with response lifecycle, not full HTTP create/ship/deliver workflows.
- Production Redis/distributed concurrent callbacks, refunds and fulfillment plus process-crash recovery need acceptance. Order-lock lease is 120 seconds; unusually long downstream workflows need explicit handling before release.
- Webhook delay can delay knowledge of an external refund/reversal. No polling recovery job has been added yet. Unknown/unmapped verified events intentionally block fulfillment globally until reviewed.
- Incomplete historical/partially completed refund workflow records fail closed and need review; they are never silently repaired. Reversal is a durable exception, not an invented ordinary refund.
- Existing legacy payments without reliable order/session/refund mapping may need review. Do not modify the old 23 orders to make tests pass.
- Standalone future internal workflow callers must use the same gate; current enforcement covers all five existing Admin routes.

## LIVE READINESS GAPS

No Live switch, Live credential creation, env/secret edits or real funds operation occurred. Complete Sandbox acceptance, reconciliation/recovery policy and release review before any later Live decision.

## Sandbox continuation — buyer approval prepared

Owner confirmed a Sandbox buyer account is available. An isolated server candidate
was prepared at `/root/pawshop-payment-sandbox-candidate-20261011` with a new
`pawshop_payment_sandbox_20261011` database. Production `current`, production
schema/data, existing 23 orders and env files remain unchanged. Existing Sandbox
credentials are consumed on the server only; no credentials were copied locally.
The candidate uses the installed Medusa runtime and the new compiled provider.
Full fresh database migration succeeded.

A single real Sandbox `AUTHORIZE` payment session for **1.00 USD** is awaiting buyer
approval. No capture has been attempted by this test yet. Nonsensitive state is
in the candidate's `acceptance-state.json`; approval URL can be read from it.
After Owner confirms approval, run `node run.mjs exec ./src/scripts/finish.js`
inside that isolated candidate. This invokes official backend authorization,
checks real capture facts and idempotent repeat authorization, and links the
transaction only to an explicitly labeled isolated test order. This is a service
integration acceptance, not a deployed storefront/webhook end-to-end result.
Do not replay the approval through any old production cart, and do not switch Live.

## 2026-10-12 — real Sandbox buyer approval verified

Owner completed approval for PayPal order `11C3089984600893K`.
The isolated candidate invoked official Medusa `authorizePaymentSession`; its new
provider automatically authorized and captured. No Admin manual capture was used.

- PayPal authorization: `2AV26884MJ4025330`.
- PayPal capture: `14A51639JW9500410`.
- Independent fresh PayPal GET: `COMPLETED`, `1.00 USD`, `final_capture=true`.
- Medusa payment: `pay_01M4NVP39YFC2DNTM96JQMARQD`; exactly one capture of 1 USD,
  `captured_at=2026-10-11T16:10:41.370Z`, no refund.
- Repeat official authorization returned the same payment and retained one capture.
- Isolated order: `order_01M4NVP3DQ00E249VJN8D8KTKN`; full-payment gate allowed.
- Accepted commerce-facts.sql on isolated Sandbox DB: captured orders 1,
  captured revenue 1 USD, refund 0, net revenue 1 USD.
- Evidence: server candidate `acceptance-state.json`, `last-run.log`,
  `commerce-facts.log`. Credentials never emitted.

Verified scope: **real Sandbox provider/service integration for normal automatic
capture, repeat authorization, Medusa capture fact, gate decision and fact query**.
Not yet full deployed storefront/webhook E2E or actual fulfillment lifecycle.
Remaining A–K acceptance and known risks above still apply. Production release,
production DB, old 23 orders and PayPal Live remain unchanged by the candidate.


## 2026-10-12 — full payment safety acceptance checkpoint

Candidate remains isolated and uncommitted. No production commerce release or Live switch.
Old production 23 orders were not modified. Temporary Sandbox webhook subscription and
PawShop nginx test route are removed after acceptance; private evidence and isolated DB retained.

### SANDBOX E2E MATRIX

| Case | Result | Scope |
|---|---|---|
| Genuine capture-completed notification, signature validation | PASS | Real Sandbox delivery, temporary isolated webhook endpoint |
| Duplicate/delayed capture notifications | PASS | Real signed notification replay; original delay about 13 minutes |
| Callback/webhook race | SAFE RECOVERY, NOT CLEAN PASS | Concurrent HTTP statuses 503/200/503/503; retry 200; one payment/capture |
| Captured create → shipped → delivered | PASS | Official Medusa handlers/workflows plus actual candidate gate; DB timestamps verified |
| Uncaptured create / shipped / delivered | PASS | Each server HTTP 409 on isolated fault fixture |
| Medusa → PayPal refund | PASS | Genuine Sandbox 0.25 USD refund |
| External PayPal → Medusa refund | PASS | Genuine external 0.25 USD; real notification adopted, no duplicate refund |
| Duplicate external refund notification | PASS | Three concurrent replays HTTP 200; still two refunds totaling 0.50 USD |
| Delayed capture notification after refund | PASS after fix | HTTP 200 twice; one capture and two refunds unchanged |
| Real capture success, response lost before Medusa facts | PASS | Isolated response-loss injection after real PayPal success; callback 503, no Medusa payment, gate 409 |
| Recovery following lost response | PASS | Same capture adopted; one Medusa payment/capture, collection captured 1 USD |
| Stable capture request key on POST retry | CONTROLLED VERIFIED | Mocked timeout plus stale provider GET; two capture requests have identical key |
| Pending / denied capture | CONTROLLED VERIFIED | Official Medusa authorization on new local scratch DB; no trusted capture; all three gates 409 |
| Reversal | NOT FULLY E2E TESTABLE | No genuine Sandbox reversal generated; durable review/gate path only controlled |

### PAYMENT IDEMPOTENCY / RECOVERY

Second approved PayPal order `4G010049MV527645X`, actual capture `04K76483FL264142C`.
The first successful capture response was deliberately discarded only inside isolated HTTP
acceptance adapter. Before recovery, Medusa had zero payment facts and fulfillment returned409.
Three same-session callbacks raced a genuine approved notification: `[503,200,503,503]`.
Retry200 and duplicate completed notifications200/200. Database: one payment, one capture1USD.
Fresh PayPal GET: capture COMPLETED1USD. Recovery used provider GET rather than a second capture POST.
A real second POST with the same request key was not forced; stable-key retry verified controlled.
Concurrent503 is retryable but remains a readiness gap; do not label the race a clean PASS.

### REFUND RECONCILIATION / COMMERCE FACTS

First capture `14A51639JW9500410` now PARTIALLY_REFUNDED. Official Medusa refund0.25USD
plus external refund `79M33888PV3610023` COMPLETED0.25USD. Core Medusa: two refund rows0.50USD.
External refund identity, amount, currency, capture/payment/order mapping verified.
Duplicate external notification issued zero candidate refund POSTs. Initial adoption is also
validated by provider refund total and core facts; wire tracing was enabled afterward.
Fresh commerce-facts.sql: captured orders2, captured revenue2USD, refund0.50USD, net1.50USD.
Unpaid fault fixture is excluded from captured revenue. Fixtures deliberately lack customer/SKU;
these integrity gaps are test fixture properties, not invented customer or product history.

Two fixes discovered by genuine notifications:
1. Normalize validated capture identity from PayPal refund `links.up` for official adoption.
2. Ignore obsolete completed notification after validated partial/full refund without recapture.
Focused provider/reconciliation tests cover both.

### EVIDENCE / REPEATABILITY

Server `/root/pawshop-payment-sandbox-candidate-20261011` retains private
`fulfillment-http-result.json`, `medusa-refund-http.json`, `external-refund.json`,
`duplicate-webhook-evidence.json`, `post-refund-delayed-capture-result.json`,
`timeout-before-recovery.json`, `race-recovery-result.json`, `final-provider-facts.json`,
`final-medusa-facts.json`, `capture-request-evidence.jsonl`, `commerce-facts-final.log`,
`webhook-evidence/` and `cleanup-result.json`. Raw events/headers are private, not Git artifacts.
Reproducible isolated fixture scripts: `_commerce/tests/sandbox-safety/`; HTTP adapter
`_commerce/tests/sandbox-safety-server.ts`; local runner `payment-controlled-acceptance.mjs`.
Latest local pending/denied database `pawshop_payment_acceptance_0381aa41b16b`; logs
`/var/folders/gc/l9xqtlv13fl5vgf2z46qm1zr0000gn/T/pawshop-payment-acceptance-iEGX3Y`.

### KNOWN LIMITATIONS / READINESS

**NOT READY FOR PRODUCTION CANDIDATE acceptance.** Core safety facts verified but concurrent
503 recovery behavior, process-crash/distributed-lock lease recovery and genuine reversal
remain unresolved. HTTP adapter executes official handlers/workflows with candidate middleware,
uses isolated loopback test authentication, and is not a deployed Medusa auth/route-stack test.
Pending/denied and stale-read request-key retry are controlled verification, not genuine PayPal
status E2E. No production candidate activation, UI changes, Live credentials or real funds.
Next narrow work: explain/eliminate or formally support race503 with deterministic retries,
verify crash/lock recovery and real deployed route-stack governance before release consideration.

Final targeted verification: 18 payment-safety runtime tests PASS; latest TypeScript check PASS.
Local controlled acceptance including pending/denied PASS. Candidate test listener absent;
original production commerce current remains `13f5de447feb1e2b91e1ebe173c0aae4a6604852`.

## 2026-10-12 — resilience continuation supersedes race blocker

See `docs/PAYMENT_RESILIENCE_CHECKPOINT.md` for503 reproduction, crash A–E plus
network/partial-fact recovery, real Medusa60-second timer verification and limits.
Full matrix converges without browser retry or direct database repair. PostgreSQL
session locks release after SIGKILL and do not block a different session. Core
regression404pass/3 existingfail/3skip; targeted33pass and TypeScript pass.
Candidate now **READY FOR PRODUCTION CANDIDATE — CONTROLLED VERIFIED** for this
resilience scope; production release/runtime acceptance and Live remain unverified.
