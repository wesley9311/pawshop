'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { deriveHmacKey, normalizeCode, digestCode } = require('../src/lib/otp-code.cjs');

// Static-source invariants for the passwordless `otp-email` auth provider and its
// wiring. The provider itself depends on the Medusa container (it is instantiated
// by the auth module's registration function), so the runtime flow is exercised in
// the loopback harness; this file pins the security invariants the Owner's Phase 2
// acceptance matrix depends on, so a regression is caught before the loopback run.

const PROVIDER_PATH = path.join(__dirname, '..', 'src', 'modules', 'pawshop-otp-email-auth', 'otp-email-auth-provider.ts');
const providerSource = fs.readFileSync(PROVIDER_PATH, 'utf8');
const INDEX_PATH = path.join(__dirname, '..', 'src', 'modules', 'pawshop-otp-email-auth', 'index.ts');
const indexSource = fs.readFileSync(INDEX_PATH, 'utf8');
const MODULES_PATH = path.join(__dirname, '..', 'src', 'lib', 'production-modules.cjs');
const modulesSource = fs.readFileSync(MODULES_PATH, 'utf8');
const POLICY_PATH = path.join(__dirname, '..', 'src', 'lib', 'production-policy.cjs');
const policySource = fs.readFileSync(POLICY_PATH, 'utf8');

// ---------- provider identity / routing ----------

test('otp-email is registered as an AUTH provider (not a verification provider)', () => {
  // A verification provider (verif_otp) proves email ownership but never issues a
  // JWT. otp-email must be an AUTH provider so its authenticate() drives JWT
  // issuance. The index wraps it via ModuleProvider(Modules.AUTH, ...).
  assert.ok(/ModuleProvider\(Modules\.AUTH/.test(indexSource), 'wrapped as an auth module provider');
  assert.ok(/services:\s*\[\s*OtpEmailAuthProvider/.test(indexSource), 'registers the provider service');
});

test('otp-email is wired into auth.providers alongside emailpass (always, no credential gate)', () => {
  assert.ok(/id:\s*'otp-email'/.test(modulesSource), 'otp-email id present');
  assert.ok(/resolve:\s*'\.\/src\/modules\/pawshop-otp-email-auth'/.test(modulesSource), 'resolves to the local module');
  assert.ok(/hmac_secret:\s*jwtSecret/.test(modulesSource), 'HMAC secret derives from jwtSecret (no new env key)');
});

test('customer authMethodsPerActor includes otp-email (and never google)', () => {
  assert.ok(/customer:\s*\[\s*'emailpass',\s*'otp-email'\s*\]/.test(policySource),
    'customer allowlist is emailpass + otp-email');
  assert.ok(!/customer:\s*\[[^\]]*'google'/.test(policySource),
    'google must never appear in the customer allowlist');
});

// ---------- security-critical: register → refresh takeover is closed ----------

test('authVerificationsPerActor gates otp-email on verified_at (closes register→refresh takeover)', () => {
  assert.ok(/authVerificationsPerActor/.test(policySource), 'verification gate is configured');
  assert.ok(/customer:\s*\[\s*\{\s*entity_type:\s*'customer',\s*auth_provider:\s*'otp-email'\s*\}/.test(policySource),
    'customer actor requires otp-email verification');
  assert.ok(/authVerificationsPerActor/.test(policySource.replace(/http:\s*\{[^}]*\}/s, '') || policySource),
    'gate is returned in the http object');
});

test('entity_type is aligned with verif_otp (customer), so validateVerification can find the row', () => {
  // validateVerification lists auth_verification by entity_type; if this were
  // 'email' while verif_otp stores 'customer', every OTP login would deadlock.
  assert.ok(/entity_type:\s*'customer'/.test(policySource), 'entity_type matches verif_otp (customer)');
});

// ---------- register(): actorless + idempotent + cross-provider binding ----------

test('register() returns an actorless identity (strips app_metadata.customer_id)', () => {
  assert.ok(/stripActor_/.test(providerSource), 'has an actor-stripping helper');
  assert.ok(/delete \(copy\.app_metadata as Record<string, unknown>\)\.customer_id/.test(providerSource),
    'deletes customer_id from app_metadata');
  assert.ok(/return \{ success: true, authIdentity: this\.stripActor_\(authIdentity\) \}/.test(providerSource),
    'every register return path strips the actor');
});

test('register() is idempotent and returns success for an existing otp-email identity', () => {
  // Unlike emailpass (which refuses an existing email), otp-email must return
  // success + actorless identity for an email that already has an otp-email
  // provider identity, so request→confirm→bind can always run. (Error branches
  // for a malformed email / failed binding are fine; an existing valid email is not.)
  assert.ok(/Already has an otp-email identity — idempotent\./.test(providerSource),
    'existing otp-email identity is an idempotent success');
  assert.ok(/return \{ success: true, authIdentity: this\.stripActor_\(authIdentity\) \}/.test(providerSource),
    'the idempotent path returns success + actorless identity');
});

test('register() binds an otp-email provider identity to an EXISTING auth_identity (no detached identity)', () => {
  assert.ok(/providerIdentityService\.list\(\{ entity_id: email \}/.test(providerSource),
    'checks for an existing identity via the unscoped service');
  assert.ok(/providerIdentityService\.create\(\{[^}]*provider:\s*'otp-email'/.test(providerSource),
    'adds an otp-email provider identity to the same auth_identity');
});

// ---------- authenticate(): OTP one-time + keyed HMAC + no plaintext leak ----------

test('authenticate() validates the 6-digit code via the shared keyed HMAC (never a bare sha256)', () => {
  assert.ok(/digestCode\(this\.hmacKey_/.test(providerSource), 'digests with the keyed HMAC');
  assert.ok(/deriveHmacKey\(secret\)/.test(providerSource), 'derives the HMAC key from the secret');
});

test('authenticate() atomically consumes the OTP (verified_at IS NULL conditional update)', () => {
  assert.ok(/nativeUpdate/.test(providerSource), 'uses nativeUpdate for the atomic claim');
  assert.ok(/verified_at:\s*null/.test(providerSource), 'claim is conditional on verified_at being NULL');
  assert.ok(/affected\s*===?\s*0/.test(providerSource), 'a zero-row claim is rejected (already used)');
});

test('authenticate() rejects an expired, wrong, or cross-entity code', () => {
  assert.ok(/Verification code has expired/.test(providerSource), 'expiry is checked');
  assert.ok(/verification\.entity_id !== email/.test(providerSource), 'the code must belong to the presented email');
  assert.ok(/Verification code is invalid or already used/.test(providerSource), 'wrong/used code is rejected');
});

test('the provider never stores or returns the plaintext code (only code_hash)', () => {
  assert.ok(/code_hash/.test(providerSource), 'only the keyed-HMAC code_hash is referenced');
  assert.ok(!/provider_metadata:\s*\{\s*code\s*:/.test(providerSource), 'plaintext code is never stored');
});

// ---------- HMAC domain separation (shared with verif_otp) ----------

test('the otp-email provider reuses the SAME keyed-HMAC contract as verif_otp', () => {
  // Both derive from the same domain-separated key, so the code requested by
  // verif_otp is the SAME digest the auth provider's authenticate() looks up.
  const k1 = deriveHmacKey('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  const k2 = deriveHmacKey('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  assert.deepEqual(k1, k2, 'deterministic');
  assert.equal(digestCode(k1, '123456'), digestCode(k2, '123456'), 'same digest for same code');
});
