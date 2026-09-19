// Public, non-secret storefront configuration only.
// Credentials and service tokens must be configured on a server, never here.
const PAWSHOP_PUBLIC_CONFIG = Object.freeze({
  mode: 'storefront',
  primaryMarket: 'US',
  displayCurrency: 'USD',
  shipsFrom: 'China',
  inquiryEnabled: false,
  // Checkout stays closed until a real payment provider is connected to the US
  // region. Flipping this flag must never be how an order gets created.
  checkoutEnabled: false,

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
  imageHosts: ['pawlivora-products-us-west-1.oss-us-west-1.aliyuncs.com'],
});
