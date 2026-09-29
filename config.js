// Public, non-secret storefront configuration only.
// Credentials and service tokens must be configured on a server, never here.
const PAWSHOP_PUBLIC_CONFIG = Object.freeze({
  mode: 'storefront',
  primaryMarket: 'US',
  displayCurrency: 'USD',
  shipsFrom: 'China',
  inquiryEnabled: false,

  // Recommended shipping country shown first at checkout. This is a default
  // only: the real list of shippable countries always comes from the region
  // (`/store/regions` -> `countries`), and the buyer can switch to any other
  // shippable country. It is never used to force or lock the final country.
  defaultCountry: 'US',

  // Shipping costs, taxes and totals are always read from the Medusa cart.
  // There is no hardcoded shipping amount in the storefront: the US region's
  // "Standard Shipping" option (and any future options) come from the cart.

  // The storefront calls the Medusa Store API on its own origin: production
  // nginx forwards /store/ to the commerce process. Same-origin means the
  // browser never depends on a CORS configuration.
  storeApiBase: '/store',

  // Publishable API key. A public identifier, not a credential: every visitor's
  // browser receives it, and all it unlocks is the published catalog of this
  // sales channel. Admin keys and secrets must never appear here.
  publishableKey: 'pk_f123c6182403217335137418b5094114d8add70aca3991f07f951c9c2c0b908e',

  // Hostnames allowed to serve product images: the object-storage bucket the
  // admin uploads to. safe.js drops every other host.
  imageHosts: ['pawlivora-products-us-west-1.oss-us-west-1.aliyuncs.com', 'media.pawlivora.com'],

  // The payment provider the storefront offers at checkout. This is the
  // provider's registered id in the payment module (pp_<identifier>_<id>), a
  // public identifier, not a credential. When no payment provider is enabled
  // for the region, checkout stops at the honest "not connected yet" boundary.
  paypalProviderId: 'pp_paypal_paypal',
});
