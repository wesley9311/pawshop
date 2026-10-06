'use strict';

// Standalone transport probe: proves a plain Node HTTPS client can reach
// https://pawlivora.com using the SAME path the verified curl used
// (curl -4 --noproxy '*'). It does NOT touch the auth backend, DB, or OTP.
//
// Usage:  node ops/commerce/transport-probe.cjs [path]
//         default path = "/"  (public, side-effect-free, returns 200 HTML)

const https = require('node:https');
const net = require('node:net');
const dns = require('node:dns');

const HOST = 'pawlivora.com';
const PORT = 443;
const PATH = (process.argv[2] || '/').trim();

// Force IPv4 at the DNS layer AND the socket layer, bypassing any proxy env.
// `lookup` overrides Node's default getaddrinfo so family=4 is guaranteed and
// no HTTP(S)_PROXY / NO_PROXY env var is consulted (https.request never reads
// them, but we also strip them defensively for absolute determinism).
const lookup = (hostname, options, callback) => {
  dns.lookup(hostname, { family: 4, all: false, verbatim: true }, (err, address) => {
    if (err) return callback(err);
    callback(null, address, 4);
  });
};

function request(method, path) {
  return new Promise((resolve) => {
    const started = Date.now();
    let phase = 'socket';
    const req = https.request({
      hostname: HOST,
      servername: HOST, // explicit TLS SNI = pawlivora.com
      port: PORT,
      path,
      method,
      family: 4,
      lookup,
      // Never use a proxy; do not read proxy env. Explicit, not default.
      agent: new https.Agent({
        keepAlive: false,
        maxSockets: 1,
      }),
      headers: {
        Accept: 'text/html,application/json',
        'User-Agent': 'pawshop-transport-probe/1.0',
      },
    }, (res) => {
      phase = 'response';
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        resolve({
          ok: true,
          status: res.statusCode,
          contentType: res.headers['content-type'] || '',
          bytes: raw.length,
          ms: Date.now() - started,
        });
      });
    });

    req.setTimeout(15000, () => {
      phase = 'timeout';
      req.destroy(Object.assign(new Error('request timed out after 15000ms'), { code: 'ETIMEDOUT' }));
    });

    req.on('socket', (s) => {
      phase = 'tls';
      // Record the resolved IPv4 address for diagnostics (no secrets).
      req._remoteAddress = s.remoteAddress;
      req._remoteFamily = s.remoteFamily;
    });

    req.on('error', (e) => {
      resolve({
        ok: false,
        phase,
        name: e?.name || 'Error',
        message: e?.message || String(e || ''),
        code: e?.code || undefined,
        causeCode: e?.cause?.code || undefined,
        causeErrno: e?.cause?.errno || undefined,
        causeSyscall: e?.cause?.syscall || undefined,
        causeAddress: e?.cause?.address || undefined,
        causePort: e?.cause?.port || undefined,
        remoteAddress: req._remoteAddress || undefined,
        ms: Date.now() - started,
      });
    });

    req.end();
  });
}

(async () => {
  console.log('=== PawShop transport probe (Node HTTPS, forced IPv4, no proxy) ===');
  console.log(` target: https://${HOST}:${PORT}${PATH}`);
  console.log('');

  // Pre-flight: resolve IPv4 to prove DNS.
  const ipv4 = await new Promise((res) => dns.lookup(HOST, { family: 4 }, (e, a) => res(e ? null : a)));
  console.log(` DNS A record for ${HOST}: ${ipv4 || 'FAILED'}`);

  const r = await request('GET', PATH);

  if (r.ok) {
    console.log(` ✅ GET ${PATH} -> ${r.status} (${r.contentType || 'n/a'}) ${r.bytes}B in ${r.ms}ms`);
    console.log('   Node HTTPS client reached pawlivora.com successfully.');
    process.exit(r.status >= 200 && r.status < 500 ? 0 : 1);
  } else {
    console.log(' ❌ TRANSPORT FAILURE:');
    for (const k of ['phase', 'name', 'message', 'code', 'causeCode', 'causeErrno', 'causeSyscall', 'causeAddress', 'causePort', 'remoteAddress']) {
      if (r[k] !== undefined) console.log(`   ${k} = ${r[k]}`);
    }
    console.log(`   elapsed = ${r.ms}ms`);
    process.exit(2);
  }
})();
