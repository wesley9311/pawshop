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
      if (!['https:', 'http:'].includes(parsed.protocol)) return '';
      return html(parsed.href);
    } catch (_) {
      return '';
    }
  }

  function icon(value) {
    const candidate = String(value || 'fa-box');
    return /^fa-[a-z0-9-]+$/.test(candidate) ? candidate : 'fa-box';
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
      if (!Number.isSafeInteger(p.stock) || p.stock < 0) return false;
      seen.add(p.id);
      return true;
    }).map(p => ({
      ...p,
      originalPrice: typeof p.originalPrice === 'number' && Number.isFinite(p.originalPrice) && p.originalPrice >= p.price ? p.originalPrice : p.price,
      variants: Array.isArray(p.variants) ? p.variants.filter(v => typeof v === 'string') : [],
      specs: Array.isArray(p.specs) ? p.specs.filter(v => v && typeof v === 'object') : [],
      reviews: Array.isArray(p.reviews) ? p.reviews.filter(v => v && typeof v === 'object') : [],
    }));
  }

  window.PawSafe = Object.freeze({ html, url, icon, token, id, quantity, catalog });
})();
