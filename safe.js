(function () {
  'use strict';

  function html(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function url(value) {
    try {
      if (typeof value !== 'string' || !value.trim()) return '';
      const parsed = new URL(value, window.location.href);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== window.location.origin) return '';
      return html(parsed.href);
    } catch (_) {
      return '';
    }
  }

  function icon(value) {
    const candidate = String(value || 'fa-box');
    return /^fa-[a-z0-9-]+$/.test(candidate) ? candidate : 'fa-box';
  }

  // Product images are served from the shop's own host and from the object
  // storage host configured in config.js. Anything else is dropped: a catalog
  // entry must not be able to turn a product card into a tracking beacon, and
  // no URL scheme other than http/https is ever emitted.
  function image(value, allowedHosts) {
    const hosts = Array.isArray(allowedHosts) ? allowedHosts : [];
    const candidate = String(value || '').trim();
    if (!candidate) return '';
    try {
      const parsed = new URL(candidate, window.location.href);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
      if (parsed.origin === window.location.origin) return html(parsed.href);
      if (parsed.protocol !== 'https:') return '';
      return hosts.includes(parsed.hostname) ? html(parsed.href) : '';
    } catch (_) {
      return '';
    }
  }

  function token(value) {
    const candidate = String(value || '');
    return /^[a-z0-9_-]+$/i.test(candidate) ? candidate : '';
  }

  function id(value) {
    const candidate = Number(value);
    return Number.isSafeInteger(candidate) && candidate > 0 ? candidate : 0;
  }

  function quantity(value) {
    const candidate = Number(value);
    return Number.isSafeInteger(candidate) && candidate > 0 ? Math.min(candidate, 99) : 1;
  }

  function catalog(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    return value.filter(p => {
      if (!p || p.active === false || !Number.isSafeInteger(p.id) || p.id <= 0 || seen.has(p.id)) return false;
      if (typeof p.name !== 'string' || !p.name.trim() || typeof p.price !== 'number' || !Number.isFinite(p.price) || p.price < 0) return false;
      if (p.availability !== 'prelaunch' || Object.hasOwn(p, 'stock')) return false;
      seen.add(p.id);
      return true;
    }).map(p => ({
      ...p,
      originalPrice: typeof p.originalPrice === 'number' && Number.isFinite(p.originalPrice) && p.originalPrice > p.price ? p.originalPrice : null,
      variants: Array.isArray(p.variants) ? p.variants.filter(v => typeof v === 'string') : [],
      specs: Array.isArray(p.specs) ? p.specs.filter(v => v && typeof v === 'object') : [],
      reviews: Array.isArray(p.reviews) ? p.reviews.filter(v => v && typeof v === 'object') : [],
    }));
  }

  window.PawSafe = Object.freeze({ html, url, image, icon, token, id, quantity, catalog });
})();
