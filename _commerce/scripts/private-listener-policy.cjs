'use strict';

function listenerHosts(source, port) {
  const suffix = `:${port}`;
  return source.split('\n').flatMap(line => {
    const fields = line.trim().split(/\s+/);
    const local = fields[3];
    if (!local?.endsWith(suffix)) return [];
    return [local.slice(0, -suffix.length).replace(/^\[|\]$/g, '')];
  });
}

function assertLoopbackListeners(source, ports = [5432, 6379, 9000]) {
  for (const port of ports) {
    const hosts = listenerHosts(source, port);
    if (hosts.length === 0) throw new Error(`Required production service is not listening on port ${port}.`);
    if (hosts.some(host => host !== '127.0.0.1')) {
      throw new Error(`Production service port ${port} is not restricted to IPv4 loopback.`);
    }
  }
}

module.exports = { listenerHosts, assertLoopbackListeners };
