// PawShop storefront data layer for the Medusa Store API.
//
// The storefront talks to the same origin it is served from (`/store/...`),
// which production nginx forwards to the commerce process on 127.0.0.1:9000.
// The only credential is the publishable API key, a public value that every
// visitor's browser receives by design: it unlocks the published catalog and
// nothing else.
//
// Scope is deliberately: list products, read one cart, build a cart. There is
// no checkout, no order submission and no customer account in this file --
// money is not connected yet, and the storefront must not pretend otherwise.
(function () {
  'use strict';

  var CART_ID_KEY = 'pawshop_medusa_cart_id';

  // Default product fields already include *images, *variants, title, subtitle,
  // description, handle, etc. Prices and inventory are extra fields and must be
  // requested explicitly, and prices additionally need a price context
  // (region_id, country_code or cart_id).
  //
  // `metadata` is also an extra field (not in the defaults). It must be
  // requested with a `+` prefix: in Medusa's field-parser, a bare field name
  // with no modifier REPLACES the default field set, so a bare `metadata` would
  // drop title/subtitle/description/images/variants entirely. `+metadata` means
  // "add this to the defaults", which keeps the whole default surface intact.
  var PRODUCT_FIELDS = [
    '*variants.calculated_price',
    '*variants.inventory_quantity',
    '*variants.manage_inventory',
    '*variants.allow_backorder',
    '+metadata',
  ].join(',');

  // Locale codes the storefront resolves product copy against. The shop's two
  // published products are currently single-language (one English, one Chinese),
  // so `metadata.i18n` carries the non-default-language overrides only. These
  // are the only two codes we resolve today.
  var SUPPORTED_LOCALES = ['en-US', 'zh-CN'];

  function containsCJK(value) {
    return isNonEmptyString(value) && /[\u4e00-\u9fff]/.test(value);
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function toAmount(value) {
    var amount = typeof value === 'string' ? Number(value) : value;
    return typeof amount === 'number' && Number.isFinite(amount) ? amount : null;
  }

  // Medusa returns amounts in the currency's major unit (29.9 => $29.90).
  function formatMoney(amount, currencyCode) {
    var value = toAmount(amount);
    if (value === null) return '';
    var symbol = String(currencyCode || 'usd').toLowerCase() === 'usd' ? '$' : '';
    return symbol + value.toFixed(2);
  }

  // Never claim stock we were not told about: when the inventory fields are
  // absent the honest answer is "unknown", not "in stock".
  function variantAvailability(variant) {
    if (!variant || typeof variant !== 'object') return 'unavailable';
    if (variant.manage_inventory === false) return 'in_stock';
    var quantity = variant.inventory_quantity;
    if (typeof quantity === 'number' && Number.isFinite(quantity)) {
      if (quantity > 0) return 'in_stock';
      return variant.allow_backorder === true ? 'backorder' : 'out_of_stock';
    }
    return 'unknown';
  }

  function variantPrice(variant) {
    if (!variant || typeof variant !== 'object') return null;
    var calculated = variant.calculated_price;
    if (calculated && typeof calculated === 'object') {
      var amount = toAmount(calculated.calculated_amount);
      if (amount !== null) return amount;
    }
    if (Array.isArray(variant.prices) && variant.prices.length) {
      var price = toAmount(variant.prices[0] && variant.prices[0].amount);
      if (price !== null) return price;
    }
    return null;
  }

  function imageUrl(entry) {
    if (typeof entry === 'string') return entry.trim();
    if (entry && typeof entry === 'object' && isNonEmptyString(entry.url)) return entry.url.trim();
    return '';
  }

  function uniqueImages(list) {
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var url = imageUrl(list[i]);
      if (!url || seen[url]) continue;
      seen[url] = true;
      out.push(url);
    }
    return out;
  }

  // Resolve one piece of customer-facing product copy (title/subtitle/
  // description) for a requested locale. The rules, in order:
  //   1. `metadata.i18n.translations[lang][field]` when present and non-empty.
  //   2. Otherwise the product's own field (the "default locale" source).
  //   3. Safety net: when the requested locale is English and the fallback
  //      field contains CJK (a Chinese-only product with no English override),
  //      we must NOT leak Chinese into an English page — return '' instead so
  //      the UI can show an honest "details coming soon" placeholder.
  // A missing/null/empty `metadata` or `metadata.i18n` never throws — it simply
  // falls back to the product's own field (and, in the CJK case, to '').
  function localizedText(raw, lang, field) {
    var i18n = raw && raw.metadata && typeof raw.metadata === 'object' ? raw.metadata.i18n : null;
    var translations = i18n && i18n.translations && typeof i18n.translations === 'object' ? i18n.translations : null;
    var override = translations && translations[lang] && isNonEmptyString(translations[lang][field])
      ? translations[lang][field]
      : '';
    if (override) return override;
    var fallback = isNonEmptyString(raw[field]) ? raw[field] : '';
    if (lang === 'en-US' && containsCJK(fallback)) return '';
    return fallback;
  }

  function normalizeVariant(raw) {
    if (!raw || typeof raw !== 'object' || !isNonEmptyString(raw.id)) return null;
    return {
      id: raw.id,
      title: isNonEmptyString(raw.title) ? raw.title : '',
      sku: isNonEmptyString(raw.sku) ? raw.sku : '',
      price: variantPrice(raw),
      availability: variantAvailability(raw),
      inventoryQuantity: typeof raw.inventory_quantity === 'number' ? raw.inventory_quantity : null,
      thumbnail: imageUrl(raw.thumbnail),
    };
  }

  // `lang` is the requested locale ("en-US" | "zh-CN"); it only changes which
  // customer-facing copy (title/subtitle/description) is returned — never the
  // product id, SKU, price, inventory or handle, which stay single-source.
  function normalizeProduct(raw, lang) {
    if (!raw || typeof raw !== 'object' || !isNonEmptyString(raw.id)) return null;
    var locale = SUPPORTED_LOCALES.indexOf(lang) !== -1 ? lang : 'en-US';
    var images = uniqueImages([].concat(Array.isArray(raw.images) ? raw.images : [], [raw.thumbnail]));
    var variants = [];
    var list = Array.isArray(raw.variants) ? raw.variants : [];
    for (var i = 0; i < list.length; i++) {
      var variant = normalizeVariant(list[i]);
      if (variant) variants.push(variant);
    }
    var prices = [];
    for (var j = 0; j < variants.length; j++) {
      if (variants[j].price !== null) prices.push(variants[j].price);
    }
    var distinct = [];
    for (var k = 0; k < prices.length; k++) {
      if (distinct.indexOf(prices[k]) === -1) distinct.push(prices[k]);
    }
    // Expose only the i18n sub-key of metadata. The rest of `metadata` is
    // internal (and today is null anyway); the storefront has no business with
    // it, and surfacing the whole blob would leak whatever the admin later
    // stores there. We forward `i18n` verbatim (default_locale + translations)
    // so the UI can re-resolve copy on a live language switch without a refetch.
    var rawI18n = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata.i18n : null;
    // Preserve the product's own (default-locale) copy so a live language
    // switch can re-resolve another locale client-side without refetching the
    // catalog. The resolved title/subtitle/description above are for the
    // bootstrap locale only; `defaultCopy` is the untouched single source.
    var defaultCopy = {
      title: isNonEmptyString(raw.title) ? raw.title : '',
      subtitle: isNonEmptyString(raw.subtitle) ? raw.subtitle : '',
      description: isNonEmptyString(raw.description) ? raw.description : '',
    };
    return {
      id: raw.id,
      title: localizedText(raw, locale, 'title'),
      subtitle: localizedText(raw, locale, 'subtitle'),
      description: localizedText(raw, locale, 'description'),
      thumbnail: images.length ? images[0] : '',
      images: images,
      group: (raw.collection && isNonEmptyString(raw.collection.title) && raw.collection.title) ||
             (raw.type && isNonEmptyString(raw.type.value) && raw.type.value) || '',
      variants: variants,
      price: distinct.length ? Math.min.apply(null, distinct) : null,
      priceVaries: distinct.length > 1,
      available: variants.some(function (variant) {
        return variant.availability === 'in_stock' || variant.availability === 'backorder';
      }),
      i18n: rawI18n && typeof rawI18n === 'object' ? rawI18n : null,
      defaultCopy: defaultCopy,
    };
  }

  function normalizeCartItem(raw) {
    if (!raw || typeof raw !== 'object' || !isNonEmptyString(raw.id)) return null;
    var quantity = typeof raw.quantity === 'number' && raw.quantity > 0 ? raw.quantity : 0;
    var unitPrice = toAmount(raw.unit_price);
    return {
      id: raw.id,
      title: isNonEmptyString(raw.product_title) ? raw.product_title
        : (isNonEmptyString(raw.title) ? raw.title : ''),
      variantId: isNonEmptyString(raw.variant_id) ? raw.variant_id : '',
      variantTitle: isNonEmptyString(raw.variant_title) ? raw.variant_title : '',
      sku: isNonEmptyString(raw.variant_sku) ? raw.variant_sku : '',
      thumbnail: imageUrl(raw.thumbnail),
      quantity: quantity,
      unitPrice: unitPrice,
      lineTotal: unitPrice === null ? null : unitPrice * quantity,
    };
  }

  // Medusa's `subtotal` is item + shipping before tax, not the item subtotal
  // alone. We surface the decomposed figures the checkout needs to show an
  // honest breakdown instead of re-deriving any number in the browser.
  function normalizeShippingMethod(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      id: isNonEmptyString(raw.id) ? raw.id : '',
      optionId: isNonEmptyString(raw.shipping_option_id) ? raw.shipping_option_id : '',
      name: isNonEmptyString(raw.name) ? raw.name : '',
      amount: toAmount(raw.amount),
    };
  }

  function normalizeShippingOption(raw) {
    if (!raw || typeof raw !== 'object' || !isNonEmptyString(raw.id)) return null;
    var amount = toAmount(raw.amount);
    if (amount === null && raw.calculated_price && typeof raw.calculated_price === 'object') {
      amount = toAmount(raw.calculated_price.calculated_amount);
    }
    return {
      id: raw.id,
      name: isNonEmptyString(raw.name) ? raw.name : '',
      amount: amount,
    };
  }

  function normalizeAddress(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      id: isNonEmptyString(raw.id) ? raw.id : '',
      firstName: isNonEmptyString(raw.first_name) ? raw.first_name : '',
      lastName: isNonEmptyString(raw.last_name) ? raw.last_name : '',
      address1: isNonEmptyString(raw.address_1) ? raw.address_1 : '',
      address2: isNonEmptyString(raw.address_2) ? raw.address_2 : '',
      city: isNonEmptyString(raw.city) ? raw.city : '',
      province: isNonEmptyString(raw.province) ? raw.province : '',
      postalCode: isNonEmptyString(raw.postal_code) ? raw.postal_code : '',
      countryCode: isNonEmptyString(raw.country_code) ? raw.country_code : '',
      phone: isNonEmptyString(raw.phone) ? raw.phone : '',
    };
  }

  function normalizeCart(raw) {
    if (!raw || typeof raw !== 'object' || !isNonEmptyString(raw.id)) return null;
    var items = [];
    var list = Array.isArray(raw.items) ? raw.items : [];
    for (var i = 0; i < list.length; i++) {
      var item = normalizeCartItem(list[i]);
      if (item) items.push(item);
    }
    var methods = [];
    var methodList = Array.isArray(raw.shipping_methods) ? raw.shipping_methods : [];
    for (var m = 0; m < methodList.length; m++) {
      var method = normalizeShippingMethod(methodList[m]);
      if (method) methods.push(method);
    }
    var count = 0;
    for (var j = 0; j < items.length; j++) count += items[j].quantity;
    return {
      id: raw.id,
      currencyCode: isNonEmptyString(raw.currency_code) ? raw.currency_code : '',
      regionId: isNonEmptyString(raw.region_id) ? raw.region_id : '',
      email: isNonEmptyString(raw.email) ? raw.email : '',
      // A completed cart is the immutable record of an order that was placed;
      // Medusa refuses add/update/checkout on it with 400 "already completed".
      completed: raw.completed_at != null,
      items: items,
      itemCount: count,
      // item subtotal = goods only; subtotal = goods + shipping (pre-tax).
      itemSubtotal: toAmount(raw.item_subtotal !== undefined ? raw.item_subtotal : raw.item_total),
      subtotal: toAmount(raw.subtotal),
      shippingTotal: toAmount(raw.shipping_total),
      taxTotal: toAmount(raw.tax_total),
      total: toAmount(raw.total),
      shippingMethods: methods,
      shippingAddress: normalizeAddress(raw.shipping_address),
      billingAddress: normalizeAddress(raw.billing_address),
    };
  }

  function createClient(options) {
    var settings = options || {};
    var baseUrl = isNonEmptyString(settings.baseUrl) ? settings.baseUrl.replace(/\/+$/, '') : '/store';
    var publishableKey = isNonEmptyString(settings.publishableKey) ? settings.publishableKey : '';
    var fetchImpl = settings.fetchImpl || (typeof fetch === 'function' ? fetch : null);

    async function request(path, init) {
      if (!fetchImpl) throw new Error('The storefront cannot reach the shop from this browser.');
      var headers = { accept: 'application/json' };
      if (publishableKey) headers['x-publishable-api-key'] = publishableKey;
      if (init && init.body) headers['content-type'] = 'application/json';
      if (init && init.headers) {
        for (var h in init.headers) if (Object.prototype.hasOwnProperty.call(init.headers, h)) headers[h] = init.headers[h];
      }
      var response;
      try {
        response = await fetchImpl(baseUrl + path, {
          method: (init && init.method) || 'GET',
          headers: headers,
          body: init && init.body ? JSON.stringify(init.body) : undefined,
        });
      } catch (cause) {
        var offline = new Error('The shop could not be reached.');
        offline.kind = 'network';
        throw offline;
      }
      return unwrapResponse(response);
    }

    // Auth endpoints live under `/auth/...` (NOT the `/store` baseUrl): customer
    // login, JWT refresh and session logout. They carry a Bearer token instead of
    // the publishable key. `requestAuth` is the same reliable client, just rooted
    // at the origin and sending only the caller-supplied headers (never the
    // publishable key, which would be meaningless on an auth route).
    async function requestAuth(path, init) {
      if (!fetchImpl) throw new Error('The storefront cannot reach the shop from this browser.');
      var headers = { accept: 'application/json' };
      if (init && init.body) headers['content-type'] = 'application/json';
      if (init && init.headers) {
        for (var h in init.headers) if (Object.prototype.hasOwnProperty.call(init.headers, h)) headers[h] = init.headers[h];
      }
      var response;
      try {
        response = await fetchImpl(path, {
          method: (init && init.method) || 'GET',
          headers: headers,
          body: init && init.body ? JSON.stringify(init.body) : undefined,
        });
      } catch (cause) {
        var offline = new Error('The shop could not be reached.');
        offline.kind = 'network';
        throw offline;
      }
      return unwrapResponse(response);
    }

    // Turn a raw fetch Response into a parsed JSON payload, or a thrown, typed
    // failure. Shared by the store and auth clients so the same error contract
    // (kind: network | not_found | service_unavailable | rejected | unauthorized,
    // plus Medusa's `type`) reaches every caller.
    async function unwrapResponse(response) {
      var payload = null;
      try { payload = await response.json(); } catch (_) { payload = null; }
      if (!response.ok) {
        var failure = new Error((payload && payload.message) || ('The shop refused the request (' + response.status + ').'));
        // 404 → "not found" (an order/cart that does not exist); 401 → the token
        // is missing/invalid/expired (the caller must re-authenticate); 5xx → the
        // service is broken (a distinct, temporary state the caller shows as
        // "temporarily unavailable", never "not found"); anything else → a
        // generic rejection.
        if (response.status === 404) failure.kind = 'not_found';
        else if (response.status === 401) failure.kind = 'unauthorized';
        else if (response.status >= 500) failure.kind = 'service_unavailable';
        else failure.kind = 'rejected';
        failure.status = response.status;
        // Expose Medusa's error `type` (e.g. "invalid_data", "not_found",
        // "not_allowed") so callers can react to a completed/expired cart
        // instead of collapsing every failure into one generic toast.
        failure.type = payload && payload.type ? payload.type : '';
        // A completed cart is the one "invalid_data" case the storefront can
        // and should self-heal: clear the stale id and start a new cart.
        if (/already completed/i.test(payload && payload.message || '')) {
          failure.kind = 'cart_completed';
        }
        throw failure;
      }
      return payload;
    }

    return {
      baseUrl: baseUrl,

      async regions() {
        var payload = await request('/regions');
        var raw = (payload && Array.isArray(payload.regions)) ? payload.regions : [];
        var out = [];
        for (var i = 0; i < raw.length; i++) {
          var region = raw[i];
          // Each region carries the list of countries it ships to. That list is
          // the authoritative "where can we deliver" set the checkout uses to
          // (a) recommend a default country and (b) refuse a non-shippable one.
          var countries = [];
          if (region && Array.isArray(region.countries)) {
            for (var j = 0; j < region.countries.length; j++) {
              var c = region.countries[j];
              if (c && isNonEmptyString(c.iso_2)) {
                countries.push({ code: c.iso_2.toLowerCase(), name: isNonEmptyString(c.display_name) ? c.display_name : (isNonEmptyString(c.name) ? c.name : c.iso_2) });
              }
            }
          }
          out.push({
            id: isNonEmptyString(region.id) ? region.id : '',
            name: isNonEmptyString(region.name) ? region.name : '',
            currencyCode: isNonEmptyString(region.currency_code) ? region.currency_code.toLowerCase() : '',
            countries: countries,
          });
        }
        return out;
      },

      // Prices are region-scoped, so the caller passes the region it sells in.
      // `lang` selects the customer-facing copy locale; it is optional and
      // defaults to en-US when absent (backward compatible with existing calls).
      async products(regionId, limit, lang) {
        var query = '?limit=' + (limit || 50) + '&fields=' + encodeURIComponent(PRODUCT_FIELDS);
        if (isNonEmptyString(regionId)) query += '&region_id=' + encodeURIComponent(regionId);
        var payload = await request('/products' + query);
        var raw = (payload && Array.isArray(payload.products)) ? payload.products : [];
        var out = [];
        for (var i = 0; i < raw.length; i++) {
          var product = normalizeProduct(raw[i], lang);
          if (product) out.push(product);
        }
        return { products: out, count: payload && typeof payload.count === 'number' ? payload.count : out.length };
      },

      async createCart(regionId) {
        var body = isNonEmptyString(regionId) ? { region_id: regionId } : {};
        var payload = await request('/carts', { method: 'POST', body: body });
        return normalizeCart(payload && payload.cart);
      },

      // Resolves to null when the stored cart no longer exists, or has been
      // completed by an order, so callers can start a fresh one instead of
      // showing a stale basket. A completed cart still answers 200 (with
      // `completed_at` set) — Medusa only 404s an id that never existed — so
      // we must also treat `completed` as "start over".
      async getCart(cartId) {
        var payload;
        try {
          payload = await request('/carts/' + encodeURIComponent(cartId));
        } catch (error) {
          if (error && error.kind === 'not_found') return null;
          throw error;
        }
        var cart = normalizeCart(payload && payload.cart);
        if (cart && cart.completed) return null;
        return cart;
      },

      async addLineItem(cartId, variantId, quantity) {
        var payload = await request('/carts/' + encodeURIComponent(cartId) + '/line-items', {
          method: 'POST',
          body: { variant_id: variantId, quantity: quantity || 1 },
        });
        return normalizeCart(payload && payload.cart);
      },

      async updateLineItem(cartId, lineId, quantity) {
        var payload = await request(
          '/carts/' + encodeURIComponent(cartId) + '/line-items/' + encodeURIComponent(lineId),
          { method: 'POST', body: { quantity: quantity } },
        );
        return normalizeCart(payload && payload.cart);
      },

      async removeLineItem(cartId, lineId) {
        var payload = await request(
          '/carts/' + encodeURIComponent(cartId) + '/line-items/' + encodeURIComponent(lineId),
          { method: 'DELETE' },
        );
        return normalizeCart(payload && payload.cart);
      },

      // Checkout data all writes back through the cart, so every number the
      // visitor sees has a Medusa-side source of truth.

      async setEmail(cartId, email) {
        var payload = await request('/carts/' + encodeURIComponent(cartId), {
          method: 'POST',
          body: { email: email },
        });
        return normalizeCart(payload && payload.cart);
      },

      // `address` is a camelCase object ({ firstName, lastName, address1, ... });
      // Medusa expects snake_case keys, so we translate here.
      async setShippingAddress(cartId, address) {
        var payload = await request('/carts/' + encodeURIComponent(cartId), {
          method: 'POST',
          body: { shipping_address: toSnakeAddress(address) },
        });
        return normalizeCart(payload && payload.cart);
      },

      async setBillingAddress(cartId, address) {
        var payload = await request('/carts/' + encodeURIComponent(cartId), {
          method: 'POST',
          body: { billing_address: toSnakeAddress(address) },
        });
        return normalizeCart(payload && payload.cart);
      },

      // Shipping options are region- and address-scoped: Medusa returns only
      // what the cart actually qualifies for, priced for its currency.
      async listShippingOptions(cartId) {
        var payload = await request(
          '/shipping-options?cart_id=' + encodeURIComponent(cartId),
        );
        var raw = (payload && Array.isArray(payload.shipping_options)) ? payload.shipping_options : [];
        var out = [];
        for (var i = 0; i < raw.length; i++) {
          var option = normalizeShippingOption(raw[i]);
          if (option) out.push(option);
        }
        return out;
      },

      async selectShippingMethod(cartId, optionId) {
        var payload = await request(
          '/carts/' + encodeURIComponent(cartId) + '/shipping-methods',
          { method: 'POST', body: { option_id: optionId } },
        );
        return normalizeCart(payload && payload.cart);
      },

      // Payment: create a payment collection for the cart, then a payment
      // session for a chosen provider. The session carries the provider's
      // redirect/approval URL back to the storefront so the buyer can approve
      // the payment off-site (e.g. PayPal). No money moves here — that only
      // happens on the provider's page and via its webhook.

      async createPaymentCollection(cartId) {
        var payload = await request('/payment-collections', {
          method: 'POST',
          body: { cart_id: cartId },
        });
        var collection = payload && payload.payment_collection;
        return collection && isNonEmptyString(collection.id) ? collection.id : null;
      },

      async createPaymentSession(paymentCollectionId, providerId) {
        var payload = await request(
          '/payment-collections/' + encodeURIComponent(paymentCollectionId) + '/payment-sessions',
          { method: 'POST', body: { provider_id: providerId } },
        );
        var collection = payload && payload.payment_collection;
        var sessions = collection && Array.isArray(collection.payment_sessions)
          ? collection.payment_sessions : [];
        // The session the provider just initialized carries its redirect target
        // in `data.approval_url` (set by the provider's initiatePayment).
        for (var i = 0; i < sessions.length; i++) {
          var session = sessions[i];
          if (session && session.data && isNonEmptyString(session.data.approval_url)) {
            return {
              id: session.id,
              providerId: session.provider_id || providerId,
              approvalUrl: session.data.approval_url,
            };
          }
        }
        return null;
      },

      // Guest order lookup: order number + email → verified summary. A 404
      // means "no such order" and is indistinguishable from a wrong email, so
      // the caller shows a single honest "not found" state. A 5xx / network
      // failure is a *different* thing — the lookup is temporarily broken, not
      // empty — so those are re-thrown (with their kind) for the caller to show
      // "service unavailable" instead. When only a cart id is known (right
      // after PayPal approval, before the order number is shown), pass cartId
      // instead of orderNumber to resolve through the order→cart link.
      async lookupOrder(orderNumber, email, cartId) {
        try {
          var query = isNonEmptyString(orderNumber)
            ? 'order_number=' + encodeURIComponent(orderNumber)
            : 'cart_id=' + encodeURIComponent(cartId || '');
          query += '&email=' + encodeURIComponent(email);
          var payload = await request('/pawshop-orders/lookup?' + query);
          return payload && payload.order ? payload.order : null;
        } catch (error) {
          if (error && error.kind === 'not_found') return null;
          throw error;
        }
      },

      // ---- customer account (signed-in) ----
      //
      // These require the customer JWT returned by login(). The token is the
      // ONLY credential; it is sent as a Bearer header and never persisted by
      // this data layer (the caller owns storage). A 401 means the token is
      // missing/invalid/expired and is surfaced as `kind: 'unauthorized'` so
      // the caller can drop the token and return to the signed-out state.

      // emailpass login for the customer actor. Resolves to the Medusa auth
      // payload: `{ token }` on success, or `{ token, verification_required }`
      // when the email still needs OTP verification before it can act.
      async login(email, password) {
        var payload = await requestAuth('/auth/customer/emailpass', {
          method: 'POST',
          body: { email: email, password: password },
        });
        return payload || null;
      },

      // ---- passwordless OTP (Account Phase 2) ----
      //
      // A new user registers with email only (no password); an existing user can
      // also sign in with a one-time code. The uniform flow is:
      //   1. otpRegister(email)  → actorless token (idempotent for new + existing)
      //   2. requestOtp(token, email) → 6-digit code emailed
      //   3. otpLogin(email, code) → verifies + consumes the code → JWT
      //   4. (new users only) registerCustomer(token, email) → create/claim customer
      //      then refreshToken to obtain an actor-bound token.
      //
      // These live under `/auth/...` (requestAuth), never the `/store` baseUrl.

      // Establish (or reuse) the otp-email auth identity. Idempotent: works for a
      // brand-new email and for an email that already has an emailpass/google or
      // otp-email identity (the latter binds to the SAME customer). Returns the
      // actorless registration token needed for the next two steps.
      async otpRegister(email) {
        var payload = await requestAuth('/auth/customer/otp-email/register', {
          method: 'POST',
          body: { email: email },
        });
        return payload && payload.token ? payload.token : null;
      },

      // Request a 6-digit OTP for the email bound to the (actorless) registration
      // token. The code is emailed; it never appears in this response.
      async requestOtp(token, email) {
        await requestAuth('/auth/verification/request', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + token },
          body: { entity_id: email, entity_type: 'customer', code_provider: 'otp' },
        });
      },

      // Verify + consume the OTP and obtain a JWT. For an email whose identity is
      // already bound to a customer this is a full login (actor-bound token); for
      // a brand-new email the token is still actorless and the caller must run
      // registerCustomer + refreshToken next. Resolves to the auth payload
      // (`{ token }`), or `{ token }` with an actorless token for a new user.
      async otpLogin(email, code) {
        var payload = await requestAuth('/auth/customer/otp-email', {
          method: 'POST',
          body: { email: email, code: code },
        });
        return payload || null;
      },

      // Create (or claim) the customer for the verified actorless token, binding
      // the auth identity to the customer. After this, refreshToken upgrades the
      // actorless token to an actor-bound login token.
      async registerCustomer(token, email) {
        var payload = await request('/customers', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + token },
          body: { email: email },
        });
        return payload && payload.customer ? payload.customer : null;
      },

      // Exchange a still-valid JWT for a fresh one before it expires. Keeps a
      // signed-in session alive without re-entering the password.
      async refreshToken(token) {
        var payload = await requestAuth('/auth/token/refresh', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + token },
        });
        return payload && payload.token ? payload.token : null;
      },

      // Discard the current session. Stateless JWT: logout simply means the
      // caller drops the token; this call tells the server to invalidate any
      // server-side session (cookie) too.
      async logout(token) {
        await requestAuth('/auth/session', {
          method: 'DELETE',
          headers: token ? { authorization: 'Bearer ' + token } : {},
        });
      },

      // The signed-in customer's own profile (id, email, first/last name,
      // has_account). Resolves to null when not authenticated.
      async getCurrentCustomer(token) {
        try {
          var payload = await request('/customers/me', {
            headers: { authorization: 'Bearer ' + token },
          });
          var customer = payload && payload.customer;
          if (!customer || typeof customer !== 'object' || !isNonEmptyString(customer.id)) return null;
          return {
            id: customer.id,
            email: isNonEmptyString(customer.email) ? customer.email : '',
            firstName: isNonEmptyString(customer.first_name) ? customer.first_name : '',
            lastName: isNonEmptyString(customer.last_name) ? customer.last_name : '',
            hasAccount: customer.has_account === true,
          };
        } catch (error) {
          if (error && (error.kind === 'unauthorized' || error.kind === 'not_found')) return null;
          throw error;
        }
      },

      async getAccountSecurity(token) {
        return request('/customers/me/security', {
          headers: { authorization: 'Bearer ' + token },
        });
      },

      async saveAccountPassword(token, data) {
        return request('/customers/me/security', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + token },
          body: data,
        });
      },

      // The signed-in customer's own orders, newest first. The server filters by
      // `customer_id = actor_id`, so this can never return another customer's
      // order. Resolves to `{ orders, count }`.
      async listMyOrders(token) {
        var query = '?fields=' + encodeURIComponent(
          'id,display_id,email,currency_code,total,status,created_at,summary'
        );
        var payload = await request('/orders' + query, {
          headers: { authorization: 'Bearer ' + token },
        });
        var raw = (payload && Array.isArray(payload.orders)) ? payload.orders : [];
        var out = [];
        for (var i = 0; i < raw.length; i++) {
          var order = normalizeOrderSummary(raw[i]);
          if (order) out.push(order);
        }
        out.sort(function (a, b) {
          return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
        });
        return { orders: out, count: payload && typeof payload.count === 'number' ? payload.count : out.length };
      },

      // The signed-in customer's own order detail. The server enforces ownership
      // (customer_id === actor_id): another customer's order id, or a nonexistent
      // id, resolves to null (indistinguishable 404). Resolves to the same shape
      // as the guest lookupOrder, so one renderer serves both paths.
      async getMyOrder(token, orderId) {
        try {
          var payload = await request('/pawshop-orders/' + encodeURIComponent(orderId), {
            headers: { authorization: 'Bearer ' + token },
          });
          return payload && payload.order ? payload.order : null;
        } catch (error) {
          if (error && error.kind === 'not_found') return null;
          throw error;
        }
      },
    };
  }

  // Normalize a raw order row from GET /store/orders into the summary the
  // account list renders. Only the fields the list explicitly requested are
  // read; everything else is ignored.
  function normalizeOrderSummary(raw) {
    if (!raw || typeof raw !== 'object' || !isNonEmptyString(raw.id)) return null;
    return {
      id: raw.id,
      orderNumber: typeof raw.display_id === 'number' ? raw.display_id : (Number.isFinite(Number(raw.display_id)) ? Number(raw.display_id) : null),
      email: isNonEmptyString(raw.email) ? raw.email : '',
      currencyCode: isNonEmptyString(raw.currency_code) ? raw.currency_code.toLowerCase() : '',
      total: toAmount(raw.total),
      status: isNonEmptyString(raw.status) ? raw.status : '',
      createdAt: isNonEmptyString(raw.created_at) ? raw.created_at : '',
    };
  }

  function toSnakeAddress(address) {
    if (!address || typeof address !== 'object') return {};
    var out = {};
    if (isNonEmptyString(address.firstName)) out.first_name = address.firstName;
    if (isNonEmptyString(address.lastName)) out.last_name = address.lastName;
    if (isNonEmptyString(address.address1)) out.address_1 = address.address1;
    if (isNonEmptyString(address.address2)) out.address_2 = address.address2;
    if (isNonEmptyString(address.city)) out.city = address.city;
    if (isNonEmptyString(address.province)) out.province = address.province;
    if (isNonEmptyString(address.postalCode)) out.postal_code = address.postalCode;
    if (isNonEmptyString(address.countryCode)) out.country_code = address.countryCode;
    if (isNonEmptyString(address.phone)) out.phone = address.phone;
    return out;
  }

  window.PawStore = Object.freeze({
    CART_ID_KEY: CART_ID_KEY,
    PRODUCT_FIELDS: PRODUCT_FIELDS,
    SUPPORTED_LOCALES: SUPPORTED_LOCALES,
    createClient: createClient,
    normalizeProduct: normalizeProduct,
    localizedText: localizedText,
    containsCJK: containsCJK,
    normalizeVariant: normalizeVariant,
    normalizeCart: normalizeCart,
    normalizeCartItem: normalizeCartItem,
    normalizeShippingMethod: normalizeShippingMethod,
    normalizeShippingOption: normalizeShippingOption,
    normalizeAddress: normalizeAddress,
    normalizeOrderSummary: normalizeOrderSummary,
    variantAvailability: variantAvailability,
    variantPrice: variantPrice,
    formatMoney: formatMoney,
  });
})();
