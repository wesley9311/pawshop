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

  // Default product fields already include *images and *variants. Prices and
  // inventory are extra fields and must be requested explicitly, and prices
  // additionally need a price context (region_id, country_code or cart_id).
  var PRODUCT_FIELDS = [
    '*variants.calculated_price',
    '*variants.inventory_quantity',
    '*variants.manage_inventory',
    '*variants.allow_backorder',
  ].join(',');

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

  function normalizeProduct(raw) {
    if (!raw || typeof raw !== 'object' || !isNonEmptyString(raw.id)) return null;
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
    return {
      id: raw.id,
      title: isNonEmptyString(raw.title) ? raw.title : '',
      subtitle: isNonEmptyString(raw.subtitle) ? raw.subtitle : '',
      description: isNonEmptyString(raw.description) ? raw.description : '',
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
      var payload = null;
      try { payload = await response.json(); } catch (_) { payload = null; }
      if (!response.ok) {
        var failure = new Error((payload && payload.message) || ('The shop refused the request (' + response.status + ').'));
        failure.kind = response.status === 404 ? 'not_found' : 'rejected';
        failure.status = response.status;
        throw failure;
      }
      return payload;
    }

    return {
      baseUrl: baseUrl,

      async regions() {
        var payload = await request('/regions');
        return (payload && Array.isArray(payload.regions)) ? payload.regions : [];
      },

      // Prices are region-scoped, so the caller passes the region it sells in.
      async products(regionId, limit) {
        var query = '?limit=' + (limit || 50) + '&fields=' + encodeURIComponent(PRODUCT_FIELDS);
        if (isNonEmptyString(regionId)) query += '&region_id=' + encodeURIComponent(regionId);
        var payload = await request('/products' + query);
        var raw = (payload && Array.isArray(payload.products)) ? payload.products : [];
        var out = [];
        for (var i = 0; i < raw.length; i++) {
          var product = normalizeProduct(raw[i]);
          if (product) out.push(product);
        }
        return { products: out, count: payload && typeof payload.count === 'number' ? payload.count : out.length };
      },

      async createCart(regionId) {
        var body = isNonEmptyString(regionId) ? { region_id: regionId } : {};
        var payload = await request('/carts', { method: 'POST', body: body });
        return normalizeCart(payload && payload.cart);
      },

      // Resolves to null when the stored cart no longer exists, so callers can
      // start a fresh one instead of showing a stale basket.
      async getCart(cartId) {
        var payload;
        try {
          payload = await request('/carts/' + encodeURIComponent(cartId));
        } catch (error) {
          if (error && error.kind === 'not_found') return null;
          throw error;
        }
        return normalizeCart(payload && payload.cart);
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
    createClient: createClient,
    normalizeProduct: normalizeProduct,
    normalizeVariant: normalizeVariant,
    normalizeCart: normalizeCart,
    normalizeCartItem: normalizeCartItem,
    normalizeShippingMethod: normalizeShippingMethod,
    normalizeShippingOption: normalizeShippingOption,
    normalizeAddress: normalizeAddress,
    variantAvailability: variantAvailability,
    variantPrice: variantPrice,
    formatMoney: formatMoney,
  });
})();
