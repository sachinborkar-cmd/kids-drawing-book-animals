import { verifyRazorpaySignature } from './_aws_s3.js';
import { processOrderEmail } from './_email.js';

/**
 * POST /api/verify-payment
 * Verifies Razorpay HMAC signature, marks order paid in D1, and generates download token
 */
export async function onRequestPost(context) {
  const { request, env, waitUntil } = context;
  try {
    const body = await request.json().catch(() => ({}));
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, order_id } = body;

    if (!razorpay_order_id || !razorpay_payment_id) {
      return new Response(JSON.stringify({ success: false, error: 'Missing payment verification parameters.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const rawKeyId = typeof env.RAZORPAY_KEY_ID === 'string' ? env.RAZORPAY_KEY_ID.trim() : '';
    const rawKeySecret = typeof env.RAZORPAY_KEY_SECRET === 'string' ? env.RAZORPAY_KEY_SECRET.trim() : '';
    const isPlaceholder = !rawKeyId || rawKeyId.includes('placeholder');

    const envName = (typeof env.ENVIRONMENT === 'string' ? env.ENVIRONMENT : '').trim().toLowerCase();
    const nodeEnv = (typeof env.NODE_ENV === 'string' ? env.NODE_ENV : '').trim().toLowerCase();
    const pagesBranch = (typeof env.CF_PAGES_BRANCH === 'string' ? env.CF_PAGES_BRANCH : '').trim().toLowerCase();
    const testTargetEnv = (typeof env.TEST_TARGET_ENV === 'string' ? env.TEST_TARGET_ENV : '').trim().toLowerCase();

    const isProd = pagesBranch === 'main' || pagesBranch === 'master' || envName === 'production' || nodeEnv === 'production' || testTargetEnv === 'production';
    const isPreview = pagesBranch === 'staging' || envName === 'staging' || envName === 'preview' || nodeEnv === 'staging' || testTargetEnv === 'staging';

    let isSignatureValid = false;

    if (rawKeySecret) {
      isSignatureValid = await verifyRazorpaySignature(
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        rawKeySecret
      );
    } else {
      // In production or preview environments, missing secret must strictly fail closed
      if (isProd || isPreview) {
        return new Response(JSON.stringify({ success: false, error: 'Payment gateway secret not configured in production.' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      // In local development test mode, allow mock only if explicitly enabled
      const allowLocalMock = env.ALLOW_LOCAL_MOCK === true || env.ALLOW_LOCAL_MOCK === 'true' || nodeEnv === 'development';
      if (allowLocalMock) {
        console.warn('[Payment Verify]: Running without RAZORPAY_KEY_SECRET. Development test mode active.');
        isSignatureValid = true;
      } else {
        return new Response(JSON.stringify({ success: false, error: 'Payment gateway secret not configured.' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    if (!isSignatureValid) {
      console.error('[Payment Verification Failed]: Invalid signature for order', razorpay_order_id);
      return new Response(JSON.stringify({ success: false, verified: false, error: 'Invalid payment signature.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const targetOrderId = order_id || razorpay_order_id;
    let existingOrder = null;

    // Check existing order in Cloudflare D1
    if (env.DB) {
      try {
        existingOrder = await env.DB.prepare(`
          SELECT id, razorpay_order_id, customer_email, amount, currency, status, download_token
          FROM orders
          WHERE id = ? OR razorpay_order_id = ?
        `).bind(targetOrderId, razorpay_order_id).first();
      } catch (dbErr) {
        console.warn('[D1 Order Query Warning]:', dbErr.message);
      }
    }

    // 1. Order ID matching check
    if (existingOrder) {
      if (existingOrder.razorpay_order_id && existingOrder.razorpay_order_id !== razorpay_order_id) {
        return new Response(JSON.stringify({
          success: false,
          verified: false,
          error: 'Order ID mismatch.'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // 2. Amount and currency check against stored D1 order
      const expectedPrice = parseInt(env.PRODUCT_PRICE || '149', 10);
      const expectedCurrency = env.PRODUCT_CURRENCY || 'INR';

      if (existingOrder.amount && existingOrder.amount !== expectedPrice) {
        return new Response(JSON.stringify({
          success: false,
          verified: false,
          error: 'Payment amount mismatch.'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (existingOrder.currency && existingOrder.currency !== expectedCurrency) {
        return new Response(JSON.stringify({
          success: false,
          verified: false,
          error: 'Payment currency mismatch.'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // 3. Idempotency & existing download token preservation: If already paid, return existing token
      if (existingOrder.status === 'paid' && existingOrder.download_token) {
        return new Response(JSON.stringify({
          success: true,
          verified: true,
          order_id: existingOrder.id,
          download_token: existingOrder.download_token,
          redirect_url: `/thank-you/?order_id=${encodeURIComponent(existingOrder.id)}&token=${encodeURIComponent(existingOrder.download_token)}`
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // 4. Independent Razorpay API verification of captured payment status
    if (rawKeySecret && rawKeyId && !isPlaceholder) {
      let rzpPaymentRes;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000); // 8-second safety timeout

        const basicAuth = btoa(`${rawKeyId}:${rawKeySecret}`);
        rzpPaymentRes = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(razorpay_payment_id)}`, {
          method: 'GET',
          headers: {
            'Authorization': `Basic ${basicAuth}`,
            'Content-Type': 'application/json'
          },
          signal: controller.signal
        });
        clearTimeout(timeoutId);
      } catch (fetchErr) {
        console.error('[Razorpay Payment Fetch Error]:', fetchErr.message);
        return new Response(JSON.stringify({
          success: false,
          verified: false,
          status: 'gateway_timeout',
          error: 'Unable to verify payment status with gateway. Please wait a moment and refresh.'
        }), {
          status: 504,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (!rzpPaymentRes.ok) {
        const errText = await rzpPaymentRes.text();
        console.error('[Razorpay Payment API Error]:', rzpPaymentRes.status, errText);
        return new Response(JSON.stringify({
          success: false,
          verified: false,
          status: 'gateway_error',
          error: 'Payment gateway status inquiry failed. Please contact support if debited.'
        }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      let paymentData;
      try {
        paymentData = await rzpPaymentRes.json();
      } catch (jsonErr) {
        return new Response(JSON.stringify({
          success: false,
          verified: false,
          error: 'Invalid response from payment gateway.'
        }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Verify payment ID matches
      if (paymentData.id !== razorpay_payment_id) {
        return new Response(JSON.stringify({
          success: false,
          verified: false,
          error: 'Payment ID mismatch from gateway.'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Verify Razorpay order ID matches
      if (paymentData.order_id !== razorpay_order_id) {
        return new Response(JSON.stringify({
          success: false,
          verified: false,
          error: 'Payment order ID mismatch from gateway.'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Verify amount is exactly 14900 paise (149 INR)
      const expectedAmountPaise = parseInt(env.PRODUCT_PRICE || '149', 10) * 100;
      if (paymentData.amount !== expectedAmountPaise) {
        return new Response(JSON.stringify({
          success: false,
          verified: false,
          error: 'Payment amount mismatch from gateway.'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Verify currency is INR
      const expectedCurrency = env.PRODUCT_CURRENCY || 'INR';
      if (paymentData.currency !== expectedCurrency) {
        return new Response(JSON.stringify({
          success: false,
          verified: false,
          error: 'Payment currency mismatch from gateway.'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Verify payment status is strictly 'captured'
      if (paymentData.status !== 'captured') {
        console.warn(`[Payment Verification Non-Captured]: status is '${paymentData.status}' for payment ${razorpay_payment_id}`);
        if (paymentData.status === 'authorized' || paymentData.status === 'pending') {
          return new Response(JSON.stringify({
            success: false,
            verified: false,
            status: paymentData.status,
            error: 'Payment capture is pending. Please wait a moment and refresh.'
          }), {
            status: 202,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return new Response(JSON.stringify({
          success: false,
          verified: false,
          status: paymentData.status,
          error: `Payment status is '${paymentData.status}' (not captured). Fulfilment refused.`
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Generate secure random download token (or preserve existing)
    let downloadToken = existingOrder?.download_token;
    if (!downloadToken) {
      const tokenBytes = new Uint8Array(24);
      crypto.getRandomValues(tokenBytes);
      downloadToken = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // Update D1 Database
    if (env.DB) {
      try {
        await env.DB.prepare(`
          UPDATE orders
          SET status = 'paid',
              razorpay_payment_id = ?,
              razorpay_signature = ?,
              download_token = COALESCE(download_token, ?),
              updated_at = datetime('now')
          WHERE razorpay_order_id = ? OR id = ?
        `).bind(razorpay_payment_id, razorpay_signature || '', downloadToken, razorpay_order_id, targetOrderId).run();

        // Asynchronously dispatch purchase confirmation email with PDF attachment
        const emailPromise = processOrderEmail(targetOrderId, env);
        if (typeof waitUntil === 'function') {
          waitUntil(emailPromise);
        } else if (typeof context !== 'undefined' && context && typeof context.waitUntil === 'function') {
          context.waitUntil(emailPromise);
        } else {
          // Await in local test runners where waitUntil is not provided
          await emailPromise;
        }
      } catch (dbErr) {
        console.error('[D1 Verify Update Error]:', dbErr);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      verified: true,
      order_id: targetOrderId,
      download_token: downloadToken,
      redirect_url: `/thank-you/?order_id=${encodeURIComponent(targetOrderId)}&token=${encodeURIComponent(downloadToken)}`
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('[Verify Payment Fatal Error]:', err);
    return new Response(JSON.stringify({ success: false, error: 'Internal error during payment verification.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
