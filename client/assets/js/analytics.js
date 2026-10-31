/**
 * Analytics and Conversion Tracking Module
 * Unified tracking for Meta Pixel (fbq), Google Analytics 4 (gtag), and Google Tag Manager (dataLayer)
 */
(function(window) {
  'use strict';

  const Analytics = {
    init: function() {
      const cfg = window.PRODUCT_CONFIG?.analytics || {};

      // Initialize Meta Pixel if ID is configured
      if (cfg.metaPixelId && !window.fbq) {
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
      this.trackPageView();
    },

    // 1. PageView
    trackPageView: function(pagePath) {
      const path = pagePath || window.location.pathname;

      // Meta Pixel
      if (typeof window.fbq === 'function') {
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

      // Meta Pixel
      if (typeof window.fbq === 'function') {
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

      const payload = {
        content_name: p.title,
        content_category: 'Children Activity Books',
        content_ids: [p.id],
        content_type: 'product',
        value: p.pricing.price,
        currency: p.pricing.currency,
        num_items: 1
      };

      // Meta Pixel
      if (typeof window.fbq === 'function') {
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

      console.debug('[Analytics] InitiateCheckout tracked:', payload);
    },

    // 4. Purchase (Only on verified payment confirmation, deduplicated by orderId)
    trackPurchase: function(orderId, amount, currency) {
      if (!orderId) {
        console.warn('[Analytics] trackPurchase called without orderId. Ignored.');
        return;
      }

      // Idempotency: Prevent duplicate purchase events
      const storageKey = `purchase_tracked_${orderId}`;
      if (sessionStorage.getItem(storageKey) || localStorage.getItem(storageKey)) {
        console.info(`[Analytics] Purchase event already tracked for order ${orderId}. Skipping duplicate.`);
        return;
      }

      const p = window.PRODUCT_CONFIG;
      const finalAmount = amount || p?.pricing.price || 149;
      const finalCurrency = currency || p?.pricing.currency || 'INR';

      const payload = {
        content_name: p ? p.title : 'Kids Drawing Book – Animals',
        content_type: 'product',
        content_ids: [p ? p.id : 'kids-drawing-book-animals'],
        value: finalAmount,
        currency: finalCurrency,
        order_id: orderId,
        num_items: 1
      };

      // Meta Pixel
      if (typeof window.fbq === 'function') {
        window.fbq('track', 'Purchase', payload);
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

      // Mark as tracked
      try {
        sessionStorage.setItem(storageKey, 'true');
        localStorage.setItem(storageKey, 'true');
      } catch (e) {}

      console.log('[Analytics] Verified Purchase tracked successfully:', payload);
    }
  };

  window.Analytics = Analytics;
  document.addEventListener('DOMContentLoaded', function() {
    Analytics.init();
  });
})(window);
