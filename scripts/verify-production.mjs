import { verifyProduction } from './production-probe.mjs';

const value = name => {
  const supplied = process.env[name];
  if (!supplied) throw new Error(`${name} is required.`);
  return supplied;
};

try {
  const result = await verifyProduction({
    httpsOrigin: value('PAWSHOP_HTTPS_ORIGIN'),
    httpOrigin: value('PAWSHOP_HTTP_ORIGIN'),
  });
  console.log(`Production verification passed with ${result.productCount} active product(s).`);
} catch (error) {
  console.error(`Production verification failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
}

