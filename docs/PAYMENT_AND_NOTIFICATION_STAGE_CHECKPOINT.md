# PawShop serial stages — 2026-10-12

## STAGE A PAYMENT RESULT — PASS, production runtime / Sandbox

Exact immutable production candidate `8201a0b392f4e2429b2498f757225dece8621a5e`;
content digest `2f025e7771e1c5d435b3b7f1249a9b0d279bb1999e162c9d5f39d191f358cfd3`.
Upgrade backup, additive migration155relations (154before), post-migration offsite
read-back and isolated restore drill passed. Runtime files matched exact release.
Service/Redis healthy; real Redis scheduled recovery jobs completed every60seconds,
including after explicit service restart. NRestarts0, commerce health200.

Owner approved a NEW production-URL Store API cart using real catalog variant
PAW-1, amount39.80USD. PayPal order `4LL81576N03659945`, capture
`8UT008713G647592F`; one provider capture / one Medusa capture fact.
Order `order_01M4PYTYHY3NE6H14T7N0WA3DA`, payment
`pay_01M4PYV1213GM4XRMKG52FNF9B`. Actual authenticated Admin routes created
fulfillment `ful_01M4PYWKRAY2HH95M3M8AVB742`, shipped and delivered; DB timestamps
confirmed. This is Sandbox acceptance, not physical shipment or Live revenue.

Official Medusa refund0.10USD: `3GS61552567747420`. External Sandbox refund39.70USD:
`4RR36708W61830804`. Both independently GET-verified COMPLETED; original production
webhook adopted external refund, both ledger rows applied. Original Sandbox webhook
subscription now also includes REFUNDED/REVERSED; credentials/mode/ID unchanged.
Post-refund valid create/ship/deliver requests returned server409. Initial empty
request400was a validator refusal and was NOT counted as a gate PASS.
New transaction captured39.80/refund39.80/net0.00. Full commerce-facts.sql reports
12captured orders, captured revenue567.30, refund39.80, net527.50USD; all Sandbox.
All original23 order/payment/capture snapshots remained identical. No UI changes.
StageA source correction removed duplicate webhook raw-body parser per Runbook;
Medusa's native hook parser is retained. No Live credentials or Live switch.

Private server evidence lives outside immutable releases under `/root/pawshop-stage-a-*`:
original-facts, acceptance, refund-proof, runtime-proof, scheduler-proof, commerce-facts,
webhook-before/after, HTTP replies and upgrade/drill/activation/restart logs.
Test harness state briefly lost its external-refund identifier; it was recovered
from existing applied ledger / provider GET, without another refund or DB repair.
StageA PASS was established BEFORE notification audit or implementation began.

## NOTIFICATION COVERAGE BEFORE — observed

Production audit: order_confirmed7sent, shipped3sent, delivered7sent.
One cancelled order, zero returns. Existing3subscribers have deterministic business
keys, real PostgreSQL claim/lease/retry audit and an existing60second retry worker.
Password-reset/verification mails are separate and remain unchanged.
Order confirmation covers normal successful checkout; no duplicate capture email
is needed. Fulfillment creation is not treated as shipment.

## NOTIFICATION GAPS / EVENT SOURCE / IMPACT

| Gap | Trusted source | Impact |
|---|---|---|
| Cancellation | order.canceled + current order + provider read-back | Customer cannot know charge/authorization/refund outcome |
| Refund confirmation | payment.refunded / refund.created, re-read confirmed provider refund and exact core mapping | Customer lacks amount/status/next-step receipt |
| Processing / review | Persisted reconciliation refund review with verified payment/order/capture/amount/currency | Customer cannot distinguish processing from completed |
| Internal refund request / failed attempt | No durable unified request/result entity; provisional refund rows can be deleted | Cannot reliably identify every request or send an accurate failed-request receipt |
| Return lifecycle | Medusa has generic Admin capabilities; no integrated PawShop customer return path, no production return records | No trustworthy end-to-end return notification source |

No return workflow, chatbot, analytics or new payment provider was built.

## IMPLEMENTED — minimal notification extension

Unified order/payment/refund events → shared notification helper → SMTP → existing
retry/idempotency/audit. Rendering remains provider-neutral; one read-only evidence
adapter currently supports the configured provider. Unsupported evidence fails
closed, leaving a clear payment_unverified audit record; no success mail invented.

Cancellation says order cancelled and distinguishes no capture, verified void,
capture/refund totals, incomplete refund, or unknown payment outcome. Refund
confirmation requires positive amount, matching currency/capture/payment/order,
core refund-map identity and fresh completed provider fact. Provisional rows never
mean successful refund. Processing and review have separate dedup keys so a later
review update is not swallowed by an earlier processing message. Resolved review
suppresses stale processing notices. Emails expose no payment identifiers/secrets.

New financial types use deterministic Message-ID. Known pre-delivery failures retry.
SMTP DATA with lost acknowledgement, stale financial sending lease, or relay
acceptance without a reliable audit transition is quarantined as delivery_unknown,
not automatically resent. That case requires operator review; SMTP has no atomic
transaction with the database. Existing3notification types retain their behavior.

A60second neutral event recovery publisher queries real new cancellations/refunds
and verified review records, so an event lost before creating a notification claim
still recovers. Rollout boundary is2026-10-12T00:00:00Z; this is not a historical
email backfill. It never modifies commerce facts. No schema or credential change.

## TRANSACTIONAL EMAIL E2E — controlled PASS

New scratch DB only, actual Medusa workflows / PostgreSQL / TLS SMTP sink:
unpaid cancel, legacy-authorized cancel/void, captured cancel with official refund,
confirmed refund, pending→review, duplicate concurrency,450retry→one accepted mail,
provisional refund refusal, deleted provisional refund suppression, and unknown
SMTP acceptance→no second mail. Amount/currency/public order-number assertions use
real fixture facts and actual transmitted MIME. Successful retry audit attempts2,
one accepted receipt. Financial uncertainty audit persists delivery_unknown.

Repeat with Node22/24: `node _commerce/scripts/financial-notification-acceptance.mjs`.
Evidence `/var/folders/gc/l9xqtlv13fl5vgf2z46qm1zr0000gn/T/pawshop-payment-acceptance-w9IODk`.
Core regression413tests:407pass,3existing order-lookup failures,3skip; types pass.

## KNOWN GAPS

Internal requested/failed refund attempts without durable business request identity
cannot be exhaustively notified; no fake processing/completed status is added.
Return remains a separate workflow gap. Reversal remains NOT FULLY E2E TESTABLE;
operator review/fulfillment block are preserved. Unknown SMTP acceptance requires
manual delivery review. SMTP relay acceptance is not proof of inbox receipt.
No automatic test is OWNER VERIFIED. Production notification acceptance follows
only after release deployment and real relay audit below.

## Production notification receipt — StageB

Initial code-only candidate `bfa0ca44d84b8508b5aabb9c6fb7dcb8c4f02836` activated
without schema/credential changes after StageA PASS. The neutral financial recovery
publisher recovered StageA's two REAL completed refunds. Production audit shows
`refund_completed: sent2`, attempt_count1 for each. Duplicate scheduled events do
not resend them. This proves actual relay acceptance, not Owner inbox verification.

Final hardening also checks sessions without local Payment rows: absence of a
Payment record is not proof of no authorization/capture. Unconverged provider facts
are reported as needing review. Controlled cancellation case verifies this message
and rejects the false "no authorization" statement. Fresh proof additionally
validates review capture and currency mapping. Latest controlled evidence:
`/var/folders/gc/l9xqtlv13fl5vgf2z46qm1zr0000gn/T/pawshop-payment-acceptance-860DPi`.

Late review suppression is also runtime-tested: once the provider refund is
completed AND its exact local refund identity/amount is confirmed, a still-review
ledger row cannot cause an obsolete processing/review mail. Latest final controlled
proof: `/var/folders/gc/l9xqtlv13fl5vgf2z46qm1zr0000gn/T/pawshop-payment-acceptance-mhBGIm`.
