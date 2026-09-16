// Redirects only the chat platform hostnames to the local sink for this test run.
//
// The monitor pins each provider's webhook to its vendor host on purpose, so the
// test keeps the real hostname in the URL and only moves the resolution.
import dns from 'node:dns';

const hosts = new Set(['open.feishu.cn', 'open.larksuite.com', 'api.telegram.org', 'hooks.slack.com']);
const original = dns.lookup;

dns.lookup = function lookup(hostname, options, callback) {
  let opts = options;
  let done = callback;
  if (typeof opts === 'function') {
    done = opts;
    opts = {};
  }
  if (hosts.has(hostname)) {
    if (opts && opts.all) return process.nextTick(done, null, [{ address: '127.0.0.1', family: 4 }]);
    return process.nextTick(done, null, '127.0.0.1', 4);
  }
  return original.call(this, hostname, opts, done);
};
