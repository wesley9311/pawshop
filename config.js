// Public, non-secret storefront configuration only.
// Credentials and service tokens must be configured on a server, never here.
const PAWSHOP_PUBLIC_CONFIG = Object.freeze({
  mode: 'prelaunch',
  primaryMarket: 'US',
  displayCurrency: 'USD',
  shipsFrom: 'China',
  inquiryEnabled: false,
  checkoutEnabled: false,
});
