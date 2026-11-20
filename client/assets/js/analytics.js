/**
 * Analytics and Conversion Tracking Module
 * Unified tracking for Meta Pixel (fbq), Google Analytics 4 (gtag), and Google Tag Manager (dataLayer)
 */
(function(window) {
  'use strict';

  const Analytics = {
    init: function() {
      const cfg = window.PRODUCT_CONFIG?.analytics || {};
      const fbqAlreadyLoaded = typeof window.fbq === 'function';

      // Initialize Meta Pixel if ID is configured and not already loaded in <head>
      if (cfg.metaPixelId && !fbqAlreadyLoaded) {
        /* eslint-disable */
        !function(f,b,e,v,n,t,s)
        {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
        n.callMethod.apply(n,arguments):n.queue.push(arguments)};
        if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
        n.queue=[];t=b.createElement(e);t.async=!0;
        t.src=v;s=b.getElementsByTagName(e)[0];
        s.parentNode.insertBefore(t,s)}(window, document,'script',
        'https://connect.facebook.net/en_US/fbevents.js');
        /* eslint-enable */
        window.fbq('init', cfg.metaPixelId);
      }

      // Initialize Google Analytics 4 if ID is configured
      if (cfg.ga4MeasurementId && !window.gtag) {
        const script = document.createElement('script');
        script.async = true;
        script.src = `https://www.googletagmanager.com/gtag/js?id=${cfg.ga4MeasurementId}`;
        document.head.appendChild(script);

        window.dataLayer = window.dataLayer || [];
        window.gtag = function() { window.dataLayer.push(arguments); };
        window.gtag('js', new Date());
        window.gtag('config', cfg.ga4MeasurementId, { send_page_view: false });
      }

      // Track PageView automatically
      // If fbq was already loaded in <head>, the head snippet already invoked fbq('track', 'PageView').
      // We pass skipMeta = true to prevent duplicate PageView on initial page load.
      this.trackPageView(null, fbqAlreadyLoaded);
    },

    // 1. PageView
    trackPageView: function(pagePath, skipMeta) {
      const path = pagePath || window.location.pathname;

      // Meta Pixel
      if (typeof window.fbq === 'function' && !skipMeta) {
        window.fbq('track', 'PageView');
      }

      // GA4
      if (typeof window.gtag === 'function') {
        window.gtag('event', 'page_view', { page_path: path });
      }

      // GTM dataLayer
      if (Array.isArray(window.dataLayer)) {
        window.dataLayer.push({ event: 'page_view', page_path: path });
      }

      console.debug('[Analytics] PageView tracked:', path);
    },

    // 2. ViewContent (Landing page engagement)
    trackViewContent: function() {
      const p = window.PRODUCT_CONFIG;
      if (!p) return;

      const payload = {
        content_name: p.title,
        content_category: 'Children Activity Books',
        content_ids: [p.id],
        content_type: 'product',
        value: p.pricing.price,
        currency: p.pricing.currency
      };

      // Meta Pixel (gated: conversion events not active until explicitly enabled)
      if (typeof window.fbq === 'function' && window.PRODUCT_CONFIG?.analytics?.enableMetaConversions === true) {
        window.fbq('track', 'ViewContent', payload);
      }

      // GA4
      if (typeof window.gtag === 'function') {
        window.gtag('event', 'view_item', {
          currency: p.pricing.currency,
          value: p.pricing.price,
          items: [{ item_id: p.id, item_name: p.title, price: p.pricing.price }]
        });
      }

      // GTM dataLayer
      if (Array.isArray(window.dataLayer)) {
        window.dataLayer.push({ event: 'view_content', ...payload });
      }

      console.debug('[Analytics] ViewContent tracked:', payload);
    },

    // 3. InitiateCheckout (Customer clicked Buy Now or opened checkout)
    trackInitiateCheckout: function() {
      const p = window.PRODUCT_CONFIG;
      if (!p) return;

      // In-session guard: Do not fire multiple events for repeated CTA clicks or modal re-opens in the same session
      const sessionKey = 'meta_initiate_checkout_tracked';
      try {
        if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(sessionKey)) {
          console.debug('[Analytics] InitiateCheckout already tracked in this session. Skipping duplicate.');
          return;
        }
      } catch (e) {}

      const payload = {
        content_name: p.title,
        content_category: 'Children Activity Books',
        content_ids: [p.id],
        content_type: 'product',
        value: p.pricing.price,
        currency: p.pricing.currency,
        num_items: 1
      };

      // Meta Pixel (gated: conversion events not active until explicitly enabled)
      if (typeof window.fbq === 'function' && window.PRODUCT_CONFIG?.analytics?.enableMetaConversions === true) {
        window.fbq('track', 'InitiateCheckout', payload);
      }

      // GA4
      if (typeof window.gtag === 'function') {
        window.gtag('event', 'begin_checkout', {
          currency: p.pricing.currency,
          value: p.pricing.price,
          items: [{ item_id: p.id, item_name: p.title, price: p.pricing.price }]
        });
      }

      // GTM dataLayer
      if (Array.isArray(window.dataLayer)) {
        window.dataLayer.push({ event: 'initiate_checkout', ...payload });
      }

      try {
        if (typeof sessionStorage !== 'undefined') {
          sessionStorage.setItem(sessionKey, 'true');
        }
      } catch (e) {}

      console.debug('[Analytics] InitiateCheckout tracked:', payload);
    },

    // 4. Purchase (Dispatched on verified payment confirmation, deduplicated by orderId)
    // IMPORTANT DELIVERY LIMITATION:
    // Calling window.fbq('track', 'Purchase', ...) queues the event in the client-side JavaScript runtime.
    // A successful fbq queue operation does NOT guarantee that Meta's network endpoint received the beacon
    // (e.g. client ad blockers such as AdBlock360, Brave Shields, network timeouts, or browser tracking
    // prevention can drop the outgoing HTTP request).
    // The localStorage idempotency flag suppresses duplicate client-side dispatches on page refresh,
    // but does NOT guarantee cross-device deduplication or delivery receipt.
    // For guaranteed conversion delivery, the future Conversions API (CAPI) architecture will independently
    // dispatch server-side events using the identical stable order event ID (order_id).
    trackPurchase: function(orderId, amount, currency) {
      if (!orderId) {
        console.warn('[Analytics] trackPurchase called without orderId. Ignored.');
        return;
      }

      // Local browser idempotency guard (per-browser / per-device storage):
      // Prevents duplicate client-side event queueing on page refreshes or repeated tab visits in this browser.
      // (Does not guarantee delivery receipt or prevent cross-browser/cross-device duplicate visits).
      const storageKey = `purchase_tracked_${orderId}`;
      try {
        if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(storageKey)) {
          console.info(`[Analytics] Purchase event already queued for order ${orderId} in this session. Skipping duplicate.`);
          return;
        }
        if (typeof localStorage !== 'undefined' && localStorage.getItem(storageKey)) {
          console.info(`[Analytics] Purchase event already queued for order ${orderId} in this browser. Skipping duplicate.`);
          return;
        }
      } catch (e) {}

      const p = window.PRODUCT_CONFIG;
      const finalAmount = (typeof amount === 'number' && amount > 0) ? amount : (p?.pricing.price || 1);
      const finalCurrency = currency || p?.pricing.currency || 'INR';

      // Strictly zero PII: Only product and order metadata.
      // Customer name, email, phone, IP, Razorpay signatures, and download tokens are strictly excluded.
      const payload = {
        content_name: p ? p.title : 'Kids Drawing Book – Animals',
        content_type: 'product',
        content_ids: [p ? p.id : 'kids-drawing-book-animals'],
        value: finalAmount,
        currency: finalCurrency,
        order_id: orderId,
        num_items: 1
      };

      // Meta Pixel: Queue event with eventID for deduplication with future server-side CAPI.
      // Note: This queues the event in memory; network transmission depends on browser connectivity and ad blockers.
      if (typeof window.fbq === 'function' && window.PRODUCT_CONFIG?.analytics?.enableMetaConversions === true) {
        window.fbq('track', 'Purchase', payload, { eventID: orderId });
      }

      // GA4
      if (typeof window.gtag === 'function') {
        window.gtag('event', 'purchase', {
          transaction_id: orderId,
          value: finalAmount,
          currency: finalCurrency,
          items: [{
            item_id: p ? p.id : 'kids-drawing-book-animals',
            item_name: p ? p.title : 'Kids Drawing Book – Animals',
            price: finalAmount,
            quantity: 1
          }]
        });
      }

      // GTM dataLayer
      if (Array.isArray(window.dataLayer)) {
        window.dataLayer.push({ event: 'purchase', ...payload });
      }

      // Record browser-level dispatch in local storage to prevent duplicate queueing on reloads
      try {
        if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(storageKey, 'true');
        if (typeof localStorage !== 'undefined') localStorage.setItem(storageKey, 'true');
      } catch (e) {}

      console.log('[Analytics] Verified Purchase event dispatched to analytics queue:', payload);
    }
  };

  window.Analytics = Analytics;
  document.addEventListener('DOMContentLoaded', function() {
    Analytics.init();
  });
})(window);
