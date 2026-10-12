# Payment resilience + eventual convergence — 2026-10-12

## 503 ROOT CAUSE

The earlier isolated HTTP adapter converted every caught exception to503 without
recording its cause. Exact old exceptions cannot be reconstructed. Reproduction
with the installed Medusa2.21 official payment module produced two errors:
`Payment with payment_session_id ... already exists`, one success, and two
provider void compensation attempts. This is a database uniqueness race across
session read → provider operation → local transaction, not demonstrated lock
contention. It plausibly explains the prior race; do not claim every old503 is proven.
An injected lost capture response is separately proven as a503 before any local
payment fact. Previously explicit callback retry restored that case; signed
webhook could also recover, but no independent durable recovery driver existed.

## IMPLEMENTATION

- PawShop payment module extends the official service, preserving its models,
  provider loader, links and installed migration history. No node_modules patch
  or replacement commerce schema. Installed version remains2.21.
- Serialize the complete official authorization by payment session using a
  PostgreSQL session advisory lock. Unique SHA256 namespace, separate pooled
  connection, owner release in finally; process/connection death releases lock.
  Fifteen-second acquisition deadline can still yield a retryable failure.
- Provider validates order/session relation. Deterministic authorization/capture
  request keys and fresh PayPal read-back remain unchanged.
- Official idempotent return now repairs collection aggregate; an existing
  authorized payment without capture can recover through official capture service.
- Never void an operation whose provider data already records a capture.
- Existing durable payment sessions form the recovery list. Medusa scheduled job
  runs every60 seconds, fresh reads provider status, executes official workflow
  and serialized service. Transient failures remain eligible for later ticks.
- Only sessions created with `auto_capture_policy=pawshop-auto-capture-v1` are
  eligible. Old23 production Sandbox orders and legacy authorizations are excluded.
  An unapproved read preserves this eligibility instead of dropping recovery data.
- No new external queue, infrastructure, credential, env key or production release.
- Test adapter now records redacted exception category and entry point.

## CRASH MATRIX — controlled provider, real PostgreSQL / Medusa / SIGKILL

| Case | Failure / concurrency | Before convergence | Final |
|---|---|---|---|
| A | Process killed before capture POST | Gate409 | One provider capture; one trusted local capture; gate allow |
| B | Provider capture succeeds, process killed before local fact | Gate409 | Same capture adopted; one local fact; gate allow |
| C | Local fact commits, process killed before response | Gate allow: fact already trusted | Same payment/capture, no second capture |
| D | Process killed while holding advisory lock | Gate409 | Restart acquires lock without TTL wait / DB repair |
| E | Two independent worker processes, same session/authorization | Serialized | Both succeed; one payment/capture |
| F | Provider success followed by socket destruction | Gate409 | Scheduled recovery handler adopts provider fact |
| G | Fault fixture: committed local authorization, missing capture fact | Gate409 | Official provider-aware capture service repairs fact |

Each recoverable incomplete case also injects one503 on recovery read-back before
successful subsequent recovery. Cases use only fresh scratch databases and clearly
labeled controlled fixtures. G fixture preparation uses official service APIs;
convergence never uses direct SQL repair. D additionally proves another session can
capture while the first session lock is held.

Final seven-case evidence:
`/var/folders/gc/l9xqtlv13fl5vgf2z46qm1zr0000gn/T/pawshop-payment-acceptance-fqQcVH/crash-matrix.json`.
Runner: `node _commerce/scripts/payment-crash-acceptance.mjs` with Node22/24.
Recovery executes through the installed Medusa JobLoader workflow adapter, verifying
its actual container argument signature. Provider is controlled, not genuine PayPal
for these crash cases; prior real Sandbox capture/refund evidence remains separate.

## LOCK RECOVERY / DOUBLE-CAPTURE CHECK

All independent worker instances use the same PostgreSQL database lock namespace.
No capture lock is stored as a `processing` row or Redis key requiring manual cleanup.
SIGKILL closes the owning connection; subsequent worker recovers immediately.
Repeated capture attempts preserve the same PayPal request key. Controlled provider
records one financial capture and core database records exactly one capture per case.
Do not mistake controlled provider idempotency for a new genuine PayPal E2E result.
No process may bypass official provider amount/currency validation or fulfillment gate.

## REVERSAL LIMITATION

A verified reversal event is intercepted, relationship-checked and durably marked
`review`; it is never adopted as a successful payment or ordinary refund. Error log:
`PayPal reconciliation requires review: paypal_capture_reversed; event=<id>`.
Review rows block subsequent server-side fulfillment. Runtime reconciliation test
checks event recognition, review reason, one alert and zero generated refund;
controlled database route tests verify review hold. Manual review is required.
Genuine PayPal Sandbox reversal remains **NOT FULLY E2E TESTABLE**.

## VERIFICATION / LIMITS

-33 targeted payment/provider/production-module tests pass.
-TypeScript check passes.
-Core regression410 tests:404pass,3 existing order-lookup failures,3skip.
-No original23 order changes, production deployment, Live credentials or real funds.
-Prior real Sandbox evidence is accepted, but new crash matrix uses a controlled
 provider and real local PostgreSQL; production Redis scheduler restart behavior
 and complete deployed application bootstrap are not represented by local tests.
-PostgreSQL advisory lock requires a live owning connection. Active network-partition
 behavior beyond configured provider timeout and eventual database reconnection is
 not an exhaustive proof of every possible infrastructure outage.

## ACTUAL TIMER VERIFICATION / READINESS

CaseH also passes: installed Medusa JobLoader registers the job and the real
in-memory WorkflowScheduler storage schedules its unmodified60-second interval.
The worker only polls facts; it does not invoke recovery, authorization or a
callback. At the scheduled tick, one provider capture / one Medusa capture forms
and gate changes409 → allow. Evidence:
`/var/folders/gc/l9xqtlv13fl5vgf2z46qm1zr0000gn/T/pawshop-payment-acceptance-LaxJrL/crash-matrix.json`.
Repeat with `node _commerce/scripts/payment-crash-acceptance.mjs --timer-only`.

**READY FOR PRODUCTION CANDIDATE — CONTROLLED VERIFIED**, within the defined
crash/concurrency/network matrix. This supersedes the prior race503 blocker.
It does not mean production-installed, Live-ready or newly real-PayPal crash E2E.
Production Redis worker bootstrap/restart and sensitive release governance remain
release acceptance gates. No production deployment is authorized by this result.
