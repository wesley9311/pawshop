import { verifyProduction } from './production-probe.mjs';

// Strict mode adds the two host-configuration gates that the standard probe
// does not cover: a Strict-Transport-Security header (with a minimum max-age)
// and a www -> apex redirect. It is kept separate from `verify:production` so
// that a host-side gap reports clearly instead of being folded into the
// deployment gate. Promote it to mandatory once the host is configured.
const value = name => {
  const supplied = process.env[name];
  if (!supplied) throw new Error(`${name} is required.`);
  return supplied;
};

try {
  const result = await verifyProduction({
    httpsOrigin: value('PAWSHOP_HTTPS_ORIGIN'),
    httpOrigin: value('PAWSHOP_HTTP_ORIGIN'),
    strict: true,
  });
  console.log(
    `Strict production verification passed with ${result.productCount} active product(s); ` +
    `HSTS max-age ${result.hstsMaxAge}s; www redirects to the apex origin.`,
  );
} catch (error) {
  console.error(`Strict production verification failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
}
