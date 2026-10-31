/**
 * Razorpay Checkout Controller
 * Manages order creation, Razorpay Standard Checkout modal, payment verification, and redirect.
 */
(function(window) {
  'use strict';

  const Checkout = {
    modal: null,
    form: null,
    errorEl: null,
    submitBtn: null,
    currentOrderId: null,

    init: function() {
      this.modal = document.getElementById('checkout-modal');
      this.form = document.getElementById('checkout-form');
      this.errorEl = document.getElementById('checkout-error');
      this.submitBtn = document.getElementById('checkout-submit-btn');

      const closeBtn = document.getElementById('checkout-close');
      if (closeBtn) {
        closeBtn.addEventListener('click', () => this.closeModal());
      }

      if (this.modal) {
        this.modal.addEventListener('click', (e) => {
          if (e.target === this.modal) this.closeModal();
        });
      }

      if (this.form) {
        this.form.addEventListener('submit', (e) => this.handleSubmit(e));
      }
    },

    openModal: function() {
      if (!this.modal) return;
      this.modal.classList.add('active');
      document.body.style.overflow = 'hidden';

      if (this.errorEl) {
        this.errorEl.style.display = 'none';
        this.errorEl.textContent = '';
      }

      // Fire InitiateCheckout tracking
      if (window.Analytics) {
        window.Analytics.trackInitiateCheckout();
      }

      const nameInput = document.getElementById('cust-name');
      if (nameInput) setTimeout(() => nameInput.focus(), 150);
    },

    closeModal: function() {
      if (!this.modal) return;
      this.modal.classList.remove('active');
      document.body.style.overflow = '';
    },

    showError: function(msg) {
      if (!this.errorEl) return;
      this.errorEl.textContent = msg;
      this.errorEl.style.display = 'block';
    },

    setLoading: function(isLoading) {
      if (!this.submitBtn) return;
      this.submitBtn.disabled = isLoading;
      const priceText = window.PRODUCT_CONFIG?.pricing.displayPrice || '₹149';
      this.submitBtn.textContent = isLoading ? 'Creating Secure Order...' : `Proceed to Pay • ${priceText}`;
    },

    handleSubmit: async function(e) {
      e.preventDefault();
      const name = document.getElementById('cust-name')?.value.trim();
      const email = document.getElementById('cust-email')?.value.trim();
      const phone = document.getElementById('cust-phone')?.value.trim();

      if (!email || !email.includes('@')) {
        this.showError('Please enter a valid email address.');
        return;
      }

      this.setLoading(true);
      if (this.errorEl) this.errorEl.style.display = 'none';

      try {
        // Step 1: Request Order Creation from Backend
        const res = await fetch('/api/create-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email, phone })
        });

        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Failed to initialize order. Please try again.');
        }

        this.currentOrderId = data.order_id;

        // Step 2: Open Razorpay Checkout Modal
        this.launchRazorpay(data, { name, email, phone });

      } catch (err) {
        console.error('[Checkout Error]:', err);
        this.showError(err.message || 'Something went wrong. Please check your connection.');
        this.setLoading(false);
      }
    },

    launchRazorpay: function(orderData, customer) {
      const cfg = window.PRODUCT_CONFIG;
      const keyId = orderData.key_id || cfg.razorpay.keyId;

      // Handle Development Mock Mode (if using test placeholder keys)
      if (keyId.includes('placeholder') || typeof window.Razorpay === 'undefined') {
        console.info('[Checkout]: Razorpay running in test/mock mode.');
        this.simulateSuccessfulPayment(orderData, customer);
        return;
      }

      const options = {
        key: keyId,
        amount: orderData.amount,
        currency: orderData.currency || 'INR',
        name: cfg.title,
        description: '22-Page Activity Book PDF Download',
        image: '/assets/images/book-cover.png',
        order_id: orderData.razorpay_order_id,
        prefill: {
          name: customer.name,
          email: customer.email,
          contact: customer.phone
        },
        theme: {
          color: cfg.razorpay.themeColor || '#FF914D'
        },
        handler: async (response) => {
          await this.verifyPayment(response, customer);
        },
        modal: {
          ondismiss: () => {
            this.setLoading(false);
            console.log('[Checkout]: Payment window dismissed by customer.');
          }
        }
      };

      try {
        const rzp = new window.Razorpay(options);
        rzp.on('payment.failed', (resp) => {
          console.error('[Payment Failed]:', resp.error);
          this.showError(`Payment Failed: ${resp.error.description || 'Transaction was declined.'} You can retry payment.`);
          this.setLoading(false);
        });
        rzp.open();
      } catch (e) {
        console.error('[Razorpay Launch Exception]:', e);
        this.showError('Unable to open payment modal. Please try again or use direct checkout.');
        this.setLoading(false);
      }
    },

    verifyPayment: async function(rzpResponse, customer) {
      if (this.submitBtn) this.submitBtn.textContent = 'Verifying Payment...';

      try {
        const res = await fetch('/api/verify-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            order_id: this.currentOrderId,
            razorpay_order_id: rzpResponse.razorpay_order_id,
            razorpay_payment_id: rzpResponse.razorpay_payment_id,
            razorpay_signature: rzpResponse.razorpay_signature,
            email: customer.email
          })
        });

        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Payment verification failed. Please contact support.');
        }

        // Fire Purchase Conversion Event
        if (window.Analytics) {
          window.Analytics.trackPurchase(
            this.currentOrderId,
            window.PRODUCT_CONFIG?.pricing.price,
            window.PRODUCT_CONFIG?.pricing.currency
          );
        }

        // Redirect to Thank You + Download Page
        window.location.href = data.redirect_url;

      } catch (err) {
        console.error('[Verify Error]:', err);
        this.showError(err.message || 'Payment verification error. If money was debited, contact support.');
        this.setLoading(false);
      }
    },

    // Development / Demo Simulation Fallback
    simulateSuccessfulPayment: async function(orderData, customer) {
      if (this.submitBtn) this.submitBtn.textContent = 'Processing Demo Payment...';
      setTimeout(async () => {
        try {
          const res = await fetch('/api/verify-payment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              order_id: this.currentOrderId,
              razorpay_order_id: orderData.razorpay_order_id,
              razorpay_payment_id: `pay_test_${Date.now().toString(36)}`,
              razorpay_signature: 'dev_mock_signature',
              email: customer.email
            })
          });

          const data = await res.json();
          if (data.redirect_url) {
            window.location.href = data.redirect_url;
          }
        } catch (e) {
          this.showError('Demo payment simulation completed. Check console.');
          this.setLoading(false);
        }
      }, 900);
    }
  };

  window.Checkout = Checkout;
  document.addEventListener('DOMContentLoaded', () => Checkout.init());
})(window);
