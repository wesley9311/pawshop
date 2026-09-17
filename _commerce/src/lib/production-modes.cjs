'use strict';

// Production runs in exactly one of two reviewed profiles. The mode is a
// deliberate, validated act rather than a feature flag: opening the storefront
// changes what the public internet can reach, so it must be a name you choose,
// not a boolean you flip.
//
//   production-admin-only  operator-only. Every /store and /auth/customer route
//                          answers 503. This is the default and the safe retreat.
//   production-storefront  the same hardened runtime, plus customer registration,
//                          sign-in and account APIs.
//
// Both profiles keep the admin API on loopback and both refuse to start on a
// malformed environment, so a mistake degrades to "the storefront stays shut"
// rather than "the storefront opened by accident".
const ADMIN_ONLY = 'production-admin-only';
const STOREFRONT = 'production-storefront';

const PRODUCTION_MODES = [ADMIN_ONLY, STOREFRONT];

function isProductionMode(value) {
  return PRODUCTION_MODES.includes(value);
}

// True only for the profile that exposes customer commerce.
function commerceIsOpen(mode) {
  return mode === STOREFRONT;
}

module.exports = { ADMIN_ONLY, STOREFRONT, PRODUCTION_MODES, isProductionMode, commerceIsOpen };
